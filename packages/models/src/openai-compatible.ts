import type { ModelTokenUsage } from "@paw/core";

import type { LanguageModel, ModelCapabilities } from "./language-model.js";
import { buildOpenAiMessageContent } from "./message-content.js";
import type { ModelCompleteOptions } from "./model-options.js";
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
}

function abortError(): Error {
  const e = new Error("The operation was aborted");
  e.name = "AbortError";
  return e;
}

/**
 * Minimal OpenAI Chat Completions client (HTTPS fetch).
 * Enough for `openai_base_url` + `openai_api_key` from `.paw/settings.local.json`.
 * Supports text and tool_calls in both streaming and non-streaming modes.
 */
export class OpenAICompatibleModel implements LanguageModel {
  readonly label: string;
  readonly capabilities?: ModelCapabilities;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(opts: OpenAICompatibleOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? "https://api.openai.com/v1").replace(
      /\/$/,
      "",
    );
    this.model = opts.model;
    this.label = opts.baseUrl?.includes("dashscope")
      ? `qwen:${opts.model}`
      : opts.baseUrl?.includes("deepseek")
        ? `deepseek:${opts.model}`
        : opts.model.toLowerCase().includes("qwen")
          ? `qwen3:${opts.model}`
          : `openai:${opts.model}`;
    this.capabilities = opts.capabilities;
  }

  async complete(
    messages: readonly ChatMessage[],
    options?: ModelCompleteOptions,
  ): Promise<ModelCompletionResult> {
    if (options?.signal?.aborted) {
      throw abortError();
    }
    const url = `${this.baseUrl}/chat/completions`;
    const body: Record<string, unknown> = {
      model: this.model,
      messages: messages.map((m) => {
        const payload: Record<string, unknown> = {
          role: m.role,
          content: buildOpenAiMessageContent(m),
        };
        if (m.thinking) {
          payload.reasoning_content = m.thinking;
        }
        return payload;
      }),
      temperature: 0.2,
    };
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
          try {
            args = JSON.parse(tc.arguments) as Record<string, unknown>;
          } catch {
            /* ignore parse errors */
          }
          nativeToolCalls.push({
            id: `call_${i}`,
            name: tc.name,
            arguments: args,
          });
          return JSON.stringify({ tool: tc.name, args });
        })
        .join("\n");
      text = text ? `${text}\n${toolLines}` : toolLines;
    }

    const usage = parseOpenAiUsageJson(root?.usage);
    return {
      text,
      ...(thinking !== undefined ? { thinking } : {}),
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
    const messagesPayload = messages.map((m) => {
      const payload: Record<string, unknown> = {
        role: m.role,
        content: buildOpenAiMessageContent(m),
      };
      if (m.thinking) {
        payload.reasoning_content = m.thinking;
      }
      return payload;
    });
    const baseStreamBody: Record<string, unknown> = {
      model: this.model,
      messages: messagesPayload,
      temperature: 0.2,
      stream: true as const,
    };
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
    // Accumulate tool calls by index
    const toolCallAcc: Map<
      number,
      { id: string; name: string; arguments: string }
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
          const payload = trimmed.slice(6);
          const part = parseOpenAiChatCompletionStreamDataPayload(payload);
          if (part.isDoneMarker) {
            continue;
          }
          if (part.textDelta.length > 0) {
            yield { type: "text", delta: part.textDelta };
          }
          if (part.thinkingDelta && part.thinkingDelta.length > 0) {
            yield { type: "thinking", delta: part.thinkingDelta };
          }
          if (part.toolCallDelta) {
            const delta = part.toolCallDelta;
            let entry = toolCallAcc.get(delta.index);
            if (!entry) {
              entry = { id: "", name: "", arguments: "" };
              toolCallAcc.set(delta.index, entry);
            }
            if (delta.id) {
              entry.id = delta.id;
            }
            if (delta.functionName) {
              entry.name = delta.functionName;
            }
            if (delta.functionArguments) {
              entry.arguments += delta.functionArguments;
            }
            // Yield a tool_use chunk when we have both name and arguments
            if (entry.name && entry.arguments) {
              try {
                JSON.parse(entry.arguments);
                yield {
                  type: "tool_use",
                  id: entry.id || `call_${delta.index}`,
                  name: entry.name,
                  input: entry.arguments,
                };
                // Remove so we don't yield again
                toolCallAcc.delete(delta.index);
              } catch {
                // Arguments not yet complete JSON
              }
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
          const payload = trimmed.slice(6);
          const part = parseOpenAiChatCompletionStreamDataPayload(payload);
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
          if (part.usage !== undefined) {
            lastUsage = part.usage;
          }
          if (part.finishReason !== undefined) {
            lastFinishReason = part.finishReason;
          }
        }
      }
    } finally {
      reader.releaseLock();
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
): Array<{ name: string; arguments: string }> {
  if (message === null || typeof message !== "object") {
    return [];
  }
  const m = message as Record<string, unknown>;
  const toolCalls = m.tool_calls;
  if (!Array.isArray(toolCalls)) {
    return [];
  }
  const out: Array<{ name: string; arguments: string }> = [];
  for (const tc of toolCalls) {
    if (tc === null || typeof tc !== "object") {
      continue;
    }
    const t = tc as Record<string, unknown>;
    const fn = t.function;
    if (fn === null || typeof fn !== "object") {
      continue;
    }
    const f = fn as Record<string, unknown>;
    const name = typeof f.name === "string" ? f.name : "";
    const args = typeof f.arguments === "string" ? f.arguments : "";
    if (name) {
      out.push({ name, arguments: args });
    }
  }
  return out;
}
