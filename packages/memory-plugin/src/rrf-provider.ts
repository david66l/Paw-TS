import type {
  MemoryEmbeddingService,
  MemoryEntry,
  MemoryStoreEngine,
  ScoredEntry,
  ScoredId,
} from "@paw/memory/longterm";
import { PostgresMemoryStoreEngine } from "@paw/memory/longterm";
import type { MemoryCardV1 } from "@paw/protocol";

import {
  assertMemoryEngineScopeV1,
  estimateMemoryCardTokensV1,
  memoryEntryToCardV1,
  postgresMemoryStorageNamespaceV1,
} from "./longterm-v2-provider.js";
import {
  PAW_NEXT_MEMORY_RRF_PROVIDER_VERSION_V1,
  PAW_NEXT_MEMORY_RRF_RERANK_PROVIDER_VERSION_V1,
  type PawNextMemoryPluginProfileV1,
  type PawNextMemoryRerankerIdentityV1,
  freezePawNextMemoryPluginProfileV1,
} from "./profile.js";
import {
  type CachedMemoryProviderOptionsV1,
  createCachedMemoryProviderV1,
} from "./retrieval-cache.js";
import {
  type MemoryProviderQueryV1,
  type MemoryProviderResultV1,
  type MemoryProviderV1,
  type MemorySearchTextV1,
  createMemorySearchTextsV1,
} from "./retrieval-input-port.js";
/*
 * Six bounded lists cover the full semantic query, two current-input lexical
 * anchors, and the equivalent goal variants without model-side query rewriting.
 */
const MAX_SEARCH_VARIANTS = 6;

const RRF_K = 60;
const MAX_CANDIDATES = 128;
export const MEMORY_RRF_TEXT_WEIGHT_V1 = 1;
export const MEMORY_RRF_VECTOR_WEIGHT_V1 = 0.35;

export function createPawNextMemoryRrfPostgresProviderV1(
  profile: PawNextMemoryPluginProfileV1,
  cache?: Omit<
    CachedMemoryProviderOptionsV1,
    "revisionToken" | "storageNamespace"
  > & { readonly storageNamespace?: string },
  store?: {
    readonly embedding?: MemoryEmbeddingService;
    readonly vectorPolicy?: MemoryVectorRecallPolicyV1;
  },
  reranker?: MemoryRerankerV1,
  telemetry?: {
    readonly onFusionEvent?: (event: MemoryRrfFusionEventV1) => void;
  },
): MemoryProviderV1 {
  const frozen = freezePawNextMemoryPluginProfileV1(profile);
  if (
    frozen.providerVersion !== PAW_NEXT_MEMORY_RRF_PROVIDER_VERSION_V1 &&
    frozen.providerVersion !== PAW_NEXT_MEMORY_RRF_RERANK_PROVIDER_VERSION_V1
  ) {
    throw new Error("Memory RRF provider profile version is invalid");
  }
  assertRerankerBinding(frozen, reranker);
  assertEmbeddingBinding(frozen, store?.embedding);
  const engine = new PostgresMemoryStoreEngine(frozen.scope, store);
  return createCachedMemoryProviderV1(
    createPawNextMemoryRrfProviderV1({
      engine,
      providerVersion: frozen.providerVersion,
      reranker,
      vectorPolicy:
        store?.vectorPolicy ??
        (store?.embedding &&
        !store.embedding.model.startsWith("partitioned-ngram+dense:")
          ? "lexical_gap_only"
          : "always"),
      onFusionEvent: telemetry?.onFusionEvent,
    }),
    {
      ...cache,
      storageNamespace:
        cache?.storageNamespace ?? postgresMemoryStorageNamespaceV1(),
      revisionToken: engine.retrievalRevisionToken.bind(engine),
    },
  );
}

export interface WeightedRankListV1 {
  readonly weight: number;
  readonly hits: readonly ScoredId[];
}

export interface RrfScoreV1 {
  readonly id: string;
  readonly score: number;
  readonly listHits: number;
}

export interface MemoryRerankCandidateV1 {
  readonly id: string;
  readonly kind: MemoryCardV1["kind"];
  readonly statement: string;
  readonly rrfScore: number;
  readonly confidence: number;
  readonly sourceRefs: readonly string[];
}

export interface MemoryRerankerV1 {
  readonly identity: PawNextMemoryRerankerIdentityV1;
  /** Return known candidate ids in preferred order; omission means filtering. */
  rerank(
    input: Readonly<{
      queryText: string;
      candidates: readonly MemoryRerankCandidateV1[];
      maxResults: number;
    }>,
    signal: AbortSignal,
  ): Promise<readonly string[]>;
}

export type MemoryVectorRecallPolicyV1 = "always" | "lexical_gap_only";

export interface MemoryRrfFusionEventV1 {
  readonly schemaVersion: "paw.memory-rrf-fusion-event.v1";
  readonly queryId: string;
  readonly providerVersion:
    | typeof PAW_NEXT_MEMORY_RRF_PROVIDER_VERSION_V1
    | typeof PAW_NEXT_MEMORY_RRF_RERANK_PROVIDER_VERSION_V1;
  readonly vectorPolicy: MemoryVectorRecallPolicyV1;
  readonly vectorSearched: boolean;
  readonly lexicalCandidateCount: number;
  readonly lexicalTopScore: number | null;
  readonly lexicalGateMinimum: number;
  readonly lexicalListFailures: number;
  readonly vectorListFailures: number;
  readonly fusedCandidateCount: number;
}

/** Score calibration is deliberately rank-only; BM25 and dense scores differ by backend. */
export function reciprocalRankFusionV1(
  lists: readonly WeightedRankListV1[],
): readonly RrfScoreV1[] {
  const scores = new Map<string, { score: number; listHits: number }>();
  for (const list of lists) {
    if (!Number.isFinite(list.weight) || list.weight <= 0) continue;
    const seen = new Set<string>();
    for (const [index, hit] of list.hits.entries()) {
      if (!hit.id || seen.has(hit.id)) continue;
      seen.add(hit.id);
      const current = scores.get(hit.id) ?? { score: 0, listHits: 0 };
      current.score += list.weight / (RRF_K + index + 1);
      current.listHits += 1;
      scores.set(hit.id, current);
    }
  }
  return Object.freeze(
    [...scores.entries()]
      .map(([id, value]) => Object.freeze({ id, ...value }))
      .sort(
        (left, right) =>
          right.score - left.score ||
          right.listHits - left.listHits ||
          left.id.localeCompare(right.id),
      ),
  );
}

/**
 * M1 read-only provider v2: structured multi-query + BM25/vector RRF.
 * It has no ledger, trial, write, or runtime side effects.
 */
export function createPawNextMemoryRrfProviderV1(input: {
  readonly engine: MemoryStoreEngine;
  readonly providerVersion?:
    | typeof PAW_NEXT_MEMORY_RRF_PROVIDER_VERSION_V1
    | typeof PAW_NEXT_MEMORY_RRF_RERANK_PROVIDER_VERSION_V1;
  readonly reranker?: MemoryRerankerV1;
  readonly vectorPolicy?: MemoryVectorRecallPolicyV1;
  readonly onFusionEvent?: (event: MemoryRrfFusionEventV1) => void;
}): MemoryProviderV1 {
  if (!input.engine) throw new Error("Memory RRF provider engine is required");
  const providerVersion =
    input.providerVersion ?? PAW_NEXT_MEMORY_RRF_PROVIDER_VERSION_V1;
  const vectorPolicy = input.vectorPolicy ?? "always";
  if (
    (providerVersion === PAW_NEXT_MEMORY_RRF_RERANK_PROVIDER_VERSION_V1) !==
    Boolean(input.reranker)
  ) {
    throw new Error("Memory RRF reranker does not match provider version");
  }
  return Object.freeze({
    providerVersion,
    async retrieve(
      query: MemoryProviderQueryV1,
      signal: AbortSignal,
    ): Promise<MemoryProviderResultV1> {
      if (signal.aborted) throw abortError();
      assertMemoryEngineScopeV1(input.engine, query);
      const variants = normalizeSearchVariants(query);
      if (variants.length === 0) {
        return Object.freeze({
          status: "completed" as const,
          cards: Object.freeze([]),
        });
      }
      const candidateK = Math.min(
        MAX_CANDIDATES,
        Math.max(query.maxCards * 8, 32),
      );
      const lexical = await Promise.all(
        variants.map((variant) =>
          settleRankList(
            variant.weight * MEMORY_RRF_TEXT_WEIGHT_V1,
            input.engine.searchText(
              variant.text,
              candidateK,
              query.scope.repositoryId,
            ),
          ),
        ),
      );
      if (signal.aborted) throw abortError();
      const lexicalCandidateCount = uniqueCandidateCount(lexical);
      const lexicalGateMinimum = Math.min(
        candidateK,
        Math.max(query.maxCards * 2, 16),
      );
      const vectorSearched =
        vectorPolicy === "always" || lexicalCandidateCount < lexicalGateMinimum;
      const vector = vectorSearched
        ? await Promise.all(
            variants.map((variant) =>
              settleRankList(
                variant.weight * MEMORY_RRF_VECTOR_WEIGHT_V1,
                input.engine.searchVector(
                  variant.text,
                  candidateK,
                  query.scope.repositoryId,
                ),
              ),
            ),
          )
        : [];
      if (signal.aborted) throw abortError();
      const settled = [...lexical, ...vector];
      let degraded = settled.some((result) => result.failed);
      const ranking = reciprocalRankFusionV1(
        settled.filter((result) => !result.failed).map((result) => result.list),
      );
      emitFusionEvent(input, {
        schemaVersion: "paw.memory-rrf-fusion-event.v1",
        queryId: query.queryId,
        providerVersion,
        vectorPolicy,
        vectorSearched,
        lexicalCandidateCount,
        lexicalTopScore: topCandidateScore(lexical),
        lexicalGateMinimum,
        lexicalListFailures: lexical.filter((result) => result.failed).length,
        vectorListFailures: vector.filter((result) => result.failed).length,
        fusedCandidateCount: ranking.length,
      });
      const candidateCards: Array<{
        readonly card: MemoryCardV1;
        readonly score: number;
      }> = [];
      const rerankCandidateLimit = Math.min(
        32,
        Math.max(query.maxCards * 4, 10),
      );
      for (const ranked of ranking) {
        if (candidateCards.length >= rerankCandidateLimit) break;
        let entry: MemoryEntry | null;
        try {
          entry = await input.engine.get(ranked.id);
        } catch {
          degraded = true;
          continue;
        }
        if (!entry || !isInjectable(entry)) continue;
        const scored: ScoredEntry = {
          entry,
          score: ranked.score,
          bm25Score: 0,
          vectorScore: 0,
          bonuses: [],
        };
        const card = memoryEntryToCardV1(scored, query);
        if (!card) continue;
        candidateCards.push(Object.freeze({ card, score: ranked.score }));
      }
      let ordered = candidateCards;
      if (input.reranker && candidateCards.length > 0) {
        try {
          const order = await input.reranker.rerank(
            Object.freeze({
              queryText: query.text,
              candidates: Object.freeze(
                candidateCards.map(({ card, score }) =>
                  Object.freeze({
                    id: card.id,
                    kind: card.kind,
                    statement: card.statement,
                    rrfScore: score,
                    confidence: card.confidence,
                    sourceRefs: Object.freeze(
                      card.sources.map((source) => source.ref),
                    ),
                  }),
                ),
              ),
              maxResults: query.maxCards,
            }),
            signal,
          );
          ordered = applyRerankOrder(candidateCards, order);
        } catch {
          degraded = true;
        }
      }
      if (signal.aborted) throw abortError();
      const cards: MemoryCardV1[] = [];
      let usedTokens = 0;
      for (const { card } of ordered) {
        if (cards.length >= query.maxCards) break;
        const tokens = estimateMemoryCardTokensV1(card);
        if (tokens > query.maxInjectedTokens - usedTokens) continue;
        cards.push(card);
        usedTokens += tokens;
      }
      return Object.freeze({
        status: degraded ? ("degraded" as const) : ("completed" as const),
        cards: Object.freeze(cards),
        ...(degraded ? { reasonCode: "memory_rrf_partial_recall" } : {}),
      });
    },
  });
}

function uniqueCandidateCount(
  settled: readonly Awaited<ReturnType<typeof settleRankList>>[],
): number {
  const ids = new Set<string>();
  for (const result of settled) {
    if (result.failed) continue;
    for (const hit of result.list.hits) ids.add(hit.id);
  }
  return ids.size;
}

function topCandidateScore(
  settled: readonly Awaited<ReturnType<typeof settleRankList>>[],
): number | null {
  let top: number | null = null;
  for (const result of settled) {
    if (result.failed) continue;
    for (const hit of result.list.hits) {
      if (!Number.isFinite(hit.score)) continue;
      top = top === null ? hit.score : Math.max(top, hit.score);
    }
  }
  return top;
}

function emitFusionEvent(
  input: { readonly onFusionEvent?: (event: MemoryRrfFusionEventV1) => void },
  event: MemoryRrfFusionEventV1,
): void {
  try {
    input.onFusionEvent?.(Object.freeze(event));
  } catch {
    // Caller-owned telemetry never changes retrieval semantics.
  }
}

function applyRerankOrder<T extends { readonly card: MemoryCardV1 }>(
  candidates: readonly T[],
  order: readonly string[],
): T[] {
  if (!Array.isArray(order) || order.length === 0) {
    throw new Error("Memory reranker returned an empty order");
  }
  const byId = new Map(
    candidates.map((candidate) => [candidate.card.id, candidate]),
  );
  const seen = new Set<string>();
  const output: T[] = [];
  for (const id of order) {
    if (typeof id !== "string" || seen.has(id)) {
      throw new Error("Memory reranker returned an invalid id order");
    }
    const candidate = byId.get(id);
    if (!candidate) throw new Error("Memory reranker returned an unknown id");
    seen.add(id);
    output.push(candidate);
  }
  return output;
}

function assertRerankerBinding(
  profile: PawNextMemoryPluginProfileV1,
  reranker: MemoryRerankerV1 | undefined,
): void {
  const expects =
    profile.providerVersion === PAW_NEXT_MEMORY_RRF_RERANK_PROVIDER_VERSION_V1;
  if (expects !== Boolean(reranker) || expects !== Boolean(profile.reranker)) {
    throw new Error("Memory reranker binding is incomplete");
  }
  if (
    reranker &&
    (reranker.identity.provider !== profile.reranker?.provider ||
      reranker.identity.model !== profile.reranker?.model ||
      reranker.identity.revision !== profile.reranker?.revision)
  ) {
    throw new Error(
      "Memory reranker identity does not match the frozen profile",
    );
  }
}

function assertEmbeddingBinding(
  profile: PawNextMemoryPluginProfileV1,
  embedding: MemoryEmbeddingService | undefined,
): void {
  if (Boolean(profile.embedding) !== Boolean(embedding)) {
    throw new Error("Memory embedding binding is incomplete");
  }
  if (
    embedding &&
    (embedding.model !== profile.embedding?.model ||
      embedding.version !== profile.embedding?.version ||
      embedding.dimensions !== profile.embedding?.dimensions)
  ) {
    throw new Error(
      "Memory embedding identity does not match the frozen profile",
    );
  }
}

function normalizeSearchVariants(
  query: MemoryProviderQueryV1,
): readonly MemorySearchTextV1[] {
  const source =
    query.searchTexts ?? createMemorySearchTextsV1(undefined, query.text);
  const variants: MemorySearchTextV1[] = [];
  const seen = new Set<string>();
  for (const variant of source.slice(0, MAX_SEARCH_VARIANTS)) {
    const text = variant.text.trim().replace(/\s+/g, " ").slice(0, 8_192);
    if (
      !text ||
      seen.has(text) ||
      !Number.isFinite(variant.weight) ||
      variant.weight <= 0
    ) {
      continue;
    }
    seen.add(text);
    variants.push(Object.freeze({ ...variant, text }));
  }
  return Object.freeze(variants);
}

async function settleRankList(
  weight: number,
  operation: Promise<ScoredId[]>,
): Promise<{ readonly failed: boolean; readonly list: WeightedRankListV1 }> {
  try {
    return Object.freeze({
      failed: false,
      list: Object.freeze({ weight, hits: Object.freeze(await operation) }),
    });
  } catch {
    return Object.freeze({
      failed: true,
      list: Object.freeze({ weight, hits: Object.freeze([]) }),
    });
  }
}

function isInjectable(
  entry: MemoryEntry,
): entry is Extract<
  MemoryEntry,
  { kind: "semantic" | "episodic" | "profile" }
> {
  return (
    entry.tInvalid == null &&
    (entry.kind === "semantic" ||
      entry.kind === "episodic" ||
      entry.kind === "profile")
  );
}

function abortError(): Error {
  const error = new Error("Memory retrieval aborted");
  error.name = "AbortError";
  return error;
}
