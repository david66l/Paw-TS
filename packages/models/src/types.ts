/**
 * 模型类型定义：消息、结果、流式块、原生工具调用。
 * =================================================
 *
 * 这些是 orchestrator 和 language-model 之间交换的核心数据类型。
 *
 * ChatMessage：富文本消息，支持 thinking 块和附件。
 * ModelCompletionResult：非流式调用的完整响应。
 * ModelStreamChunk：流式调用的增量块（联合类型，通过 type 字段区分）。
 * NativeToolCall：provider 原生返回的工具调用（非文本解析）。
 */

import type { ModelTokenUsage } from "@paw/core";

export type ChatRole = "system" | "user" | "assistant";

/** 用户消息的文件或图片附件。 */
export interface Attachment {
  readonly type: "image" | "file";
  readonly name: string;
  readonly content: string;
  readonly mimeType?: string;
}

/**
 * 富文本消息类型：支持 thinking 块、附件和进度。
 * 向后兼容：旧代码使用 {role, content} 仍然有效。
 */
export interface ChatMessage {
  readonly role: ChatRole;
  readonly content: string;
  /** 推理/思考内容（来自支持 extended thinking 的模型，如 Claude）。 */
  readonly thinking?: string;
  /** 用户消息的附件（图片、文件等）。 */
  readonly attachments?: readonly Attachment[];
}

/** 非流式模型调用结果。 */
export interface ModelCompletionResult {
  readonly text: string;
  readonly usage?: ModelTokenUsage;
  /** 模型产生的 thinking 内容。 */
  readonly thinking?: string;
  /** Provider 的 finish/stop reason。"length" 或 "max_tokens" 表示输出被截断。 */
  readonly finishReason?: string;
  /** 原生结构化工具调用（当 provider 支持 function calling 时）。 */
  readonly toolCalls?: readonly NativeToolCall[];
}

/** 模型 provider 原生返回的工具调用（非文本解析）。 */
export interface NativeToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

/**
 * 流式增量块 + 终止 done 块。
 *
 * - text：文本增量
 * - thinking：推理增量（Claude extended thinking）
 * - tool_use：实时工具调用片段（原生 function calling）
 * - done：流结束 + token 用量
 */
export type ModelStreamChunk =
  | { readonly type: "text"; readonly delta: string }
  | { readonly type: "thinking"; readonly delta: string }
  | { readonly type: "tool_use"; readonly id: string; readonly name: string; readonly input: string }
  | { readonly type: "done"; readonly usage?: ModelTokenUsage; readonly finishReason?: string };
