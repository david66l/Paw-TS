import type { ModelTokenUsage } from "@paw/core";

/**
 * One `data: …` payload from an OpenAI-style chat completions SSE stream.
 * @see https://platform.openai.com/docs/api-reference/chat/streaming
 */
export function parseOpenAiChatCompletionStreamDataPayload(raw: string): {
  readonly textDelta: string;
  readonly usage?: ModelTokenUsage;
  readonly isDoneMarker: boolean;
  readonly toolCallDelta?: OpenAiToolCallDelta;
} {
  const t = raw.trim();
  if (t === "[DONE]") {
    return { textDelta: "", isDoneMarker: true };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(t);
  } catch {
    return { textDelta: "", isDoneMarker: false };
  }
  const root =
    parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  if (!root) {
    return { textDelta: "", isDoneMarker: false };
  }
  let textDelta = "";
  let toolCallDelta: OpenAiToolCallDelta | undefined;
  const choices = root.choices;
  if (
    Array.isArray(choices) &&
    choices[0] !== null &&
    typeof choices[0] === "object"
  ) {
    const c0 = choices[0] as Record<string, unknown>;
    const delta = c0.delta;
    if (delta !== null && typeof delta === "object") {
      const d = delta as Record<string, unknown>;
      const content = d.content;
      if (typeof content === "string") {
        textDelta = content;
      }
      const toolCalls = d.tool_calls;
      if (Array.isArray(toolCalls) && toolCalls.length > 0) {
        toolCallDelta = parseToolCallDelta(toolCalls[0]);
      }
    }
  }
  const usage = parseOpenAiUsageJson(root.usage);
  return {
    textDelta,
    ...(usage !== undefined ? { usage } : {}),
    isDoneMarker: false,
    ...(toolCallDelta !== undefined ? { toolCallDelta } : {}),
  };
}

/** Partial tool_call fragment from an OpenAI stream delta. */
export interface OpenAiToolCallDelta {
  readonly index: number;
  readonly id?: string;
  readonly type?: string;
  readonly functionName?: string;
  readonly functionArguments?: string;
}

function parseToolCallDelta(raw: unknown): OpenAiToolCallDelta | undefined {
  if (raw === null || typeof raw !== "object") {
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  const index = typeof obj.index === "number" ? obj.index : 0;
  const id = typeof obj.id === "string" ? obj.id : undefined;
  const type = typeof obj.type === "string" ? obj.type : undefined;
  const fn = obj.function;
  let functionName: string | undefined;
  let functionArguments: string | undefined;
  if (fn !== null && typeof fn === "object") {
    const f = fn as Record<string, unknown>;
    if (typeof f.name === "string") {
      functionName = f.name;
    }
    if (typeof f.arguments === "string") {
      functionArguments = f.arguments;
    }
  }
  if (
    id === undefined &&
    type === undefined &&
    functionName === undefined &&
    functionArguments === undefined
  ) {
    return undefined;
  }
  return {
    index,
    ...(id !== undefined ? { id } : {}),
    ...(type !== undefined ? { type } : {}),
    ...(functionName !== undefined ? { functionName } : {}),
    ...(functionArguments !== undefined ? { functionArguments } : {}),
  };
}

/** Usage object from chat/completions JSON (streaming or non-streaming). */
export function parseOpenAiUsageJson(
  raw: unknown,
): ModelTokenUsage | undefined {
  if (raw === null || typeof raw !== "object") {
    return undefined;
  }
  const u = raw as Record<string, unknown>;
  const promptTokens = pickNum(u.prompt_tokens ?? u.promptTokens);
  const completionTokens = pickNum(u.completion_tokens ?? u.completionTokens);
  const totalTokens = pickNum(u.total_tokens ?? u.totalTokens);
  if (
    promptTokens === undefined &&
    completionTokens === undefined &&
    totalTokens === undefined
  ) {
    return undefined;
  }
  return {
    ...(promptTokens !== undefined ? { promptTokens } : {}),
    ...(completionTokens !== undefined ? { completionTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  };
}

function pickNum(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) {
    return v;
  }
  return undefined;
}
