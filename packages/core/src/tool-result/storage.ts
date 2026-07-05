/**
 * 将大型或被驱逐出上下文的工具结果持久化到磁盘（参考 Claude Code 的恢复路径设计）。
 * Persist large or evicted tool results to disk (Claude Code–style recovery path).
 *
 * ============================================================================
 * 模块职责 (Module Purpose)
 * ============================================================================
 * 本模块负责工具执行结果的"非上下文存储"策略。当工具输出过大（超过 50,000 个
 * UTF-16 代码单元）或因上下文裁剪被驱逐时，本模块将其持久化写入磁盘，在上下文中
 * 仅保留一个轻量级的占位符，包含文件路径和内容预览。
 *
 * 存储布局：
 * - 完整内容 → `.paw/sessions/{runId}/tool-results/{id}.txt`
 * - 上下文消息 → 包含 `<persisted-output>` 标签的预览块
 *
 * 设计决策：
 * - **阈值策略**：默认 50,000 字符以上触发持久化（DEFAULT_MAX_TOOL_OUTPUT_BYTES）。
 *   这个阈值参考了 Claude Code 的处理方式。
 * - **预览机制**：保留前 2,000 字节的预览（PREVIEW_SIZE_BYTES），让 LLM 能了解
 *   输出的内容概貌，必要时再指示 agent 读取完整文件。
 * - **幂等目录创建**：persistToolResultToDisk 使用 `recursive: true` 的 mkdirSync，
 *   确保目录层级存在。
 * - **文件名安全**：使用 sanitizeRunId 清理 ID 中的特殊字符，防止路径遍历攻击。
 *
 * 架构定位：存储层（Storage），位于工具执行层和上下文管理层之间，是上下文
 * 裁剪策略的配套模块。
 * ============================================================================
 */

import fs from "node:fs";
import path from "node:path";
import { atomicWrite } from "../utils/fs.js";
import { formatToolResult } from "./format.js";
import { sanitizeRunId, toolResultsDir } from "../workspace-paths.js";

/**
 * 持久化输出在上下文中的标记标签。
 * LLM 通过这些标签识别输出已被持久化到磁盘。
 */
export const PERSISTED_OUTPUT_OPEN = "<persisted-output>";
export const PERSISTED_OUTPUT_CLOSE = "</persisted-output>";

/** 预览内容的最大字节数（2,000 字节）。足够 LLM 了解输出概貌。 */
export const PREVIEW_SIZE_BYTES = 2_000;

/** 保留在上下文中不持久化的最近工具结果数量。 */
export const DEFAULT_KEEP_RECENT_TOOLS = 5;

/**
 * Phase A 持久化阈值：当工具结果超过此 UTF-16 代码单元数时触发持久化。
 * 参考 Claude Code 的 ~50K 字符限制。
 * Phase A: persist when tool result exceeds this many UTF-16 code units (Claude ~50K chars).
 */
export const DEFAULT_MAX_TOOL_OUTPUT_BYTES = 50_000;

/**
 * 获取指定 workspace 和 runId 的工具结果存储目录路径。
 * 委托给 workspace-paths 模块确保路径一致性。
 */
export function getToolResultsDir(
  workspaceRoot: string,
  runId: string,
): string {
  return toolResultsDir(workspaceRoot, runId);
}

/**
 * 检查内容是否已经被持久化（包含 `<persisted-output>` 标记）。
 * 防止对已持久化的内容重复处理。
 */
export function isPersistedToolResult(content: string): boolean {
  return content.includes(PERSISTED_OUTPUT_OPEN);
}

/**
 * 生成内容的预览片段。
 *
 * 截断策略：
 * - 如果内容未超过 maxBytes，返回原内容（hasMore: false）
 * - 否则截取前 maxBytes 字符，并尽量在最后一个完整行处截断
 *   （如果最后一个换行符的位置超过截断点的一半，则在该换行符处截断）
 *
 * Generate a preview of the content for in-context display.
 */
export function generatePreview(
  content: string,
  maxBytes: number = PREVIEW_SIZE_BYTES,
): { preview: string; hasMore: boolean } {
  if (content.length <= maxBytes) {
    return { preview: content, hasMore: false };
  }
  // 截断到 maxBytes，尝试在换行处对齐
  const truncated = content.slice(0, maxBytes);
  const lastNewline = truncated.lastIndexOf("\n");
  // 只在换行符离末尾不太远时（>50% 位置）才在换行处截断
  const preview =
    lastNewline > maxBytes * 0.5
      ? truncated.slice(0, lastNewline)
      : truncated;
  return { preview, hasMore: true };
}

/**
 * 将工具结果完整内容写入磁盘。
 *
 * @param toolResultsDir - 工具结果存储目录
 * @param id - 结果唯一标识符（会被 sanitize 处理）
 * @param content - 完整输出内容
 * @returns 写入的文件绝对路径
 *
 * Persist tool result full content to disk.
 */
export function persistToolResultToDisk(
  toolResultsDir: string,
  id: string,
  content: string,
): string {
  // 递归创建目录（幂等操作）
  fs.mkdirSync(toolResultsDir, { recursive: true });
  // 清理 ID 中的危险字符
  const safeId = sanitizeRunId(id);
  const filepath = path.join(toolResultsDir, `${safeId}.txt`);
  atomicWrite(filepath, content);
  return filepath;
}

/**
 * 构建持久化工具结果在上下文中的占位消息。
 *
 * 格式示例：
 *   <persisted-output>
 *   Output saved to disk (120.5 KB). Full output: /path/to/file.txt
 *
 *   Preview (first 2000 bytes):
 *   <内容前 2000 字节的预览>
 *   ...
 *   </persisted-output>
 *
 * 这个格式让 LLM 可以：
 * 1. 知道输出已被保存到磁盘
 * 2. 知道完整文件的路径
 * 3. 看到前 2000 字节的预览以了解内容概貌
 *
 * Build the in-context placeholder for a persisted tool result.
 */
export function buildPersistedToolResultContent(opts: {
  readonly tool: string;
  readonly ok: boolean;
  readonly summary: string;
  readonly filepath: string;
  readonly originalSize: number;
  readonly fullBody: string;
}): string {
  const { preview, hasMore } = generatePreview(opts.fullBody);
  const sizeKb = (opts.originalSize / 1024).toFixed(1);
  const body = [
    PERSISTED_OUTPUT_OPEN,
    `Output saved to disk (${sizeKb} KB). Full output: ${opts.filepath}`,
    "",
    `Preview (first ${PREVIEW_SIZE_BYTES} bytes):`,
    preview,
    hasMore ? "..." : "",
    PERSISTED_OUTPUT_CLOSE,
  ].join("\n");
  return formatToolResult({
    tool: opts.tool,
    ok: opts.ok,
    summary: opts.summary,
    payload: body,
  });
}

/**
 * 判断工具结果是否超过大小限制，需要持久化到磁盘。
 *
 * 逻辑：
 * 1. 如果内容已被持久化（包含 `<persisted-output>` 标记），返回 false
 * 2. 否则比较内容长度与阈值
 *
 * Check whether a tool result exceeds the size limit and needs persisting.
 */
export function toolResultExceedsLimits(
  content: string,
  maxBytes: number = DEFAULT_MAX_TOOL_OUTPUT_BYTES,
): boolean {
  // 已经持久化的内容无需再次检查
  if (isPersistedToolResult(content)) return false;
  return content.length > maxBytes;
}
