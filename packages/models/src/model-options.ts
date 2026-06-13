/** OpenAI-compatible function definition for native tool calling. */
export interface ToolDefinition {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
}

/** Options for a single model completion call. */
export interface ModelCompleteOptions {
  readonly signal?: AbortSignal;
  /** Tool definitions for providers that support native function calling. */
  readonly tools?: readonly ToolDefinition[];
}
