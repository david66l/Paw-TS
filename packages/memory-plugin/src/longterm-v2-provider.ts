import {
  type MemoryEntry,
  type MemoryStoreEngine,
  PostgresMemoryStoreEngine,
  RECALL_ALPHA,
  type ScoredEntry,
  hybridRecall,
} from "@paw/memory/longterm";
import type { JsonValue, MemoryCardV1 } from "@paw/protocol";

import { hashCanonicalJsonV1 } from "./canonical.js";
import {
  PAW_NEXT_MEMORY_V2_PROVIDER_VERSION_V1,
  type PawNextMemoryPluginProfileV1,
  freezePawNextMemoryPluginProfileV1,
} from "./profile.js";
import {
  type CachedMemoryProviderOptionsV1,
  createCachedMemoryProviderV1,
} from "./retrieval-cache.js";
import type {
  MemoryProviderQueryV1,
  MemoryProviderResultV1,
  MemoryProviderV1,
} from "./retrieval-input-port.js";

export function createPawNextMemoryV2PostgresProviderV1(
  profile: PawNextMemoryPluginProfileV1,
  cache?: Omit<
    CachedMemoryProviderOptionsV1,
    "revisionToken" | "storageNamespace"
  > & { readonly storageNamespace?: string },
): MemoryProviderV1 {
  const frozen = freezePawNextMemoryPluginProfileV1(profile);
  if (frozen.providerVersion !== PAW_NEXT_MEMORY_V2_PROVIDER_VERSION_V1) {
    throw new Error("Memory v2 provider profile version is invalid");
  }
  const engine = new PostgresMemoryStoreEngine(frozen.scope);
  const provider = createPawNextMemoryV2ProviderV1({ engine });
  return createCachedMemoryProviderV1(provider, {
    ...cache,
    storageNamespace:
      cache?.storageNamespace ?? postgresMemoryStorageNamespaceV1(),
    revisionToken: engine.retrievalRevisionToken.bind(engine),
  });
}

export function postgresMemoryStorageNamespaceV1(): string {
  const databaseUrl =
    process.env.DATABASE_URL?.trim() ||
    "postgresql://localhost:5432/paw_memory";
  return `postgres:${hashCanonicalJsonV1(databaseUrl as unknown as JsonValue)}`;
}

/** Read-only adapter: it deliberately bypasses legacy hit ledgers and trials. */
export function createPawNextMemoryV2ProviderV1(input: {
  readonly engine: MemoryStoreEngine;
}): MemoryProviderV1 {
  if (!input.engine) throw new Error("Memory v2 provider engine is required");
  return Object.freeze({
    providerVersion: PAW_NEXT_MEMORY_V2_PROVIDER_VERSION_V1,
    async retrieve(
      query: MemoryProviderQueryV1,
      signal: AbortSignal,
    ): Promise<MemoryProviderResultV1> {
      if (signal.aborted) throw abortError();
      assertMemoryEngineScopeV1(input.engine, query);
      const options = {
        alpha: RECALL_ALPHA.taskStart,
        candidates: Math.max(query.maxCards * 4, 10),
        repo: query.scope.repositoryId,
      };
      const [episodic, profiles] = await Promise.all([
        hybridRecall(input.engine, query.text, {
          ...options,
          kind: "episodic",
        }),
        hybridRecall(input.engine, query.text, { ...options, kind: "profile" }),
      ]);
      if (signal.aborted) throw abortError();
      const candidates = [...episodic.items, ...profiles.items].sort(
        (left, right) =>
          right.score - left.score ||
          left.entry.id.localeCompare(right.entry.id),
      );
      const cards: MemoryCardV1[] = [];
      let usedTokens = 0;
      const seen = new Set<string>();
      for (const item of candidates) {
        if (cards.length >= query.maxCards || seen.has(item.entry.id)) continue;
        seen.add(item.entry.id);
        const card = memoryEntryToCardV1(item, query);
        if (!card) continue;
        const tokens = estimateMemoryCardTokensV1(card);
        if (tokens > query.maxInjectedTokens - usedTokens) continue;
        cards.push(card);
        usedTokens += tokens;
      }
      return Object.freeze({
        status:
          episodic.degraded || profiles.degraded ? "degraded" : "completed",
        cards: Object.freeze(cards),
        ...(episodic.degraded || profiles.degraded
          ? { reasonCode: "memory_v2_partial_recall" }
          : {}),
      });
    },
  });
}

export function memoryEntryToCardV1(
  item: ScoredEntry,
  query: MemoryProviderQueryV1,
): MemoryCardV1 | undefined {
  const entry = item.entry;
  if (
    entry.kind !== "semantic" &&
    entry.kind !== "episodic" &&
    entry.kind !== "profile"
  ) {
    return undefined;
  }
  const statement = renderStatement(entry).slice(0, 16_384);
  if (!statement.trim()) return undefined;
  const sources = Object.freeze(
    [...new Set([`memory:item/${entry.id}`, ...entry.evidence])]
      .slice(0, 32)
      .map((ref) =>
        Object.freeze({ kind: "memory_store_evidence" as const, ref }),
      ),
  );
  const base = Object.freeze({
    id: entry.id,
    revision: 1,
    kind: entry.kind,
    statement,
    applicability:
      entry.kind !== "profile" &&
      [
        "agent_verified",
        "user_statement",
        "repo_docs",
        "trial_graduated",
      ].includes(entry.source)
        ? ("applicable" as const)
        : ("reference" as const),
    scope: Object.freeze({
      repositoryId: query.scope.repositoryId,
      ...(entry.kind === "episodic" && entry.branch
        ? { branch: entry.branch }
        : {}),
    }),
    sources,
    confidence: clampConfidence(entry.confidence),
    validFrom: entry.tValid,
  });
  return Object.freeze({
    ...base,
    contentHash: hashCanonicalJsonV1(base as unknown as JsonValue),
  });
}

function renderStatement(
  entry: Extract<MemoryEntry, { kind: "semantic" | "episodic" | "profile" }>,
): string {
  if (entry.kind === "profile") return entry.insight;
  if (entry.kind === "semantic") return entry.fact;
  return [
    `Situation: ${entry.whenToUse}`,
    `Lesson: ${entry.perspective}`,
    `Possible adjustment: ${entry.modification.join("; ")}`,
  ].join("\n");
}

export function estimateMemoryCardTokensV1(card: MemoryCardV1): number {
  return Math.ceil(JSON.stringify(card).length / 4) + 8;
}

function clampConfidence(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

export function assertMemoryEngineScopeV1(
  engine: MemoryStoreEngine,
  query: MemoryProviderQueryV1,
): void {
  const scope = engine.scope;
  if (
    !scope ||
    scope.tenantId !== query.scope.tenantId ||
    scope.userId !== query.scope.userId ||
    scope.workspaceId !== query.scope.workspaceId ||
    scope.repositoryId !== query.scope.repositoryId
  ) {
    throw new Error(
      "Memory provider scope does not match the frozen task scope",
    );
  }
}

function abortError(): Error {
  const error = new Error("Memory retrieval aborted");
  error.name = "AbortError";
  return error;
}
