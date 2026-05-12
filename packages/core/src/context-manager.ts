/**
 * Context manager: sliding-window message history with truncation.
 *
 * Keeps the system message + the most recent N messages when the
 * conversation grows beyond configured limits.
 */

import { pruneToolResults, type PruneConfig, type PruneResult } from "./context-pruner.js";
import { estimateMessagesTokens } from "./token-estimate.js";

export interface Attachment {
  readonly type: "image" | "file";
  readonly name: string;
  readonly content: string;
  readonly mimeType?: string;
}

export interface ContextManagerOptions {
  /** Max messages to retain (excluding system). Oldest non-system dropped first. */
  readonly maxMessages?: number;
  /** Approx max characters across all messages before truncation. */
  readonly maxChars?: number;
  /** Approx max tokens before truncation. When set, takes priority over maxChars. */
  readonly maxTokens?: number;
}

export class ContextManager {
  private systemMessage: ChatMessage | null = null;
  private history: ChatMessage[] = [];
  private readonly maxMessages: number;
  private readonly maxChars: number;
  private readonly maxTokens: number | null;

  constructor(opts?: ContextManagerOptions) {
    this.maxMessages = opts?.maxMessages ?? 40;
    this.maxChars = opts?.maxChars ?? 80_000;
    this.maxTokens = opts?.maxTokens ?? null;
  }

  /** Set or replace the system message. */
  setSystem(content: string): void {
    this.systemMessage = { role: "system", content };
  }

  /** Append a user message (optionally with attachments). */
  addUser(content: string, attachments?: readonly Attachment[]): void {
    const msg: ChatMessage =
      attachments && attachments.length > 0
        ? { role: "user", content, attachments }
        : { role: "user", content };
    this.history.push(msg);
    this.maybeTruncate();
  }

  /** Append an assistant message (optionally with thinking content). */
  addAssistant(content: string, thinking?: string): void {
    const msg: ChatMessage = thinking
      ? { role: "assistant", content, thinking }
      : { role: "assistant", content };
    this.history.push(msg);
    this.maybeTruncate();
  }

  /** Append a tool-result observation as a user message. */
  addToolResult(tool: string, ok: boolean, summary: string, payload?: unknown): void {
    const detail = payload !== undefined ? `\n${JSON.stringify(payload).slice(0, 10_000)}` : "";
    this.history.push({
      role: "user",
      content: `Tool result (${tool}): ${ok ? "OK" : "FAIL"} — ${summary}${detail}`,
    });
    this.maybeTruncate();
  }

  /** Append multiple tool-result observations as a single user message. */
  addToolResults(
    results: ReadonlyArray<{ tool: string; ok: boolean; summary: string; payload?: unknown }>,
  ): void {
    const lines = results.map((r) => {
      const detail = r.payload !== undefined ? `\n${JSON.stringify(r.payload).slice(0, 10_000)}` : "";
      return `Tool result (${r.tool}): ${r.ok ? "OK" : "FAIL"} — ${r.summary}${detail}`;
    });
    this.history.push({
      role: "user",
      content: lines.join("\n\n"),
    });
    this.maybeTruncate();
  }

  /** Replace the entire history (e.g. for replay / restore). */
  replaceHistory(messages: readonly ChatMessage[]): void {
    const sys = messages.find((m) => m.role === "system");
    if (sys) {
      this.systemMessage = sys;
    }
    this.history = messages.filter((m) => m.role !== "system").map((m) => ({ ...m }));
    this.maybeTruncate();
  }

  /** Return the full conversation for the model (system + history). */
  buildMessages(): ChatMessage[] {
    const out: ChatMessage[] = [];
    if (this.systemMessage) {
      out.push(this.systemMessage);
    }
    out.push(...this.history);
    return out;
  }

  /** Current message count excluding system. */
  get length(): number {
    return this.history.length;
  }

  /** Total approximate character count. */
  get charCount(): number {
    let n = 0;
    if (this.systemMessage) {
      n += this.systemMessage.content.length;
    }
    for (const m of this.history) {
      n += m.content.length;
      if (m.thinking) {
        n += m.thinking.length;
      }
    }
    return n;
  }

  /** Estimated token count for the full conversation (system + history). */
  get estimatedTokens(): number {
    const messages = this.buildMessages();
    return estimateMessagesTokens(messages);
  }

  /**
   * Prune old tool results to free context space.
   * Zero LLM calls — pure text manipulation.
   */
  prune(config?: PruneConfig): PruneResult {
    const result = pruneToolResults(this.history, config);
    if (result.pruned) {
      this.history = result.messages;
    }
    return result;
  }

  private maybeTruncate(): void {
    // First truncate by message count
    while (this.history.length > this.maxMessages) {
      this.history.shift();
    }
    // Then truncate by token count if configured, otherwise by character count
    if (this.maxTokens !== null) {
      let tokens = this.estimatedTokens;
      while (tokens > this.maxTokens && this.history.length > 1) {
        const removed = this.history.shift();
        if (removed) {
          tokens -= estimateMessagesTokens([removed]);
        }
      }
    } else {
      // Fall back to character count
      let chars = this.charCount;
      while (chars > this.maxChars && this.history.length > 1) {
        const removed = this.history.shift();
        if (removed) {
          chars -= removed.content.length;
          if (removed.thinking) {
            chars -= removed.thinking.length;
          }
        }
      }
    }
  }
}

/** Rich message type supporting thinking blocks and attachments. */
export interface ChatMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
  /** Thinking/reasoning content from models that support it (e.g. Claude extended thinking). */
  readonly thinking?: string;
  /** Attachments for user messages (images, files, etc.). */
  readonly attachments?: readonly Attachment[];
}
