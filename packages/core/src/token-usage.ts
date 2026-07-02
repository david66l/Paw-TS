/**
 * 模型提供方返回的 token 用量统计（当可用时）
 * Token accounting from the model provider (when available).
 *
 * ============================================================================
 * 模块职责 (Module Purpose)
 * ============================================================================
 * 本模块定义了从 LLM 模型提供方（DeepSeek / Anthropic / OpenAI）返回的
 * token 使用量数据结构。
 *
 * 设计要点：
 * - 所有字段都是可选的（readonly），因为并非所有模型提供方都返回完整的
 *   token 统计信息。
 * - cachedPromptTokens 字段专门用于跟踪"前缀缓存命中"节省的 token 量。
 *   DeepSeek、Anthropic 和 OpenAI 都支持某种形式的前缀缓存（prompt caching），
 *   已缓存的 prompt token 通常按折扣价格计费。
 * - 这是一个纯数据接口，不包含任何逻辑，只定义数据形状。
 *
 * 架构定位：数据传输对象（DTO），位于模型 API 响应解析层和成本统计层之间。
 * ============================================================================
 */

/** 模型提供方的 token 用量统计。 */
export interface ModelTokenUsage {
  /** prompt（输入）消耗的 token 数 */
  readonly promptTokens?: number;
  /** completion（输出）消耗的 token 数 */
  readonly completionTokens?: number;
  /** 总 token 数（prompt + completion） */
  readonly totalTokens?: number;
  /**
   * 由提供方前缀缓存（DeepSeek / Anthropic / OpenAI）命中的 token 数。
   * 这些 token 通常按折扣价计费或免费。
   * Tokens served from the provider's prefix cache.
   */
  readonly cachedPromptTokens?: number;
}
