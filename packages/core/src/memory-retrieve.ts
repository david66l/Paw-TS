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
import type { UnifiedMemoryStore } from "./unified-memory-store.js";

export interface RetrieveMemoriesOptions {
  readonly mode?: "keyword" | "cascade";
  readonly config?: RetrievalConfig;
  readonly llmSelect?: LlmMemorySelectFn;
  readonly cascadeConfig?: CascadeFallbackConfig;
}

async function retrieveCascadeMemories(
  store: UnifiedMemoryStore,
  query: RetrievalQuery,
  options: RetrieveMemoriesOptions,
): Promise<MemoryRetrievalResult> {
  const retriever = new KeywordMemoryRetriever(store, options.config);
  const ranked = retriever.rankRecords(query);
  const keywordResult = retriever.buildResult(ranked, query);
  const pool = store.listExcludingCurrent();
  const cascadeConfig = {
    ...DEFAULT_CASCADE_CONFIG,
    ...options.cascadeConfig,
  };

  if (
    options.llmSelect &&
    shouldEscalateToLlmFallback(
      keywordResult,
      ranked,
      pool.length,
      cascadeConfig,
    )
  ) {
    const manifestRecords = [...pool]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, cascadeConfig.maxManifestEntries);
    const candidateIds = manifestRecords.map((record) => record.id);
    const scoreById = new Map(
      ranked.map((item) => [item.record.id, item.score]),
    );

    try {
      const selectedIds = await options.llmSelect({
        query,
        manifest: formatMemoryManifest(manifestRecords),
        candidateIds,
      });
      const limit = query.limit ?? 5;
      const selected = selectedIds
        .filter((id) => candidateIds.includes(id))
        .slice(0, limit)
        .map((id) => {
          const record = manifestRecords.find((item) => item.id === id);
          if (!record) return null;
          return {
            record,
            score: scoreById.get(id) ?? LLM_FALLBACK_SCORE,
          };
        })
        .filter(
          (
            item,
          ): item is { record: (typeof pool)[number]; score: number } =>
            item !== null,
        );

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

  return {
    ...keywordResult,
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

  if (mode === "cascade") {
    return retrieveCascadeMemories(store, query, options);
  }

  const retriever = new KeywordMemoryRetriever(store, options.config);
  const result = retriever.retrieve(query);
  return { ...result, retrievalMode: "keyword" };
}
