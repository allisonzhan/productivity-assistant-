import { DateTime } from "luxon";

/**
 * Deterministic resolution of short date phrases ("Sunday", "tomorrow", "11/14", "Nov 14",
 * "in 3 days", "2026-11-14") to a user-local ISO date. The LLM passes the user's words here;
 * it never does date arithmetic itself. Anything ambiguous returns a question instead of a guess.
 */

export const WEEKDAYS: Record<string, number> = {
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
  sun: 7, sunday: 7,
};

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
};

export type ResolvedDate = { ok: true; date: string; label: string } | { ok: false; message: string };

function ok(d: DateTime): ResolvedDate {
  return { ok: true, date: d.toISODate()!, label: d.toFormat("cccc LLL d, yyyy") };
}

/** A future-or-today date for month/day without a year: rolls into next year if already past. */
function monthDay(today: DateTime, month: number, day: number, zone: string, year?: number): ResolvedDate {
  let y = year ?? today.year;
  let d = DateTime.fromObject({ year: y, month, day }, { zone });
  if (!d.isValid) return { ok: false, message: `${month}/${day} is not a valid date.` };
  if (year === undefined && d < today) {
    y += 1;
    d = DateTime.fromObject({ year: y, month, day }, { zone });
  }
  return ok(d);
}

export function resolveDateText(raw: string, zone: string, now: Date = new Date()): ResolvedDate {
  const today = DateTime.fromJSDate(now, { zone }).startOf("day");
  const text = raw.trim().toLowerCase().replace(/[.!?,]+$/g, "").replace(/^(on|by|due|for|until)\s+/, "").replace(/\s+/g, " ");
  if (!text) return { ok: false, message: "No date given." };

  if (text === "today" || text === "tonight") return ok(today);
  if (["tomorrow", "tmrw", "tmr", "tomorrow night"].includes(text)) return ok(today.plus({ days: 1 }));

  const inDays = /^in (\d{1,3}) (day|days|week|weeks)$/.exec(text);
  if (inDays) return ok(today.plus(inDays[2].startsWith("week") ? { weeks: Number(inDays[1]) } : { days: Number(inDays[1]) }));

  const wk = /^(?:(this|next|coming|this coming)\s+)?([a-z]+)$/.exec(text);
  if (wk && WEEKDAYS[wk[2]] !== undefined) {
    if (wk[1] === "next") {
      return { ok: false, message: `"next ${wk[2]}" could mean two different days. Say the date (e.g. ${today.plus({ weeks: 1 }).toFormat("LLL d")}) or "this ${wk[2]}".` };
    }
    const target = WEEKDAYS[wk[2]];
    // The coming occurrence of that weekday; the same weekday means today.
    return ok(today.plus({ days: (target - today.weekday + 7) % 7 }));
  }

  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (iso) {
    const d = DateTime.fromISO(text, { zone });
    return d.isValid ? ok(d) : { ok: false, message: `${raw} is not a valid date.` };
  }

  const num = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/.exec(text);
  if (num) {
    const year = num[3] ? Number(num[3].length === 2 ? `20${num[3]}` : num[3]) : undefined;
    return monthDay(today, Number(num[1]), Number(num[2]), zone, year);
  }

  // "Nov 14", "November 14th", "14 Nov", optionally with a year; an optional leading weekday is ignored.
  const words = text.replace(/^(?:[a-z]+,?\s+)(?=[a-z]+\s+\d)/, (m) => (WEEKDAYS[m.replace(/[,\s]/g, "")] ? "" : m));
  const md = /^([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?$/.exec(words) ?? null;
  if (md && MONTHS[md[1]]) return monthDay(today, MONTHS[md[1]], Number(md[2]), zone, md[3] ? Number(md[3]) : undefined);
  const dm = /^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)(?:,?\s+(\d{4}))?$/.exec(words);
  if (dm && MONTHS[dm[2]]) return monthDay(today, MONTHS[dm[2]], Number(dm[1]), zone, dm[3] ? Number(dm[3]) : undefined);

  return { ok: false, message: `I couldn't read the date "${raw}". Use a weekday, "tomorrow", or a date like 11/14.` };
}
