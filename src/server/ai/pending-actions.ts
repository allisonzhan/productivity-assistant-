import { DateTime } from "luxon";
import type { Prisma } from "@prisma/client";
import { audit } from "@/server/audit/log";
import { isoToDateOnly } from "@/server/time";
import type { ProposedAction } from "@/server/ai/tools";

/**
 * Proposed changes wait here until the user replies YES (or NO) in the same email thread.
 * Execution happens inside the transaction that claims the YES message, so it runs once.
 */

export const PENDING_TTL_HOURS = 24;

type Tx = Prisma.TransactionClient;

export async function createPendingAction(
  tx: Tx,
  input: { userId: string; inboundMessageId: string; threadId: string | null; actions: ProposedAction[]; now: Date },
) {
  // Only the newest proposal in a thread can be confirmed.
  await tx.pendingAction.updateMany({
    where: { userId: input.userId, threadId: input.threadId, status: "pending" },
    data: { status: "superseded", resolvedAt: input.now },
  });
  return tx.pendingAction.create({
    data: {
      userId: input.userId,
      inboundMessageId: input.inboundMessageId,
      threadId: input.threadId,
      actions: input.actions as unknown as Prisma.InputJsonValue,
      summary: input.actions.map((a) => a.summary).join("; "),
      expiresAt: DateTime.fromJSDate(input.now).plus({ hours: PENDING_TTL_HOURS }).toJSDate(),
    },
  });
}

export function confirmationPrompt(actions: ProposedAction[]): string {
  const list = actions.length === 1 ? `Proposed: ${actions[0].summary}.` : `Proposed:\n${actions.map((a, i) => `${i + 1}. ${a.summary}`).join("\n")}`;
  return `${list}\nReply YES to confirm or NO to cancel (expires in ${PENDING_TTL_HOURS}h).`;
}

async function latestPending(tx: Tx, userId: string, threadId: string | null) {
  return tx.pendingAction.findFirst({ where: { userId, threadId, status: "pending" }, orderBy: { createdAt: "desc" } });
}

export async function hasPendingAction(tx: Tx, userId: string, threadId: string | null) {
  return !!(await latestPending(tx, userId, threadId));
}

export type ConfirmResult = { reply: string; executed: number; pendingActionId?: string; taskIds: string[] };

/** YES: re-validates and applies the newest pending proposal in this thread. */
export async function confirmPendingAction(tx: Tx, input: { userId: string; threadId: string | null; inboundMessageId: string; now: Date }): Promise<ConfirmResult> {
  const pending = await latestPending(tx, input.userId, input.threadId);
  if (!pending) return { reply: "Nothing is waiting for confirmation in this thread.", executed: 0, taskIds: [] };
  if (pending.expiresAt <= input.now) {
    await tx.pendingAction.update({ where: { id: pending.id }, data: { status: "expired", resolvedAt: input.now } });
    return { reply: `That proposal expired (${pending.summary}). Send the request again.`, executed: 0, pendingActionId: pending.id, taskIds: [] };
  }
  // Claim it: a second YES (another message) finds nothing pending.
  const claim = await tx.pendingAction.updateMany({
    where: { id: pending.id, status: "pending" },
    data: { status: "confirmed", resolvedAt: input.now, resolvedByInboundId: input.inboundMessageId },
  });
  if (claim.count !== 1) return { reply: "Nothing is waiting for confirmation in this thread.", executed: 0, taskIds: [] };

  const actions = pending.actions as unknown as ProposedAction[];
  const done: string[] = [];
  const skipped: string[] = [];
  const taskIds: string[] = [];
  for (const action of actions) {
    const meta = { pendingActionId: pending.id, inboundMessageId: input.inboundMessageId };
    if (action.type === "create") {
      const task = await tx.task.create({
        data: {
          userId: input.userId,
          title: action.title,
          dueDate: action.dueDate ? isoToDateOnly(action.dueDate) : null,
          priority: action.priority,
          notes: action.notes,
          sourceType: "agent",
          sourceRef: pending.inboundMessageId,
        },
      });
      await audit({ userId: input.userId, actor: "agent", action: "task.create", entityType: "Task", entityId: task.id, metadata: meta }, tx);
      taskIds.push(task.id);
      done.push(action.summary);
      continue;
    }
    // The task may have changed since the proposal: re-check ownership and Canvas rules.
    const task = await tx.task.findFirst({ where: { id: action.taskId, userId: input.userId, deletedAt: null } });
    if (!task) {
      skipped.push(`${action.summary} (task no longer exists)`);
      continue;
    }
    if (action.type === "complete") {
      await tx.task.update({ where: { id: task.id }, data: { status: "done", completedAt: input.now } });
      await audit({ userId: input.userId, actor: "agent", action: "task.complete", entityType: "Task", entityId: task.id, metadata: meta }, tx);
    } else {
      const c = action.changes;
      if (task.externalProvider === "canvas" && (c.dueDate !== undefined || c.title !== undefined)) {
        skipped.push(`${action.summary} (Canvas owns that deadline)`);
        continue;
      }
      await tx.task.update({
        where: { id: task.id },
        data: {
          ...(c.title !== undefined ? { title: c.title } : {}),
          ...(c.dueDate !== undefined ? { dueDate: c.dueDate ? isoToDateOnly(c.dueDate) : null, dueAt: null } : {}),
          ...(c.priority !== undefined ? { priority: c.priority } : {}),
          ...(c.notes !== undefined ? { notes: c.notes } : {}),
        },
      });
      await audit({ userId: input.userId, actor: "agent", action: "task.update", entityType: "Task", entityId: task.id, metadata: { ...meta, changes: c } }, tx);
    }
    taskIds.push(task.id);
    done.push(action.summary);
  }
  const lines = [...done.map((s) => `Done: ${s}.`), ...skipped.map((s) => `Skipped: ${s}.`)];
  return { reply: lines.join("\n") || "Nothing to do.", executed: done.length, pendingActionId: pending.id, taskIds };
}

/** NO: drops the newest pending proposal in this thread. */
export async function cancelPendingAction(tx: Tx, input: { userId: string; threadId: string | null; now: Date }): Promise<string> {
  const pending = await latestPending(tx, input.userId, input.threadId);
  if (!pending) return "Nothing is waiting for confirmation in this thread.";
  await tx.pendingAction.update({ where: { id: pending.id }, data: { status: "cancelled", resolvedAt: input.now } });
  return `Cancelled: ${pending.summary}.`;
}
