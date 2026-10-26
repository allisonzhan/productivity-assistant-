import { Prisma } from "@prisma/client";
import { DateTime } from "luxon";
import { prisma } from "@/server/db";
import { audit } from "@/server/audit/log";
import { createTask, listOpenTasks } from "@/server/tasks/service";
import { generateBriefing } from "@/server/briefings/generate";
import { sendSms } from "@/server/delivery/sms";
import { HELP_TEXT, parseSmsCommand } from "@/server/sms/commands";
import { dateOnlyToISO } from "@/server/time";
import type { SmsProviderName } from "@/server/sms/provider";

const RATE_LIMIT_PER_MINUTE = 10;

export type InboundResult = {
  duplicate: boolean;
  status: "processed" | "ignored" | "duplicate";
  reply: string | null;
  taskId?: string;
};

/**
 * Handles one inbound SMS after its signature was verified (or, for the simulator, after the
 * session was verified). Exactly-once: the InboundMessage row (unique on provider + message ID)
 * and any task it creates are written in the same transaction.
 */
export async function handleInboundSms(
  msg: { provider: SmsProviderName; providerMessageId: string; from: string; body: string },
  opts: { now?: Date; sendReply?: boolean } = {},
): Promise<InboundResult> {
  const now = opts.now ?? new Date();
  const user = await prisma.user.findFirst({ where: { phoneE164: msg.from, phoneVerifiedAt: { not: null } } });

  // `deferToday`: the TODAY reply is generated after commit (it reads via the main client).
  let result: InboundResult & { deferToday?: boolean };
  try {
    result = await prisma.$transaction(async (tx) => {
      const inbound = await tx.inboundMessage.create({
        data: {
          provider: msg.provider,
          providerMessageId: msg.providerMessageId,
          fromE164: msg.from,
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
        return r;
      };

      // Unknown or unverified numbers never touch any account.
      if (!user) return finish({ duplicate: false, status: "ignored", reply: null }, "unknown_sender");

      const recent = await tx.inboundMessage.count({
        where: { userId: user.id, receivedAt: { gte: new Date(now.getTime() - 60_000) } },
      });
      if (recent > RATE_LIMIT_PER_MINUTE) return finish({ duplicate: false, status: "ignored", reply: null }, "rate_limited");

      const cmd = parseSmsCommand(msg.body, { zone: user.timezone, now });
      if (user.smsOptOut && cmd.type !== "start") {
        return finish({ duplicate: false, status: "ignored", reply: null }, "opted_out");
      }

      switch (cmd.type) {
        case "add": {
          const task = await createTask(
            { userId: user.id, title: cmd.title, dueDate: cmd.dueDate, sourceType: "sms", sourceRef: inbound.id },
            tx,
          );
          await audit({ userId: user.id, actor: "sms", action: "task.create", entityType: "Task", entityId: task.id, metadata: { inboundMessageId: inbound.id } }, tx);
          const due = cmd.dueDate ? ` (due ${DateTime.fromISO(cmd.dueDate).toFormat("ccc LLL d")})` : "";
          return finish({ duplicate: false, status: "processed", reply: `Added: ${task.title}${due}`, taskId: task.id }, "add");
        }
        case "stop":
          await tx.user.update({ where: { id: user.id }, data: { smsOptOut: true } });
          await audit({ userId: user.id, actor: "sms", action: "sms.opt_out" }, tx);
          // Twilio sends the carrier-required STOP confirmation itself.
          return finish({ duplicate: false, status: "processed", reply: null }, "stop");
        case "start":
          await tx.user.update({ where: { id: user.id }, data: { smsOptOut: false } });
          await audit({ userId: user.id, actor: "sms", action: "sms.opt_in" }, tx);
          return finish({ duplicate: false, status: "processed", reply: null }, "start");
        case "help":
          return finish({ duplicate: false, status: "processed", reply: HELP_TEXT }, "help");
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
          return finish({ duplicate: false, status: "processed", reply: `${cmd.keyword} is coming soon. ${HELP_TEXT}` }, "unsupported");
        default:
          return finish({ duplicate: false, status: "processed", reply: `Sorry, I didn't understand. ${HELP_TEXT}` }, "unknown");
      }
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      // Same provider message ID seen before: a webhook retry or replay. No side effects.
      return { duplicate: true, status: "duplicate", reply: null };
    }
    throw err;
  }

  const { deferToday, ...final } = result;
  if (deferToday && user) final.reply = (await generateBriefing(user.id, "sms_today", now)).content;
  if (opts.sendReply !== false && final.reply && user) {
    await sendSms({ userId: user.id, to: msg.from, body: final.reply, purpose: "reply" });
  }
  return final;
}
