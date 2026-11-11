import { DateTime } from "luxon";

/**
 * Pure scheduling rules. All local-time math goes through Luxon in the user's IANA zone, so
 * DST changes move the instant, never the local briefing time.
 */

// A briefing missed while the worker was off still goes out if it is at most this late.
export const CATCH_UP_HOURS = 4;

export type ScheduleKind = "morning" | "evening";

export type SchedulePrefs = {
  morningEnabled: boolean;
  morningTime: string; // "HH:MM" local
  eveningEnabled: boolean;
  eveningTime: string;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
};

export const DEFAULT_PREFS: SchedulePrefs = {
  morningEnabled: true,
  morningTime: "08:00",
  eveningEnabled: false,
  eveningTime: "19:00",
  quietHoursStart: null,
  quietHoursEnd: null,
};

export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export type DueBriefing = { kind: ScheduleKind; forDate: string; scheduledFor: Date };

function minutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

/** Quiet hours are [start, end) local time and may wrap midnight (e.g. 22:00–07:00). */
export function inQuietHours(local: DateTime, prefs: Pick<SchedulePrefs, "quietHoursStart" | "quietHoursEnd">): boolean {
  if (!prefs.quietHoursStart || !prefs.quietHoursEnd) return false;
  const start = minutes(prefs.quietHoursStart);
  const end = minutes(prefs.quietHoursEnd);
  if (start === end) return false;
  const m = local.hour * 60 + local.minute;
  return start < end ? m >= start && m < end : m >= start || m < end;
}

/** The instant of `time` on `local`'s date. A time skipped by DST resolves forward (Luxon). */
export function atLocalTime(local: DateTime, time: string): DateTime {
  const [hour, minute] = time.split(":").map(Number);
  return DateTime.fromObject({ year: local.year, month: local.month, day: local.day, hour, minute }, { zone: local.zone });
}

/**
 * Briefings that should go out now: past their local time today, within the catch-up window,
 * and not inside quiet hours (a send deferred by quiet hours goes out when they end, if still
 * within the window). Whether one was already sent is the caller's job (ScheduledBriefing).
 */
export function dueBriefings(zone: string, prefs: SchedulePrefs, now: Date): DueBriefing[] {
  const local = DateTime.fromJSDate(now, { zone });
  if (inQuietHours(local, prefs)) return [];
  const slots: [ScheduleKind, boolean, string][] = [
    ["morning", prefs.morningEnabled, prefs.morningTime],
    ["evening", prefs.eveningEnabled, prefs.eveningTime],
  ];
  const due: DueBriefing[] = [];
  for (const [kind, enabled, time] of slots) {
    if (!enabled) continue;
    const at = atLocalTime(local, time);
    if (local >= at && local < at.plus({ hours: CATCH_UP_HOURS })) {
      due.push({ kind, forDate: local.toISODate()!, scheduledFor: at.toJSDate() });
    }
  }
  return due;
}
