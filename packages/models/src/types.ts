import type { ModelTokenUsage } from "@paw/core";

export type ChatRole = "system" | "user" | "assistant";

/** File or image attachment for user messages. */
export interface Attachment {
  readonly type: "image" | "file";
  readonly name: string;
  readonly content: string;
  readonly mimeType?: string;
}

/**
 * Rich message type supporting thinking blocks, attachments, and progress.
 * Backwards-compatible: old code using {role,content} still works.
 */
export interface ChatMessage {
  readonly role: ChatRole;
  readonly content: string;
  /** Thinking/reasoning content from models that support it (e.g. Claude extended thinking). */
  readonly thinking?: string;
  /** Attachments for user messages (images, files, etc.). */
  readonly attachments?: readonly Attachment[];
}

export interface ModelCompletionResult {
  readonly text: string;
  readonly usage?: ModelTokenUsage;
  /** Thinking content when model produces it. */
  readonly thinking?: string;
}

/**
 * Streaming deltas + terminal `done` (usage when provider reports it).
 * `thinking` carries reasoning deltas; `tool_use` carries live tool-call fragments.
 */
export type ModelStreamChunk =
  | { readonly type: "text"; readonly delta: string }
  | { readonly type: "thinking"; readonly delta: string }
  | {
      readonly type: "tool_use";
      readonly id: string;
      readonly name: string;
      readonly input: string;
    }
  | { readonly type: "done"; readonly usage?: ModelTokenUsage };
