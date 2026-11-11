import type { ToolCallRecord } from "@/server/ai/agent";
import { WRITE_TOOLS } from "@/server/ai/tools";
import { resolveDateText } from "@/server/dates/resolve";

/**
 * Tool stub for replaying a logged reply: read tools return what they returned originally (so
 * today's data can't change the result); write tools re-check dates exactly like production and
 * report a proposal, without touching the database.
 */
export function makeReplay(recorded: ToolCallRecord[], zone: string, receivedAt: Date) {
  const used = new Set<number>();
  return (name: string, input: unknown): { output: unknown; isError: boolean } => {
    const key = JSON.stringify(input);
    let idx = recorded.findIndex((r, i) => !used.has(i) && r.name === name && JSON.stringify(r.input) === key);
    if (idx < 0 && !WRITE_TOOLS.has(name)) idx = recorded.findIndex((r, i) => !used.has(i) && r.name === name);
    if (idx >= 0) {
      used.add(idx);
      return { output: recorded[idx].output, isError: recorded[idx].isError };
    }
    if (!WRITE_TOOLS.has(name)) {
      return { output: { error: "No recorded result for this lookup in the original run. Answer from what you already have." }, isError: true };
    }
    const fields = (input ?? {}) as Record<string, unknown>;
    const dateText = typeof fields.due_text === "string" && fields.due_text ? fields.due_text : null;
    if (dateText) {
      const r = resolveDateText(dateText, zone, receivedAt);
      if (!r.ok) return { output: { error: `${r.message} Ask the user which date they mean.` }, isError: true };
    }
    return { output: { proposed: `${name} ${key}`, saved: false, note: "Not saved yet: the user must reply YES." }, isError: false };
  };
}
