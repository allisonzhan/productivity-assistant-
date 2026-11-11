import { z } from "zod";
import { resolveDateText } from "@/server/dates/resolve";
import type { ToolCallRecord } from "@/server/ai/agent";
import { WRITE_TOOLS } from "@/server/ai/tools";

/**
 * Deterministic grading for replayed agent runs. What matters is what the agent would have
 * DONE: which changes it proposed (type, target task, resolved date, priority), or that it
 * proposed nothing (an answer) or asked back (a clarification). Answer wording is not graded.
 */

export type NormAction =
  | { type: "create"; title: string; dueDate: string | null }
  | { type: "update"; taskId: string; dueDate?: string | null; priority?: string }
  | { type: "complete"; taskId: string };

export const expectedSchema = z.discriminatedUnion("intent", [
  z.object({ intent: z.literal("answer") }),
  z.object({ intent: z.literal("clarify") }),
  z.object({
    intent: z.literal("actions"),
    actions: z
      .array(
        z.discriminatedUnion("type", [
          z.object({ type: z.literal("create"), title: z.string().min(1), dueDate: z.string().nullable() }),
          z.object({ type: z.literal("update"), taskId: z.string().min(1), dueDate: z.string().nullable().optional(), priority: z.string().optional() }),
          z.object({ type: z.literal("complete"), taskId: z.string().min(1) }),
        ]),
      )
      .min(1),
  }),
]);
export type Expected = z.infer<typeof expectedSchema>;

/** Write-tool calls → normalized actions. Dates resolve exactly as production would (same zone and "now"). */
export function normalizeActions(toolCalls: ToolCallRecord[], zone: string, now: Date): NormAction[] {
  const out: NormAction[] = [];
  for (const call of toolCalls) {
    if (!WRITE_TOOLS.has(call.name) || call.isError) continue;
    const input = (call.input ?? {}) as Record<string, unknown>;
    const date = (text: unknown) => {
      if (typeof text !== "string" || !text) return undefined;
      const r = resolveDateText(text, zone, now);
      return r.ok ? r.date : undefined;
    };
    if (call.name === "create_task") {
      out.push({ type: "create", title: String(input.title ?? ""), dueDate: date(input.due_text) ?? null });
    } else if (call.name === "complete_task") {
      out.push({ type: "complete", taskId: String(input.task_id ?? "") });
    } else {
      const a: NormAction = { type: "update", taskId: String(input.task_id ?? "") };
      if (input.remove_due_date === true) a.dueDate = null;
      else if (date(input.due_text) !== undefined) a.dueDate = date(input.due_text);
      if (typeof input.priority === "string") a.priority = input.priority;
      out.push(a);
    }
  }
  return out;
}

/** What a run marked "right" is expected to keep doing: exactly what it did. */
export function expectedFromRun(toolCalls: ToolCallRecord[], reply: string | null, zone: string, now: Date): Expected {
  const actions = normalizeActions(toolCalls, zone, now);
  if (actions.length) return { intent: "actions", actions };
  return looksLikeQuestion(reply) && !toolCalls.some((c) => !WRITE_TOOLS.has(c.name)) ? { intent: "clarify" } : { intent: "answer" };
}

function looksLikeQuestion(reply: string | null) {
  return !!reply && /\?\s*$/.test(reply.trim().split("\n").filter(Boolean).at(-1) ?? "");
}

function titleKey(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function sameAction(e: NormAction, a: NormAction): boolean {
  if (e.type !== a.type) return false;
  if (e.type === "create" && a.type === "create") {
    const [x, y] = [titleKey(e.title), titleKey(a.title)];
    return (x.includes(y) || y.includes(x)) && e.dueDate === a.dueDate;
  }
  if (e.type === "complete" && a.type === "complete") return e.taskId === a.taskId;
  if (e.type === "update" && a.type === "update") {
    if (e.taskId !== a.taskId) return false;
    if (e.dueDate !== undefined && e.dueDate !== a.dueDate) return false;
    if (e.priority !== undefined && e.priority !== a.priority) return false;
    return true;
  }
  return false;
}

export type Grade = { pass: boolean; reason: string; intent: string };

export function intentTag(e: Expected): string {
  if (e.intent !== "actions") return e.intent === "answer" ? "question" : "clarify";
  const t = e.actions[0];
  if (t.type === "create") return "add";
  if (t.type === "complete") return "done";
  return t.dueDate !== undefined ? "reschedule" : "edit";
}

export function gradeRun(expected: Expected, actual: NormAction[], reply: string | null): Grade {
  const intent = intentTag(expected);
  if (expected.intent === "answer") {
    return actual.length ? { pass: false, reason: `proposed ${actual.length} change(s) for a question`, intent } : { pass: !!reply, reason: reply ? "answered without changes" : "no reply", intent };
  }
  if (expected.intent === "clarify") {
    if (actual.length) return { pass: false, reason: "proposed a change instead of asking", intent };
    return looksLikeQuestion(reply) ? { pass: true, reason: "asked back", intent } : { pass: false, reason: "did not ask a clarifying question", intent };
  }
  const unmatched = [...actual];
  for (const e of expected.actions) {
    const i = unmatched.findIndex((a) => sameAction(e, a));
    if (i < 0) return { pass: false, reason: `missing ${JSON.stringify(e)}; proposed ${JSON.stringify(actual)}`, intent };
    unmatched.splice(i, 1);
  }
  if (unmatched.length) return { pass: false, reason: `extra change(s) ${JSON.stringify(unmatched)}`, intent };
  return { pass: true, reason: "proposed the expected change(s)", intent };
}

/** 95% Wilson score interval for a pass rate. */
export function wilson(pass: number, n: number): [number, number] {
  if (!n) return [0, 0];
  const z = 1.96;
  const p = pass / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}
