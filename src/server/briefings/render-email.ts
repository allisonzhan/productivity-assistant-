import { DateTime } from "luxon";
import type { BriefingItem, BriefingSnapshot } from "@/server/briefings/generate";
import { formatSlot } from "@/server/scheduling/availability";

/**
 * Email rendering of a stored briefing snapshot: a plain-text part (what replies quote) and
 * an HTML part. Every title comes from calendars/tasks and is escaped: it is untrusted text.
 */

const COMMAND_HINTS = ["Add task: finish reading Friday", "TODAY · TASKS · HELP · STOP"];
const AGENT_HINTS = ["what's due this week?", "push 2 to Sunday", "done with the lab", "Add task: finish reading Friday"];

export type RenderOptions = { agent?: boolean; reviewUrl?: string };

function hints(opts: RenderOptions) {
  return opts.agent ? AGENT_HINTS : COMMAND_HINTS;
}

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function dayLabel(dateISO: string, today: string): string {
  const d = DateTime.fromISO(dateISO);
  if (dateISO === today) return `Today, ${d.toFormat("ccc LLL d")}`;
  if (dateISO === DateTime.fromISO(today).plus({ days: 1 }).toISODate()) return `Tomorrow, ${d.toFormat("ccc LLL d")}`;
  return d.toFormat("cccc LLL d");
}

function shortDate(dateISO: string): string {
  return DateTime.fromISO(dateISO).toFormat("ccc LLL d");
}

function eventLine(e: BriefingItem): string {
  return e.time ? `${e.time}  ${e.title}` : `All day  ${e.title}`;
}

function taskLine(t: BriefingItem, opts: { showDate?: boolean } = {}): string {
  const num = t.n ? `${t.n}. ` : "";
  const when = [opts.showDate && t.date ? shortDate(t.date) : null, t.time].filter(Boolean).join(" ");
  const flag = t.priority === "high" || t.priority === "critical" ? " (!)" : "";
  const course = t.course ? ` [${t.course}]` : "";
  return `${num}${t.title}${course}${when ? ` — ${when}` : ""}${flag}`;
}

type Section = { title: string; lines: string[]; muted?: string };

function sections(s: BriefingSnapshot): Section[] {
  const zone = s.timezone;
  const [today, ...rest] = s.days;
  const out: Section[] = [];

  out.push({
    title: `Today's schedule`,
    lines: today.events.map(eventLine),
    muted: today.events.length ? undefined : "No events on your calendar today.",
  });

  const dueNow = [...s.overdue.map((t) => taskLine(t, { showDate: true }) + "  [overdue]"), ...today.tasksDue.map((t) => taskLine(t))];
  out.push({ title: "Due today", lines: dueNow, muted: dueNow.length ? undefined : "Nothing due today." });

  if (s.freeSlots) {
    const free = s.freeSlots.map((slot) => `${formatSlot(slot, zone)} (${slot.minutes >= 60 ? `${Math.floor(slot.minutes / 60)}h${slot.minutes % 60 ? ` ${slot.minutes % 60}m` : ""}` : `${slot.minutes}m`})`);
    out.push({ title: "Free time today", lines: free, muted: free.length ? undefined : "No free blocks of 30+ minutes left today." });
  }
  if (s.focus?.length) {
    out.push({
      title: "Suggested focus",
      lines: s.focus.map((f) => `${f.slot ? `${formatSlot(f.slot, zone)}: ` : ""}${f.n ? `${f.n}. ` : ""}${f.title}${f.due ? ` (due ${shortDate(f.due)})` : ""}`),
      muted: "Suggestions only, based on due dates and your free time.",
    });
  }

  const week = rest
    .filter((d) => d.tasksDue.length || d.events.length)
    .flatMap((d) => [
      `${dayLabel(d.date, s.today)}`,
      ...d.tasksDue.map((t) => `  due: ${taskLine(t)}`),
      ...d.events.map((e) => `  ${eventLine(e)}`),
    ]);
  out.push({ title: "Next 7 days", lines: week, muted: week.length ? undefined : "Nothing scheduled or due in the next week." });

  if (s.undated.length) out.push({ title: "No due date", lines: s.undated.slice(0, 5).map((t) => taskLine(t)), muted: s.undated.length > 5 ? `+${s.undated.length - 5} more` : undefined });
  return out;
}

export function renderEmailText(s: BriefingSnapshot, opts: RenderOptions = {}): string {
  const parts = [`${DateTime.fromISO(s.today).toFormat("cccc, LLLL d")} — your briefing`];
  for (const sec of sections(s)) {
    parts.push("", sec.title.toUpperCase(), ...sec.lines.map((l) => (l.startsWith("  ") ? l : `- ${l}`)));
    if (sec.muted) parts.push(sec.lines.length ? `(${sec.muted})` : sec.muted);
  }
  parts.push("", "--", opts.agent ? "Reply to this email, e.g.:" : "Reply to this email (first line), e.g.:", ...hints(opts).map((h) => `  ${h}`), "Built from your stored calendar and tasks.");
  if (opts.agent && opts.reviewUrl) parts.push(`Did a reply go wrong? Mark it: ${opts.reviewUrl}`);
  return parts.join("\n");
}

const STYLE = {
  body: "font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1f2328;max-width:600px;margin:0 auto;padding:16px;",
  h1: "font-size:20px;margin:0 0 12px;",
  h2: "font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:#57606a;margin:20px 0 6px;border-bottom:1px solid #d0d7de;padding-bottom:4px;",
  ul: "margin:0;padding-left:18px;",
  sub: "list-style:none;margin:6px 0 0 -18px;font-weight:600;",
  muted: "color:#6e7781;font-size:13px;margin:4px 0 0;",
  footer: "color:#6e7781;font-size:13px;margin-top:24px;border-top:1px solid #d0d7de;padding-top:8px;",
};

export function renderEmailHtml(s: BriefingSnapshot, opts: RenderOptions = {}): string {
  const body = sections(s)
    .map((sec) => {
      const items = sec.lines
        .map((l) => (l.startsWith("  ") ? `<li>${escapeHtml(l.trim())}</li>` : `<li style="${STYLE.sub}">${escapeHtml(l)}</li>`))
        .join("");
      // Day headings inside "Next 7 days" are the unindented lines; elsewhere every line is an item.
      const list = sec.title === "Next 7 days" ? items : sec.lines.map((l) => `<li>${escapeHtml(l)}</li>`).join("");
      return `<h2 style="${STYLE.h2}">${escapeHtml(sec.title)}</h2>${sec.lines.length ? `<ul style="${STYLE.ul}">${list}</ul>` : ""}${sec.muted ? `<p style="${STYLE.muted}">${escapeHtml(sec.muted)}</p>` : ""}`;
    })
    .join("");
  const hintHtml = hints(opts).map((h) => `<code>${escapeHtml(h)}</code>`).join("<br>");
  const lead = opts.agent ? "Reply to this email, e.g.:" : "Reply to this email (first line), e.g.:";
  const review = opts.agent && opts.reviewUrl ? `<br>Did a reply go wrong? <a href="${escapeHtml(opts.reviewUrl)}">Mark it</a>.` : "";
  return `<!doctype html><html><body style="margin:0;background:#ffffff;"><div style="${STYLE.body}"><h1 style="${STYLE.h1}">${escapeHtml(DateTime.fromISO(s.today).toFormat("cccc, LLLL d"))}</h1>${body}<p style="${STYLE.footer}">${lead}<br>${hintHtml}<br>Built from your stored calendar and tasks.${review}</p></div></body></html>`;
}
