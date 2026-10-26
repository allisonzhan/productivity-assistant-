import { DateTime } from "luxon";

/**
 * Date-only values are stored in Postgres `date` columns, which Prisma maps to a JS Date at
 * UTC midnight. These helpers convert without ever applying a local offset.
 */
export function dateOnlyToISO(d: Date): string {
  return DateTime.fromJSDate(d, { zone: "utc" }).toISODate()!;
}

export function isoToDateOnly(iso: string): Date {
  const dt = DateTime.fromISO(iso, { zone: "utc" });
  if (!dt.isValid) throw new Error(`Invalid ISO date: ${iso}`);
  return dt.startOf("day").toJSDate();
}

/** Today's calendar date (YYYY-MM-DD) in the given IANA zone. */
export function todayIn(zone: string, now: Date = new Date()): string {
  return DateTime.fromJSDate(now, { zone }).toISODate()!;
}

export function isValidZone(zone: string): boolean {
  return DateTime.local().setZone(zone).isValid;
}

/** UTC instants bounding the local calendar day `isoDate` in `zone` ([start, end)). */
export function localDayBounds(isoDate: string, zone: string): { start: Date; end: Date } {
  const start = DateTime.fromISO(isoDate, { zone }).startOf("day");
  return { start: start.toJSDate(), end: start.plus({ days: 1 }).toJSDate() };
}

export function addDaysISO(isoDate: string, days: number): string {
  return DateTime.fromISO(isoDate, { zone: "utc" }).plus({ days }).toISODate()!;
}
