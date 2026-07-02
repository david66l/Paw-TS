/**
 * 记忆检索入口：关键词 + 语义重排 + LLM 级联回退。
 * ===================================================
 *
 * 两级检索模式：
 *
 * 1. keyword：纯关键词匹配（BM25 变体），零 LLM 调用，速度快
 * 2. cascade（默认）：
 *    Tier 1 — 关键词粗排（minScore=5，获取候选池）
 *    Tier 2 — 语义重排（embedding 余弦相似度，70% 关键词 + 30% 语义）
 *    Tier 3 — LLM 级联回退（低置信度时用 LLM 从分片清单中精选 ≤5 条）
 *
 * 面试要点：
 * - 为什么是级联而非纯语义？纯语义需要为所有记忆预计算 embedding，
 *   大项目可能有数千条记忆，embedding 计算成本高。关键词粗排大幅缩小候选池。
 * - 为什么 LLM 作为最后一层？关键词+语义可以处理大部分情况，LLM 只在
 *   置信度低时兜底，控制成本。
 * - Shard 机制：记忆太多时分片处理，每片 180 条，最多 5 片（900 条）。
 */

import {
  KeywordMemoryRetriever,
  type MemoryRetrievalResult,
  type RetrievalConfig,
  type RetrievalQuery,
} from "./memory-retriever.js";
import {
  DEFAULT_CASCADE_CONFIG,
  formatMemoryManifest,
  LLM_FALLBACK_SCORE,
  shouldEscalateToLlmFallback,
  type CascadeFallbackConfig,
  type LlmMemorySelectFn,
} from "./memory-retrieval-cascade.js";
import { EmbeddingCache } from "./embedding-cache.js";
import { classifyTask } from "./memory-record.js";
import type { MemoryRecord } from "./memory-record.js";
import type { UnifiedMemoryStore } from "./unified-memory-store.js";

export interface RetrieveMemoriesOptions {
  readonly mode?: "keyword" | "cascade";
  readonly config?: RetrievalConfig;
  readonly llmSelect?: LlmMemorySelectFn;
  readonly cascadeConfig?: CascadeFallbackConfig;
  /** LLM 选择循环中每个分片的最大条目数（默认 180）。 */
  readonly shardSize?: number;
}

const DEFAULT_SHARD_SIZE = 180;
const MAX_SHARDS = 5;

/**
 * Tier 2：语义重排。
 *
 * 将查询 embedding 与每个候选项的 embedding 做余弦相似度比较。
 * 合并分数 = 关键词分数 * 0.7 + 语义分数 * 0.3。
 *
 * 为什么关键词权重更高（70% vs 30%）？
 * 关键词匹配更适合精确匹配（文件名、函数名、错误码），
 * embedding 作为补充来捕获语义相近但关键词不同的记忆。
 */
function semanticRerank(
  ranked: readonly { record: MemoryRecord; score: number }[],
  queryEmbedding: number[],
): { record: MemoryRecord; score: number; keywordScore: number; semanticScore: number }[] {
  const reranked = ranked.map(({ record, score: keywordScore }) => {
    let semanticScore = 0;
    if (record.embedding && record.embedding.length > 0) {
      const cosineSim = EmbeddingCache.cosineSimilarity(queryEmbedding, record.embedding);
      semanticScore = cosineSim * 100; // 缩放到与关键词分数相近的范围
    }
    // 混合：关键词 70%，语义 30%
    const mergedScore = keywordScore * 0.7 + semanticScore * 0.3;
    return { record, score: mergedScore, keywordScore, semanticScore };
  });

  reranked.sort((a, b) => b.score - a.score);
  return reranked;
}

/**
 * 级联检索：关键词粗排 → 语义重排 → LLM 精选。
 */
async function retrieveCascadeMemories(
  store: UnifiedMemoryStore,
  query: RetrievalQuery,
  options: RetrieveMemoriesOptions,
): Promise<MemoryRetrievalResult> {
  const retriever = new KeywordMemoryRetriever(store, options.config);

  // ── Tier 1：关键词粗排 ──
  // 使用较低的 minScore 获取更大的候选池供 Tier 2 筛选
  const tier1Query: RetrievalQuery = {
    ...query,
    minScore: 5, // 低阈值：只过滤完全不相关的结果
    semanticBoostWeight: 0, // Tier 2 再做语义增强
  };
  const ranked = retriever.rankRecords(tier1Query);
  const top30 = ranked.slice(0, 30);

  // ── Tier 2：语义重排 ──
  let tier2Ranked: { record: MemoryRecord; score: number }[] = top30.map((r) => ({
    record: r.record,
    score: r.score,
  }));
  let embeddingCacheHits = 0;
  let embeddingCacheMisses = 0;

  if (query.queryEmbedding && query.queryEmbedding.length > 0 && top30.length > 0) {
    const reranked = semanticRerank(
      top30.map((r) => ({ record: r.record, score: r.score })),
      query.queryEmbedding,
    );
    tier2Ranked = reranked.map((r) => ({ record: r.record, score: r.score }));

    // 统计 embedding 缓存的命中/未命中
    for (const r of ranked) {
      if (r.record.embedding && r.record.embedding.length > 0) {
        embeddingCacheHits++;
      } else {
        embeddingCacheMisses++;
      }
    }
  }

  const keywordResult = retriever.buildResult(tier2Ranked, query, {
    totalCandidates: ranked.length,
  });

  // ── Tier 3：LLM 级联（仅在低置信度时）──
  const pool = store.listExcludingCurrent();
  const cascadeConfig = {
    ...DEFAULT_CASCADE_CONFIG,
    ...options.cascadeConfig,
  };

  if (
    options.llmSelect &&
    shouldEscalateToLlmFallback(keywordResult, tier2Ranked, pool.length, cascadeConfig)
  ) {
    const scoreById = new Map(
      tier2Ranked.map((item) => [item.record.id, item.score]),
    );

    // A.4：基于分片的内存清单循环
    // 记忆太多时按更新时间排序后分片，每片 180 条，最多 5 片
    const sorted = [...pool].sort((a, b) => b.updatedAt - a.updatedAt);
    const shardSize = options.shardSize ?? DEFAULT_SHARD_SIZE;
    const shards: MemoryRecord[][] = [];
    for (let i = 0; i < sorted.length; i += shardSize) {
      shards.push(sorted.slice(i, i + shardSize));
    }
    const visibleShards = shards.slice(0, MAX_SHARDS);

    try {
      const selectedIds = new Set<string>();
      const limit = query.limit ?? 5;

      // 逐片让 LLM 选择最相关的记忆 ID
      for (const shard of visibleShards) {
        const candidateIds = shard.map((r) => r.id);
        const shardIds = await options.llmSelect({
          query,
          manifest: formatMemoryManifest(shard),
          candidateIds,
        });
        for (const id of shardIds) {
          if (candidateIds.includes(id)) {
            selectedIds.add(id);
          }
        }
        // 选够了就停止（limit * 2 作为缓冲）
        if (selectedIds.size >= limit * 2) break;
      }

      const selected = [...selectedIds]
        .map((id) => {
          // 先在 Tier2 重排结果中找，再回退到排序后的池
          const record =
            tier2Ranked.find((r) => r.record.id === id)?.record ??
            sorted.find((r) => r.id === id);
          if (!record) return null;
          return {
            record,
            score: scoreById.get(id) ?? LLM_FALLBACK_SCORE,
          };
        })
        .filter(
          (
            item,
          ): item is { record: MemoryRecord; score: number } =>
            item !== null,
        )
        .slice(0, limit);

      if (selected.length > 0) {
        const llmResult = retriever.buildResult(selected, query, {
          totalCandidates: pool.length,
        });
        return {
          ...llmResult,
          retrievalMode: "cascade",
          usedLlmFallback: true,
          embeddingCacheHits,
          embeddingCacheMisses,
        };
      }
    } catch {
      /* LLM 选择失败 → 回退到关键词结果 */
    }
  }

  // 回退：返回 Tier1/Tier2 结果
  return {
    ...keywordResult,
    retrievalMode: "cascade",
    usedLlmFallback: false,
    embeddingCacheHits,
    embeddingCacheMisses,
  };
}

/**
 * 记忆检索主入口。
 *
 * @param store 统一记忆存储（项目记忆 + 会话记忆）
 * @param query 检索查询
 * @param options 检索选项（模式、配置、LLM 选择器等）
 */
export async function retrieveMemories(
  store: UnifiedMemoryStore,
  query: RetrievalQuery,
  options: RetrieveMemoriesOptions = {},
): Promise<MemoryRetrievalResult> {
  const mode = options.mode ?? "keyword";

  // B.4：自动分类任务画像（从 goal 推断任务类型，优化检索权重）
  const effectiveQuery: RetrievalQuery = query.taskProfile
    ? query
    : { ...query, taskProfile: classifyTask(query.goal, query.errorMessage) };

  if (mode === "cascade") {
    return retrieveCascadeMemories(store, effectiveQuery, options);
  }

  // 纯关键词模式
  const retriever = new KeywordMemoryRetriever(store, options.config);
  const result = retriever.retrieve(effectiveQuery);
  return { ...result, retrievalMode: "keyword" };
}
