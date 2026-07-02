/**
 * 记忆检索级联回退（Cascade Fallback）——当关键词检索质量不足时升级到 LLM 选择。
 *
 * ## 模块定位
 *
 * 本模块实现了记忆检索的"二级回退"机制。关键词检索（memory-retriever）虽然快速且无额外
 * API 调用成本，但在以下场景可能效果不佳：
 * - 查询意图模糊，关键词匹配不到相关记忆
 * - 多个候选项得分相近，无法区分首选记忆
 * - 记忆库较大，关键词检索的信噪比过低
 *
 * 当检测到上述情况时，本模块将"升级"到 LLM 选择模式：把候选项格式化为清单（manifest），
 * 交给 LLM 进行语义理解和筛选。
 *
 * ## 触发条件（shouldEscalateToLlmFallback）
 *
 * 1. 关键词检索返回零条记录 → 立即升级
 * 2. top-1 得分低于 lowConfidenceScore（默认 25） → 升级（低可信度）
 * 3. top-1 和 top-2 之间的分差小于 weakSeparationGap（默认 5），
 *    且 top-1 得分低于 weakSeparationMaxTop（默认 40） → 升级（分离度不足）
 *
 * ## 关键设计决策
 *
 * - 不升级的条件：已经触发了元查询回退（usedMetaFallback），说明走的是另一种兜底路径
 * - LLM 选中的记忆如果没有关键词命中，统一给 LLM_FALLBACK_SCORE（50）的固定分
 * - 清单格式化为紧凑的文本行，控制 token 消耗
 * - maxManifestEntries 限制发送给 LLM 的候选项数量上限（默认 200），防止上下文溢出
 */

import type { MemoryRecord } from "./memory-record.js";
import type { MemoryRetrievalResult, RetrievalQuery } from "./memory-retriever.js";

/**
 * 级联回退的默认配置。
 *
 * 这些阈值经过实践调优：
 * - lowConfidenceScore=25: 低于此分数说明关键词匹配的可信度不足以独立决策
 * - weakSeparationGap=5: top-1 和 top-2 分差小于 5 时，关键词无法区分首选
 * - weakSeparationMaxTop=40: 只对"中等偏弱"的 top 分检查分离度（高分本身就说明匹配质量好）
 * - maxManifestEntries=200: 200 条候选项足够覆盖大部分场景，同时控制上下文大小
 */
export const DEFAULT_CASCADE_CONFIG: Required<CascadeFallbackConfig> = {
  lowConfidenceScore: 25,
  weakSeparationGap: 5,
  weakSeparationMaxTop: 40,
  maxManifestEntries: 200,
};

/**
 * 级联回退配置接口。
 *
 * 四个参数分别控制不同的升级触发阈值：
 * - lowConfidenceScore: 单条记录可信度阈值
 * - weakSeparationGap: 记录间区分度阈值
 * - weakSeparationMaxTop: 分离度检查的适用范围上限
 * - maxManifestEntries: 发送给 LLM 的最大候选项数
 */
export interface CascadeFallbackConfig {
  /** 当关键词检索 top-1 得分低于此值时升级到 LLM（默认 25）。 */
  readonly lowConfidenceScore?: number;
  /** 当 top1 - top2 分差低于此值且 top 属于弱信区间时升级（默认 5）。 */
  readonly weakSeparationGap?: number;
  /** 被判定为"弱信号"的 top 得分上限，用于分离度检查（默认 40）。 */
  readonly weakSeparationMaxTop?: number;
  /** 发送给 LLM 选择器的清单条目上限（默认 200）。 */
  readonly maxManifestEntries?: number;
}

/**
 * LLM 记忆选择的输入参数。
 *
 * - query: 原始检索查询（包含 goal、文件路径等信息供 LLM 理解上下文）
 * - manifest: 格式化后的记忆清单文本
 * - candidateIds: 候选项 ID 列表，LLM 返回的选中 ID 必须在此范围内
 */
export interface LlmMemorySelectInput {
  readonly query: RetrievalQuery;
  readonly manifest: string;
  readonly candidateIds: readonly string[];
}

/**
 * LLM 记忆选择函数类型。
 *
 * 接收清单和查询，异步返回被选中的记忆 ID 列表。
 * 实现方负责调用 LLM API 并解析响应。
 */
export type LlmMemorySelectFn = (
  input: LlmMemorySelectInput,
) => Promise<readonly string[]>;

/**
 * LLM 回退选择的固定得分。
 *
 * 当 LLM 选中了一条关键词检索未命中（得分为 0 或很低）的记忆时，
 * 赋予此固定分值（50），使其在最终排序中处于合理位置。
 */
export const LLM_FALLBACK_SCORE = 50;

/**
 * 将记忆记录列表格式化为 LLM 可读的清单文本。
 *
 * 格式：`[id] [来源] 标题 — 摘要 (tags: 标签1, 标签2)`
 *
 * 设计要点：
 * - 摘要优先使用 summary 字段，为空时截取 content 前 120 字符
 * - 标签信息附加在末尾，便于 LLM 按标签过滤
 * - 每条记录占一行，便于 LLM 解析和引用 ID
 */
export function formatMemoryManifest(records: readonly MemoryRecord[]): string {
  return records
    .map((record) => {
      const tags =
        record.tags.length > 0 ? ` (tags: ${record.tags.join(", ")})` : "";
      const summary = record.summary.trim() || record.content.slice(0, 120);
      return `[${record.id}] [${record.source}] ${record.title} — ${summary}${tags}`;
    })
    .join("\n");
}

/**
 * 判断是否应该升级到 LLM 回退选择。
 *
 * ## 决策流程
 *
 * 1. 如果已经使用了元查询回退 → 不升级（元查询本身就是另一种兜底策略）
 * 2. 如果记忆池为空 → 不升级（没有东西可以给 LLM 选）
 * 3. 如果关键词检索返回零条记录 → 立即升级
 * 4. 如果 top-1 得分低于可信度阈值 → 升级
 * 5. 如果 top-1 和 top-2 分差过小且 top-1 本身不够强 → 升级
 * 6. 否则 → 不升级，关键词检索结果足够可靠
 *
 * @param keywordResult - 关键词检索的结果
 * @param ranked - 排序后的全部候选项（含得分）
 * @param poolSize - 记忆池总大小
 * @param config - 可选的自定义阈值配置
 * @returns 是否应该升级到 LLM 回退
 */
export function shouldEscalateToLlmFallback(
  keywordResult: MemoryRetrievalResult,
  ranked: readonly { record: MemoryRecord; score: number }[],
  poolSize: number,
  config?: CascadeFallbackConfig,
): boolean {
  // 合并默认配置和用户配置
  const cfg = { ...DEFAULT_CASCADE_CONFIG, ...config };

  // 已走元查询回退 → 不升级（避免双重兜底）
  if (keywordResult.usedMetaFallback) return false;

  // 池子为空 → 无法升级
  if (poolSize === 0) return false;

  // 关键词检索零结果 → 必须升级
  if (keywordResult.records.length === 0) return true;

  // 提取 top-1 和 top-2 的得分
  const top = ranked[0]?.score ?? 0;
  const second = ranked[1]?.score ?? 0;

  // 条件 1: top 分低于可信度阈值
  if (top < cfg.lowConfidenceScore) return true;

  // 条件 2: top 分在弱信区间内且与第二名的差距过小
  if (
    ranked.length >= 2 &&
    top < cfg.weakSeparationMaxTop &&
    top - second < cfg.weakSeparationGap
  ) {
    return true;
  }

  // 关键词检索结果可信，不需要升级
  return false;
}
