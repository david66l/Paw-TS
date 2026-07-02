/**
 * 记忆检索器（Memory Retriever）——轻量级关键词 + 文件路径相关性打分。
 *
 * ## 模块定位
 *
 * 本模块是整个记忆系统的"查询入口"。它接收用户的检索查询（RetrievalQuery），
 * 从统一记忆仓库（UnifiedMemoryStore）中拉取全部记忆记录，用记分器（memory-scorer）
 * 为每条记录打分，再通过选择器（memory-selector）按 token 预算和数量限制选出
 * 最终的 top-K 结果，注入到系统提示词中供 LLM 参考。
 *
 * ## 架构设计
 *
 * 本模块将分词、打分、选择/预算三个子职责委托给独立的模块：
 *   - memory-tokenizer.ts   —— 文本分词（含路径模式剔除）
 *   - memory-scorer.ts       —— 基于多维信号的综合打分
 *   - memory-selector.ts     —— 预算约束下的 top-K 选择（含元查询回退）
 *
 * 这样拆分的好处：
 *   1. 每个模块可以独立测试和调优
 *   2. 打分策略调整不影响选择和分词
 *   3. 选择器的 token 预算逻辑与任务画像（TaskProfile）解耦
 *
 * ## 核心流程
 *
 * 1. `retrieve(query)` → 调用 `rankRecords` 对所有记忆打分排序
 * 2. `rankRecords` → 从 store 取全部记录，分词，调用 scorer 逐条打分，过滤低于阈值的候选项
 * 3. `buildResult` → 从 rankRecords 的结果中按预算选出最终记录，必要时走元查询回退
 * 4. 同时统计 embedding 缓存的命中/未命中情况
 *
 * ## 关键设计决策
 *
 * - 默认最低分阈值（minScore）为 15，避免返回毫无相关性的噪音记忆
 * - 支持任务画像（TaskProfile）动态调整 token 分配策略
 * - 当关键词检索无结果但查询本身是"记忆元查询"（meta-query）时，走 selectMetaFallback 兜底
 * - 支持预计算的 query embedding 用于语义相似度加权（semantic boost）
 */

import {
  isMemoryMetaQuery,
  type MemoryRecord,
  type TaskProfile,
} from "./memory-record.js";
import { TASK_PROFILE_BUDGETS, type ProfileBudget } from "./memory-profiles.js";
import { scoreMemoryRecord } from "./memory-scorer.js";
import { selectMetaFallback, selectRecords } from "./memory-selector.js";
import { stripPathLikeText, tokenize } from "./memory-tokenizer.js";
import type { UnifiedMemoryStore } from "./unified-memory-store.js";

// 重新导出任务画像预算表，方便调用方直接引用
export { TASK_PROFILE_BUDGETS };
export type { ProfileBudget };

/**
 * 检索配置 —— 控制检索行为的三项核心参数。
 *
 * 这三项参数主要影响 session 类型记忆的选择策略：
 * - maxSessionInTopK: 最多允许几条 session 记忆进入 top-K
 * - maxSessionTokens: session 记忆累计 token 上限
 * - sessionRecencyHalfLifeDays: session 时效性的半衰期（天），用于衰减陈旧 session 的权重
 */
export interface RetrievalConfig {
  readonly maxSessionInTopK?: number;
  readonly maxSessionTokens?: number;
  readonly sessionRecencyHalfLifeDays?: number;
}

/** 检索配置的默认值，所有参数均为必填（通过 Required 泛型保证） */
export const DEFAULT_RETRIEVAL_CONFIG: Required<RetrievalConfig> = {
  maxSessionInTopK: 2,
  maxSessionTokens: 800,
  sessionRecencyHalfLifeDays: 7,
};

/**
 * 检索查询 —— 表示一次记忆检索的全部输入信息。
 *
 * 设计要点：
 * - goal: 用户的当前任务描述，是关键词打分的主要文本来源
 * - currentFile / recentFiles: 用于路径相关性加权（当前文件和最近访问的文件列表）
 * - errorMessage: 如果存在错误信息，会提取其中的关键词用于匹配错误相关记忆
 * - queryEmbedding: 预计算好的查询向量，用于语义余弦相似度加权
 * - taskProfile: 任务画像，控制动态 token 分配（如 refactor_arch 需要更多记忆上下文）
 */
export interface RetrievalQuery {
  readonly goal: string;
  readonly currentFile?: string;
  readonly recentFiles?: readonly string[];
  readonly recentToolNames?: readonly string[];
  readonly errorMessage?: string;
  readonly workspaceRoot: string;
  readonly limit?: number;
  readonly maxTokens?: number;
  readonly minScore?: number;
  readonly config?: RetrievalConfig;
  /** 预计算的查询 embedding 向量，用于语义相似度加权（余弦相似度）。 */
  readonly queryEmbedding?: number[];
  /** 语义加权乘数，默认 0.2（即语义最多贡献 20% 的加分）。设为 0 可禁用语义加权。 */
  readonly semanticBoostWeight?: number;
  /** 任务画像，用于动态 token 分配（refactor_arch / bug_fix / simple_script / general）。 */
  readonly taskProfile?: TaskProfile;
}

/**
 * 记忆检索结果 —— 返回给调用方的最终数据结构。
 *
 * 包含：
 * - records: 最终选出的记忆记录列表
 * - scores: 每条记录对应的得分
 * - injectedTokens: 这些记录注入到提示词中占用的 token 数
 * - totalCandidates: 原始候选项总数（用于诊断和日志）
 * - usedMetaFallback: 是否触发了元查询回退（选择了非关键词匹配的记忆）
 * - embeddingCacheHits/Misses: embedding 缓存的命中统计
 * - usedLlmFallback: 是否在级联模式下升级到了 LLM 清单选择
 */
export interface MemoryRetrievalResult {
  readonly records: readonly MemoryRecord[];
  readonly totalCandidates: number;
  readonly scores: readonly number[];
  readonly injectedTokens: number;
  /** 为 true 时表示元意图回退（meta-intent fallback）选中了记忆。 */
  readonly usedMetaFallback?: boolean;
  readonly retrievalMode?: "keyword" | "cascade";
  readonly embeddingCacheHits?: number;
  readonly embeddingCacheMisses?: number;
  /** 为 true 时表示级联模式已升级到 LLM 清单选择。 */
  readonly usedLlmFallback?: boolean;
}

/**
 * 关键词记忆检索器 —— 记忆检索的主类。
 *
 * 职责：
 * 1. 持有 UnifiedMemoryStore 的引用
 * 2. 调用 rankRecords 打分排序
 * 3. 调用 buildResult 根据预算选出最终结果
 * 4. 统计 embedding 缓存命中情况
 */
export class KeywordMemoryRetriever {
  /** 统一记忆仓库引用 */
  private readonly store: UnifiedMemoryStore;
  /** 合并了默认值的检索配置 */
  private readonly config: Required<RetrievalConfig>;

  constructor(
    store: UnifiedMemoryStore,
    config: RetrievalConfig = DEFAULT_RETRIEVAL_CONFIG,
  ) {
    this.store = store;
    // 用展开运算符实现用户配置覆盖默认值
    this.config = { ...DEFAULT_RETRIEVAL_CONFIG, ...config };
  }

  /**
   * 执行一次完整的记忆检索。
   *
   * 流程：打分排序 → 构建结果（含预算选择） → 统计缓存 → 合并返回
   */
  retrieve(query: RetrievalQuery): MemoryRetrievalResult {
    const sorted = this.rankRecords(query);
    const result = this.buildResult(sorted, query);
    const cacheStats = this.countEmbeddingCacheStats(sorted, query);
    return { ...result, ...cacheStats };
  }

  /**
   * 对每条记忆打分并排序，返回得分高于 minScore 的候选项（降序）。
   *
   * 打分维度（由 memory-scorer 内部处理）：
   * - 关键词匹配度
   * - 文件路径相关性
   * - 错误签名匹配
   * - 时效性衰减
   * - 优先级加权
   * - embedding 语义相似度
   */
  rankRecords(
    query: RetrievalQuery,
  ): readonly { record: MemoryRecord; score: number }[] {
    // 获取全部记忆（排除当前 session 避免自引用）
    const all = this.store.listExcludingCurrent();

    // 将 goal 文本分词，先剔除路径类文本避免噪音
    const queryWords = tokenize(stripPathLikeText(query.goal));

    // 构建当前文件和最近文件列表（过滤掉 falsy 值）
    const queryFiles = [query.currentFile, ...(query.recentFiles ?? [])].filter(
      (f): f is string => !!f,
    );

    // 如果存在错误消息，也分词用于错误签名匹配
    const errWords = query.errorMessage
      ? tokenize(query.errorMessage)
      : undefined;

    // 对每条记录调用打分器
    const scored = all.map((m) => ({
      record: m,
      score: scoreMemoryRecord(m, query, queryWords, queryFiles, errWords),
    }));

    // 过滤掉低于阈值的候选项，按得分降序排列
    const minScore = query.minScore ?? 15;
    return scored
      .filter((s) => s.score > minScore)
      .sort((a, b) => b.score - a.score);
  }

  /**
   * 从排序后的候选项中构建最终的检索结果。
   *
   * 核心逻辑：
   * 1. 合并用户配置和默认检索配置
   * 2. 根据任务画像（TaskProfile）确定数量和 token 预算
   * 3. 调用 selectRecords 在预算约束下选出最优记录组合
   * 4. 如果关键词检索无结果但查询是"记忆元查询"，触发 selectMetaFallback 兜底
   *
   * 元查询回退（meta-fallback）的场景示例：
   * - 用户问"我们之前是怎么处理这个问题的？"
   * - 这类查询的关键词可能找不到任何记忆，但元查询回退可以从全部记忆中
   *   按 token 预算选出一批记录供 LLM 参考
   */
  buildResult(
    sorted: readonly { record: MemoryRecord; score: number }[],
    query: RetrievalQuery,
    options?: { totalCandidates?: number },
  ): MemoryRetrievalResult {
    // 合并配置：实例级默认值 ← 查询级覆盖
    const cfg = { ...this.config, ...query.config };

    // 根据任务画像确定预算参数
    const profile = query.taskProfile ?? "general";
    const budget = TASK_PROFILE_BUDGETS[profile];
    const limit = query.limit ?? budget.recordLimit;
    const maxTokens = query.maxTokens ?? budget.maxTokens;

    // 用任务画像的 session 参数覆盖检索配置
    const profileCfg: Required<RetrievalConfig> = {
      ...cfg,
      maxSessionInTopK: budget.maxSessionInTopK,
      maxSessionTokens: budget.maxSessionTokens,
    };

    const all = this.store.listExcludingCurrent();

    // 第一步：正常的关键词选择
    let selected = selectRecords(sorted, limit, maxTokens, profileCfg);
    let totalCandidates = options?.totalCandidates ?? sorted.length;
    let usedMetaFallback = false;

    // 第二步：如果关键词选择无结果且查询是记忆元查询，走元查询回退
    if (selected.records.length === 0 && isMemoryMetaQuery(query.goal)) {
      const fallback = selectMetaFallback(all, limit, maxTokens, profileCfg);
      selected = fallback;
      totalCandidates = fallback.candidateCount;
      usedMetaFallback = true;
    }

    return {
      records: selected.records,
      totalCandidates,
      scores: selected.scores,
      injectedTokens: selected.injectedTokens,
      // 条件性添加 usedMetaFallback 字段，仅当为 true 时出现在结果中
      ...(usedMetaFallback ? { usedMetaFallback: true } : {}),
    };
  }

  /**
   * 统计候选项中 embedding 缓存的命中和未命中数量。
   *
   * embedding 是预先计算并缓存到记忆记录中的语义向量，
   * 命中意味着可以直接用于余弦相似度计算，未命中则需要实时编码。
   * 此统计仅在有 queryEmbedding 时才有意义。
   */
  private countEmbeddingCacheStats(
    ranked: readonly { record: MemoryRecord; score: number }[],
    query: RetrievalQuery,
  ): { embeddingCacheHits: number; embeddingCacheMisses: number } {
    // 如果没有查询 embedding，返回空统计
    const hasQueryEmb = query.queryEmbedding && query.queryEmbedding.length > 0;
    if (!hasQueryEmb) return { embeddingCacheHits: 0, embeddingCacheMisses: 0 };

    let hits = 0;
    let misses = 0;
    for (const { record } of ranked) {
      if (record.embedding && record.embedding.length > 0) {
        hits++;
      } else {
        misses++;
      }
    }
    return { embeddingCacheHits: hits, embeddingCacheMisses: misses };
  }
}
