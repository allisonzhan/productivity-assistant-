import type Anthropic from "@anthropic-ai/sdk";
import type { CreateMessage } from "@/server/ai/agent";

type Step =
  | { tools: { name: string; input: Record<string, unknown> }[] }
  | { text: string }
  | { refusal: true }
  | ((params: Anthropic.Beta.MessageCreateParamsNonStreaming) => Step);

/** A scripted stand-in for the Messages API: each call returns the next step. Never touches the network. */
export function fakeModel(steps: Step[]) {
  const calls: Anthropic.Beta.MessageCreateParamsNonStreaming[] = [];
  let i = 0;
  const create: CreateMessage = async (params) => {
    calls.push(structuredClone(params));
    let step = steps[i++];
    if (!step) throw new Error(`fake model: no step ${i}`);
    while (typeof step === "function") step = step(params);
    const base = { id: `msg_${i}`, type: "message", role: "assistant", model: params.model, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 20 } };
    if ("refusal" in step) return { ...base, content: [], stop_reason: "refusal" } as unknown as Anthropic.Beta.BetaMessage;
    if ("text" in step) return { ...base, content: [{ type: "text", text: step.text }], stop_reason: "end_turn" } as unknown as Anthropic.Beta.BetaMessage;
    return {
      ...base,
      content: step.tools.map((t, k) => ({ type: "tool_use", id: `tu_${i}_${k}`, name: t.name, input: t.input })),
      stop_reason: "tool_use",
    } as unknown as Anthropic.Beta.BetaMessage;
  };
  return { create, calls };
}

/** The tool_result contents the model received on its last call, parsed. */
export function lastToolResults(params: Anthropic.Beta.MessageCreateParamsNonStreaming): { content: unknown; isError: boolean }[] {
  const last = params.messages.at(-1);
  if (!last || typeof last.content === "string") return [];
  return (last.content as Anthropic.Beta.BetaToolResultBlockParam[])
    .filter((b) => b.type === "tool_result")
    .map((b) => ({ content: JSON.parse(String(b.content)), isError: !!b.is_error }));
}

export const throwingModel: CreateMessage = async () => {
  throw new Error("fake model: should not have been called");
};
