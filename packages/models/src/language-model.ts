import type { ModelCompleteOptions } from "./model-options.js";
import type {
  ChatMessage,
  ModelCompletionResult,
  ModelStreamChunk,
} from "./types.js";

/** Declares what a model supports — context window, max output, etc. */
export interface ModelCapabilities {
  readonly contextWindow: number;
  readonly maxOutputTokens?: number;
}

/** Pluggable LLM — orchestrator depends only on this surface. */
export interface LanguageModel {
  readonly label: string;
  /** Model capabilities for dynamic context-window sizing. Defaults to 128K when absent. */
  readonly capabilities?: ModelCapabilities;
  complete(
    messages: readonly ChatMessage[],
    options?: ModelCompleteOptions,
  ): Promise<ModelCompletionResult>;
  /**
   * Optional incremental generation. When implemented, orchestrator prefers this
   * over {@link complete} for `model.chunk` streaming.
   */
  completeStream?(
    messages: readonly ChatMessage[],
    options?: ModelCompleteOptions,
  ): AsyncIterable<ModelStreamChunk>;
}
