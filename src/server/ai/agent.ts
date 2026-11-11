import Anthropic from "@anthropic-ai/sdk";
import { env } from "@/server/env";
import { audit } from "@/server/audit/log";
import { SYSTEM_PROMPT, buildUserTurn, type UserTurnInput } from "@/server/ai/prompt";
import { TOOL_DEFINITIONS, ToolInputError, runTool, type ProposedAction, type ToolContext } from "@/server/ai/tools";
import { errorMessage } from "@/server/jobs/run";

/**
 * Manual tool-use loop over the app's tools (Anthropic Messages API). The loop is ours so every
 * tool call is audited and recorded for replay. Write tools only collect proposals.
 */

export const MAX_ITERATIONS = 6;
const MAX_TOKENS = 4000;
const TIMEOUT_MS = 30_000;

export type CreateMessage = (params: Anthropic.Beta.MessageCreateParamsNonStreaming) => Promise<Anthropic.Beta.BetaMessage>;

export type ToolCallRecord = { name: string; input: unknown; output: unknown; isError: boolean };

export type AgentResult = {
  reply: string | null;
  proposals: ProposedAction[];
  toolCalls: ToolCallRecord[];
  model: string;
  inputTokens: number;
  outputTokens: number;
  error: string | null;
};

export function agentConfigured(): boolean {
  const e = env();
  return e.AGENT_ENABLED === "true" && !!e.ANTHROPIC_API_KEY;
}

let client: Anthropic | undefined;

/** The real model call. Server-side refusal fallback is on (fallbacks: "default"). */
export const anthropicCreate: CreateMessage = (params) => {
  client ??= new Anthropic({ apiKey: env().ANTHROPIC_API_KEY, timeout: TIMEOUT_MS, maxRetries: 1 });
  return client.beta.messages.create(params);
};

export type RunAgentOptions = {
  userId: string;
  zone: string;
  now: Date;
  turn: UserTurnInput;
  create?: CreateMessage;
  model?: string;
  /** Replays recorded tool outputs instead of reading the DB (eval); never writes the audit log. */
  replayTool?: (name: string, input: unknown) => { output: unknown; isError: boolean } | null;
};

export async function runAgent(opts: RunAgentOptions): Promise<AgentResult> {
  const model = opts.model ?? env().ANTHROPIC_MODEL;
  const create = opts.create ?? anthropicCreate;
  const ctx: ToolContext = { userId: opts.userId, zone: opts.zone, now: opts.now, proposals: [] };
  const result: AgentResult = { reply: null, proposals: ctx.proposals, toolCalls: [], model, inputTokens: 0, outputTokens: 0, error: null };
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: buildUserTurn(opts.turn) }];

  try {
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const response = await create({
        model,
        max_tokens: MAX_TOKENS,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "low" },
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        tools: TOOL_DEFINITIONS,
        tool_choice: { type: "auto" },
        messages,
      });
      result.inputTokens += (response.usage.input_tokens ?? 0) + (response.usage.cache_read_input_tokens ?? 0) + (response.usage.cache_creation_input_tokens ?? 0);
      result.outputTokens += response.usage.output_tokens ?? 0;

      if (response.stop_reason === "refusal") throw new Error("The model declined this request.");
      if (response.stop_reason === "max_tokens") throw new Error("The model ran out of output tokens.");
      // Keep the full content (including thinking blocks) for the next turn.
      messages.push({ role: "assistant", content: response.content });
      if (response.stop_reason === "pause_turn") continue;

      const toolUses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      if (response.stop_reason !== "tool_use" || !toolUses.length) {
        const text = response.content
          .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim();
        result.reply = text || null;
        if (!result.reply) throw new Error("The model returned no text.");
        return result;
      }

      // All results go back in one user message (keeps parallel tool use working).
      const toolResults: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const use of toolUses) {
        const record = await callTool(use, ctx, opts);
        result.toolCalls.push(record);
        toolResults.push({ type: "tool_result", tool_use_id: use.id, content: JSON.stringify(record.output), is_error: record.isError || undefined });
      }
      messages.push({ role: "user", content: toolResults });
    }
    throw new Error(`No answer after ${MAX_ITERATIONS} model calls.`);
  } catch (err) {
    result.error = errorMessage(err);
    result.reply = null;
    return result;
  }
}

async function callTool(use: Anthropic.Beta.BetaToolUseBlock, ctx: ToolContext, opts: RunAgentOptions): Promise<ToolCallRecord> {
  if (opts.replayTool) {
    // Eval: read tools return what they returned originally; write tools still run (they only propose).
    const recorded = opts.replayTool(use.name, use.input);
    if (recorded) return { name: use.name, input: use.input, ...recorded };
  }
  let record: ToolCallRecord;
  try {
    record = { name: use.name, input: use.input, output: await runTool(use.name, use.input, ctx), isError: false };
  } catch (err) {
    if (!(err instanceof ToolInputError)) throw err;
    record = { name: use.name, input: use.input, output: { error: err.message }, isError: true };
  }
  if (!opts.replayTool) {
    await audit({
      userId: ctx.userId,
      actor: "agent",
      action: `agent.tool.${use.name}`,
      metadata: { input: use.input as object, isError: record.isError, output: summarize(record.output) },
    });
  }
  return record;
}

function summarize(output: unknown): string {
  const s = JSON.stringify(output);
  return s.length > 500 ? `${s.slice(0, 500)}…` : s;
}
