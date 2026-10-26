import { DateTime } from "luxon";
import type { GoogleEvent } from "@/server/calendar/google-client";
import { isoToDateOnly } from "@/server/time";

export type NormalizedEvent = {
  externalId: string;
  title: string;
  description: string | null;
  location: string | null;
  allDay: boolean;
  startAt: Date | null;
  endAt: Date | null;
  startDate: Date | null;
  endDate: Date | null;
  sourceTimezone: string | null;
  status: string;
  htmlLink: string | null;
  externalUpdatedAt: Date | null;
};

const IGNORED_TYPES = new Set(["workingLocation"]);

/** Maps a Google event to our schema. Returns null for events we deliberately skip. */
export function normalizeGoogleEvent(e: GoogleEvent): NormalizedEvent | null {
  if (e.eventType && IGNORED_TYPES.has(e.eventType)) return null;
  const status = e.status ?? "confirmed";
  const base = {
    externalId: e.id,
    title: e.summary?.trim() || "(No title)",
    description: e.description ?? null,
    location: e.location ?? null,
    status,
    htmlLink: e.htmlLink ?? null,
    externalUpdatedAt: e.updated ? new Date(e.updated) : null,
  };
  const none = { startAt: null, endAt: null, startDate: null, endDate: null, sourceTimezone: null };

  if (e.start?.date) {
    return {
      ...base,
      ...none,
      allDay: true,
      startDate: isoToDateOnly(e.start.date),
      endDate: e.end?.date ? isoToDateOnly(e.end.date) : null,
    };
  }
  if (e.start?.dateTime) {
    const start = DateTime.fromISO(e.start.dateTime, { setZone: true });
    const end = e.end?.dateTime ? DateTime.fromISO(e.end.dateTime, { setZone: true }) : null;
    if (!start.isValid) return null;
    return {
      ...base,
      ...none,
      allDay: false,
      startAt: start.toJSDate(),
      endAt: end?.isValid ? end.toJSDate() : null,
      sourceTimezone: e.start.timeZone ?? null,
    };
  }
  // Cancelled instances of recurring events can arrive without start/end.
  if (status === "cancelled") return { ...base, ...none, allDay: false };
  return null;
}
