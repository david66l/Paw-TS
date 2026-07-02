/**
 * models 包的公共导出入口
 *
 * ## 概述
 * 本包是 Paw 项目的 LLM 抽象层，提供统一的模型接口和多种模型实现。
 * 所有对外暴露的类型和函数均在此文件集中 re-export，外部使用者只需
 * `import { ... } from "@paw/models"` 即可获取所需的一切。
 *
 * ## 导出分类
 * - **消息内容构建**：buildAnthropicUserContent / buildOpenAiMessageContent
 * - **模型工厂**：createDefaultLanguageModel / createDeepSeekFlashModel
 * - **模型实现**：FakeLanguageModel / OpenAICompatibleModel / AnthropicCompatibleModel
 * - **类型定义**：LanguageModel, ModelCapabilities, ChatMessage, Attachment 等
 */

// ── 消息内容构建 ──
export {
  buildAnthropicUserContent,
  buildOpenAiMessageContent,
} from "./message-content.js";
export type {
  AnthropicContentBlock,
  OpenAiContentPart,
} from "./message-content.js";

// ── 模型工厂 ──
export { createDefaultLanguageModel } from "./default-model.js";
export { createDeepSeekFlashModel } from "./auxiliary-model.js";

// ── 模型实现 ──
export { FakeLanguageModel } from "./fake-model.js";
export type { FakeModelResponse } from "./fake-model.js";
export { OpenAICompatibleModel } from "./openai-compatible.js";
export type { OpenAICompatibleOptions } from "./openai-compatible.js";
export { AnthropicCompatibleModel } from "./anthropic-compatible.js";
export type { AnthropicCompatibleOptions } from "./anthropic-compatible.js";

// ── 核心类型 ──
export type { LanguageModel, ModelCapabilities } from "./language-model.js";
export type { ModelCompleteOptions, ToolDefinition } from "./model-options.js";
export type {
  Attachment,
  ChatMessage,
  ChatRole,
  ModelCompletionResult,
  ModelStreamChunk,
  NativeToolCall,
} from "./types.js";

// ── 工具函数 ──
export { extractThinkBlocks } from "./think-extraction.js";
