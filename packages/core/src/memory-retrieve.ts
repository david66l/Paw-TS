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
  /** Max entry count per shard when looping LLM selection (default 180). */
  readonly shardSize?: number;
}

const DEFAULT_SHARD_SIZE = 180;

/**
 * Tier 2: Semantic re-rank.
 *
 * The query embedding is compared against each candidate's embedding via
 * cosine similarity. The merged score is a weighted blend of the keyword
 * score (70%) and the normalized semantic score (30%).
 *
 * Returns re-ranked candidates ordered by mergedScore descending.
 */
function semanticRerank(
  ranked: readonly { record: MemoryRecord; score: number }[],
  queryEmbedding: number[],
): { record: MemoryRecord; score: number; keywordScore: number; semanticScore: number }[] {
  const reranked = ranked.map(({ record, score: keywordScore }) => {
    let semanticScore = 0;
    if (record.embedding && record.embedding.length > 0) {
      const cosineSim = EmbeddingCache.cosineSimilarity(queryEmbedding, record.embedding);
      semanticScore = cosineSim * 100; // scale to rough keyword-score range
    }
    // Blend: keyword 70%, semantic 30%
    const mergedScore = keywordScore * 0.7 + semanticScore * 0.3;
    return { record, score: mergedScore, keywordScore, semanticScore };
  });

  reranked.sort((a, b) => b.score - a.score);
  return reranked;
}

/** Tier 3 thresholds (same as DEFAULT_CASCADE_CONFIG defaults). */
const TIER3_LOW_CONFIDENCE = 25;
const TIER3_WEAK_SEPARATION_GAP = 5;
const TIER3_WEAK_SEPARATION_MAX_TOP = 40;

function shouldTriggerTier3(
  reranked: readonly { record: MemoryRecord; score: number }[],
  poolSize: number,
): boolean {
  if (poolSize === 0) return false;

  // Empty keyword results → escalate
  if (reranked.length === 0) return true;

  const top = reranked[0]?.score ?? 0;
  const second = reranked[1]?.score ?? 0;

  if (top < TIER3_LOW_CONFIDENCE) return true;
  if (
    reranked.length >= 2 &&
    top < TIER3_WEAK_SEPARATION_MAX_TOP &&
    top - second < TIER3_WEAK_SEPARATION_GAP
  ) {
    return true;
  }
  return false;
}

async function retrieveCascadeMemories(
  store: UnifiedMemoryStore,
  query: RetrievalQuery,
  options: RetrieveMemoriesOptions,
): Promise<MemoryRetrievalResult> {
  const retriever = new KeywordMemoryRetriever(store, options.config);

  // ── Tier 1: Keyword coarse rank ──────────────────────────────
  // Use lower minScore to capture a larger candidate pool for Tier 2
  const tier1Query: RetrievalQuery = {
    ...query,
    minScore: 5,  // low threshold for coarse rank
    semanticBoostWeight: 0,  // disable inline semantic boost — done in Tier 2
  };
  const ranked = retriever.rankRecords(tier1Query);
  const top30 = ranked.slice(0, 30);
  const keywordResult = retriever.buildResult(ranked, query);

  // ── Tier 2: Semantic re-rank ─────────────────────────────────
  let tier2Ranked: { record: MemoryRecord; score: number }[] = top30.map(r => ({ record: r.record, score: r.score }));

  if (query.queryEmbedding && query.queryEmbedding.length > 0 && top30.length > 0) {
    const reranked = semanticRerank(top30.map(r => ({ record: r.record, score: r.score })), query.queryEmbedding);
    tier2Ranked = reranked.map(r => ({ record: r.record, score: r.score }));
    // Blend Tier 2 results into the keyword result for downstream use
    const tier2Result = retriever.buildResult(tier2Ranked, query, {
      totalCandidates: ranked.length,
    });
    // Apply re-ranked records/scores into the result
    if (tier2Result.records.length > 0) {
      tier2Ranked = tier2Result.records.map((r, i) => ({
        record: r,
        score: tier2Result.scores[i] ?? r.score ?? 0,
      }));
    }
  }

  // ── Tier 3: LLM cascade (only on low confidence) ────────────
  const pool = store.listExcludingCurrent();
  const cascadeConfig = {
    ...DEFAULT_CASCADE_CONFIG,
    ...options.cascadeConfig,
  };

  if (
    options.llmSelect &&
    shouldTriggerTier3(tier2Ranked, pool.length)
  ) {
    const scoreById = new Map(
      tier2Ranked.map((item) => [item.record.id, item.score]),
    );

    // A.4: Shard-based manifest loop
    const sorted = [...pool].sort((a, b) => b.updatedAt - a.updatedAt);
    const shardSize = options.shardSize ?? DEFAULT_SHARD_SIZE;
    const shards: MemoryRecord[][] = [];
    for (let i = 0; i < sorted.length; i += shardSize) {
      shards.push(sorted.slice(i, i + shardSize));
    }
    const maxShards = 5;
    const visibleShards = shards.slice(0, maxShards);

    try {
      const selectedIds = new Set<string>();
      const limit = query.limit ?? 5;

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
        if (selectedIds.size >= limit * 2) break;
      }

      const selected = [...selectedIds]
        .map((id) => {
          // Search tier2 re-ranked first, then fall back to sorted pool
          const record = tier2Ranked.find((r) => r.record.id === id)?.record
            ?? sorted.find((r) => r.id === id);
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
        };
      }
    } catch {
      /* keyword result below */
    }
  }

  // Fallback: return Tier1/Tier2 result
  const finalResult = retriever.buildResult(
    tier2Ranked,
    query,
    { totalCandidates: ranked.length },
  );
  return {
    ...finalResult,
    retrievalMode: "cascade",
    usedLlmFallback: false,
  };
}

export async function retrieveMemories(
  store: UnifiedMemoryStore,
  query: RetrievalQuery,
  options: RetrieveMemoriesOptions = {},
): Promise<MemoryRetrievalResult> {
  const mode = options.mode ?? "keyword";

  // B.4: Auto-classify task profile from goal when not explicitly set
  const effectiveQuery: RetrievalQuery = query.taskProfile
    ? query
    : { ...query, taskProfile: classifyTask(query.goal, query.errorMessage) };

  if (mode === "cascade") {
    return retrieveCascadeMemories(store, effectiveQuery, options);
  }

  const retriever = new KeywordMemoryRetriever(store, options.config);
  const result = retriever.retrieve(effectiveQuery);
  return { ...result, retrievalMode: "keyword" };
}
