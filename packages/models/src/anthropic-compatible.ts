import type { ModelTokenUsage } from "@paw/core";

import type { LanguageModel, ModelCapabilities } from "./language-model.js";
import {
  buildAnthropicUserContent,
  type AnthropicContentBlock,
} from "./message-content.js";
import type { ModelCompleteOptions } from "./model-options.js";
import type {
  ChatMessage,
  ModelCompletionResult,
  ModelStreamChunk,
} from "./types.js";

export interface AnthropicCompatibleOptions {
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

/** Convert Paw ChatMessage[] to Anthropic message format. */
function toAnthropicMessages(messages: readonly ChatMessage[]): {
  system: string | undefined;
  messages: Array<{
    role: "user" | "assistant";
    content: string | AnthropicContentBlock[];
  }>;
} {
  let system: string | undefined;
  const out: Array<{
    role: "user" | "assistant";
    content: string | AnthropicContentBlock[];
  }> = [];
  for (const m of messages) {
    if (m.role === "system") {
      system = system ? `${system}\n\n${m.content}` : m.content;
    } else if (m.role === "user") {
      out.push({ role: "user", content: buildAnthropicUserContent(m) });
    } else {
      out.push({ role: "assistant", content: m.content });
    }
  }
  return { system, messages: out };
}

/**
 * Minimal Anthropic Messages API client (HTTPS fetch).
 * Supports text, thinking blocks, and tool_use blocks.
 */
export class AnthropicCompatibleModel implements LanguageModel {
  readonly label: string;
  readonly capabilities?: ModelCapabilities;
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
      max_tokens: this.capabilities?.maxOutputTokens ?? 4096,
    };
    if (system) {
      body.system = system;
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
    const { text, thinking } = extractAnthropicContent(root);
    const usage = parseAnthropicUsage(root?.usage);
    const finishReason =
      typeof root?.stop_reason === "string" ? root.stop_reason : undefined;
    const result: ModelCompletionResult = {
      text,
      ...(usage !== undefined ? { usage } : {}),
      ...(thinking ? { thinking } : {}),
      ...(finishReason ? { finishReason } : {}),
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
      max_tokens: this.capabilities?.maxOutputTokens ?? 4096,
      stream: true,
    };
    if (system) {
      body.system = system;
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
    let currentToolUse: { id: string; name: string; input: string } | null =
      null;
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
          if (part.textDelta.length > 0) {
            yield { type: "text", delta: part.textDelta };
          }
          if (part.thinkingDelta.length > 0) {
            yield { type: "thinking", delta: part.thinkingDelta };
          }
          if (part.toolUseStart) {
            currentToolUse = {
              id: part.toolUseStart.id,
              name: part.toolUseStart.name,
              input: "",
            };
          }
          if (part.toolUseDelta && currentToolUse) {
            currentToolUse.input += part.toolUseDelta;
          }
          if (part.toolUseStop && currentToolUse) {
            yield {
              type: "tool_use",
              id: currentToolUse.id,
              name: currentToolUse.name,
              input: currentToolUse.input,
            };
            currentToolUse = null;
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
          const part = parseAnthropicStreamPayload(payload);
          if (part.textDelta.length > 0) {
            yield { type: "text", delta: part.textDelta };
          }
          if (part.thinkingDelta.length > 0) {
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

function extractAnthropicContent(root: Record<string, unknown> | null): {
  text: string;
  thinking?: string;
} {
  const content = root?.content;
  if (!Array.isArray(content)) {
    return { text: "" };
  }
  const textParts: string[] = [];
  const thinkingParts: string[] = [];
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
      }
    }
  }
  const result: { text: string; thinking?: string } = {
    text: textParts.join(""),
  };
  if (thinkingParts.length > 0) {
    result.thinking = thinkingParts.join("");
  }
  return result;
}

function parseAnthropicUsage(raw: unknown): ModelTokenUsage | undefined {
  if (raw === null || typeof raw !== "object") {
    return undefined;
  }
  const u = raw as Record<string, unknown>;
  const inputTokens = pickNum(u.input_tokens ?? u.promptTokens);
  const outputTokens = pickNum(u.output_tokens ?? u.completionTokens);
  if (inputTokens === undefined && outputTokens === undefined) {
    return undefined;
  }
  return {
    ...(inputTokens !== undefined ? { promptTokens: inputTokens } : {}),
    ...(outputTokens !== undefined ? { completionTokens: outputTokens } : {}),
  };
}

function parseAnthropicStreamPayload(raw: string): {
  readonly textDelta: string;
  readonly thinkingDelta: string;
  readonly toolUseStart?: { id: string; name: string };
  readonly toolUseDelta?: string;
  readonly toolUseStop: boolean;
  readonly usage?: ModelTokenUsage;
  readonly finishReason?: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { textDelta: "", thinkingDelta: "", toolUseStop: false };
  }
  const root =
    parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  if (!root) {
    return { textDelta: "", thinkingDelta: "", toolUseStop: false };
  }

  const type = root.type;

  // message_delta carries usage + stop_reason at end of stream
  if (type === "message_delta" || type === "message_stop") {
    const usage = parseAnthropicUsage(root.usage);
    const finishReason =
      typeof root.stop_reason === "string" ? root.stop_reason : undefined;
    return {
      textDelta: "",
      thinkingDelta: "",
      toolUseStop: false,
      ...(usage !== undefined ? { usage } : {}),
      ...(finishReason ? { finishReason } : {}),
    };
  }

  // content_block_start signals beginning of a block
  if (type === "content_block_start") {
    const contentBlock = root.content_block;
    if (
      contentBlock !== null &&
      typeof contentBlock === "object" &&
      (contentBlock as Record<string, unknown>).type === "tool_use"
    ) {
      const cb = contentBlock as Record<string, unknown>;
      const id = typeof cb.id === "string" ? cb.id : "";
      const name = typeof cb.name === "string" ? cb.name : "";
      return {
        textDelta: "",
        thinkingDelta: "",
        toolUseStart: { id, name },
        toolUseStop: false,
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
        toolUseStop: false,
      };
    }
    return { textDelta: "", thinkingDelta: "", toolUseStop: false };
  }

  // content_block_delta carries deltas
  if (type === "content_block_delta") {
    const delta = root.delta;
    if (delta !== null && typeof delta === "object") {
      const d = delta as Record<string, unknown>;
      // text delta
      const text = d.text;
      if (typeof text === "string") {
        return {
          textDelta: text,
          thinkingDelta: "",
          toolUseStop: false,
        };
      }
      // thinking delta
      const thinking = d.thinking;
      if (typeof thinking === "string") {
        return {
          textDelta: "",
          thinkingDelta: thinking,
          toolUseStop: false,
        };
      }
      // tool_use partial_json delta
      const partialJson = d.partial_json;
      if (typeof partialJson === "string") {
        return {
          textDelta: "",
          thinkingDelta: "",
          toolUseDelta: partialJson,
          toolUseStop: false,
        };
      }
    }
  }

  // content_block_stop signals end of a block
  if (type === "content_block_stop") {
    return { textDelta: "", thinkingDelta: "", toolUseStop: true };
  }

  return { textDelta: "", thinkingDelta: "", toolUseStop: false };
}

function pickNum(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) {
    return v;
  }
  return undefined;
}
