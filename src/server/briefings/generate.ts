import { DateTime } from "luxon";
import type { Event, Task } from "@prisma/client";
import { prisma } from "@/server/db";
import { addDaysISO, dateOnlyToISO, isoToDateOnly, localDayBounds, todayIn } from "@/server/time";
import { computeFreeSlots, type FreeSlot } from "@/server/scheduling/availability";

export type BriefingItem = {
  id: string;
  kind: "event" | "task";
  title: string;
  date: string;
  time: string | null;
  /** Tasks only: stable number for this briefing, so a reply can say "done with 2". */
  n?: number;
  priority?: string;
  /** Imported assignments: the course they belong to. */
  course?: string;
};

/** A suggested (not confirmed) pairing of an open task with a free block today. */
export type FocusSuggestion = { n?: number; taskId: string; title: string; due: string | null; slot: FreeSlot | null };

export type BriefingSnapshot = {
  generatedAt: string;
  timezone: string;
  today: string;
  days: { date: string; events: BriefingItem[]; tasksDue: BriefingItem[] }[];
  overdue: BriefingItem[];
  undated: BriefingItem[];
  /** Added in gate-ai-upgrade; absent on older stored snapshots. */
  freeSlots?: FreeSlot[];
  focus?: FocusSuggestion[];
};

const PRIORITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const MAX_FOCUS = 3;

/**
 * Pure, deterministic: the most urgent open tasks (overdue, then soonest due, then priority),
 * paired with today's largest free blocks. Labeled "suggested" wherever it is shown.
 */
export function suggestFocus(s: Pick<BriefingSnapshot, "overdue" | "days">, freeSlots: FreeSlot[]): FocusSuggestion[] {
  const candidates = [...s.overdue, ...s.days.flatMap((d) => d.tasksDue)]
    .map((t, order) => ({ t, order }))
    .sort((a, b) => {
      if (a.t.date !== b.t.date) return a.t.date < b.t.date ? -1 : 1;
      const pa = PRIORITY_RANK[a.t.priority ?? "medium"] ?? 2;
      const pb = PRIORITY_RANK[b.t.priority ?? "medium"] ?? 2;
      return pa - pb || a.order - b.order;
    })
    .slice(0, MAX_FOCUS)
    .map(({ t }) => t);
  // The biggest blocks go to the most urgent tasks; then they are shown in time order.
  const bySize = [...freeSlots].sort((a, b) => b.minutes - a.minutes);
  const picks = candidates.map((t, i) => ({ n: t.n, taskId: t.id, title: t.title, due: t.date || null, slot: bySize[i] ?? null }));
  return picks.sort((a, b) => (a.slot && b.slot ? a.slot.start.localeCompare(b.slot.start) : a.slot ? -1 : b.slot ? 1 : 0));
}

const PREVIEW_DAYS = 7;

/** Loads persisted events/tasks for [today, today+7). Never calls a live provider. */
export async function loadBriefingInputs(userId: string, zone: string, now: Date = new Date()) {
  const today = todayIn(zone, now);
  const last = addDaysISO(today, PREVIEW_DAYS);
  const { start } = localDayBounds(today, zone);
  const { start: end } = localDayBounds(last, zone);
  const [events, tasks] = await Promise.all([
    prisma.event.findMany({
      where: {
        userId,
        deletedAt: null,
        status: { not: "cancelled" },
        OR: [
          { allDay: false, startAt: { gte: start, lt: end } },
          { allDay: true, startDate: { lt: isoToDateOnly(last) }, endDate: { gt: isoToDateOnly(today) } },
        ],
      },
      orderBy: [{ startAt: "asc" }, { startDate: "asc" }],
    }),
    // Assignments already submitted in Canvas are hidden; the user's own status is untouched.
    prisma.task.findMany({ where: { userId, status: "open", deletedAt: null, externalSubmittedAt: null }, orderBy: { createdAt: "asc" } }),
  ]);
  return { events, tasks, today };
}

/** Pure: builds the snapshot from persisted rows. */
export function buildSnapshot(events: Event[], tasks: Task[], zone: string, today: string, now: Date = new Date()): BriefingSnapshot {
  const days = Array.from({ length: PREVIEW_DAYS }, (_, i) => addDaysISO(today, i)).map((date) => ({
    date,
    events: [] as BriefingItem[],
    tasksDue: [] as BriefingItem[],
  }));
  const byDate = new Map(days.map((d) => [d.date, d]));

  for (const e of events) {
    if (e.allDay && e.startDate) {
      const endISO = e.endDate ? dateOnlyToISO(e.endDate) : addDaysISO(dateOnlyToISO(e.startDate), 1);
      for (const d of days) {
        if (d.date >= dateOnlyToISO(e.startDate) && d.date < endISO) {
          d.events.push({ id: e.id, kind: "event", title: e.title, date: d.date, time: null });
        }
      }
    } else if (e.startAt) {
      const local = DateTime.fromJSDate(e.startAt, { zone });
      byDate.get(local.toISODate()!)?.events.push({
        id: e.id, kind: "event", title: e.title, date: local.toISODate()!, time: local.toFormat("h:mma").toLowerCase(),
      });
    }
  }

  const overdue: BriefingItem[] = [];
  const undated: BriefingItem[] = [];
  for (const t of tasks) {
    const due = t.dueDate ? dateOnlyToISO(t.dueDate) : t.dueAt ? DateTime.fromJSDate(t.dueAt, { zone }).toISODate()! : null;
    const time = t.dueAt ? DateTime.fromJSDate(t.dueAt, { zone }).toFormat("h:mma").toLowerCase() : null;
    const item: BriefingItem = { id: t.id, kind: "task", title: t.title, date: due ?? "", time, priority: t.priority };
    if (t.courseName) item.course = t.courseName;
    if (!due) undated.push(item);
    else if (due < today) overdue.push(item);
    else byDate.get(due)?.tasksDue.push(item);
  }

  // Number tasks in the order the email lists them: overdue, by day, then undated.
  let n = 0;
  for (const item of [...overdue, ...days.flatMap((d) => d.tasksDue), ...undated]) item.n = ++n;

  const freeSlots = computeFreeSlots(events, today, zone, {}, now);
  const focus = suggestFocus({ overdue, days }, freeSlots);
  return { generatedAt: now.toISOString(), timezone: zone, today, days, overdue, undated, freeSlots, focus };
}

function list(items: BriefingItem[], max = 3): string {
  const shown = items.slice(0, max).map((i) => (i.time ? `${i.time} ${i.title}` : i.title));
  if (items.length > max) shown.push(`+${items.length - max} more`);
  return shown.join("; ");
}

/** Concise SMS text (aims for <= 2-3 segments). Email/dashboard show the full snapshot. */
export function renderSms(s: BriefingSnapshot): string {
  const [today, tomorrow, ...rest] = s.days;
  const lines = [`${DateTime.fromISO(s.today).toFormat("ccc LLL d")} briefing`];
  lines.push(`TODAY: ${today.events.length ? list(today.events) : "no events"}`);
  if (today.tasksDue.length) lines.push(`DUE TODAY: ${list(today.tasksDue)}`);
  if (s.overdue.length) lines.push(`OVERDUE: ${list(s.overdue, 2)}`);
  if (tomorrow.events.length || tomorrow.tasksDue.length) {
    lines.push(`TOMORROW: ${list([...tomorrow.events, ...tomorrow.tasksDue.map((t) => ({ ...t, title: `${t.title} (due)` }))])}`);
  }
  const preview = rest
    .filter((d) => d.events.length || d.tasksDue.length)
    .map((d) => {
      const parts = [];
      if (d.events.length) parts.push(`${d.events.length} ev`);
      if (d.tasksDue.length) parts.push(`${d.tasksDue.length} due`);
      return `${DateTime.fromISO(d.date).toFormat("ccc")} ${parts.join("/")}`;
    });
  if (preview.length) lines.push(`NEXT DAYS: ${preview.join(", ")}`);
  lines.push("Reply ADD <task>, TODAY, HELP");
  return lines.join("\n");
}

export async function generateBriefing(userId: string, kind: "adhoc" | "morning" | "evening" | "sms_today" | "email_today", now: Date = new Date()) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const { events, tasks, today } = await loadBriefingInputs(userId, user.timezone, now);
  const snapshot = buildSnapshot(events, tasks, user.timezone, today, now);
  return prisma.briefing.create({
    data: {
      userId,
      kind,
      forDate: isoToDateOnly(today),
      timezone: user.timezone,
      content: renderSms(snapshot),
      snapshot,
    },
  });
}
