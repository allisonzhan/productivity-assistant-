import { DateTime } from "luxon";

/**
 * Deterministic SMS command parser. Date arithmetic happens here (never in an LLM).
 * Anything ambiguous yields a `clarify` command instead of a guess.
 */
export type SmsCommand =
  | { type: "add"; title: string; dueDate: string | null; dateText: string | null }
  | { type: "today" }
  | { type: "tasks" }
  | { type: "help" }
  | { type: "stop" }
  | { type: "start" }
  | { type: "unsupported"; keyword: string }
  | { type: "clarify"; message: string }
  | { type: "unknown" };

const STOP_WORDS = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]);
const START_WORDS = new Set(["START", "UNSTOP", "YES"]);
const HELP_WORDS = new Set(["HELP", "INFO", "COMMANDS"]);
const LATER_WORDS = new Set(["WEEK", "MONTH", "DONE"]); // Gate 2

const WEEKDAYS: Record<string, number> = {
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
  sun: 7, sunday: 7,
};

const ADD_RE = /^(?:add(?:\s+task)?|task|todo)\b\s*[:\-–]?\s*([\s\S]*)$/i;
const CONNECTOR = String.raw`(?:\s+(?:due|by|on))?`;
const RELATIVE_RE = new RegExp(String.raw`${CONNECTOR}\s+(today|tonight|tomorrow|tmrw|tmr)[.!]?$`, "i");
const WEEKDAY_RE = new RegExp(String.raw`${CONNECTOR}\s+(?:(next|this)\s+)?(${Object.keys(WEEKDAYS).join("|")})[.!]?$`, "i");
const NUMERIC_RE = new RegExp(String.raw`${CONNECTOR}\s+(\d{1,2})/(\d{1,2})(?:/(\d{2}|\d{4}))?[.!]?$`, "i");

export function parseSmsCommand(rawBody: string, ctx: { zone: string; now?: Date }): SmsCommand {
  const body = rawBody.trim().replace(/\s+/g, " ");
  const keyword = body.toUpperCase().replace(/[.!]+$/, "");
  if (STOP_WORDS.has(keyword)) return { type: "stop" };
  if (START_WORDS.has(keyword)) return { type: "start" };
  if (HELP_WORDS.has(keyword)) return { type: "help" };
  if (keyword === "TODAY") return { type: "today" };
  if (keyword === "TASKS") return { type: "tasks" };
  const first = keyword.split(" ")[0];
  if (LATER_WORDS.has(first)) return { type: "unsupported", keyword: first };

  const add = ADD_RE.exec(body);
  if (add) return parseAdd(add[1], ctx);
  return { type: "unknown" };
}

function parseAdd(rest: string, ctx: { zone: string; now?: Date }): SmsCommand {
  const today = DateTime.fromJSDate(ctx.now ?? new Date(), { zone: ctx.zone }).startOf("day");
  let text = ` ${rest.trim()}`;
  let dueDate: string | null = null;
  let dateText: string | null = null;

  const rel = RELATIVE_RE.exec(text);
  const wk = rel ? null : WEEKDAY_RE.exec(text);
  const num = rel || wk ? null : NUMERIC_RE.exec(text);

  if (rel) {
    const word = rel[1].toLowerCase();
    dueDate = (word === "today" || word === "tonight" ? today : today.plus({ days: 1 })).toISODate();
    dateText = rel[1];
    text = text.slice(0, rel.index);
  } else if (wk) {
    if (wk[1]?.toLowerCase() === "next") {
      return clarify(`"next ${wk[2]}" could mean two different days. Resend with a date, e.g. "Add task: ${titleCase(text.slice(0, wk.index))} ${today.plus({ weeks: 1 }).toFormat("M/d")}".`);
    }
    const target = WEEKDAYS[wk[2].toLowerCase()];
    // The coming occurrence of that weekday; the same weekday means today.
    dueDate = today.plus({ days: (target - today.weekday + 7) % 7 }).toISODate();
    dateText = wk[2];
    text = text.slice(0, wk.index);
  } else if (num) {
    const month = Number(num[1]);
    const day = Number(num[2]);
    let year = num[3] ? Number(num[3].length === 2 ? `20${num[3]}` : num[3]) : today.year;
    let candidate = DateTime.fromObject({ year, month, day }, { zone: ctx.zone });
    if (!candidate.isValid) return clarify(`I couldn't read the date "${num[1]}/${num[2]}". Use month/day, e.g. 10/30.`);
    if (!num[3] && candidate < today) {
      year += 1;
      candidate = DateTime.fromObject({ year, month, day }, { zone: ctx.zone });
    }
    dueDate = candidate.toISODate();
    dateText = num[0].trim();
    text = text.slice(0, num.index);
  }

  const title = titleCase(text);
  if (!title) return clarify('What should the task be? Example: "Add task: finish reading Friday".');
  if (title.length > 200) return clarify("That task title is too long (max 200 characters).");
  return { type: "add", title, dueDate, dateText };
}

function titleCase(text: string): string {
  const t = text.trim().replace(/[\s,;:\-–]+$/, "");
  return t ? t[0].toUpperCase() + t.slice(1) : "";
}

function clarify(message: string): SmsCommand {
  return { type: "clarify", message };
}

export const HELP_TEXT =
  "Commands: ADD <task> [today|tomorrow|Fri|10/30], TODAY, TASKS, HELP, STOP. Example: Add task: finish reading Friday";
