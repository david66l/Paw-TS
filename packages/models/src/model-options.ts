/**
 * 模型调用选项的类型定义
 *
 * ## 是什么
 * 定义一次 LLM 调用所需的配置参数类型，包括工具定义和取消信号。
 *
 * ## 为什么需要
 * 1. **统一接口**：不同提供商（OpenAI、Anthropic 等）的原生工具调用格式不同，
 *    ToolDefinition 提供了一层抽象，将工具定义标准化为 OpenAI 兼容的函数格式。
 * 2. **取消支持**：通过 AbortSignal 允许上游在模型调用中途取消（如用户按 Ctrl+C），
 *    避免浪费 API 调用配额。
 * 3. **类型安全**：所有模型实现的 complete/completeStream 方法使用统一的选项类型，
 *    确保接口一致性。
 *
 * ## 关键设计决策
 * - ToolDefinition 采用 OpenAI 的函数调用格式作为标准：
 *   `{type:"function", function:{name, description, parameters}}`
 *   这是目前业界最广泛支持的工具调用格式，Anthropic、DeepSeek、Qwen 等均可兼容此格式。
 */

/**
 * OpenAI 兼容的函数工具定义。
 *
 * `parameters` 使用 JSON Schema 格式描述函数的输入参数结构，
 * 例如：`{type:"object", properties:{path:{type:"string"}}, required:["path"]}`
 */
export interface ToolDefinition {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
}

/** 单次模型完成调用的选项 */
export interface ModelCompleteOptions {
  /** 用于取消正在进行的模型请求的 AbortSignal */
  readonly signal?: AbortSignal;
  /**
   * 工具定义列表，供支持原生函数调用（native function calling）的提供商使用。
   * 不支持的提供商可以忽略此字段。
   */
  readonly tools?: readonly ToolDefinition[];
}
