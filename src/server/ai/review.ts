import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import { resolveDateText } from "@/server/dates/resolve";
import type { Expected } from "@/server/ai/eval-grading";

/** Marking logged replies right/wrong (the eval's labels). Always scoped to the session's userId. */

export class ReviewError extends Error {}

const input = z.object({
  runId: z.string().min(1),
  verdict: z.enum(["right", "wrong"]),
  note: z.string().max(1000).optional().default(""),
  // Optional "should have" for a wrong run.
  should: z.enum(["", "answer", "clarify", "create", "update_due", "complete"]).optional().default(""),
  taskId: z.string().max(64).optional().default(""),
  title: z.string().max(200).optional().default(""),
  dateText: z.string().max(60).optional().default(""),
});

export async function markAgentRun(userId: string, raw: unknown) {
  const p = input.safeParse(raw);
  if (!p.success) throw new ReviewError(p.error.issues.map((i) => i.message).join(" "));
  const v = p.data;
  const run = await prisma.agentRun.findFirst({ where: { id: v.runId, userId } });
  if (!run) throw new ReviewError("Reply not found.");

  let expected: Expected | null = null;
  if (v.verdict === "wrong" && v.should) {
    const date = () => {
      if (!v.dateText.trim()) return null;
      // Relative to when the reply was written, like the agent itself.
      const r = resolveDateText(v.dateText, run.zone, run.receivedAt);
      if (!r.ok) throw new ReviewError(r.message);
      return r.date;
    };
    const ownTask = async () => {
      if (!v.taskId) throw new ReviewError("Pick the task it should have changed.");
      const t = await prisma.task.findFirst({ where: { id: v.taskId, userId } });
      if (!t) throw new ReviewError("Task not found.");
      return t.id;
    };
    if (v.should === "answer") expected = { intent: "answer" };
    else if (v.should === "clarify") expected = { intent: "clarify" };
    else if (v.should === "create") {
      if (!v.title.trim()) throw new ReviewError("Give the task title it should have added.");
      expected = { intent: "actions", actions: [{ type: "create", title: v.title.trim(), dueDate: date() }] };
    } else if (v.should === "update_due") {
      expected = { intent: "actions", actions: [{ type: "update", taskId: await ownTask(), dueDate: date() }] };
    } else {
      expected = { intent: "actions", actions: [{ type: "complete", taskId: await ownTask() }] };
    }
  }

  return prisma.agentRun.update({
    where: { id: run.id },
    data: {
      verdict: v.verdict,
      note: v.note.trim() || null,
      expected: expected ? (expected as unknown as Prisma.InputJsonValue) : undefined,
      markedAt: new Date(),
    },
  });
}

export async function clearAgentRunMark(userId: string, runId: string) {
  await prisma.agentRun.updateMany({ where: { id: runId, userId }, data: { verdict: null, note: null, markedAt: null } });
}
