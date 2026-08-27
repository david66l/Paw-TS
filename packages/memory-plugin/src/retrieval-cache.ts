import type { JsonValue } from "@paw/protocol";

import { hashCanonicalJsonV1 } from "./canonical.js";
import { memoryScopeFingerprintV1 } from "./profile.js";
import type {
  MemoryProviderQueryV1,
  MemoryProviderResultV1,
  MemoryProviderV1,
} from "./retrieval-input-port.js";
import {
  PAW_MEMORY_SEARCH_PLAN_VERSION_V2,
  createMemorySearchTextsV1,
} from "./retrieval-input-port.js";

export const PAW_NEXT_MEMORY_RETRIEVAL_CACHE_POLICY_VERSION_V1 =
  "paw.memory-retrieval-cache.v2:storage-namespace" as const;

export type MemoryRetrievalCacheEventTypeV1 =
  | "hit"
  | "miss"
  | "store"
  | "expired"
  | "bypass";

export interface MemoryRetrievalCacheEventV1 {
  readonly schemaVersion: "paw.memory-retrieval-cache-event.v1";
  readonly event: MemoryRetrievalCacheEventTypeV1;
  readonly cachePolicyVersion: typeof PAW_NEXT_MEMORY_RETRIEVAL_CACHE_POLICY_VERSION_V1;
  readonly cacheKey?: string;
  readonly queryId: string;
  readonly trigger: MemoryProviderQueryV1["trigger"];
  readonly providerVersion: string;
  readonly scopeFingerprint: string;
  readonly cardCount?: number;
  readonly ageMs?: number;
  readonly durationMs: number;
  readonly reasonCode?: "revision_unavailable" | "result_not_completed";
}

export interface MemoryRetrievalCacheStatsV1 {
  readonly hits: number;
  readonly misses: number;
  readonly stores: number;
  readonly expired: number;
  readonly bypasses: number;
  readonly entries: number;
  readonly hitRate: number;
}

interface CacheRecordV1 {
  readonly storedAtMs: number;
  readonly result: MemoryProviderResultV1;
}

export interface MemoryRetrievalCacheStoreV1 {
  get(
    key: string,
    nowMs: number,
    ttlMs: number,
  ): {
    readonly state: "hit" | "miss" | "expired";
    readonly ageMs?: number;
    readonly result?: MemoryProviderResultV1;
  };
  set(key: string, result: MemoryProviderResultV1, nowMs: number): void;
  recordBypass(): void;
  snapshot(): MemoryRetrievalCacheStatsV1;
  clear(): void;
}

export interface CachedMemoryProviderOptionsV1 {
  /** Must change whenever a write can alter retrieval output. */
  readonly revisionToken: () => Promise<string>;
  /** Stable, non-secret identity of the physical backend and logical dataset. */
  readonly storageNamespace: string;
  readonly cache?: MemoryRetrievalCacheStoreV1;
  readonly ttlMs?: number;
  readonly now?: () => number;
  readonly onEvent?: (event: MemoryRetrievalCacheEventV1) => void;
}

const DEFAULT_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_MAX_ENTRIES = 512;

export function createMemoryRetrievalCacheStoreV1(input?: {
  readonly maxEntries?: number;
}): MemoryRetrievalCacheStoreV1 {
  const maxEntries = input?.maxEntries ?? DEFAULT_MAX_ENTRIES;
  if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
    throw new Error("Memory retrieval cache maxEntries must be positive");
  }
  const records = new Map<string, CacheRecordV1>();
  let hits = 0;
  let misses = 0;
  let stores = 0;
  let expired = 0;
  let bypasses = 0;

  return Object.freeze({
    get(key: string, nowMs: number, ttlMs: number) {
      const record = records.get(key);
      if (!record) {
        misses += 1;
        return Object.freeze({ state: "miss" as const });
      }
      const ageMs = Math.max(0, nowMs - record.storedAtMs);
      if (ageMs >= ttlMs) {
        records.delete(key);
        expired += 1;
        return Object.freeze({ state: "expired" as const, ageMs });
      }
      // Refresh insertion order for deterministic LRU eviction.
      records.delete(key);
      records.set(key, record);
      hits += 1;
      return Object.freeze({
        state: "hit" as const,
        ageMs,
        result: record.result,
      });
    },
    set(key: string, result: MemoryProviderResultV1, nowMs: number) {
      records.delete(key);
      records.set(key, Object.freeze({ storedAtMs: nowMs, result }));
      stores += 1;
      while (records.size > maxEntries) {
        const oldest = records.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        records.delete(oldest);
      }
    },
    recordBypass() {
      bypasses += 1;
    },
    snapshot() {
      const attempts = hits + misses + expired;
      return Object.freeze({
        hits,
        misses,
        stores,
        expired,
        bypasses,
        entries: records.size,
        hitRate: attempts === 0 ? 0 : hits / attempts,
      });
    },
    clear() {
      records.clear();
      hits = 0;
      misses = 0;
      stores = 0;
      expired = 0;
      bypasses = 0;
    },
  });
}

const sharedMemoryRetrievalCacheV1 = createMemoryRetrievalCacheStoreV1();

export function getSharedMemoryRetrievalCacheV1(): MemoryRetrievalCacheStoreV1 {
  return sharedMemoryRetrievalCacheV1;
}

export function createCachedMemoryProviderV1(
  provider: MemoryProviderV1,
  options: CachedMemoryProviderOptionsV1,
): MemoryProviderV1 {
  if (!provider || typeof provider.retrieve !== "function") {
    throw new Error("Memory retrieval cache provider is invalid");
  }
  if (typeof options.revisionToken !== "function") {
    throw new Error("Memory retrieval cache revisionToken is required");
  }
  const storageNamespace = normalizedStorageNamespace(options.storageNamespace);
  const cache = options.cache ?? sharedMemoryRetrievalCacheV1;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? Date.now;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error("Memory retrieval cache ttlMs must be positive");
  }

  return Object.freeze({
    providerVersion: provider.providerVersion,
    async retrieve(
      query: MemoryProviderQueryV1,
      signal: AbortSignal,
    ): Promise<MemoryProviderResultV1> {
      if (signal.aborted) throw abortError();
      const startedAtMs = now();
      const scopeFingerprint = memoryScopeFingerprintV1(query.scope);
      let revisionToken: string;
      try {
        revisionToken = await options.revisionToken();
        if (!revisionToken) throw new Error("empty revision token");
      } catch {
        cache.recordBypass();
        emit(options, {
          event: "bypass",
          query,
          provider,
          scopeFingerprint,
          durationMs: elapsed(now, startedAtMs),
          reasonCode: "revision_unavailable",
        });
        return provider.retrieve(query, signal);
      }
      if (signal.aborted) throw abortError();

      const cacheKey = buildCacheKey(
        query,
        provider.providerVersion,
        revisionToken,
        storageNamespace,
      );
      const lookup = cache.get(cacheKey, now(), ttlMs);
      emit(options, {
        event: lookup.state,
        query,
        provider,
        scopeFingerprint,
        cacheKey,
        ...(lookup.ageMs === undefined ? {} : { ageMs: lookup.ageMs }),
        ...(lookup.result ? { cardCount: lookup.result.cards.length } : {}),
        durationMs: elapsed(now, startedAtMs),
      });
      if (lookup.result) return lookup.result;

      const result = await provider.retrieve(query, signal);
      if (signal.aborted) throw abortError();
      if (result.status === "completed") {
        cache.set(cacheKey, result, now());
        emit(options, {
          event: "store",
          query,
          provider,
          scopeFingerprint,
          cacheKey,
          cardCount: result.cards.length,
          durationMs: elapsed(now, startedAtMs),
        });
      } else {
        cache.recordBypass();
        emit(options, {
          event: "bypass",
          query,
          provider,
          scopeFingerprint,
          cacheKey,
          cardCount: result.cards.length,
          durationMs: elapsed(now, startedAtMs),
          reasonCode: "result_not_completed",
        });
      }
      return result;
    },
  });
}

function buildCacheKey(
  query: MemoryProviderQueryV1,
  providerVersion: string,
  revisionToken: string,
  storageNamespace: string,
): string {
  return hashCanonicalJsonV1({
    schemaVersion: PAW_NEXT_MEMORY_RETRIEVAL_CACHE_POLICY_VERSION_V1,
    providerVersion,
    storageNamespace,
    revisionToken,
    queryTextHash: hashCanonicalJsonV1(query.text as unknown as JsonValue),
    searchPlanHash: hashCanonicalJsonV1(
      (query.searchTexts ??
        createMemorySearchTextsV1(
          undefined,
          query.text,
        )) as unknown as JsonValue,
    ),
    searchPlanVersion: PAW_MEMORY_SEARCH_PLAN_VERSION_V2,
    inputContentHash: query.inputContentHash,
    trigger: query.trigger,
    scopeFingerprint: memoryScopeFingerprintV1(query.scope),
    maxCards: query.maxCards,
    maxInjectedTokens: query.maxInjectedTokens,
  } as unknown as JsonValue);
}

function normalizedStorageNamespace(value: string): string {
  const normalized = value?.trim();
  if (!normalized || normalized.length > 256) {
    throw new Error("Memory retrieval cache storageNamespace is invalid");
  }
  return normalized;
}

function emit(
  options: CachedMemoryProviderOptionsV1,
  input: {
    readonly event: MemoryRetrievalCacheEventTypeV1;
    readonly query: MemoryProviderQueryV1;
    readonly provider: MemoryProviderV1;
    readonly scopeFingerprint: string;
    readonly cacheKey?: string;
    readonly cardCount?: number;
    readonly ageMs?: number;
    readonly durationMs: number;
    readonly reasonCode?: MemoryRetrievalCacheEventV1["reasonCode"];
  },
): void {
  try {
    options.onEvent?.(
      Object.freeze({
        schemaVersion: "paw.memory-retrieval-cache-event.v1" as const,
        event: input.event,
        cachePolicyVersion: PAW_NEXT_MEMORY_RETRIEVAL_CACHE_POLICY_VERSION_V1,
        queryId: input.query.queryId,
        trigger: input.query.trigger,
        providerVersion: input.provider.providerVersion,
        scopeFingerprint: input.scopeFingerprint,
        durationMs: input.durationMs,
        ...(input.cacheKey ? { cacheKey: input.cacheKey } : {}),
        ...(input.cardCount === undefined
          ? {}
          : { cardCount: input.cardCount }),
        ...(input.ageMs === undefined ? {} : { ageMs: input.ageMs }),
        ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
      }),
    );
  } catch {
    // Telemetry is caller-owned and must never change retrieval semantics.
  }
}

function elapsed(now: () => number, startedAtMs: number): number {
  return Math.max(0, now() - startedAtMs);
}

function abortError(): Error {
  const error = new Error("Memory retrieval aborted");
  error.name = "AbortError";
  return error;
}
