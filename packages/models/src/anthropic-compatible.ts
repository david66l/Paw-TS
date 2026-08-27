/**
 * Anthropic Messages API 兼容客户端（HTTPS fetch）。
 * ===================================================
 *
 * 实现 LanguageModel 接口，封装 Anthropic Messages API。
 *
 * 支持：
 * - 非流式调用（complete）
 * - 流式调用（completeStream）— SSE 事件解析
 * - thinking 块提取
 * - 原生 tool_use 块（content_block_start/delta/stop）
 *
 * 面试要点：
 * - SSE 协议解析：按行读取 "\ndata: " 前缀的分块
 * - system 消息处理：Anthropic 有顶层 system 参数（非 messages 数组中的 role:system）
 */

import { type ModelTokenUsage, isNativeToolTurnV2 } from "@paw/core";

import type { LanguageModel, ModelCapabilities } from "./language-model.js";
import {
  type AnthropicContentBlock,
  buildAnthropicUserContent,
} from "./message-content.js";
import {
  type ModelCompleteOptions,
  type ToolDefinition,
  resolveRequestMaxOutputTokens,
} from "./model-options.js";
import type {
  ChatMessage,
  ModelCompletionResult,
  ModelStreamChunk,
  NativeToolCall,
} from "./types.js";

export interface AnthropicCompatibleOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly model: string;
  readonly capabilities?: ModelCapabilities;
  readonly reasoningEffort?: "high" | "max";
}

function abortError(): Error {
  const e = new Error("The operation was aborted");
  e.name = "AbortError";
  return e;
}

/** Convert the shared OpenAI-shaped tool definition to Anthropic's wire shape. */
function toAnthropicTools(tools: readonly ToolDefinition[]): Array<{
  readonly name: string;
  readonly description: string;
  readonly input_schema: Record<string, unknown>;
}> {
  return tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters,
  }));
}

/** Convert Paw ChatMessage[] to Anthropic message format. */
function toAnthropicMessages(messages: readonly ChatMessage[]): {
  system: string | undefined;
  messages: Array<{
    role: "user" | "assistant";
    content: string | AnthropicRequestContentBlock[];
  }>;
} {
  let system: string | undefined;
  const out: Array<{
    role: "user" | "assistant";
    content: string | AnthropicRequestContentBlock[];
  }> = [];
  for (const m of messages) {
    if (m.role === "system") {
      system = system ? `${system}\n\n${m.content}` : m.content;
    } else if (m.role === "user") {
      out.push({ role: "user", content: buildAnthropicUserContent(m) });
    } else if (isNativeToolTurnV2(m.nativeToolTurn)) {
      const turn = m.nativeToolTurn;
      if (turn.reasoningPassback !== undefined) {
        throw new Error(
          "Anthropic-compatible history cannot replay string reasoningPassback",
        );
      }
      const assistant: AnthropicRequestContentBlock[] = [];
      if (turn.assistantContent) {
        assistant.push({ type: "text", text: turn.assistantContent });
      }
      for (const call of turn.calls) {
        let input: unknown;
        try {
          input = JSON.parse(call.rawArguments);
        } catch {
          throw new Error(`Native tool call ${call.callId} has invalid JSON`);
        }
        if (
          input === null ||
          typeof input !== "object" ||
          Array.isArray(input)
        ) {
          throw new Error(
            `Native tool call ${call.callId} arguments must be an object`,
          );
        }
        assistant.push({
          type: "tool_use",
          id: call.callId,
          name: call.providerName,
          input: input as Record<string, unknown>,
        });
      }
      out.push({ role: "assistant", content: assistant });
      out.push({
        role: "user",
        content: turn.results.map((result) => ({
          type: "tool_result" as const,
          tool_use_id: result.callId,
          content: result.content || "(no output)",
          is_error: result.isError,
        })),
      });
    } else if (m.reasoningPassback !== undefined) {
      throw new Error(
        "Anthropic-compatible history cannot replay string reasoningPassback",
      );
    } else {
      out.push({ role: "assistant", content: m.content });
    }
  }
  return { system, messages: out };
}

type AnthropicRequestContentBlock =
  | AnthropicContentBlock
  | Readonly<{
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    }>
  | Readonly<{
      type: "tool_result";
      tool_use_id: string;
      content: string;
      is_error: boolean;
    }>;

/**
 * Minimal Anthropic Messages API client (HTTPS fetch).
 * Supports text, thinking blocks, and tool_use blocks.
 */
export class AnthropicCompatibleModel implements LanguageModel {
  readonly label: string;
  readonly capabilities?: ModelCapabilities;
  readonly runtimeProfile: import("./language-model.js").ModelRuntimeProfile;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(opts: AnthropicCompatibleOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? "https://api.anthropic.com/v1").replace(
      /\/$/,
      "",
    );
    this.model = opts.model;
    this.label = `anthropic:${opts.model}`;
    this.capabilities = opts.capabilities;
    this.runtimeProfile = {
      protocol: "anthropic-compatible",
      model: opts.model,
      baseUrl: this.baseUrl,
      ...(opts.reasoningEffort !== undefined
        ? { reasoningEffort: opts.reasoningEffort }
        : {}),
    };
  }

  async complete(
    messages: readonly ChatMessage[],
    options?: ModelCompleteOptions,
  ): Promise<ModelCompletionResult> {
    if (options?.signal?.aborted) {
      throw abortError();
    }
    const url = `${this.baseUrl}/messages`;
    const { system, messages: msgs } = toAnthropicMessages(messages);
    const body: Record<string, unknown> = {
      model: this.model,
      messages: msgs,
      max_tokens: resolveRequestMaxOutputTokens(
        options?.maxOutputTokens,
        this.capabilities?.maxOutputTokens,
        4096,
      ),
    };
    if (
      options?.thinkingEnabled !== false &&
      this.runtimeProfile.reasoningEffort !== undefined
    ) {
      body.output_config = { effort: this.runtimeProfile.reasoningEffort };
    }
    if (system) {
      body.system = system;
    }
    if (options?.tools && options.tools.length > 0) {
      body.tools = toAnthropicTools(options.tools);
    }
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: options?.signal,
    });
    const raw = await res.text();
    if (!res.ok) {
      throw new Error(`Anthropic HTTP ${res.status}: ${raw.slice(0, 500)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("Anthropic: invalid JSON body");
    }
    const root =
      parsed !== null && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : null;
    const { text, thinking, toolCalls } = extractAnthropicContent(root);
    const usage = parseAnthropicUsage(root?.usage);
    const finishReason =
      typeof root?.stop_reason === "string" ? root.stop_reason : undefined;
    const result: ModelCompletionResult = {
      text,
      ...(toolCalls.length > 0 ? { nativeAssistantContent: text } : {}),
      ...(usage !== undefined ? { usage } : {}),
      ...(thinking ? { thinking } : {}),
      ...(finishReason ? { finishReason } : {}),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };
    return result;
  }

  async *completeStream(
    messages: readonly ChatMessage[],
    options?: ModelCompleteOptions,
  ): AsyncIterable<ModelStreamChunk> {
    if (options?.signal?.aborted) {
      throw abortError();
    }
    const url = `${this.baseUrl}/messages`;
    const { system, messages: msgs } = toAnthropicMessages(messages);
    const body: Record<string, unknown> = {
      model: this.model,
      messages: msgs,
      max_tokens: resolveRequestMaxOutputTokens(
        options?.maxOutputTokens,
        this.capabilities?.maxOutputTokens,
        4096,
      ),
      stream: true,
    };
    if (
      options?.thinkingEnabled !== false &&
      this.runtimeProfile.reasoningEffort !== undefined
    ) {
      body.output_config = { effort: this.runtimeProfile.reasoningEffort };
    }
    if (system) {
      body.system = system;
    }
    if (options?.tools && options.tools.length > 0) {
      body.tools = toAnthropicTools(options.tools);
    }
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(body),
      signal: options?.signal,
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(
        `Anthropic stream HTTP ${res.status}: ${errText.slice(0, 500)}`,
      );
    }
    const reader = res.body?.getReader();
    if (!reader) {
      throw new Error("Anthropic: missing response body for stream");
    }
    const decoder = new TextDecoder();
    let buffer = "";
    let lastUsage: ModelTokenUsage | undefined;
    let lastFinishReason: string | undefined;
    let sawMessageStop = false;
    const toolUseByBlockIndex = new Map<
      number,
      {
        readonly id: string;
        readonly name: string;
        input: string;
        stopped: boolean;
      }
    >();
    const processPart = (part: AnthropicStreamPart): ModelStreamChunk[] => {
      if (sawMessageStop) {
        throw new Error("Anthropic stream emitted data after message_stop");
      }
      const chunks: ModelStreamChunk[] = [];
      if (part.textDelta.length > 0) {
        chunks.push({ type: "text", delta: part.textDelta });
      }
      if (part.thinkingDelta.length > 0) {
        chunks.push({ type: "thinking", delta: part.thinkingDelta });
      }
      if (part.toolUseStart) {
        const { blockIndex, id, name, initialInput } = part.toolUseStart;
        if (toolUseByBlockIndex.has(blockIndex)) {
          throw new Error(
            `Anthropic duplicate tool_use block index ${blockIndex}`,
          );
        }
        toolUseByBlockIndex.set(blockIndex, {
          id,
          name,
          input: initialInput,
          stopped: false,
        });
      }
      if (part.toolUseDelta) {
        const { blockIndex, partialJson } = part.toolUseDelta;
        const toolUse = toolUseByBlockIndex.get(blockIndex);
        if (!toolUse || toolUse.stopped) {
          throw new Error(
            `Anthropic orphan tool_use delta at block index ${blockIndex}`,
          );
        }
        toolUse.input += partialJson;
      }
      if (part.toolUseStopIndex !== undefined) {
        const toolUse = toolUseByBlockIndex.get(part.toolUseStopIndex);
        if (toolUse) {
          if (toolUse.stopped) {
            throw new Error(
              `Anthropic duplicate tool_use stop at block index ${part.toolUseStopIndex}`,
            );
          }
          toolUse.stopped = true;
        }
      }
      if (part.usage !== undefined) {
        lastUsage = mergeAnthropicUsage(lastUsage, part.usage);
      }
      if (part.finishReason !== undefined) {
        lastFinishReason = part.finishReason;
      }
      if (part.messageStopped) {
        sawMessageStop = true;
      }
      return chunks;
    };
    try {
      while (true) {
        if (options?.signal?.aborted) {
          await reader.cancel();
          throw abortError();
        }
        const { done, value } = await reader.read();
        buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
        const lines = buffer.split("\n");
        buffer = done ? "" : (lines.pop() ?? "");
        for (const line of lines) {
          const trimmed = line.replace(/\r$/, "").trim();
          if (!trimmed.startsWith("data: ")) {
            continue;
          }
          const payload = trimmed.slice(6);
          const part = parseAnthropicStreamPayload(payload);
          for (const chunk of processPart(part)) {
            yield chunk;
          }
        }
        if (done) {
          break;
        }
      }
      if (buffer.trim()) {
        const trimmed = buffer.replace(/\r$/, "").trim();
        if (trimmed.startsWith("data: ")) {
          const payload = trimmed.slice(6);
          const part = parseAnthropicStreamPayload(payload);
          for (const chunk of processPart(part)) {
            yield chunk;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
    if (!sawMessageStop && !lastFinishReason) {
      throw new Error(
        "Anthropic stream ended without message_stop or stop_reason",
      );
    }
    const completedToolUses = [...toolUseByBlockIndex.entries()].sort(
      ([left], [right]) => left - right,
    );
    const callIds = new Set<string>();
    for (const [sourceIndex, [, toolUse]] of completedToolUses.entries()) {
      if (
        !toolUse.stopped ||
        !toolUse.id.trim() ||
        !toolUse.name.trim() ||
        callIds.has(toolUse.id)
      ) {
        throw new Error(
          `Anthropic invalid tool_use identity at source index ${sourceIndex}`,
        );
      }
      callIds.add(toolUse.id);
      yield {
        type: "tool_use",
        id: toolUse.id,
        name: toolUse.name,
        input: toolUse.input,
        sourceIndex,
      };
    }
    yield {
      type: "done",
      ...(lastUsage !== undefined ? { usage: lastUsage } : {}),
      ...(lastFinishReason !== undefined
        ? { finishReason: lastFinishReason }
        : {}),
    };
  }
}

function extractAnthropicContent(root: Record<string, unknown> | null): {
  text: string;
  thinking?: string;
  toolCalls: readonly NativeToolCall[];
} {
  const content = root?.content;
  if (!Array.isArray(content)) {
    return { text: "", toolCalls: [] };
  }
  const textParts: string[] = [];
  const thinkingParts: string[] = [];
  const toolCalls: NativeToolCall[] = [];
  const callIds = new Set<string>();
  for (const block of content) {
    if (block !== null && typeof block === "object") {
      const b = block as Record<string, unknown>;
      if (b.type === "text") {
        const t = b.text;
        if (typeof t === "string") {
          textParts.push(t);
        }
      } else if (b.type === "thinking") {
        const t = b.thinking;
        if (typeof t === "string") {
          thinkingParts.push(t);
        }
      } else if (b.type === "tool_use") {
        const id = typeof b.id === "string" ? b.id : "";
        const name = typeof b.name === "string" ? b.name : "";
        if (!id.trim() || !name.trim() || callIds.has(id)) {
          throw new Error(
            `Anthropic invalid tool_use identity at source index ${toolCalls.length}`,
          );
        }
        callIds.add(id);
        toolCalls.push(
          toNativeToolCall(id, name, b.input, toolCalls.length, "complete"),
        );
      }
    }
  }
  const result: {
    text: string;
    thinking?: string;
    toolCalls: readonly NativeToolCall[];
  } = {
    text: textParts.join(""),
    toolCalls,
  };
  if (thinkingParts.length > 0) {
    result.thinking = thinkingParts.join("");
  }
  return result;
}

function toNativeToolCall(
  id: string,
  name: string,
  input: unknown,
  sourceIndex: number,
  source: "complete" | "stream",
): NativeToolCall {
  const rawArguments =
    source === "stream"
      ? typeof input === "string"
        ? input
        : ""
      : typeof input === "string"
        ? input
        : JSON.stringify(input ?? null);
  let parsedInput: unknown = input;
  if (source === "stream") {
    try {
      parsedInput = JSON.parse(rawArguments);
    } catch {
      parsedInput = undefined;
    }
  }
  const argumentsValid =
    parsedInput !== null &&
    typeof parsedInput === "object" &&
    !Array.isArray(parsedInput);
  return {
    id,
    name,
    arguments: argumentsValid ? (parsedInput as Record<string, unknown>) : {},
    rawArguments,
    sourceIndex,
    argumentsValid,
  };
}

function parseAnthropicUsage(raw: unknown): ModelTokenUsage | undefined {
  if (raw === null || typeof raw !== "object") {
    return undefined;
  }
  const u = raw as Record<string, unknown>;
  const inputTokens = pickNum(u.input_tokens ?? u.promptTokens);
  const outputTokens = pickNum(u.output_tokens ?? u.completionTokens);
  const cachedPromptTokens = pickNum(
    u.cache_read_input_tokens ?? u.cachedPromptTokens,
  );
  const totalTokens =
    inputTokens !== undefined && outputTokens !== undefined
      ? inputTokens + outputTokens
      : undefined;
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cachedPromptTokens === undefined
  ) {
    return undefined;
  }
  return {
    ...(inputTokens !== undefined ? { promptTokens: inputTokens } : {}),
    ...(outputTokens !== undefined ? { completionTokens: outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(cachedPromptTokens !== undefined ? { cachedPromptTokens } : {}),
  };
}

function mergeAnthropicUsage(
  current: ModelTokenUsage | undefined,
  incoming: ModelTokenUsage,
): ModelTokenUsage {
  const promptTokens = incoming.promptTokens ?? current?.promptTokens;
  const completionTokens =
    incoming.completionTokens ?? current?.completionTokens;
  const cachedPromptTokens =
    incoming.cachedPromptTokens ?? current?.cachedPromptTokens;
  const totalTokens =
    incoming.totalTokens ??
    (promptTokens !== undefined && completionTokens !== undefined
      ? promptTokens + completionTokens
      : current?.totalTokens);
  return {
    ...(promptTokens !== undefined ? { promptTokens } : {}),
    ...(completionTokens !== undefined ? { completionTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(cachedPromptTokens !== undefined ? { cachedPromptTokens } : {}),
  };
}

interface AnthropicStreamPart {
  readonly textDelta: string;
  readonly thinkingDelta: string;
  readonly toolUseStart?: {
    readonly blockIndex: number;
    readonly id: string;
    readonly name: string;
    readonly initialInput: string;
  };
  readonly toolUseDelta?: {
    readonly blockIndex: number;
    readonly partialJson: string;
  };
  readonly toolUseStopIndex?: number;
  readonly usage?: ModelTokenUsage;
  readonly finishReason?: string;
  readonly messageStopped?: boolean;
}

function emptyAnthropicStreamPart(): AnthropicStreamPart {
  return { textDelta: "", thinkingDelta: "" };
}

function parseAnthropicStreamPayload(raw: string): AnthropicStreamPart {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Anthropic invalid JSON stream payload");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Anthropic stream payload must be a JSON object");
  }
  const root = parsed as Record<string, unknown>;

  const type = root.type;

  if (type === "message_start") {
    const message =
      root.message !== null && typeof root.message === "object"
        ? (root.message as Record<string, unknown>)
        : undefined;
    const usage = parseAnthropicUsage(message?.usage);
    return {
      ...emptyAnthropicStreamPart(),
      ...(usage !== undefined ? { usage } : {}),
    };
  }

  // message_delta carries usage at the root and stop_reason inside delta.
  if (type === "message_delta") {
    const usage = parseAnthropicUsage(root.usage);
    const delta =
      root.delta !== null && typeof root.delta === "object"
        ? (root.delta as Record<string, unknown>)
        : undefined;
    const finishReason =
      typeof delta?.stop_reason === "string" && delta.stop_reason.trim()
        ? delta.stop_reason
        : undefined;
    return {
      ...emptyAnthropicStreamPart(),
      ...(usage !== undefined ? { usage } : {}),
      ...(finishReason ? { finishReason } : {}),
    };
  }

  if (type === "message_stop") {
    return { ...emptyAnthropicStreamPart(), messageStopped: true };
  }

  // content_block_start signals beginning of a block
  if (type === "content_block_start") {
    const blockIndex = pickNonNegativeInteger(root.index);
    const contentBlock = root.content_block;
    if (
      blockIndex !== undefined &&
      contentBlock !== null &&
      typeof contentBlock === "object" &&
      (contentBlock as Record<string, unknown>).type === "tool_use"
    ) {
      const cb = contentBlock as Record<string, unknown>;
      const id = typeof cb.id === "string" ? cb.id : "";
      const name = typeof cb.name === "string" ? cb.name : "";
      const initialInput =
        cb.input !== null &&
        typeof cb.input === "object" &&
        !Array.isArray(cb.input) &&
        Object.keys(cb.input as Record<string, unknown>).length > 0
          ? JSON.stringify(cb.input)
          : "";
      return {
        ...emptyAnthropicStreamPart(),
        toolUseStart: { blockIndex, id, name, initialInput },
      };
    }
    // thinking block start may carry initial text
    if (
      contentBlock !== null &&
      typeof contentBlock === "object" &&
      (contentBlock as Record<string, unknown>).type === "thinking"
    ) {
      const cb = contentBlock as Record<string, unknown>;
      const t = cb.thinking;
      return {
        textDelta: "",
        thinkingDelta: typeof t === "string" ? t : "",
      };
    }
    return emptyAnthropicStreamPart();
  }

  // content_block_delta carries deltas
  if (type === "content_block_delta") {
    const blockIndex = pickNonNegativeInteger(root.index);
    const delta = root.delta;
    if (delta !== null && typeof delta === "object") {
      const d = delta as Record<string, unknown>;
      // text delta
      const text = d.text;
      if (typeof text === "string") {
        return {
          textDelta: text,
          thinkingDelta: "",
        };
      }
      // thinking delta
      const thinking = d.thinking;
      if (typeof thinking === "string") {
        return {
          textDelta: "",
          thinkingDelta: thinking,
        };
      }
      // tool_use partial_json delta
      const partialJson = d.partial_json;
      if (typeof partialJson === "string" && blockIndex !== undefined) {
        return {
          ...emptyAnthropicStreamPart(),
          toolUseDelta: { blockIndex, partialJson },
        };
      }
    }
  }

  // content_block_stop signals end of a block
  if (type === "content_block_stop") {
    const blockIndex = pickNonNegativeInteger(root.index);
    return {
      ...emptyAnthropicStreamPart(),
      ...(blockIndex !== undefined ? { toolUseStopIndex: blockIndex } : {}),
    };
  }

  return emptyAnthropicStreamPart();
}

function pickNum(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) {
    return v;
  }
  return undefined;
}

function pickNonNegativeInteger(v: unknown): number | undefined {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0
    ? v
    : undefined;
}
