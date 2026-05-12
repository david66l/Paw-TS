import type { ModelCompleteOptions } from "./model-options.js";
import type {
  ChatMessage,
  ModelCompletionResult,
  ModelStreamChunk,
} from "./types.js";

/** Pluggable LLM — orchestrator depends only on this surface. */
export interface LanguageModel {
  readonly label: string;
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
