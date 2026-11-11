import { DateTime } from "luxon";
import type { Event } from "@prisma/client";
import { prisma } from "@/server/db";
import { localDayBounds } from "@/server/time";

/**
 * Deterministic free-time computation from persisted, timed calendar events. All-day events
 * (holidays, "midterm week") do not block time. Never calls a live provider.
 */

export type FreeSlot = { start: string; end: string; minutes: number }; // ISO instants

export type AvailabilityOptions = {
  dayStart?: string; // "HH:MM" local
  dayEnd?: string;
  minMinutes?: number;
};

const DEFAULTS = { dayStart: "08:00", dayEnd: "22:00", minMinutes: 30 };

function atLocal(dateISO: string, hhmm: string, zone: string): DateTime {
  const [hour, minute] = hhmm.split(":").map(Number);
  return DateTime.fromISO(dateISO, { zone }).set({ hour, minute, second: 0, millisecond: 0 });
}

/** Pure: free blocks inside [dayStart, dayEnd) on local date `dateISO`, never before `now`. */
export function computeFreeSlots(
  events: Pick<Event, "allDay" | "startAt" | "endAt" | "status" | "deletedAt">[],
  dateISO: string,
  zone: string,
  opts: AvailabilityOptions = {},
  now?: Date,
): FreeSlot[] {
  const o = { ...DEFAULTS, ...opts };
  let windowStart = atLocal(dateISO, o.dayStart, zone);
  const windowEnd = atLocal(dateISO, o.dayEnd, zone);
  if (now) {
    // Round "now" up to the next 15 minutes so slots start on a readable time.
    const n = DateTime.fromJSDate(now, { zone });
    const rounded = n.startOf("minute").plus({ minutes: (15 - (n.minute % 15)) % 15 });
    if (rounded > windowStart) windowStart = rounded;
  }
  if (windowEnd <= windowStart) return [];

  const busy = events
    .filter((e) => !e.allDay && e.startAt && e.endAt && e.status !== "cancelled" && !e.deletedAt)
    .map((e) => ({ start: DateTime.fromJSDate(e.startAt!, { zone }), end: DateTime.fromJSDate(e.endAt!, { zone }) }))
    .filter((b) => b.end > windowStart && b.start < windowEnd)
    .sort((a, b) => a.start.toMillis() - b.start.toMillis());

  const slots: FreeSlot[] = [];
  let cursor = windowStart;
  const push = (start: DateTime, end: DateTime) => {
    const minutes = Math.floor(end.diff(start, "minutes").minutes);
    if (minutes >= o.minMinutes) slots.push({ start: start.toUTC().toISO()!, end: end.toUTC().toISO()!, minutes });
  };
  for (const b of busy) {
    if (b.start > cursor) push(cursor, b.start < windowEnd ? b.start : windowEnd);
    if (b.end > cursor) cursor = b.end;
    if (cursor >= windowEnd) break;
  }
  if (cursor < windowEnd) push(cursor, windowEnd);
  return slots;
}

/** Free blocks on a user-local date, from stored events. Scoped by the verified userId. */
export async function getAvailableTimeSlots(userId: string, dateISO: string, zone: string, opts: AvailabilityOptions = {}, now?: Date) {
  const { start, end } = localDayBounds(dateISO, zone);
  const events = await prisma.event.findMany({
    where: { userId, deletedAt: null, status: { not: "cancelled" }, allDay: false, startAt: { lt: end }, endAt: { gt: start } },
  });
  return computeFreeSlots(events, dateISO, zone, opts, now);
}

/** "2:00–3:30pm" style label in the user's zone. */
export function formatSlot(slot: Pick<FreeSlot, "start" | "end">, zone: string): string {
  const s = DateTime.fromISO(slot.start, { zone });
  const e = DateTime.fromISO(slot.end, { zone });
  const fmt = (d: DateTime) => (d.minute ? d.toFormat("h:mm") : d.toFormat("h"));
  const samePeriod = s.toFormat("a") === e.toFormat("a");
  return `${fmt(s)}${samePeriod ? "" : s.toFormat("a").toLowerCase()}–${fmt(e)}${e.toFormat("a").toLowerCase()}`;
}
