/**
 * OpenAI Chat Completions 兼容客户端（HTTPS fetch）。
 * ===================================================
 *
 * 实现 LanguageModel 接口，封装 OpenAI 兼容的 Chat Completions API。
 * 通过 openai_base_url 可适配任何兼容 OpenAI 接口的 provider（Qwen/DeepSeek/...）。
 *
 * 支持：
 * - 非流式调用（complete）：提取 tool_calls + thinking + 文本
 * - 流式调用（completeStream）：SSE delta 解析 + tool_use 增量拼接
 * - 推理模型 think 标签提取（extractThinkBlocks）
 * - stream_options.include_usage → 400 回退（某些 provider 不支持此参数）
 *
 * 面试要点：
 * - label 自动识别：根据 baseUrl 判断 provider 并设置合适的 label
 * - tool_use 增量拼接：流式模式下 tool_use 的 arguments 是分多次 delta 传来的，
 *   需要在客户端拼接完整 JSON 后才 yield
 */

import { type ModelTokenUsage, isNativeToolTurn } from "@paw/core";

import type {
  LanguageModel,
  ModelCapabilities,
  ModelRuntimeProfile,
} from "./language-model.js";
import { buildOpenAiMessageContent } from "./message-content.js";
import {
  type ModelCompleteOptions,
  resolveRequestMaxOutputTokens,
} from "./model-options.js";
import {
  parseOpenAiChatCompletionStreamDataPayload,
  parseOpenAiUsageJson,
} from "./openai-stream-parse.js";
import { extractThinkBlocks } from "./think-extraction.js";
import type {
  ChatMessage,
  ModelCompletionResult,
  ModelStreamChunk,
} from "./types.js";

export interface OpenAICompatibleOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly model: string;
  readonly capabilities?: ModelCapabilities;
  readonly thinkingEnabled?: boolean;
  readonly reasoningEffort?: "high" | "max";
  /** Endpoint accepts DeepSeek's non-standard `thinking` request field. */
  readonly supportsThinkingToggle?: boolean;
}

function abortError(): Error {
  const e = new Error("The operation was aborted");
  e.name = "AbortError";
  return e;
}

function resolveRequestThinkingV1(
  profile: ModelRuntimeProfile,
  options: ModelCompleteOptions | undefined,
  supportsThinkingToggle: boolean,
): Readonly<{
  enabled: boolean | undefined;
  effort: "high" | "max" | undefined;
}> {
  const enabled =
    options?.thinkingEnabled === false
      ? supportsThinkingToggle
        ? false
        : undefined
      : (options?.thinkingEnabled ?? profile.thinkingEnabled);
  return {
    enabled,
    // Explicitly disabling reasoning for a bounded auxiliary call must also
    // suppress the configured effort knob; sending both is contradictory on
    // DeepSeek-compatible endpoints.
    effort:
      options?.thinkingEnabled === false ? undefined : profile.reasoningEffort,
  };
}

/**
 * Minimal OpenAI Chat Completions client (HTTPS fetch).
 * Enough for `openai_base_url` + `openai_api_key` from `.paw/settings.local.json`.
 * Supports text and tool_calls in both streaming and non-streaming modes.
 */
export class OpenAICompatibleModel implements LanguageModel {
  readonly label: string;
  readonly capabilities?: ModelCapabilities;
  readonly runtimeProfile: import("./language-model.js").ModelRuntimeProfile;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly supportsThinkingToggle: boolean;

  constructor(opts: OpenAICompatibleOptions) {
    if (opts.thinkingEnabled === false && opts.reasoningEffort !== undefined) {
      throw new Error(
        "reasoningEffort cannot be set when thinkingEnabled is false",
      );
    }
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? "https://api.openai.com/v1").replace(
      /\/$/,
      "",
    );
    this.model = opts.model;
    this.supportsThinkingToggle =
      opts.supportsThinkingToggle ?? opts.thinkingEnabled !== undefined;
    this.label = opts.baseUrl?.includes("dashscope")
      ? `qwen:${opts.model}`
      : opts.baseUrl?.includes("deepseek")
        ? `deepseek:${opts.model}`
        : opts.model.toLowerCase().includes("qwen")
          ? `qwen3:${opts.model}`
          : `openai:${opts.model}`;
    this.capabilities = opts.capabilities;
    this.runtimeProfile = {
      protocol: "openai-compatible",
      model: opts.model,
      baseUrl: this.baseUrl,
      ...(opts.thinkingEnabled !== undefined
        ? { thinkingEnabled: opts.thinkingEnabled }
        : {}),
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
    const url = `${this.baseUrl}/chat/completions`;
    const requestThinking = resolveRequestThinkingV1(
      this.runtimeProfile,
      options,
      this.supportsThinkingToggle,
    );
    const body: Record<string, unknown> = {
      model: this.model,
      messages: serializeOpenAiMessages(messages),
      ...(requestThinking.enabled === true ||
      requestThinking.effort !== undefined
        ? {}
        : { temperature: 0.2 }),
    };
    if (options?.maxOutputTokens !== undefined) {
      body.max_tokens = resolveRequestMaxOutputTokens(
        options.maxOutputTokens,
        this.capabilities?.maxOutputTokens,
      );
    }
    if (requestThinking.enabled !== undefined) {
      body.thinking = {
        type: requestThinking.enabled ? "enabled" : "disabled",
      };
    }
    if (requestThinking.effort !== undefined) {
      body.reasoning_effort = requestThinking.effort;
    }
    if (options?.tools && options.tools.length > 0) {
      body.tools = options.tools;
    }
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: options?.signal,
    });
    const raw = await res.text();
    if (!res.ok) {
      throw new Error(
        `OpenAI-compatible HTTP ${res.status}: ${raw.slice(0, 500)}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("OpenAI-compatible: invalid JSON body");
    }
    const root =
      parsed !== null && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : null;
    const choices = root?.choices;
    const firstChoice =
      Array.isArray(choices) &&
      choices[0] !== null &&
      typeof choices[0] === "object"
        ? (choices[0] as Record<string, unknown>)
        : undefined;
    const finishReason =
      typeof firstChoice?.finish_reason === "string"
        ? firstChoice.finish_reason
        : undefined;
    const first = firstChoice?.message;
    const content =
      first !== null && typeof first === "object"
        ? (first as Record<string, unknown>).content
        : undefined;
    let text = typeof content === "string" ? content : "";
    const extracted = extractThinkBlocks(text);
    text = extracted.text;
    const nativeAssistantContent = text;

    const reasoningContent =
      first !== null && typeof first === "object"
        ? (first as Record<string, unknown>).reasoning_content
        : undefined;
    const reasoningThinking =
      typeof reasoningContent === "string" ? reasoningContent : undefined;
    const thinking =
      extracted.thinking || reasoningThinking
        ? [extracted.thinking, reasoningThinking].filter(Boolean).join("\n\n")
        : undefined;

    // If the model returned tool_calls, convert them to JSON tool lines
    // AND collect as structured NativeToolCall objects
    const rawToolCalls = extractOpenAiToolCalls(first);
    const nativeToolCalls: import("./types.js").NativeToolCall[] = [];
    if (rawToolCalls.length > 0) {
      const toolLines = rawToolCalls
        .map((tc, i) => {
          let args: Record<string, unknown> = {};
          let argumentsValid = false;
          try {
            const parsedArgs = JSON.parse(tc.arguments) as unknown;
            if (
              parsedArgs !== null &&
              typeof parsedArgs === "object" &&
              !Array.isArray(parsedArgs)
            ) {
              args = parsedArgs as Record<string, unknown>;
              argumentsValid = true;
            }
          } catch {
            /* ignore parse errors */
          }
          nativeToolCalls.push({
            id: tc.id,
            name: tc.name,
            arguments: args,
            rawArguments: tc.arguments,
            sourceIndex: i,
            argumentsValid,
          });
          return JSON.stringify({ tool: tc.name, args });
        })
        .join("\n");
      text = text ? `${text}\n${toolLines}` : toolLines;
    }

    const usage = parseOpenAiUsageJson(root?.usage);
    return {
      text,
      ...(nativeToolCalls.length > 0 ? { nativeAssistantContent } : {}),
      ...(thinking !== undefined ? { thinking } : {}),
      ...(reasoningThinking !== undefined
        ? { reasoningPassback: reasoningThinking }
        : {}),
      ...(usage !== undefined ? { usage } : {}),
      ...(finishReason ? { finishReason } : {}),
      ...(nativeToolCalls.length > 0 ? { toolCalls: nativeToolCalls } : {}),
    };
  }

  async *completeStream(
    messages: readonly ChatMessage[],
    options?: ModelCompleteOptions,
  ): AsyncIterable<ModelStreamChunk> {
    if (options?.signal?.aborted) {
      throw abortError();
    }
    const url = `${this.baseUrl}/chat/completions`;
    const messagesPayload = serializeOpenAiMessages(messages);
    const requestThinking = resolveRequestThinkingV1(
      this.runtimeProfile,
      options,
      this.supportsThinkingToggle,
    );
    const baseStreamBody: Record<string, unknown> = {
      model: this.model,
      messages: messagesPayload,
      ...(requestThinking.enabled === true ||
      requestThinking.effort !== undefined
        ? {}
        : { temperature: 0.2 }),
      stream: true as const,
    };
    if (options?.maxOutputTokens !== undefined) {
      baseStreamBody.max_tokens = resolveRequestMaxOutputTokens(
        options.maxOutputTokens,
        this.capabilities?.maxOutputTokens,
      );
    }
    if (requestThinking.enabled !== undefined) {
      baseStreamBody.thinking = {
        type: requestThinking.enabled ? "enabled" : "disabled",
      };
    }
    if (requestThinking.effort !== undefined) {
      baseStreamBody.reasoning_effort = requestThinking.effort;
    }
    if (options?.tools && options.tools.length > 0) {
      baseStreamBody.tools = options.tools;
    }
    let res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({
        ...baseStreamBody,
        stream_options: { include_usage: true },
      }),
      signal: options?.signal,
    });
    if (!res.ok && res.status === 400) {
      const errOnce = await res.text();
      res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify(baseStreamBody),
        signal: options?.signal,
      });
      if (!res.ok) {
        const retryErr = await res.text();
        throw new Error(
          `OpenAI-compatible stream HTTP ${res.status}: first=${errOnce.slice(0, 200)} retry=${retryErr.slice(0, 300)}`,
        );
      }
    } else if (!res.ok) {
      const errText = await res.text();
      throw new Error(
        `OpenAI-compatible stream HTTP ${res.status}: ${errText.slice(0, 500)}`,
      );
    }
    const reader = res.body?.getReader();
    if (!reader) {
      throw new Error("OpenAI-compatible: missing response body for stream");
    }
    const decoder = new TextDecoder();
    let buffer = "";
    let lastUsage: ModelTokenUsage | undefined;
    let lastFinishReason: string | undefined;
    let sawDoneMarker = false;
    // Accumulate tool calls by index
    const toolCallAcc: Map<
      number,
      { id: string; name: string; arguments: string; invalid: boolean }
    > = new Map();
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
          if (sawDoneMarker) {
            throw new Error(
              "OpenAI-compatible stream emitted data after [DONE]",
            );
          }
          const payload = trimmed.slice(6);
          const part = parseOpenAiChatCompletionStreamDataPayload(payload);
          if (part.isDoneMarker) {
            sawDoneMarker = true;
            continue;
          }
          if (part.textDelta.length > 0) {
            yield { type: "text", delta: part.textDelta };
          }
          if (part.thinkingDelta && part.thinkingDelta.length > 0) {
            yield { type: "thinking", delta: part.thinkingDelta };
          }
          if (
            part.reasoningPassbackDelta &&
            part.reasoningPassbackDelta.length > 0
          ) {
            yield {
              type: "reasoning_passback",
              delta: part.reasoningPassbackDelta,
            };
          }
          for (const delta of part.toolCallDeltas ?? []) {
            let entry = toolCallAcc.get(delta.index);
            if (!entry) {
              entry = { id: "", name: "", arguments: "", invalid: false };
              toolCallAcc.set(delta.index, entry);
            }
            entry.invalid ||= delta.invalid === true;
            if (delta.id) {
              if (entry.id && entry.id !== delta.id) {
                throw new Error(
                  `OpenAI-compatible conflicting tool call id at index ${delta.index}`,
                );
              }
              entry.id = delta.id;
            }
            if (delta.functionName) {
              if (entry.name && entry.name !== delta.functionName) {
                throw new Error(
                  `OpenAI-compatible conflicting tool name at index ${delta.index}`,
                );
              }
              entry.name = delta.functionName;
            }
            if (delta.functionArguments) {
              entry.arguments += delta.functionArguments;
            }
          }
          if (part.usage !== undefined) {
            lastUsage = part.usage;
          }
          if (part.finishReason !== undefined) {
            lastFinishReason = part.finishReason;
          }
        }
        if (done) {
          break;
        }
      }
      if (buffer.trim()) {
        const trimmed = buffer.replace(/\r$/, "").trim();
        if (trimmed.startsWith("data: ")) {
          if (sawDoneMarker) {
            throw new Error(
              "OpenAI-compatible stream emitted data after [DONE]",
            );
          }
          const payload = trimmed.slice(6);
          const part = parseOpenAiChatCompletionStreamDataPayload(payload);
          if (part.isDoneMarker) {
            sawDoneMarker = true;
          }
          if (!part.isDoneMarker && part.textDelta.length > 0) {
            yield { type: "text", delta: part.textDelta };
          }
          if (
            !part.isDoneMarker &&
            part.thinkingDelta &&
            part.thinkingDelta.length > 0
          ) {
            yield { type: "thinking", delta: part.thinkingDelta };
          }
          if (
            !part.isDoneMarker &&
            part.reasoningPassbackDelta &&
            part.reasoningPassbackDelta.length > 0
          ) {
            yield {
              type: "reasoning_passback",
              delta: part.reasoningPassbackDelta,
            };
          }
          if (part.usage !== undefined) {
            lastUsage = part.usage;
          }
          if (part.finishReason !== undefined) {
            lastFinishReason = part.finishReason;
          }
          for (const delta of part.toolCallDeltas ?? []) {
            let entry = toolCallAcc.get(delta.index);
            if (!entry) {
              entry = { id: "", name: "", arguments: "", invalid: false };
              toolCallAcc.set(delta.index, entry);
            }
            entry.invalid ||= delta.invalid === true;
            if (delta.id) {
              if (entry.id && entry.id !== delta.id) {
                throw new Error(
                  `OpenAI-compatible conflicting tool call id at index ${delta.index}`,
                );
              }
              entry.id = delta.id;
            }
            if (delta.functionName) {
              if (entry.name && entry.name !== delta.functionName) {
                throw new Error(
                  `OpenAI-compatible conflicting tool name at index ${delta.index}`,
                );
              }
              entry.name = delta.functionName;
            }
            if (delta.functionArguments) {
              entry.arguments += delta.functionArguments;
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
    if (!sawDoneMarker && !lastFinishReason?.trim()) {
      throw new Error(
        "OpenAI-compatible stream ended without a terminal marker or finish reason",
      );
    }
    const completedCalls = [...toolCallAcc.entries()].sort(
      ([left], [right]) => left - right,
    );
    const callIds = new Set<string>();
    for (const [index, call] of completedCalls) {
      if (call.invalid || !call.id.trim() || !call.name.trim()) {
        throw new Error(
          `OpenAI-compatible incomplete tool call identity at index ${index}`,
        );
      }
      if (callIds.has(call.id)) {
        throw new Error(`OpenAI-compatible duplicate tool call id ${call.id}`);
      }
      callIds.add(call.id);
      yield {
        type: "tool_use",
        id: call.id,
        name: call.name,
        input: call.arguments,
        sourceIndex: index,
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

/** Extract tool_calls from an OpenAI message object. */
function extractOpenAiToolCalls(
  message: unknown,
): Array<{ id: string; name: string; arguments: string }> {
  if (message === null || typeof message !== "object") {
    return [];
  }
  const m = message as Record<string, unknown>;
  const toolCalls = m.tool_calls;
  if (toolCalls === undefined) {
    return [];
  }
  if (!Array.isArray(toolCalls)) {
    throw new Error("OpenAI-compatible tool_calls must be an array");
  }
  const out: Array<{ id: string; name: string; arguments: string }> = [];
  const ids = new Set<string>();
  for (let index = 0; index < toolCalls.length; index += 1) {
    const tc = toolCalls[index];
    if (tc === null || typeof tc !== "object") {
      throw new Error(`OpenAI-compatible invalid tool call at index ${index}`);
    }
    const t = tc as Record<string, unknown>;
    const fn = t.function;
    if (fn === null || typeof fn !== "object") {
      throw new Error(
        `OpenAI-compatible missing tool function at index ${index}`,
      );
    }
    const f = fn as Record<string, unknown>;
    const id = typeof t.id === "string" ? t.id : "";
    const name = typeof f.name === "string" ? f.name : "";
    const args = typeof f.arguments === "string" ? f.arguments : "";
    if (!id.trim() || !name.trim() || typeof f.arguments !== "string") {
      throw new Error(
        `OpenAI-compatible incomplete tool call identity at index ${index}`,
      );
    }
    if (ids.has(id)) {
      throw new Error(`OpenAI-compatible duplicate tool call id ${id}`);
    }
    ids.add(id);
    out.push({ id, name, arguments: args });
  }
  return out;
}

/** Serialize request history, expanding atomic native turns on the wire. */
function serializeOpenAiMessages(
  messages: readonly ChatMessage[],
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    const nativeTurn = message.nativeToolTurn;
    if (message.role === "assistant" && isNativeToolTurn(nativeTurn)) {
      out.push({
        role: "assistant",
        content: nativeTurn.assistantContent,
        ...(nativeTurn.reasoningPassback
          ? { reasoning_content: nativeTurn.reasoningPassback }
          : {}),
        tool_calls: nativeTurn.calls.map((call) => ({
          id: call.callId,
          type: "function",
          function: {
            name: call.providerName,
            arguments: call.rawArguments,
          },
        })),
      });
      for (let index = 0; index < nativeTurn.results.length; index += 1) {
        const call = nativeTurn.calls[index];
        const result = nativeTurn.results[index];
        if (!call || !result || call.callId !== result.callId) {
          throw new Error(`Native tool turn result ${index} is not paired`);
        }
        out.push({
          role: "tool",
          tool_call_id: result.callId,
          content: result.content || "(no output)",
        });
      }
      continue;
    }
    // Historical thinking is audit data, not generic request state.
    if (message.reasoningPassback && message.role !== "assistant") {
      throw new Error("reasoningPassback is valid only on assistant messages");
    }
    out.push({
      role: message.role,
      content: buildOpenAiMessageContent(message),
      ...(message.role === "assistant" && message.reasoningPassback
        ? { reasoning_content: message.reasoningPassback }
        : {}),
    });
  }
  return out;
}
