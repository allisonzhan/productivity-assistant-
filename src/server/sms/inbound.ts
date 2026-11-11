import { Prisma } from "@prisma/client";
import { DateTime } from "luxon";
import { prisma } from "@/server/db";
import { audit } from "@/server/audit/log";
import { createTask, listOpenTasks } from "@/server/tasks/service";
import { generateBriefing } from "@/server/briefings/generate";
import { sendSms } from "@/server/delivery/sms";
import { sendEmail } from "@/server/delivery/email";
import { replySubject } from "@/server/email/mime";
import { HELP_TEXT, parseSmsCommand } from "@/server/sms/commands";
import { extractReplyCommand } from "@/server/email/mime";
import { agentConfigured, type CreateMessage } from "@/server/ai/agent";
import { processAgentInbound } from "@/server/ai/handle-reply";
import { cancelPendingAction, confirmPendingAction, hasPendingAction } from "@/server/ai/pending-actions";
import { dateOnlyToISO } from "@/server/time";
import type { SmsProviderName } from "@/server/sms/provider";

const RATE_LIMIT_PER_MINUTE = 10;

export type InboundResult = {
  duplicate: boolean;
  status: "processed" | "ignored" | "duplicate";
  reply: string | null;
  taskId?: string;
};

export type InboundInput =
  | { channel: "sms"; provider: SmsProviderName; providerMessageId: string; from: string; body: string }
  | {
      channel: "email";
      provider: "gmail";
      providerMessageId: string;
      from: string;
      body: string;
      /** Owner of the mailbox the reply was read from; `from` must be that user's address. */
      userId: string;
      thread: { threadId: string; subject: string; messageIdHeader?: string };
    };

type InboundOptions = {
  now?: Date;
  sendReply?: boolean;
  fetchImpl?: typeof fetch;
  /** Model call for natural-language replies (tests inject a fake). */
  create?: CreateMessage;
  /** Overrides whether the LLM agent handles replies the command parser doesn't understand. */
  agentEnabled?: boolean;
};

/** Inbound SMS after its signature was verified (or, for the simulator, after the session was verified). */
export function handleInboundSms(msg: Omit<Extract<InboundInput, { channel: "sms" }>, "channel">, opts: InboundOptions = {}) {
  return handleInboundMessage({ channel: "sms", ...msg }, opts);
}

/**
 * Handles one inbound command message. Exactly-once: the InboundMessage row (unique on
 * provider + message ID) and any task it creates are written in the same transaction.
 */
export async function handleInboundMessage(msg: InboundInput, opts: InboundOptions = {}): Promise<InboundResult> {
  const now = opts.now ?? new Date();
  const channel = msg.channel;
  // SMS: only verified phone numbers. Email: only the mailbox owner's own Google-verified address.
  const user =
    msg.channel === "sms"
      ? await prisma.user.findFirst({ where: { phoneE164: msg.from, phoneVerifiedAt: { not: null } } })
      : await prisma.user.findFirst({ where: { id: msg.userId, email: { equals: msg.from, mode: "insensitive" } } });

  // Email replies the parser doesn't understand go to the LLM agent (email only: confirmations need a thread).
  const agentOn = msg.channel === "email" && (opts.agentEnabled ?? agentConfigured());
  const threadId = msg.channel === "email" ? msg.thread.threadId : null;

  // `deferToday`: the TODAY reply is generated after commit (it reads via the main client).
  // `deferAgent`: the agent runs after commit, outside the transaction.
  let result: InboundResult & { deferToday?: boolean; deferAgent?: string };
  try {
    result = await prisma.$transaction(async (tx) => {
      const inbound = await tx.inboundMessage.create({
        data: {
          channel,
          provider: msg.provider,
          providerMessageId: msg.providerMessageId,
          fromAddress: msg.from,
          threadId: msg.channel === "email" ? msg.thread.threadId : undefined,
          body: msg.body.slice(0, 1600),
          userId: user?.id,
          receivedAt: now,
        },
      });
      const finish = async (r: InboundResult & { deferToday?: boolean }, command: string) => {
        await tx.inboundMessage.update({
          where: { id: inbound.id },
          data: { status: r.status, command, result: { reply: r.reply, taskId: r.taskId ?? null } },
        });
        // Every handled reply is logged for the quality review, including the fast path.
        if (user && r.status === "processed") {
          await tx.agentRun.create({
            data: {
              userId: user.id,
              inboundMessageId: inbound.id,
              kind: "fast_path",
              input: msg.body.slice(0, 1600),
              zone: user.timezone,
              receivedAt: now,
              reply: r.reply ?? (r.deferToday ? "(today's briefing)" : null),
              context: { command },
            },
          });
        }
        return r;
      };

      // Unknown or unverified senders never touch any account.
      if (!user) return finish({ duplicate: false, status: "ignored", reply: null }, "unknown_sender");

      const recent = await tx.inboundMessage.count({
        where: { userId: user.id, receivedAt: { gte: new Date(now.getTime() - 60_000) } },
      });
      if (recent > RATE_LIMIT_PER_MINUTE) return finish({ duplicate: false, status: "ignored", reply: null }, "rate_limited");

      // Email bodies keep everything written above the quote (for the agent); commands read the first line.
      const cmd = parseSmsCommand(msg.channel === "email" ? extractReplyCommand(msg.body) : msg.body, { zone: user.timezone, now });
      const optedOut = channel === "sms" ? user.smsOptOut : user.emailOptOut;
      if (optedOut && cmd.type !== "start") {
        return finish({ duplicate: false, status: "ignored", reply: null }, "opted_out");
      }

      switch (cmd.type) {
        case "add": {
          const task = await createTask(
            { userId: user.id, title: cmd.title, dueDate: cmd.dueDate, sourceType: channel, sourceRef: inbound.id },
            tx,
          );
          await audit({ userId: user.id, actor: channel, action: "task.create", entityType: "Task", entityId: task.id, metadata: { inboundMessageId: inbound.id } }, tx);
          const due = cmd.dueDate ? ` (due ${DateTime.fromISO(cmd.dueDate).toFormat("ccc LLL d")})` : "";
          return finish({ duplicate: false, status: "processed", reply: `Added: ${task.title}${due}`, taskId: task.id }, "add");
        }
        case "stop":
          // In an email thread with a proposal waiting, "cancel" means cancel the proposal, not unsubscribe.
          if (channel === "email" && cmd.keyword === "CANCEL" && (await hasPendingAction(tx, user.id, threadId))) {
            return finish({ duplicate: false, status: "processed", reply: await cancelPendingAction(tx, { userId: user.id, threadId, now }) }, "cancel");
          }
          await tx.user.update({ where: { id: user.id }, data: channel === "sms" ? { smsOptOut: true } : { emailOptOut: true } });
          await audit({ userId: user.id, actor: channel, action: `${channel}.opt_out` }, tx);
          // Twilio sends the carrier-required STOP confirmation itself; email confirms here.
          return finish({ duplicate: false, status: "processed", reply: channel === "email" ? "Email briefings stopped. Reply START to resume." : null }, "stop");
        case "start":
          await tx.user.update({ where: { id: user.id }, data: channel === "sms" ? { smsOptOut: false } : { emailOptOut: false } });
          await audit({ userId: user.id, actor: channel, action: `${channel}.opt_in` }, tx);
          return finish({ duplicate: false, status: "processed", reply: channel === "email" ? "Email briefings resumed." : null }, "start");
        case "help":
          return finish({ duplicate: false, status: "processed", reply: HELP_TEXT }, "help");
        case "confirm": {
          const r = await confirmPendingAction(tx, { userId: user.id, threadId, inboundMessageId: inbound.id, now });
          return finish({ duplicate: false, status: "processed", reply: r.reply, taskId: r.taskIds[0] }, "confirm");
        }
        case "cancel":
          return finish({ duplicate: false, status: "processed", reply: await cancelPendingAction(tx, { userId: user.id, threadId, now }) }, "cancel");
        case "tasks": {
          const tasks = await listOpenTasks(user.id, tx);
          const lines = tasks.slice(0, 5).map((t, i) => `${i + 1}. ${t.title}${t.dueDate ? ` (${DateTime.fromISO(dateOnlyToISO(t.dueDate)).toFormat("LLL d")})` : ""}`);
          const reply = tasks.length ? `Open tasks:\n${lines.join("\n")}${tasks.length > 5 ? `\n+${tasks.length - 5} more` : ""}` : "No open tasks.";
          return finish({ duplicate: false, status: "processed", reply }, "tasks");
        }
        case "today":
          return finish({ duplicate: false, status: "processed", reply: null, deferToday: true }, "today");
        case "clarify":
          return finish({ duplicate: false, status: "processed", reply: cmd.message }, "clarify");
        case "unsupported":
        case "unknown":
          if (agentOn && msg.channel === "email") {
            await tx.inboundMessage.update({
              where: { id: inbound.id },
              data: { status: "agent_pending", command: "agent", result: { thread: { subject: msg.thread.subject, messageIdHeader: msg.thread.messageIdHeader ?? null } } },
            });
            return { duplicate: false, status: "processed", reply: null, deferAgent: inbound.id };
          }
          return cmd.type === "unsupported"
            ? finish({ duplicate: false, status: "processed", reply: `${cmd.keyword} is coming soon. ${HELP_TEXT}` }, "unsupported")
            : finish({ duplicate: false, status: "processed", reply: `Sorry, I didn't understand. ${HELP_TEXT}` }, "unknown");
      }
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      // Same provider message ID seen before: a webhook retry, replay or repeated reply check. No side effects.
      return { duplicate: true, status: "duplicate", reply: null };
    }
    throw err;
  }

  const { deferToday, deferAgent, ...final } = result;
  if (deferAgent) {
    const r = await processAgentInbound(deferAgent, { fetchImpl: opts.fetchImpl, create: opts.create, sendReply: opts.sendReply });
    return { ...final, reply: r?.reply ?? null };
  }
  if (deferToday && user) final.reply = (await generateBriefing(user.id, channel === "sms" ? "sms_today" : "email_today", now)).content;
  if (opts.sendReply !== false && final.reply && user) {
    if (msg.channel === "sms") {
      await sendSms({ userId: user.id, to: msg.from, body: final.reply, purpose: "reply" });
    } else {
      await sendEmail({
        userId: user.id,
        to: user.email,
        subject: replySubject(msg.thread.subject),
        body: final.reply,
        purpose: "reply",
        thread: { threadId: msg.thread.threadId, inReplyTo: msg.thread.messageIdHeader },
        fetchImpl: opts.fetchImpl,
      });
    }
  }
  return final;
}
