/** Token accounting from the model provider (when available). */
export interface ModelTokenUsage {
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens?: number;
  /** Tokens served from the provider's prefix cache (DeepSeek / Anthropic / OpenAI). */
  readonly cachedPromptTokens?: number;
}
