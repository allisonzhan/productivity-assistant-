import { DateTime } from "luxon";
import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import type { Task } from "@prisma/client";
import { prisma } from "@/server/db";
import { addDaysISO, dateOnlyToISO, isoToDateOnly, localDayBounds, todayIn } from "@/server/time";
import { resolveDateText } from "@/server/dates/resolve";
import { formatSlot, getAvailableTimeSlots } from "@/server/scheduling/availability";

/**
 * The agent's tools. Read tools answer immediately from stored data, always scoped to the
 * verified userId. Write tools never write: they validate, resolve dates deterministically and
 * return a proposal that runs only after the user replies YES (see pending-actions.ts).
 */

export type ProposedAction =
  | { type: "create"; title: string; dueDate: string | null; priority: Priority; notes: string | null; summary: string }
  | {
      type: "update";
      taskId: string;
      changes: { title?: string; dueDate?: string | null; priority?: Priority; notes?: string };
      summary: string;
    }
  | { type: "complete"; taskId: string; summary: string };

type Priority = "critical" | "high" | "medium" | "low";

export type ToolContext = { userId: string; zone: string; now: Date; proposals: ProposedAction[] };

export class ToolInputError extends Error {}

const PRIORITIES = ["critical", "high", "medium", "low"] as const;
const nullableString = { type: ["string", "null"] } as const;

export const TOOL_DEFINITIONS: Anthropic.Beta.BetaTool[] = [
  {
    name: "get_today_schedule",
    description: "Today's calendar events, tasks and assignments due today, overdue items, and free time left today.",
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "get_upcoming_events",
    description: "Calendar events for the next N days (1-14), starting today, grouped by day.",
    input_schema: {
      type: "object",
      properties: { days: { type: "integer", description: "1-14" } },
      required: ["days"],
      additionalProperties: false,
    },
  },
  {
    name: "get_tasks",
    description:
      "The user's tasks (including imported Canvas assignments). Use it to find a task's id before proposing a change. " +
      "Filter by status, by due within N days, and/or by words in the title.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["open", "done", "all"] },
        due_within_days: { type: ["integer", "null"], description: "Only tasks due within this many days (includes overdue). null = any." },
        title_contains: { ...nullableString, description: "Case-insensitive words to match in the title. null = no filter." },
      },
      required: ["status", "due_within_days", "title_contains"],
      additionalProperties: false,
    },
  },
  {
    name: "get_upcoming_assignments",
    description: "Canvas assignments due in the next N days (1-60), with course and whether they were already submitted.",
    input_schema: {
      type: "object",
      properties: { days: { type: "integer", description: "1-60" } },
      required: ["days"],
      additionalProperties: false,
    },
  },
  {
    name: "get_available_time_slots",
    description: "Free blocks (30+ min, 8am-10pm) on one day, from the calendar. Pass the user's words for the day, e.g. \"Thursday\" or \"tomorrow\".",
    input_schema: {
      type: "object",
      properties: { date_text: { type: "string", description: "The day exactly as the user said it; it is resolved by code." } },
      required: ["date_text"],
      additionalProperties: false,
    },
  },
  {
    name: "create_task",
    description: "PROPOSE a new task. Nothing is saved until the user replies YES.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        due_text: { ...nullableString, description: "The due date in the user's own words (e.g. \"Friday\", \"11/14\"); resolved by code. null = no date." },
        priority: { type: ["string", "null"], enum: [...PRIORITIES, null] },
        notes: nullableString,
      },
      required: ["title", "due_text", "priority", "notes"],
      additionalProperties: false,
    },
  },
  {
    name: "update_task",
    description:
      "PROPOSE changes to an existing task (id from get_tasks). Only set the fields to change; use null to leave a field as it is. " +
      "Canvas assignment deadlines belong to Canvas and cannot be changed. Nothing changes until the user replies YES.",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        title: nullableString,
        due_text: { ...nullableString, description: "New due date in the user's words; resolved by code." },
        remove_due_date: { type: "boolean" },
        priority: { type: ["string", "null"], enum: [...PRIORITIES, null] },
        notes: nullableString,
      },
      required: ["task_id", "title", "due_text", "remove_due_date", "priority", "notes"],
      additionalProperties: false,
    },
  },
  {
    name: "complete_task",
    description: "PROPOSE marking a task done (id from get_tasks). Nothing changes until the user replies YES.",
    input_schema: {
      type: "object",
      properties: { task_id: { type: "string" } },
      required: ["task_id"],
      additionalProperties: false,
    },
  },
].map((t) => ({ ...t, strict: true }) as Anthropic.Beta.BetaTool);

export const WRITE_TOOLS = new Set(["create_task", "update_task", "complete_task"]);

const inputs = {
  get_today_schedule: z.object({}).strict(),
  get_upcoming_events: z.object({ days: z.number().int().min(1).max(14) }).strict(),
  get_tasks: z
    .object({
      status: z.enum(["open", "done", "all"]),
      due_within_days: z.number().int().min(0).max(365).nullable(),
      title_contains: z.string().max(200).nullable(),
    })
    .strict(),
  get_upcoming_assignments: z.object({ days: z.number().int().min(1).max(60) }).strict(),
  get_available_time_slots: z.object({ date_text: z.string().min(1).max(60) }).strict(),
  create_task: z
    .object({
      title: z.string().trim().min(1).max(200),
      due_text: z.string().max(60).nullable(),
      priority: z.enum(PRIORITIES).nullable(),
      notes: z.string().max(1000).nullable(),
    })
    .strict(),
  update_task: z
    .object({
      task_id: z.string().min(1).max(64),
      title: z.string().trim().min(1).max(200).nullable(),
      due_text: z.string().max(60).nullable(),
      remove_due_date: z.boolean(),
      priority: z.enum(PRIORITIES).nullable(),
      notes: z.string().max(1000).nullable(),
    })
    .strict(),
  complete_task: z.object({ task_id: z.string().min(1).max(64) }).strict(),
};

export type ToolName = keyof typeof inputs;

function dayName(iso: string) {
  return DateTime.fromISO(iso).toFormat("ccc LLL d");
}

/** Local due date (ISO) of a task, from the date-only or instant field. */
export function taskDueISO(t: Pick<Task, "dueDate" | "dueAt">, zone: string): string | null {
  if (t.dueDate) return dateOnlyToISO(t.dueDate);
  if (t.dueAt) return DateTime.fromJSDate(t.dueAt, { zone }).toISODate();
  return null;
}

function taskView(t: Task, zone: string) {
  const due = taskDueISO(t, zone);
  return {
    id: t.id,
    title: t.title,
    due: due ? `${due} (${dayName(due)})${t.dueAt ? ` ${DateTime.fromJSDate(t.dueAt, { zone }).toFormat("h:mma").toLowerCase()}` : ""}` : null,
    status: t.status,
    priority: t.priority,
    source: t.sourceType,
    course: t.courseName ?? undefined,
    submitted_in_canvas: t.externalSubmittedAt ? true : undefined,
    notes: t.notes ?? undefined,
  };
}

async function eventsBetween(userId: string, zone: string, fromISO: string, days: number) {
  const { start } = localDayBounds(fromISO, zone);
  const { start: end } = localDayBounds(addDaysISO(fromISO, days), zone);
  const events = await prisma.event.findMany({
    where: {
      userId,
      deletedAt: null,
      status: { not: "cancelled" },
      OR: [
        { allDay: false, startAt: { gte: start, lt: end } },
        { allDay: true, startDate: { lt: isoToDateOnly(addDaysISO(fromISO, days)) }, endDate: { gt: isoToDateOnly(fromISO) } },
      ],
    },
    orderBy: [{ startAt: "asc" }, { startDate: "asc" }],
  });
  const byDay = new Map<string, { title: string; time: string }[]>();
  for (let i = 0; i < days; i++) byDay.set(addDaysISO(fromISO, i), []);
  for (const e of events) {
    if (e.allDay && e.startDate) {
      const endISO = e.endDate ? dateOnlyToISO(e.endDate) : addDaysISO(dateOnlyToISO(e.startDate), 1);
      for (const [d, list] of byDay) if (d >= dateOnlyToISO(e.startDate) && d < endISO) list.push({ title: e.title, time: "all day" });
    } else if (e.startAt) {
      const s = DateTime.fromJSDate(e.startAt, { zone });
      const en = e.endAt ? DateTime.fromJSDate(e.endAt, { zone }) : null;
      byDay.get(s.toISODate()!)?.push({ title: e.title, time: `${s.toFormat("h:mma").toLowerCase()}${en ? `-${en.toFormat("h:mma").toLowerCase()}` : ""}` });
    }
  }
  return [...byDay].map(([date, list]) => ({ date: `${date} (${dayName(date)})`, events: list }));
}

async function openTasks(userId: string) {
  return prisma.task.findMany({ where: { userId, deletedAt: null, status: "open" }, orderBy: [{ dueDate: "asc" }, { dueAt: "asc" }, { createdAt: "asc" }] });
}

async function ownedTask(ctx: ToolContext, taskId: string) {
  const task = await prisma.task.findFirst({ where: { id: taskId, userId: ctx.userId, deletedAt: null } });
  if (!task) throw new ToolInputError(`No task with id ${taskId}. Call get_tasks to find the right id.`);
  return task;
}

function resolveOrThrow(text: string, ctx: ToolContext) {
  const r = resolveDateText(text, ctx.zone, ctx.now);
  if (!r.ok) throw new ToolInputError(`${r.message} Ask the user which date they mean.`);
  return r;
}

/** Runs one tool call. Returns a JSON-serializable result; throws ToolInputError for bad input. */
export async function runTool(name: string, rawInput: unknown, ctx: ToolContext): Promise<unknown> {
  if (!(name in inputs)) throw new ToolInputError(`Unknown tool ${name}.`);
  const parsed = inputs[name as ToolName].safeParse(rawInput);
  if (!parsed.success) throw new ToolInputError(`Invalid input: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  const today = todayIn(ctx.zone, ctx.now);

  switch (name as ToolName) {
    case "get_today_schedule": {
      const [[day], tasks, slots] = await Promise.all([
        eventsBetween(ctx.userId, ctx.zone, today, 1),
        openTasks(ctx.userId),
        getAvailableTimeSlots(ctx.userId, today, ctx.zone, {}, ctx.now),
      ]);
      const visible = tasks.filter((t) => !t.externalSubmittedAt);
      return {
        today: day.date,
        events: day.events,
        due_today: visible.filter((t) => taskDueISO(t, ctx.zone) === today).map((t) => taskView(t, ctx.zone)),
        overdue: visible.filter((t) => (taskDueISO(t, ctx.zone) ?? "9999") < today).map((t) => taskView(t, ctx.zone)),
        free_time_left_today: slots.map((s) => `${formatSlot(s, ctx.zone)} (${s.minutes} min)`),
      };
    }
    case "get_upcoming_events": {
      const { days } = parsed.data as z.infer<typeof inputs.get_upcoming_events>;
      return { days: await eventsBetween(ctx.userId, ctx.zone, today, days) };
    }
    case "get_tasks": {
      const p = parsed.data as z.infer<typeof inputs.get_tasks>;
      const tasks = await prisma.task.findMany({
        where: {
          userId: ctx.userId,
          deletedAt: null,
          ...(p.status === "all" ? {} : { status: p.status }),
          ...(p.title_contains ? { title: { contains: p.title_contains, mode: "insensitive" as const } } : {}),
        },
        orderBy: [{ dueDate: "asc" }, { dueAt: "asc" }, { createdAt: "asc" }],
        take: 100,
      });
      const limit = p.due_within_days === null ? null : addDaysISO(today, p.due_within_days);
      const filtered = limit === null ? tasks : tasks.filter((t) => {
        const due = taskDueISO(t, ctx.zone);
        return due !== null && due <= limit;
      });
      return { count: filtered.length, tasks: filtered.slice(0, 40).map((t) => taskView(t, ctx.zone)) };
    }
    case "get_upcoming_assignments": {
      const { days } = parsed.data as z.infer<typeof inputs.get_upcoming_assignments>;
      const limit = addDaysISO(today, days);
      const tasks = await prisma.task.findMany({
        where: { userId: ctx.userId, deletedAt: null, externalProvider: "canvas" },
        orderBy: [{ dueAt: "asc" }],
      });
      const upcoming = tasks.filter((t) => {
        const due = taskDueISO(t, ctx.zone);
        return due !== null && due >= today && due < limit;
      });
      return { canvas_connected: tasks.length > 0, assignments: upcoming.map((t) => taskView(t, ctx.zone)) };
    }
    case "get_available_time_slots": {
      const { date_text } = parsed.data as z.infer<typeof inputs.get_available_time_slots>;
      const d = resolveOrThrow(date_text, ctx);
      const slots = await getAvailableTimeSlots(ctx.userId, d.date, ctx.zone, {}, ctx.now);
      return { date: `${d.date} (${dayName(d.date)})`, free: slots.map((s) => `${formatSlot(s, ctx.zone)} (${s.minutes} min)`) };
    }
    case "create_task": {
      const p = parsed.data as z.infer<typeof inputs.create_task>;
      const due = p.due_text ? resolveOrThrow(p.due_text, ctx) : null;
      const summary = `Add task "${p.title}"${due ? ` due ${dayName(due.date)}` : ""}${p.priority && p.priority !== "medium" ? ` (${p.priority} priority)` : ""}`;
      ctx.proposals.push({ type: "create", title: p.title, dueDate: due?.date ?? null, priority: p.priority ?? "medium", notes: p.notes, summary });
      return { proposed: summary, saved: false, note: "Not saved yet: the user must reply YES." };
    }
    case "update_task": {
      const p = parsed.data as z.infer<typeof inputs.update_task>;
      const task = await ownedTask(ctx, p.task_id);
      const changes: Extract<ProposedAction, { type: "update" }>["changes"] = {};
      const parts: string[] = [];
      if (p.due_text || p.remove_due_date) {
        if (task.externalProvider === "canvas") {
          throw new ToolInputError(`"${task.title}" is a Canvas assignment; its deadline belongs to Canvas and can't be changed here. You can change its priority or notes.`);
        }
        if (p.remove_due_date) {
          changes.dueDate = null;
          parts.push("remove its due date");
        } else {
          const d = resolveOrThrow(p.due_text!, ctx);
          changes.dueDate = d.date;
          parts.push(`move it to ${dayName(d.date)}`);
        }
      }
      if (p.title && p.title !== task.title) {
        if (task.externalProvider === "canvas") throw new ToolInputError("Canvas assignment titles belong to Canvas and can't be renamed.");
        changes.title = p.title;
        parts.push(`rename it to "${p.title}"`);
      }
      if (p.priority && p.priority !== task.priority) {
        changes.priority = p.priority;
        parts.push(`set priority to ${p.priority}`);
      }
      if (p.notes !== null) {
        changes.notes = p.notes;
        parts.push("update its notes");
      }
      if (!parts.length) throw new ToolInputError("No change requested.");
      const summary = `For "${task.title}": ${parts.join(", ")}`;
      ctx.proposals.push({ type: "update", taskId: task.id, changes, summary });
      return { proposed: summary, saved: false, note: "Not saved yet: the user must reply YES." };
    }
    case "complete_task": {
      const { task_id } = parsed.data as z.infer<typeof inputs.complete_task>;
      const task = await ownedTask(ctx, task_id);
      if (task.status === "done") return { already_done: true, title: task.title };
      const summary = `Mark "${task.title}" done`;
      ctx.proposals.push({ type: "complete", taskId: task.id, summary });
      return { proposed: summary, saved: false, note: "Not saved yet: the user must reply YES." };
    }
  }
}
