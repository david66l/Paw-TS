/**
 * OpenAI 兼容的 SSE（Server-Sent Events）流式响应解析器
 *
 * ## 是什么
 * 解析 OpenAI Chat Completions API 流式响应中的每一条 `data:` 载荷（SSE chunk），
 * 提取文本增量（delta）、思考内容（thinking）、工具调用片段（tool_call）、
 * token 用量和使用终止原因等信息。
 *
 * ## 为什么需要
 * 1. **流式输出**：LLM 的流式响应以 SSE 格式逐块到达，每块是一个 JSON 对象。
 *    本模块负责将原始 JSON 解析为结构化的、类型安全的结果对象。
 * 2. **思考内容提取**：某些模型（如 Qwen 系列）在 content 字段中嵌入
 *    `<think>...</think>` 标签作为推理链。本模块自动分离思考内容和输出文本。
 * 3. **推理模型的 reasoning_content**：OpenAI o1/o3/o4 等模型使用独立的
 *    `reasoning_content` 字段，本模块将其合并到 thinkingDelta 中。
 * 4. **工具调用流式聚合**：流式响应中的 tool_calls 是逐 chunk 到达的
 *    （先发 id/name，再发 arguments 片段），本模块负责提取每个 chunk 的增量信息。
 *
 * ## 关键设计决策
 * 1. **格式兼容**：同时支持 OpenAI 原生格式、DeepSeek 格式、Qwen DashScope 格式
 *    ——它们都遵循 OpenAI 兼容的 choices[0].delta 结构。
 * 2. **[DONE] 标记**：流结束时 SSE 会发送 `data: [DONE]` 行，解析为 isDoneMarker=true
 * 3. **防御性解析**：JSON 解析失败不抛异常，返回空结果（textDelta=""）
 * 4. **可选字段合并**：使用展开运算符 + 条件判断，只在字段有值时才包含在返回对象中
 * 5. **cache token 统计**：从 prompt_tokens_details.cached_tokens 中提取缓存命中 token 数
 *    （OpenAI/DeepSeek 兼容的 prompt caching 功能）
 *
 * @see https://platform.openai.com/docs/api-reference/chat/streaming
 */

import type { ModelTokenUsage } from "@paw/core";
import { extractThinkBlocks } from "./think-extraction.js";

/**
 * 流式工具调用的增量片段。
 * 在流式传输中，工具调用信息分多个 chunk 到达：
 * 第一个 chunk 包含 index、id、type、function.name；
 * 后续 chunk 包含 function.arguments 的增量片段。
 */
export interface OpenAiToolCallDelta {
  readonly index: number;
  readonly id?: string;
  readonly type?: string;
  readonly functionName?: string;
  readonly functionArguments?: string;
}

/**
 * 解析 OpenAI 风格 Chat Completions SSE 流中的一条 `data:` 载荷。
 *
 * 从原始 JSON 字符串中提取：
 * - 文本增量（经过 `<think>` 标签剥离）
 * - 思考内容增量（从 `<think>` 标签或 reasoning_content 字段）
 * - 工具调用增量
 * - token 用量信息
 * - 终止原因（finish_reason）
 * - 流结束标记（isDoneMarker）
 *
 * @param raw - SSE 事件中的 data 字段原始字符串（不含 "data: " 前缀）
 * @returns 结构化的解析结果，所有字段默认为空/undefined
 */
export function parseOpenAiChatCompletionStreamDataPayload(raw: string): {
  readonly textDelta: string;
  readonly thinkingDelta?: string;
  readonly usage?: ModelTokenUsage;
  readonly isDoneMarker: boolean;
  readonly finishReason?: string;
  readonly toolCallDelta?: OpenAiToolCallDelta;
} {
  const t = raw.trim();
  // ── 流结束标记 ──
  if (t === "[DONE]") {
    return { textDelta: "", isDoneMarker: true };
  }
  // ── JSON 解析（防御性：失败时返回空结果，不抛异常） ──
  let parsed: unknown;
  try {
    parsed = JSON.parse(t);
  } catch {
    return { textDelta: "", isDoneMarker: false };
  }
  const root =
    parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  if (!root) {
    return { textDelta: "", isDoneMarker: false };
  }
  let textDelta = "";
  let thinkingDelta: string | undefined;
  let toolCallDelta: OpenAiToolCallDelta | undefined;
  let finishReason: string | undefined;

  // ── 解析 choices[0] ──
  const choices = root.choices;
  if (
    Array.isArray(choices) &&
    choices[0] !== null &&
    typeof choices[0] === "object"
  ) {
    const c0 = choices[0] as Record<string, unknown>;
    // 提取终止原因
    const fr = c0.finish_reason;
    if (typeof fr === "string" && fr) {
      finishReason = fr;
    }
    // 提取 delta 内容
    const delta = c0.delta;
    if (delta !== null && typeof delta === "object") {
      const d = delta as Record<string, unknown>;
      // 文本内容：经过 <think> 标签剥离
      const content = d.content;
      if (typeof content === "string") {
        const extracted = extractThinkBlocks(content);
        textDelta = extracted.text;
        if (extracted.thinking) {
          thinkingDelta = extracted.thinking;
        }
      }
      // reasoning_content：OpenAI o1/o3 等推理模型的思考链
      const reasoning = d.reasoning_content;
      if (typeof reasoning === "string") {
        thinkingDelta = thinkingDelta
          ? `${thinkingDelta}\n\n${reasoning}`
          : reasoning;
      }
      // 工具调用增量
      const toolCalls = d.tool_calls;
      if (Array.isArray(toolCalls) && toolCalls.length > 0) {
        toolCallDelta = parseToolCallDelta(toolCalls[0]);
      }
    }
  }

  // ── 解析 usage（token 用量统计） ──
  const usage = parseOpenAiUsageJson(root.usage);

  // 使用展开运算符构建返回对象，可选字段只在有值时出现
  return {
    textDelta,
    ...(thinkingDelta !== undefined ? { thinkingDelta } : {}),
    ...(usage !== undefined ? { usage } : {}),
    isDoneMarker: false,
    ...(finishReason !== undefined ? { finishReason } : {}),
    ...(toolCallDelta !== undefined ? { toolCallDelta } : {}),
  };
}

/**
 * 从流式 delta 中解析单个工具调用的增量信息。
 *
 * 流式工具调用的典型传输过程：
 * Chunk 1: {index:0, id:"call_xxx", type:"function", function:{name:"read_file", arguments:""}}
 * Chunk 2: {index:0, function:{arguments:"{\"path"}}
 * Chunk 3: {index:0, function:{arguments:"\":\"/foo/bar\"}"}}
 *
 * 本函数提取每个 chunk 中的 index/id/type/functionName/functionArguments，
 * 如果所有可选字段都为空则返回 undefined（避免无效的 tool call delta）。
 */
function parseToolCallDelta(raw: unknown): OpenAiToolCallDelta | undefined {
  if (raw === null || typeof raw !== "object") {
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  const index = typeof obj.index === "number" ? obj.index : 0;
  const id = typeof obj.id === "string" ? obj.id : undefined;
  const type = typeof obj.type === "string" ? obj.type : undefined;
  const fn = obj.function;
  let functionName: string | undefined;
  let functionArguments: string | undefined;
  if (fn !== null && typeof fn === "object") {
    const f = fn as Record<string, unknown>;
    if (typeof f.name === "string") {
      functionName = f.name;
    }
    if (typeof f.arguments === "string") {
      functionArguments = f.arguments;
    }
  }
  // 所有可选字段都为空 → 无效的 tool call，返回 undefined
  if (
    id === undefined &&
    type === undefined &&
    functionName === undefined &&
    functionArguments === undefined
  ) {
    return undefined;
  }
  return {
    index,
    ...(id !== undefined ? { id } : {}),
    ...(type !== undefined ? { type } : {}),
    ...(functionName !== undefined ? { functionName } : {}),
    ...(functionArguments !== undefined ? { functionArguments } : {}),
  };
}

/**
 * 解析 OpenAI 兼容 API 返回的 token 用量对象（usage）。
 *
 * 同时兼容 camelCase 和 snake_case 两种命名风格：
 * - OpenAI 官方：`prompt_tokens`, `completion_tokens`, `total_tokens`
 * - 某些兼容实现：`promptTokens`, `completionTokens`, `totalTokens`
 *
 * 额外解析 `prompt_tokens_details.cached_tokens` 用于追踪 prompt caching 的命中量
 * （OpenAI/DeepSeek 兼容的缓存功能）。
 *
 * @param raw - usage 字段的原始 JSON 值
 * @returns 结构化的 token 用量对象，若无法解析则返回 undefined
 */
export function parseOpenAiUsageJson(
  raw: unknown,
): ModelTokenUsage | undefined {
  if (raw === null || typeof raw !== "object") {
    return undefined;
  }
  const u = raw as Record<string, unknown>;
  // 同时支持 snake_case 和 camelCase
  const promptTokens = pickNum(u.prompt_tokens ?? u.promptTokens);
  const completionTokens = pickNum(u.completion_tokens ?? u.completionTokens);
  const totalTokens = pickNum(u.total_tokens ?? u.totalTokens);
  if (
    promptTokens === undefined &&
    completionTokens === undefined &&
    totalTokens === undefined
  ) {
    return undefined;
  }
  // 提取 prompt_tokens_details 中的缓存 token 数（OpenAI / DeepSeek 兼容）
  let cachedPromptTokens: number | undefined;
  const details = u.prompt_tokens_details ?? u.promptTokensDetails;
  if (details !== null && typeof details === "object") {
    const d = details as Record<string, unknown>;
    cachedPromptTokens = pickNum(d.cached_tokens ?? d.cachedTokens);
  }
  return {
    ...(promptTokens !== undefined ? { promptTokens } : {}),
    ...(completionTokens !== undefined ? { completionTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(cachedPromptTokens !== undefined ? { cachedPromptTokens } : {}),
  };
}

/**
 * 安全地从 unknown 值中提取有限数字。
 * 只接受 number 类型且为有限值，排除 NaN、Infinity、-Infinity。
 */
function pickNum(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) {
    return v;
  }
  return undefined;
}
