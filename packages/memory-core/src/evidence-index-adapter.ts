import {
  type JsonValue,
  hashCanonicalJsonV1,
  hashTextV1,
} from "./canonical.js";
import type { MemoryEvidenceKindV2 } from "./evidence-first.js";
import { evidenceSourceIdV1 as evidenceSourceId } from "./evidence-ref.js";
import type {
  MemoryEvidenceIndexSearchResultV1,
  MemoryEvidenceIndexV1,
} from "./evidence-resolver.js";
import type {
  MemoryProductArchiveV1,
  MemoryProductProfileV1,
  MemoryProductProviderV1,
  MemoryProductScopeV1,
} from "./product-ports.js";

export { evidenceSourceIdV1 } from "./evidence-ref.js";

export const PAW_MEMORY_PRODUCT_EVIDENCE_INDEX_VERSION_V1 =
  "paw.memory-product-evidence-index.v2:l1-navigation-l0-hydration" as const;

/** Product adapter for the shared evidence resolver; runtime stays unaware. */
export function createProductMemoryEvidenceIndexV1<
  TArchive extends MemoryProductArchiveV1,
>(input: {
  readonly profile: MemoryProductProfileV1;
  readonly provider: MemoryProductProviderV1;
  /** Extra host capabilities are accepted but never enter the read core. */
  readonly archive: TArchive;
  readonly maxRawSpans?: number;
  readonly maxRawChars?: number;
}): MemoryEvidenceIndexV1 {
  assertArchiveScope(input.archive.scope, input.profile.scope);
  const maxRawSpans = input.maxRawSpans ?? 16;
  const maxRawChars = input.maxRawChars ?? 8_000;
  if (
    !Number.isSafeInteger(maxRawSpans) ||
    maxRawSpans < 1 ||
    maxRawSpans > 16 ||
    !Number.isSafeInteger(maxRawChars) ||
    maxRawChars < 256 ||
    maxRawChars > 16_384
  ) {
    throw namedError("MemoryProductEvidenceIndexBudgetInvalid");
  }
  return Object.freeze({
    indexVersion: PAW_MEMORY_PRODUCT_EVIDENCE_INDEX_VERSION_V1,
    async search(query: string, signal: AbortSignal) {
      const value = query.trim().replace(/\s+/gu, " ");
      if (!value || value.length > 512) {
        throw namedError("MemoryProductEvidenceIndexQueryInvalid");
      }
      const queryHash = hashTextV1(value);
      const providerQuery = Object.freeze({
        queryId: hashCanonicalJsonV1({
          schemaVersion: "paw.memory-product-evidence-query.v1",
          queryHash,
          providerVersion: input.provider.providerVersion,
          scope: input.profile.scope,
        } as unknown as JsonValue),
        trigger: "task_start" as const,
        text: value,
        inputId: `memory-evidence-${queryHash.slice(0, 24)}`,
        inputContentHash: queryHash,
        scope: input.profile.scope,
        maxCards: Math.min(16, Math.max(8, input.profile.maxCards)),
        maxInjectedTokens: Math.max(1_024, input.profile.maxInjectedTokens),
      });
      const [retrievalSettlement, rawSettlement] = await Promise.allSettled([
        input.provider.retrieve(providerQuery, signal),
        input.archive.search
          ? input.archive.search(
              { query: value, maxSpans: maxRawSpans, maxChars: maxRawChars },
              signal,
            )
          : Promise.resolve([]),
      ]);
      if (signal.aborted) throw abortError();
      const degradedChannels: Array<"l0" | "l1"> = [];
      const retrieval =
        retrievalSettlement.status === "fulfilled"
          ? retrievalSettlement.value
          : { status: "degraded" as const, cards: Object.freeze([]) };
      if (
        retrievalSettlement.status === "rejected" ||
        retrieval.status !== "completed"
      ) {
        degradedChannels.push("l1");
      }
      const raw =
        rawSettlement.status === "fulfilled" ? rawSettlement.value : [];
      if (rawSettlement.status === "rejected" || !input.archive.search) {
        degradedChannels.push("l0");
      }
      const l0Candidates = raw.map((span) => ({
        candidateId: `l0:${span.evidenceRef}`,
        sourceId: evidenceSourceId(span.evidenceRef),
        evidenceRef: span.evidenceRef,
        sourceKind: span.sourceKind as MemoryEvidenceKindV2,
        authority: span.authority,
        observedAt: span.createdAt,
      }));
      const l1Candidates = retrieval.cards.flatMap((card) => {
        const refs =
          card.sources.length > 0
            ? card.sources.map((source) => source.ref)
            : [`memory:${card.id}`];
        return refs.map((evidenceRef) => ({
          candidateId: `l1:${card.id}:${evidenceRef}`,
          sourceId: evidenceSourceId(evidenceRef),
          evidenceRef,
          sourceKind: "derived_atom" as const,
          authority: "derived" as const,
          ...(card.validFrom === undefined
            ? {}
            : { observedAt: card.validFrom }),
        }));
      });
      const lists = [
        ...(l0Candidates.length === 0
          ? []
          : [
              Object.freeze({
                channel: "l0" as const,
                retrieverId: "product-l0-conversation",
                weight: 1,
                candidates: Object.freeze(l0Candidates),
              }),
            ]),
        ...(l1Candidates.length === 0
          ? []
          : [
              Object.freeze({
                channel: "l1" as const,
                retrieverId: "product-l1-provider",
                weight: 0.75,
                candidates: Object.freeze(l1Candidates),
              }),
            ]),
      ];
      // L1 cards are navigation only. Model-facing evidence must be hydrated
      // from the authoritative L0 archive, otherwise a derived summary could
      // be type-erased and falsely reported as verified raw evidence.
      const hits = raw.map((span) =>
        Object.freeze({
          sourceId: evidenceSourceId(span.evidenceRef),
          evidenceRef: span.evidenceRef,
          content: span.hitContent,
          authority: span.authority,
          sourceKind: span.sourceKind,
          observedAt: span.createdAt,
          turnOrder: span.sourceSeq,
        }),
      );
      return Object.freeze({
        lists: Object.freeze(lists),
        hits: Object.freeze(hits),
        degradedChannels: Object.freeze(degradedChannels),
      }) satisfies MemoryEvidenceIndexSearchResultV1;
    },
  });
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

function abortError(): Error {
  const error = new Error("Memory product evidence search aborted");
  error.name = "AbortError";
  return error;
}

function assertArchiveScope(
  actual: MemoryProductScopeV1,
  expected: MemoryProductScopeV1,
): void {
  if (
    actual.tenantId !== expected.tenantId ||
    actual.userId !== expected.userId ||
    actual.workspaceId !== expected.workspaceId ||
    actual.repositoryId !== expected.repositoryId
  ) {
    throw namedError("MemoryProductEvidenceArchiveScopeMismatch");
  }
}
