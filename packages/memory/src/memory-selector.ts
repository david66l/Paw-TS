/**
 * 记忆选择器 / 预算控制模块。
 *
 * ## 模块定位
 *
 * 记忆评分（memory-scorer）完成后，所有候选记忆按分数降序排列。
 * 本模块负责从排序后的候选列表中选出最终注入到系统提示词的记忆集合，
 * 同时遵守以下约束：
 * - 总 token 预算上限（maxTokens）
 * - 最大记忆条数上限（limit）
 * - 会话记忆条数上限（maxSessionInTopK）
 * - 会话记忆 token 总量上限（maxSessionTokens）
 *
 * ## 架构设计
 *
 * - **selectRecords**: 主选择函数，按分数从高到低依次选取，
 *   对每条候选记忆检查三项约束是否满足，满足则入选
 * - **selectMetaFallback**: 元回退选择策略，当嵌入向量不可用时的降级方案。
 *   优先选取 reference 标签的记忆，再补充最近 7 天的 auto 来源记忆
 * - **estimateRecordTokens**: Token 估算辅助函数，使用 ApproximateEstimator
 *   估算每条记忆的 token 消耗。排名第一的记忆（rankInSelection=0）会额外分配
 *   `MEMORY_INJECTION_DETAIL_TOKENS` 用于展开详细信息
 * - **TASK_PROFILE_BUDGETS**: 导出各任务画像的预算配置（标签偏好、加成系数等）
 *
 * ## 关键设计决策
 *
 * 1. **分层预算控制**: 不仅限制总 token 数，还单独限制会话记忆的条数和 token 数，
 *    防止近期会话记忆挤占长期有价值的参考资料
 * 2. **保底策略**: `selectMetaFallback` 确保在没有嵌入向量的环境下仍能选出有意义的记忆集合
 * 3. **首条展开**: 排名第一的记忆会额外分配 token 预算用于展示详细内容（content），
 *    后续记忆只显示 title + summary + relatedFiles，节约上下文空间
 * 4. **greedy 而非背包**: 选择策略是贪心的（按分数从高到低依次加入），
 *    而非全局最优的背包问题求解——因为分数已经充分反映了相关性排序，
 *    贪心策略在实际效果中足够好且计算成本极低
 */

import { MEMORY_INJECTION_DETAIL_TOKENS } from "@paw/core";
import type { MemoryRecord } from "./memory-record.js";
import { TASK_PROFILE_BUDGETS, type ProfileBudget } from "./memory-profiles.js";
import { ApproximateEstimator } from "@paw/core";
import type { RetrievalConfig } from "./memory-retriever.js";

/** 全局共享的 token 近似估算器实例，用于估算记忆条目的 token 消耗 */
const _tokenEstimator = new ApproximateEstimator();

export { TASK_PROFILE_BUDGETS };
export type { ProfileBudget };

/**
 * 选择结果的数据结构。
 *
 * 包含入选的记忆记录列表、对应的评分列表，以及注入的总 token 估算值。
 * scores 数组与 records 数组按索引一一对应。
 */
export interface SelectedRecords {
  /** 入选的记忆记录列表（按分数降序） */
  readonly records: MemoryRecord[];
  /** 对应每条记忆的相关性分数 */
  readonly scores: number[];
  /** 注入到系统提示词中的总 token 估算值 */
  readonly injectedTokens: number;
}

/**
 * 主选择函数：从排序后的候选列表中按预算约束选出最终记忆集合。
 *
 * ## 选择流程（贪心策略）
 *
 * 1. 依次遍历候选列表（已按分数降序排列）
 * 2. 检查是否达到 `limit` 上限
 * 3. 估算当前记忆的 token 消耗（首条额外分配 DETAIL_TOKENS）
 * 4. 如果是会话记忆，检查条数上限（maxSessionInTopK）和 token 上限（maxSessionTokens）
 * 5. 检查总 token 是否超过 maxTokens（至少保证入选一条，避免空结果）
 * 6. 全部通过则入选，更新计数器
 *
 * @param sorted - 已按分数降序排列的候选记录列表
 * @param limit - 最大记忆条数上限
 * @param maxTokens - 总 token 预算上限
 * @param cfg - 检索配置（包含会话记忆的限制参数）
 * @returns 包含入选记录、评分和 token 消耗的 SelectedRecords
 */
export function selectRecords(
  sorted: readonly { record: MemoryRecord; score: number }[],
  limit: number,
  maxTokens: number,
  cfg: Required<RetrievalConfig>,
): SelectedRecords {
  const records: MemoryRecord[] = [];
  const scores: number[] = [];
  let totalTokens = 0;
  let sessionCount = 0;
  let sessionTokens = 0;

  for (const s of sorted) {
    // 约束 1: 达到条数上限 → 停止
    if (records.length >= limit) break;

    const isSession = s.record.source === "session";
    const rankInSelection = records.length;
    // 估算当前记忆的 token 消耗（首条额外分配详细内容的 token 预算）
    const recordTokens = estimateRecordTokens(
      s.record,
      rankInSelection === 0,
    );

    // 约束 2: 会话记忆的条数和 token 双重上限
    if (isSession) {
      if (sessionCount >= cfg.maxSessionInTopK) continue;
      if (sessionTokens + recordTokens > cfg.maxSessionTokens) continue;
    }

    // 约束 3: 总 token 上限（但至少允许入选一条，避免空结果）
    if (totalTokens + recordTokens > maxTokens && records.length > 0) break;

    // 通过所有约束 → 入选
    records.push(s.record);
    scores.push(s.score);
    totalTokens += recordTokens;
    if (isSession) {
      sessionCount++;
      sessionTokens += recordTokens;
    }
  }

  return { records, scores, injectedTokens: totalTokens };
}

/**
 * 元回退选择策略：当嵌入向量不可用时的降级方案。
 *
 * ## 选择逻辑
 *
 * 1. 优先选取所有标记为 "reference" 的记忆（按更新时间降序排列）
 * 2. 补充最近 7 天内创建/更新的 auto 来源记忆（去重后按更新时间降序）
 * 3. 对合并后的候选池执行标准的预算约束选择
 *
 * 这种策略确保即使没有语义搜索能力，仍能选出高质量的记忆集合：
 * reference 记忆通常是项目级别的文档，auto 记忆是近期自动提取的上下文。
 *
 * @param all - 所有可用记忆记录
 * @param limit - 最大记忆条数上限
 * @param maxTokens - 总 token 预算上限
 * @param cfg - 检索配置
 * @returns 包含入选记录、评分、token 消耗及候选池容量的结果
 */
export function selectMetaFallback(
  all: readonly MemoryRecord[],
  limit: number,
  maxTokens: number,
  cfg: Required<RetrievalConfig>,
): SelectedRecords & { candidateCount: number } {
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const seen = new Set<string>(); // 去重集合
  const pool: MemoryRecord[] = [];

  // 第一优先级：reference 标签的记忆（项目文档、架构决策等）
  const references = [...all]
    .filter((m) => m.tags.includes("reference"))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  for (const record of references) {
    if (seen.has(record.id)) continue;
    pool.push(record);
    seen.add(record.id);
  }

  // 第二优先级：最近 7 天的 auto 记忆（自动提取的上下文）
  for (const record of [...all].sort((a, b) => b.updatedAt - a.updatedAt)) {
    if (
      record.source === "auto" &&
      record.updatedAt >= sevenDaysAgo &&
      !seen.has(record.id)
    ) {
      pool.push(record);
      seen.add(record.id);
    }
  }

  // 对候选池执行标准选择
  const selected = selectRecords(
    pool.map((record) => ({ record, score: 1 })), // 元回退策略中所有候选分数相同（=1）
    limit,
    maxTokens,
    cfg,
  );
  return { ...selected, candidateCount: pool.length };
}

/**
 * 估算单条记忆记录的 token 消耗。
 *
 * ## 估算策略
 *
 * - 基础估算：title + summary + relatedFiles 拼接后的 token 数
 * - 首条展开：如果是排名第一的记忆（includeTopDetail=true），额外加上
 *   MEMORY_INJECTION_DETAIL_TOKENS，用于展示 content 正文。这是因为
 *   首条记忆的详细内容对用户最有价值，后续记忆只需摘要即可
 *
 * @param m - 记忆记录
 * @param includeTopDetail - 是否为排名第一的记忆（需要展开详细内容）
 * @returns 估算的 token 数量
 */
function estimateRecordTokens(
  m: MemoryRecord,
  includeTopDetail: boolean,
): number {
  const text = [m.title, m.summary, ...m.relatedFiles].join(" ");
  let tokens = _tokenEstimator.count(text);
  // 排名第一的记忆额外分配详细内容的 token 预算
  if (includeTopDetail && m.content.trim()) {
    tokens += MEMORY_INJECTION_DETAIL_TOKENS;
  }
  return tokens;
}
