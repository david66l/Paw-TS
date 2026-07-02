/**
 * `[Tool <name> completed/failed]` 线格式的单一事实来源（Single Source of Truth）。
 * Single source of truth for the `[Tool <name> completed/failed]` wire format.
 *
 * ============================================================================
 * 模块职责 (Module Purpose)
 * ============================================================================
 * 本模块是工具执行结果的"序列化/反序列化"协议层，定义了统一的线格式：
 *
 *   [Tool <tool_name> completed|failed]
 *   <summary_line>
 *   <optional_detail>
 *
 * 所有需要读写这个格式的模块 —— 上下文管理器（context-manager）、上下文裁剪器
 * （context-pruner）、持久化工具结果存储（tool-result-storage）、记忆信号提取
 * （memory-query）—— 都通过本模块的格式化/解析函数操作，确保格式的一致性。
 *
 * 核心设计原则：
 * - **单一事实来源**：格式定义只存在于一处，任何格式变更只需修改本模块。
 * - **结构化与非结构化的桥梁**：将工具执行的结构化信息（工具名、成功/失败、
 *   摘要）打包为 LLM 可读的文本格式，同时支持反向解析。
 * - **多块支持**：一条消息可以包含多个 `[Tool ...]` 块（由连续的换行分隔），
 *   通过 splitToolBlocks 分离。
 *
 * 架构定位：协议层（Protocol），位于工具执行层和上下文管理层之间。
 * ============================================================================
 */

/**
 * 工具结果的结构化表示（输入格式）。
 * 由工具执行层构建，交给本模块格式化为文本。
 */
export interface ToolResultLine {
  /** 工具名称 */
  readonly tool: string;
  /** 工具是否执行成功 */
  readonly ok: boolean;
  /** 单行摘要信息 */
  readonly summary: string;
  /** 可选的附加数据（字符串或任意可序列化值） */
  readonly payload?: unknown;
}

/**
 * 工具结果的解析后表示（输出格式）。
 * 由本模块从文本中解析出来，供下游模块消费。
 */
export interface ParsedToolResult {
  /** 工具名称 */
  readonly tool: string;
  /** 工具是否执行成功 */
  readonly ok: boolean;
  /** 单行摘要 */
  readonly summary: string;
  /** 摘要行之后的详细内容 */
  readonly detail: string;
  /** 原始的完整内容（用于透传） */
  readonly originalContent: string;
}

/**
 * 匹配 `[Tool <name> completed|failed]\n...` 格式的正则表达式。
 * 使用 s 标志以支持跨行匹配（`.` 匹配换行符）。
 */
const TOOL_RESULT_RE = /^\[Tool (.+?) (completed|failed)\]\n(.+)/s;

/**
 * 用于拆分包含多个工具结果块的消息。
 * 匹配两个连续换行后紧跟 `[Tool ...]` 的位置。
 */
const TOOL_BLOCK_SPLIT = /\n\n(?=\[Tool .+? (?:completed|failed)\]\n)/;

/**
 * 格式化单个工具执行结果为线格式文本。
 *
 * 输出格式：
 *   [Tool <tool> completed|failed]
 *   <summary>
 *   <payload>
 *
 * 如果 payload 不是字符串，则用 JSON.stringify 序列化后截断为 10000 字符。
 *
 * Format a single tool result line.
 */
export function formatToolResult(line: ToolResultLine): string {
  let detail = "";
  if (line.payload !== undefined) {
    if (typeof line.payload === "string") {
      detail = `\n${line.payload}`;
    } else {
      // 序列化非字符串 payload，限制最大 10000 字符以防止撑爆上下文
      detail = `\n${JSON.stringify(line.payload).slice(0, 10_000)}`;
    }
  }
  return `[Tool ${line.tool} ${line.ok ? "completed" : "failed"}]\n${line.summary}${detail}`;
}

/**
 * 格式化多个工具结果为一条用户消息（多个 `[Tool ...]` 块以 `\n\n` 分隔）。
 *
 * Format multiple tool results as a single user message.
 */
export function formatToolResults(
  results: readonly ToolResultLine[],
): string {
  return results.map(formatToolResult).join("\n\n");
}

/**
 * 解析单个 `[Tool ...]` 块为其组件，如果不匹配则返回 null。
 *
 * 解析逻辑：
 * 1. 用正则提取工具名（group 1）、状态（group 2）、剩余内容（group 3）
 * 2. 剩余内容的第一行是 summary，之后的是 detail
 * 3. 保留 originalContent 以便下游透传原始文本
 *
 * Parse a `[Tool ...]` block into its components, or null if it doesn't match.
 */
export function parseToolResult(content: string): ParsedToolResult | null {
  const m = content.match(TOOL_RESULT_RE);
  if (!m) return null;
  const tool = m[1]!;
  const ok = m[2] === "completed";
  const rest = m[3] ?? "";
  // 第一个换行之前的是 summary，之后的是 detail
  const nlIdx = rest.indexOf("\n");
  const summary = nlIdx >= 0 ? rest.slice(0, nlIdx) : rest;
  const detail = nlIdx >= 0 ? rest.slice(nlIdx + 1) : "";
  return { tool, ok, summary, detail, originalContent: content };
}

/**
 * 拆分包含多个 `[Tool ...]` 块的消息为独立块数组。
 *
 * 拆分依据：两个或更多连续换行后紧跟着 `[Tool ...]` 的位置。
 * 如果消息不以 `[Tool ` 开头（即不是工具结果格式），返回空数组。
 *
 * Split a message that contains multiple `[Tool ...]` blocks.
 */
export function splitToolBlocks(content: string): string[] {
  if (!content.startsWith("[Tool ")) return [];
  return content.split(TOOL_BLOCK_SPLIT);
}

/**
 * 判断内容是否看起来像一个或多个格式化的工具结果。
 * 简单检查前缀 `[Tool `。
 *
 * True if the content looks like one or more formatted tool results.
 */
export function isToolResultMessage(content: string): boolean {
  return content.startsWith("[Tool ");
}
