import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/server/db";
import { runAgent, type ToolCallRecord } from "@/server/ai/agent";
import { makeReplay } from "@/server/ai/eval-replay";
import { expectedFromRun, gradeRun, normalizeActions, wilson, type Expected } from "@/server/ai/eval-grading";
import { ReviewError, markAgentRun } from "@/server/ai/review";
import { hasDb, makeUser, resetDb } from "../helpers";
import { fakeModel } from "../fake-anthropic";

const NY = "America/New_York";
const T = new Date("2026-11-10T14:05:00Z"); // Tue 9:05am NY

const getTasks: ToolCallRecord = {
  name: "get_tasks",
  input: { status: "open", due_within_days: null, title_contains: "essay" },
  output: { count: 1, tasks: [{ id: "task_essay", title: "Essay draft", due: "2026-11-12 (Thu Nov 12)" }] },
  isError: false,
};
const moveEssay: ToolCallRecord = {
  name: "update_task",
  input: { task_id: "task_essay", title: null, due_text: "Sunday", remove_due_date: false, priority: null, notes: null },
  output: { proposed: "...", saved: false },
  isError: false,
};

describe("reply eval grading (pure)", () => {
  it("oracle: a run graded against its own recorded actions passes; a null run fails", () => {
    const expected = expectedFromRun([getTasks, moveEssay], "I can move it.", NY, T);
    expect(expected).toEqual({ intent: "actions", actions: [{ type: "update", taskId: "task_essay", dueDate: "2026-11-15" }] });
    expect(gradeRun(expected, normalizeActions([getTasks, moveEssay], NY, T), "ok").pass).toBe(true);
    expect(gradeRun(expected, [], "ok").pass).toBe(false); // null: did nothing
    expect(gradeRun(expected, normalizeActions([{ ...moveEssay, input: { ...(moveEssay.input as object), due_text: "Saturday" } }], NY, T), "ok").reason).toContain("missing");
  });

  it("questions must not propose changes; clarifications must ask", () => {
    const answer: Expected = { intent: "answer" };
    expect(gradeRun(answer, [], "Due this week: Essay draft.").pass).toBe(true);
    expect(gradeRun(answer, normalizeActions([moveEssay], NY, T), "Moved!").pass).toBe(false);
    expect(gradeRun(answer, [], null).pass).toBe(false);
    const clarify: Expected = { intent: "clarify" };
    expect(gradeRun(clarify, [], "Which essay do you mean?").pass).toBe(true);
    expect(gradeRun(clarify, [], "Done.").pass).toBe(false);
  });

  it("matches added tasks by title words and the resolved date", () => {
    const expected: Expected = { intent: "actions", actions: [{ type: "create", title: "Call mom", dueDate: "2026-11-13" }] };
    const create = (title: string, due: string): ToolCallRecord => ({ name: "create_task", input: { title, due_text: due, priority: null, notes: null }, output: {}, isError: false });
    expect(gradeRun(expected, normalizeActions([create("call Mom", "Friday")], NY, T), "ok").pass).toBe(true);
    expect(gradeRun(expected, normalizeActions([create("Call mom", "tomorrow")], NY, T), "ok").pass).toBe(false);
    // Errored write calls (e.g. a refused Canvas change) are not actions.
    expect(normalizeActions([{ ...moveEssay, isError: true }], NY, T)).toEqual([]);
  });

  it("reports a 95% interval, not just a point estimate", () => {
    const [lo, hi] = wilson(8, 10);
    expect(lo).toBeGreaterThan(0.44);
    expect(hi).toBeLessThan(0.98);
  });

  it("replays recorded lookups and re-checks dates without touching the DB", () => {
    const replay = makeReplay([getTasks], NY, T);
    expect(replay("get_tasks", { status: "open", due_within_days: null, title_contains: "essay" }).output).toEqual(getTasks.output);
    expect(replay("get_today_schedule", {}).isError).toBe(true); // never recorded
    expect(replay("update_task", { task_id: "x", due_text: "next friday" }).isError).toBe(true);
    expect(replay("update_task", { task_id: "x", due_text: "Sunday" }).isError).toBe(false);
  });
});

describe.skipIf(!hasDb)("reply eval: replay + marking", () => {
  beforeEach(resetDb);

  it("a replayed run with a fake model is graded on what it proposes, with no DB writes", async () => {
    const user = await makeUser();
    const model = fakeModel([
      { tools: [{ name: "get_tasks", input: getTasks.input as Record<string, unknown> }] },
      { tools: [{ name: "update_task", input: moveEssay.input as Record<string, unknown> }] },
      { text: "I can move Essay draft to Sunday." },
    ]);
    const result = await runAgent({
      userId: user.id, zone: NY, now: T, create: model.create, model: "claude-opus-5-5",
      turn: { nowLabel: "Tuesday Nov 10, 2026, 9:05 AM", zone: NY, briefingTasks: [], message: "push my essay to Sunday" },
      replayTool: makeReplay([getTasks, moveEssay], NY, T),
    });
    const expected = expectedFromRun([getTasks, moveEssay], "ok", NY, T);
    expect(gradeRun(expected, normalizeActions(result.toolCalls, NY, T), result.reply).pass).toBe(true);
    expect(await prisma.auditLog.count()).toBe(0);
    expect(await prisma.pendingAction.count()).toBe(0);
  });

  it("marks only my own runs, and resolves the 'should have' date as of when I replied", async () => {
    const me = await makeUser();
    const other = await makeUser();
    const task = await prisma.task.create({ data: { userId: me.id, title: "Essay draft", sourceType: "manual" } });
    const mk = (userId: string) =>
      prisma.agentRun.create({
        data: { userId, inboundMessageId: `in-${userId}`, kind: "agent", input: "push my essay to sunday", zone: NY, receivedAt: T, reply: "Done!" },
      });
    const mine = await mk(me.id);
    const theirs = await mk(other.id);

    await expect(markAgentRun(me.id, { runId: theirs.id, verdict: "right" })).rejects.toBeInstanceOf(ReviewError);
    const marked = await markAgentRun(me.id, { runId: mine.id, verdict: "wrong", note: "didn't move it", should: "update_due", taskId: task.id, dateText: "Sunday" });
    expect(marked.verdict).toBe("wrong");
    expect(marked.expected).toEqual({ intent: "actions", actions: [{ type: "update", taskId: task.id, dueDate: "2026-11-15" }] });
    await expect(markAgentRun(me.id, { runId: mine.id, verdict: "wrong", should: "update_due", taskId: task.id, dateText: "next friday" })).rejects.toThrow("two different days");
  });
});
