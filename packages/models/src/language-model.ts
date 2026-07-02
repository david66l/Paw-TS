/**
 * LanguageModel 接口 — 可插拔的 LLM 抽象。
 * =========================================
 *
 * 这是 orchestrator 与 LLM 之间的唯一接口。任何实现了此接口的模型
 * 都可以被 AgentOrchestrator 使用。
 *
 * 设计原则：
 * - 最小接口：只有 label + complete + 可选的 completeStream
 * - completeStream 是可选的：不支持流式的模型通过 complete 也能工作
 * - capabilities 也是可选的：未提供时默认 contextWindow = 128K
 *
 * 面试要点：
 * - 为什么要把 LLM 抽象为接口？方便测试（fake-model.ts 实现了此接口），
 *   方便切换 provider（Anthropic/OpenAI/Ollama 都实现同一个接口）
 */

import type { ModelCompleteOptions } from "./model-options.js";
import type {
  ChatMessage,
  ModelCompletionResult,
  ModelStreamChunk,
} from "./types.js";

/** 声明模型的能力 — 上下文窗口、最大输出等。 */
export interface ModelCapabilities {
  readonly contextWindow: number;
  readonly maxOutputTokens?: number;
}

/** 可插拔的 LLM — orchestrator 只依赖此接口。 */
export interface LanguageModel {
  /** 人类可读的模型标识（如 "claude-sonnet-4-6"） */
  readonly label: string;
  /** 模型能力，用于动态上下文窗口大小。缺失时默认 128K。 */
  readonly capabilities?: ModelCapabilities;
  /** 非流式调用：发送消息，等待完整响应 */
  complete(
    messages: readonly ChatMessage[],
    options?: ModelCompleteOptions,
  ): Promise<ModelCompletionResult>;
  /**
   * 可选的增量生成。当实现时，orchestrator 优先使用此方法
   * 而非 complete，用于 model.chunk 流式输出到 TUI。
   */
  completeStream?(
    messages: readonly ChatMessage[],
    options?: ModelCompleteOptions,
  ): AsyncIterable<ModelStreamChunk>;
}
