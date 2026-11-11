import { DateTime } from "luxon";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import { sendEmail } from "@/server/delivery/email";
import { replySubject } from "@/server/email/mime";
import { runAgent, type CreateMessage } from "@/server/ai/agent";
import { confirmationPrompt, createPendingAction } from "@/server/ai/pending-actions";
import type { BriefingSnapshot } from "@/server/briefings/generate";

/**
 * Natural-language email replies. The InboundMessage row was already claimed (exactly-once) and
 * committed as `agent_pending`; this runs the LLM outside any DB transaction, then records the
 * outcome and the reply in one transaction that only succeeds while the row is still pending.
 * The agent itself writes nothing but a PendingAction, so retrying a crashed run is safe.
 */

export const AGENT_STALE_MS = 10 * 60_000;

export const AGENT_FALLBACK_REPLY =
  "Sorry, I couldn't work that out just now. These always work: \"Add task: finish reading Friday\", TODAY, TASKS, HELP.";

export type AgentThreadInfo = { subject: string; messageIdHeader?: string };

type Opts = { now?: Date; fetchImpl?: typeof fetch; create?: CreateMessage; sendReply?: boolean };

/** The numbered tasks of the briefing this thread started with, so "done with 2" can be resolved. */
async function briefingTasks(userId: string, threadId: string | null) {
  if (!threadId) return [];
  const attempt = await prisma.deliveryAttempt.findFirst({
    where: { userId, threadId, briefingId: { not: null } },
    orderBy: { createdAt: "asc" },
    include: { briefing: true },
  });
  const s = attempt?.briefing?.snapshot as unknown as BriefingSnapshot | undefined;
  if (!s?.days) return [];
  return [...s.overdue, ...s.days.flatMap((d) => d.tasksDue), ...s.undated]
    .filter((t) => t.n)
    .map((t) => ({ n: t.n!, id: t.id, title: t.title }));
}

export async function processAgentInbound(inboundId: string, opts: Opts = {}) {
  const now = opts.now ?? new Date();
  const claim = await prisma.inboundMessage.updateMany({
    where: {
      id: inboundId,
      status: "agent_pending",
      OR: [{ agentStartedAt: null }, { agentStartedAt: { lt: new Date(now.getTime() - AGENT_STALE_MS) } }],
    },
    data: { agentStartedAt: now },
  });
  if (claim.count === 0) return null;

  const inbound = await prisma.inboundMessage.findUniqueOrThrow({ where: { id: inboundId } });
  const user = await prisma.user.findUniqueOrThrow({ where: { id: inbound.userId! } });
  const thread = (inbound.result as { thread?: AgentThreadInfo } | null)?.thread ?? { subject: "Your briefing" };
  const zone = user.timezone;
  const asOf = inbound.receivedAt; // dates resolve relative to when the reply was written
  const turn = {
    nowLabel: DateTime.fromJSDate(asOf, { zone }).toFormat("cccc LLL d, yyyy, h:mm a"),
    zone,
    briefingTasks: await briefingTasks(user.id, inbound.threadId),
    message: inbound.body,
  };

  const started = Date.now();
  const result = await runAgent({ userId: user.id, zone, now: asOf, turn, create: opts.create });
  const latencyMs = Date.now() - started;

  const proposals = result.error ? [] : result.proposals;
  let reply = result.reply ?? AGENT_FALLBACK_REPLY;
  if (proposals.length) reply = `${reply}\n\n${confirmationPrompt(proposals)}`;

  const recorded = await prisma.$transaction(async (tx) => {
    const done = await tx.inboundMessage.updateMany({
      where: { id: inbound.id, status: "agent_pending" },
      data: { status: "processed", command: "agent" },
    });
    if (done.count !== 1) return null; // another run finished it first
    const pending = proposals.length
      ? await createPendingAction(tx, { userId: user.id, inboundMessageId: inbound.id, threadId: inbound.threadId, actions: proposals, now: asOf })
      : null;
    await tx.inboundMessage.update({
      where: { id: inbound.id },
      data: { result: { reply, pendingActionId: pending?.id ?? null, error: result.error, thread } as Prisma.InputJsonValue },
    });
    await tx.agentRun.create({
      data: {
        userId: user.id,
        inboundMessageId: inbound.id,
        kind: "agent",
        input: inbound.body,
        context: { nowLabel: turn.nowLabel, briefingTasks: turn.briefingTasks } as Prisma.InputJsonValue,
        zone,
        receivedAt: asOf,
        model: result.model,
        toolCalls: result.toolCalls as unknown as Prisma.InputJsonValue,
        proposedActions: proposals as unknown as Prisma.InputJsonValue,
        pendingActionId: pending?.id,
        reply,
        error: result.error,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        latencyMs,
      },
    });
    return { pendingActionId: pending?.id ?? null };
  });
  if (!recorded) return null;

  // Sent after commit: at most one reply per inbound message (a crash here loses the reply, never duplicates it).
  if (opts.sendReply !== false) {
    await sendEmail({
      userId: user.id,
      to: user.email,
      subject: replySubject(thread.subject),
      body: reply,
      purpose: "reply",
      thread: inbound.threadId ? { threadId: inbound.threadId, inReplyTo: thread.messageIdHeader } : undefined,
      fetchImpl: opts.fetchImpl,
    });
  }
  return { reply, pendingActionId: recorded.pendingActionId, error: result.error };
}

/** Agent replies that never finished (worker died mid-run) are retried by the next reply check. */
export async function retryStuckAgentReplies(userId: string, opts: Opts = {}) {
  const now = opts.now ?? new Date();
  const stuck = await prisma.inboundMessage.findMany({
    where: {
      userId,
      status: "agent_pending",
      OR: [{ agentStartedAt: null }, { agentStartedAt: { lt: new Date(now.getTime() - AGENT_STALE_MS) } }],
    },
    select: { id: true },
    take: 5,
  });
  const results = [];
  for (const { id } of stuck) results.push(await processAgentInbound(id, opts));
  return results.filter(Boolean).length;
}
