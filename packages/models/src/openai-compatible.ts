import type { ModelTokenUsage } from "@paw/core";

import type { LanguageModel } from "./language-model.js";
import type { ModelCompleteOptions } from "./model-options.js";
import {
  parseOpenAiChatCompletionStreamDataPayload,
  parseOpenAiUsageJson,
} from "./openai-stream-parse.js";
import type {
  ChatMessage,
  ModelCompletionResult,
  ModelStreamChunk,
} from "./types.js";

export interface OpenAICompatibleOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly model: string;
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
    this.label = `openai:${opts.model}`;
  }

  async complete(
    messages: readonly ChatMessage[],
    options?: ModelCompleteOptions,
  ): Promise<ModelCompletionResult> {
    if (options?.signal?.aborted) {
      throw abortError();
    }
    const url = `${this.baseUrl}/chat/completions`;
    const body = {
      model: this.model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      temperature: 0.2,
    };
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
    const first =
      Array.isArray(choices) &&
      choices[0] !== null &&
      typeof choices[0] === "object"
        ? (choices[0] as Record<string, unknown>).message
        : undefined;
    const content =
      first !== null && typeof first === "object"
        ? (first as Record<string, unknown>).content
        : undefined;
    let text = typeof content === "string" ? content : "";

    // If the model returned tool_calls, convert them to JSON tool lines
    const toolCalls = extractOpenAiToolCalls(first);
    if (toolCalls.length > 0) {
      const toolLines = toolCalls
        .map((tc) => {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(tc.arguments) as Record<string, unknown>;
          } catch {
            /* ignore parse errors */
          }
          return JSON.stringify({ tool: tc.name, args });
        })
        .join("\n");
      text = text ? `${text}\n${toolLines}` : toolLines;
    }

    const usage = parseOpenAiUsageJson(root?.usage);
    return { text, ...(usage !== undefined ? { usage } : {}) };
  }

  async *completeStream(
    messages: readonly ChatMessage[],
    options?: ModelCompleteOptions,
  ): AsyncIterable<ModelStreamChunk> {
    if (options?.signal?.aborted) {
      throw abortError();
    }
    const url = `${this.baseUrl}/chat/completions`;
    const messagesPayload = messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));
    const baseStreamBody = {
      model: this.model,
      messages: messagesPayload,
      temperature: 0.2,
      stream: true as const,
    };
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
                const args = JSON.parse(entry.arguments) as Record<
                  string,
                  unknown
                >;
                yield {
                  type: "tool_use",
                  id: entry.id || `call_${delta.index}`,
                  name: entry.name,
                  input: JSON.stringify({ tool: entry.name, args }),
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
          if (part.usage !== undefined) {
            lastUsage = part.usage;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
    yield {
      type: "done",
      ...(lastUsage !== undefined ? { usage: lastUsage } : {}),
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
