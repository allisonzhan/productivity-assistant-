/**
 * npm run eval — replays every reply you marked right/wrong on /replies through the current
 * agent (same system prompt, tools and model as production; the original "now" and timezone;
 * read tools answer with what they returned originally, so today's data can't change the result)
 * and grades what it would DO, deterministically. Nothing is written to your tasks.
 *
 *   npm run eval                 plan + estimated cost, no API calls
 *   npm run eval -- --oracle     grader self-check: grade the recorded runs themselves (free)
 *   npm run eval -- --yes        run it (paid API calls)
 *   options: --variant v1  --reps 2  --model claude-sonnet-5-5  --timeout-s 90  --limit 20
 *
 * Output: .claude/hillclimb/email-replies/<variant>/{results.jsonl,traces/,errors.jsonl}
 * (the claude-api eval layout, so its report builder and /claude-api hillclimb can read it).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "@/server/db";
import { env } from "@/server/env";
import { anthropicCreate, runAgent, type ToolCallRecord } from "@/server/ai/agent";
import { SYSTEM_PROMPT, buildUserTurn, type UserTurnInput } from "@/server/ai/prompt";
import { makeReplay } from "@/server/ai/eval-replay";
import { expectedFromRun, expectedSchema, gradeRun, intentTag, normalizeActions, wilson, type Expected } from "@/server/ai/eval-grading";

const PRICES: Record<string, { in: number; out: number }> = {
  "claude-opus-5-5": { in: 4, out: 20 },
  "claude-sonnet-5-5": { in: 2, out: 10 },
  "claude-haiku-5-5": { in: 0.1, out: 0.5 },
};

function arg(name: string, fallback?: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

type Case = {
  id: string;
  input: string;
  zone: string;
  receivedAt: Date;
  userId: string;
  turn: UserTurnInput;
  recorded: ToolCallRecord[];
  recordedReply: string | null;
  expected: Expected;
  verdict: string;
  tokens: { in: number; out: number };
};

const replayFor = (c: Case) => makeReplay(c.recorded, c.zone, c.receivedAt);

async function loadCases(limit: number): Promise<{ cases: Case[]; ungraded: { id: string; input: string }[] }> {
  const runs = await prisma.agentRun.findMany({ where: { kind: "agent", verdict: { not: null } }, orderBy: { receivedAt: "asc" }, take: limit });
  const cases: Case[] = [];
  const ungraded: { id: string; input: string }[] = [];
  for (const r of runs) {
    const recorded = (r.toolCalls as ToolCallRecord[] | null) ?? [];
    let expected: Expected;
    if (r.verdict === "right") {
      expected = expectedFromRun(recorded, r.reply, r.zone, r.receivedAt);
    } else {
      const parsed = expectedSchema.safeParse(r.expected);
      if (!parsed.success) {
        ungraded.push({ id: r.id, input: r.input });
        continue;
      }
      expected = parsed.data;
    }
    const ctx = (r.context ?? {}) as { nowLabel?: string; briefingTasks?: UserTurnInput["briefingTasks"] };
    cases.push({
      id: r.id,
      input: r.input,
      zone: r.zone,
      receivedAt: r.receivedAt,
      userId: r.userId,
      turn: { nowLabel: ctx.nowLabel ?? r.receivedAt.toISOString(), zone: r.zone, briefingTasks: ctx.briefingTasks ?? [], message: r.input },
      recorded,
      recordedReply: r.reply,
      expected,
      verdict: r.verdict!,
      tokens: { in: r.inputTokens ?? 0, out: r.outputTokens ?? 0 },
    });
  }
  return { cases, ungraded };
}

function trace(c: Case, calls: ToolCallRecord[], reply: string | null) {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: buildUserTurn(c.turn) },
    ...calls.flatMap((t) => [
      { role: "tool_call", name: t.name, content: JSON.stringify(t.input, null, 2) },
      { role: "tool_result", content: JSON.stringify(t.output) },
    ]),
    { role: "assistant", content: reply ?? "(no reply)" },
  ];
}

function report(rows: { tag: string; pass: boolean; id: string; input: string; reason: string }[]) {
  const n = rows.length;
  const pass = rows.filter((r) => r.pass).length;
  const [lo, hi] = wilson(pass, n);
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  console.log(`\nCorrect: ${pass}/${n} = ${n ? pct(pass / n) : "n/a"}  (95% CI ${pct(lo)}–${pct(hi)})`);
  const tags = [...new Set(rows.map((r) => r.tag))].sort();
  for (const t of tags) {
    const g = rows.filter((r) => r.tag === t);
    console.log(`  ${t.padEnd(11)} ${g.filter((r) => r.pass).length}/${g.length}`);
  }
  const fails = rows.filter((r) => !r.pass);
  if (fails.length) {
    console.log("\nFailures:");
    for (const f of fails) console.log(`  [${f.tag}] "${f.input.slice(0, 70)}" — ${f.reason}  (run ${f.id})`);
  }
}

async function main() {
  const variant = arg("variant", "baseline")!;
  if (variant !== "baseline" && !/^v\d+$/.test(variant)) throw new Error('--variant must be "baseline" or v<N>.');
  const reps = Math.max(1, Number(arg("reps", "1")));
  const model = arg("model", env().ANTHROPIC_MODEL)!;
  const timeoutMs = Number(arg("timeout-s", "90")) * 1000;
  const { cases, ungraded } = await loadCases(Number(arg("limit", "500")));

  console.log(`Marked replies: ${cases.length} gradable${ungraded.length ? `, ${ungraded.length} marked wrong without a "should have" (skipped)` : ""}.`);
  if (!cases.length) {
    console.log('Mark some replies right/wrong on /replies first (for wrong ones, say what it should have done).');
    return;
  }

  if (flag("oracle")) {
    // Grader self-check: replies marked right must pass on their own recorded actions; wrong ones should fail.
    const rows = cases.map((c) => {
      const g = gradeRun(c.expected, normalizeActions(c.recorded, c.zone, c.receivedAt), c.recordedReply);
      return { tag: `${c.verdict}:${intentTag(c.expected)}`, pass: g.pass, id: c.id, input: c.input, reason: g.reason };
    });
    console.log("Oracle check (no API calls). Expect 100% for right:* and 0% for wrong:*.");
    report(rows);
    return;
  }

  const price = PRICES[model];
  const avgIn = cases.reduce((s, c) => s + c.tokens.in, 0) / cases.length;
  const avgOut = cases.reduce((s, c) => s + c.tokens.out, 0) / cases.length;
  const est = price ? ((avgIn * price.in + avgOut * price.out) / 1e6) * cases.length * reps : null;
  console.log(
    `Plan: ${cases.length} cases × ${reps} rep(s) on ${model}. Original runs averaged ~${Math.round(avgIn)} input / ~${Math.round(avgOut)} output tokens` +
      (est !== null ? `, so roughly $${est.toFixed(2)} in total.` : "."),
  );
  if (!flag("yes")) {
    console.log("Add --yes to run it (this calls the paid Anthropic API).");
    return;
  }
  if (!env().ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set in .env.");

  const dir = join(".claude", "hillclimb", "email-replies", variant);
  mkdirSync(join(dir, "traces"), { recursive: true });
  const stateFile = join(".claude", "hillclimb", "email-replies", "_state.json");
  if (!existsSync(stateFile)) {
    writeFileSync(stateFile, JSON.stringify({ metrics: [{ id: "correct", label: "Correct", kind: "binary" }], perf_fields: ["latency_s", "tool_calls", "usage"] }, null, 2));
  }
  const resultsFile = join(dir, "results.jsonl");
  const done = new Set(
    existsSync(resultsFile)
      ? readFileSync(resultsFile, "utf8").split("\n").filter(Boolean).map((l) => {
          const r = JSON.parse(l) as { prompt_id: string; rep: number };
          return `${r.prompt_id}#${r.rep}`;
        })
      : [],
  );

  const jobs = cases.flatMap((c) => Array.from({ length: reps }, (_, rep) => ({ c, rep }))).filter(({ c, rep }) => !done.has(`${c.id}#${rep}`));
  let spentIn = 0;
  let spentOut = 0;
  const CONCURRENCY = 3;
  const queue = [...jobs];
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (let job = queue.shift(); job; job = queue.shift()) {
        const { c, rep } = job;
        const started = Date.now();
        try {
          const result = await Promise.race([
            runAgent({ userId: c.userId, zone: c.zone, now: c.receivedAt, turn: c.turn, create: anthropicCreate, model, replayTool: replayFor(c) }),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timeout after ${timeoutMs / 1000}s`)), timeoutMs)),
          ]);
          spentIn += result.inputTokens;
          spentOut += result.outputTokens;
          if (result.error) throw Object.assign(new Error(result.error), { usage: result });
          const actual = normalizeActions(result.toolCalls, c.zone, c.receivedAt);
          const g = gradeRun(c.expected, actual, result.reply);
          appendFileSync(
            resultsFile,
            `${JSON.stringify({
              prompt_id: c.id,
              rep,
              prompt: c.input,
              tags: [g.intent, c.verdict === "right" ? "was-right" : "was-wrong"],
              status: "ok",
              grade: { correct: g.pass ? 1 : 0 },
              explanation: { correct: g.reason },
              model: result.model,
              usage: { input_tokens: result.inputTokens, output_tokens: result.outputTokens },
              latency_s: (Date.now() - started) / 1000,
              tool_calls: result.toolCalls.length,
              meta: { expected: c.expected, actual },
            })}\n`,
          );
          writeFileSync(join(dir, "traces", `${c.id}_rep${rep}.json`), JSON.stringify(trace(c, result.toolCalls, result.reply), null, 2));
          process.stdout.write(g.pass ? "." : "F");
        } catch (err) {
          appendFileSync(join(dir, "errors.jsonl"), `${JSON.stringify({ prompt_id: c.id, rep, error: (err as Error).message, at: new Date().toISOString() })}\n`);
          process.stdout.write("E");
        }
      }
    }),
  );

  const rows = readFileSync(resultsFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { prompt_id: string; prompt: string; tags: string[]; grade: { correct: number }; explanation: { correct: string } })
    .filter((r) => cases.some((c) => c.id === r.prompt_id))
    .map((r) => ({ tag: r.tags[0], pass: r.grade.correct === 1, id: r.prompt_id, input: r.prompt, reason: r.explanation.correct }));
  report(rows);
  const errors = existsSync(join(dir, "errors.jsonl")) ? readFileSync(join(dir, "errors.jsonl"), "utf8").split("\n").filter(Boolean).length : 0;
  if (errors) console.log(`\n${errors} attempt(s) failed to run (see ${join(dir, "errors.jsonl")}); they are not counted above.`);
  if (price) console.log(`This run: ${spentIn} input / ${spentOut} output tokens ≈ $${((spentIn * price.in + spentOut * price.out) / 1e6).toFixed(3)}.`);
  console.log(`Results: ${resultsFile}`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
