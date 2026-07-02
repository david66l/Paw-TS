/**
 * L2 压缩摘要验证（质量门控）。
 *
 * 【模块职责】
 * 对对话压缩（conversation compression）产生的摘要文本进行结构化和定量验证。
 * 压缩是将长对话历史浓缩为摘要的过程，但压缩后的摘要必须满足最低质量标准——
 * 包含必要的章节、达到一定的 token 节省比例——否则压缩就是无效的。
 *
 * 【为什么存在】
 * - 压缩是上下文管理中缓解 token 预算压力的核心手段，但如果压缩质量差
 *   （丢失关键信息、节省比例太低），反而会降低模型表现。这个模块提供了
 *   自动化质量检查，确保只有合格的压缩摘要被使用。
 * - 将验证逻辑与压缩逻辑解耦：压缩器只负责生成摘要，验证器决定是否接受。
 * - `MIN_COMPRESSION_SAVINGS_RATIO = 0.15`（15%）设定了最低性价比门槛：
 *   如果压缩连 15% 的 token 都省不掉，说明内容太短或压缩无意义。
 *
 * 【关键设计决策】
 * - `REQUIRED_SUMMARY_SECTIONS` 使用 `as const` 断言，既保证数组不可变，
 *   又让 TypeScript 推导出字面量联合类型（`"active task" | "goal" | "progress"`），
 *   在遍历时获得精确的类型提示。
 * - 验证失败时返回 `{ ok: false, reason: "…" }` 而非抛出异常——这是"结果类型"
 *   模式（Result type），让调用方可以优雅地处理失败，而不必 try-catch。
 * - `compressionSavingsRatio` 在 `beforeTokens <= 0` 时返回 0，避免除零错误。
 */

/** 压缩摘要必须包含的章节标题（Markdown 二级标题） */
export const REQUIRED_SUMMARY_SECTIONS = [
  "active task",  // 活跃任务：当前正在执行什么
  "goal",          // 目标：最终要达成什么
  "progress",      // 进度：已经完成了什么
] as const;

/** 压缩最低节省比例：压缩后至少要比原始内容少 15% 的 token */
export const MIN_COMPRESSION_SAVINGS_RATIO = 0.15;

import { parseMarkdownSections } from "../markdown.js";

/**
 * 验证压缩摘要的结构是否完整。
 *
 * 检查项：
 * 1. 摘要不能为空
 * 2. 摘要必须包含所有必需章节（## active task, ## goal, ## progress）
 *
 * @returns 验证结果，ok=false 时附带原因说明
 */
export function validateCompressionSummary(summary: string): {
  readonly ok: boolean;
  readonly reason?: string;
} {
  const trimmed = summary.trim();
  if (!trimmed) {
    return { ok: false, reason: "empty summary" };
  }

  // 解析 Markdown 章节结构，检查每个必需章节是否存在且非空
  const sections = parseMarkdownSections(trimmed);
  for (const sec of REQUIRED_SUMMARY_SECTIONS) {
    if (!sections[sec]?.trim()) {
      return { ok: false, reason: `missing section: ## ${sec}` };
    }
  }
  return { ok: true };
}

/**
 * 计算压缩节省比例。
 *
 * 公式：(压缩前 token - 压缩后 token) / 压缩前 token
 * 返回 0~1 之间的值，表示节省的 token 占比。
 * 当 beforeTokens <= 0 时返回 0，防御除零错误。
 */
export function compressionSavingsRatio(
  beforeTokens: number,
  afterTokens: number,
): number {
  if (beforeTokens <= 0) return 0;
  return (beforeTokens - afterTokens) / beforeTokens;
}

/**
 * 判断压缩是否达到最低节省阈值。
 *
 * @param beforeTokens  压缩前的 token 数
 * @param afterTokens   压缩后的 token 数
 * @param minRatio      最低节省比例，默认使用 MIN_COMPRESSION_SAVINGS_RATIO
 */
export function meetsCompressionSavingsThreshold(
  beforeTokens: number,
  afterTokens: number,
  minRatio = MIN_COMPRESSION_SAVINGS_RATIO,
): boolean {
  return compressionSavingsRatio(beforeTokens, afterTokens) >= minRatio;
}
