import { type JsonValue, canonicalJsonStringifyV1 } from "./canonical.js";
import type {
  MemoryProductArchiveV1,
  MemoryProductCardV1,
  MemoryProductProviderV1,
  MemoryProductRawEvidenceV1,
  MemoryProductScopeV1,
} from "./product-ports.js";

export interface InMemoryEvidenceInputV1 extends MemoryProductRawEvidenceV1 {}

export interface InMemoryCardInputV1 extends MemoryProductCardV1 {
  /** Searchable L1 navigation text; it is never rendered as L0 evidence. */
  readonly statement: string;
}

export interface InMemoryEvidenceStoreV1
  extends MemoryProductArchiveV1,
    MemoryProductProviderV1 {
  putEvidence(spans: readonly InMemoryEvidenceInputV1[]): void;
  putCards(cards: readonly InMemoryCardInputV1[]): void;
}

/** Small deterministic reference adapter for examples, tests, and prototypes. */
export function createInMemoryEvidenceStoreV1(input: {
  readonly scope: MemoryProductScopeV1;
}): InMemoryEvidenceStoreV1 {
  const scope = Object.freeze({ ...input.scope });
  const evidence = new Map<string, InMemoryEvidenceInputV1>();
  const cards = new Map<string, InMemoryCardInputV1>();

  return Object.freeze({
    providerVersion: "paw.memory-reference-store.v1",
    scope,
    putEvidence(spans: readonly InMemoryEvidenceInputV1[]) {
      for (const span of spans) {
        assertEvidence(span);
        putImmutable(evidence, span.evidenceRef, freezeEvidence(span));
      }
    },
    putCards(nextCards: readonly InMemoryCardInputV1[]) {
      for (const card of nextCards) {
        assertCard(card);
        cards.set(card.id, freezeCard(card));
      }
    },
    async search(
      query: Parameters<NonNullable<MemoryProductArchiveV1["search"]>>[0],
      signal: AbortSignal,
    ) {
      if (signal.aborted) throw abortError();
      const terms = searchTerms(query.query);
      const ranked = [...evidence.values()]
        .map((span) => ({ span, score: lexicalScore(span.hitContent, terms) }))
        .filter((item) => item.score > 0)
        .sort(
          (left, right) =>
            right.score - left.score ||
            right.span.sourceSeq - left.span.sourceSeq ||
            left.span.evidenceRef.localeCompare(right.span.evidenceRef),
        );
      const selected: MemoryProductRawEvidenceV1[] = [];
      let remaining = query.maxChars;
      for (const { span } of ranked) {
        if (selected.length >= query.maxSpans || remaining < 1) break;
        const hitContent = span.hitContent.slice(0, remaining);
        if (!hitContent) continue;
        selected.push(Object.freeze({ ...span, hitContent }));
        remaining -= hitContent.length;
      }
      return Object.freeze(selected);
    },
    async retrieve(
      query: Parameters<MemoryProductProviderV1["retrieve"]>[0],
      signal: AbortSignal,
    ) {
      if (signal.aborted) throw abortError();
      assertScope(query.scope, scope);
      const terms = searchTerms(query.text);
      const selected = [...cards.values()]
        .map((card) => ({ card, score: lexicalScore(card.statement, terms) }))
        .filter((item) => item.score > 0)
        .sort(
          (left, right) =>
            right.score - left.score ||
            left.card.id.localeCompare(right.card.id),
        )
        .slice(0, query.maxCards)
        .map(({ card }) => card);
      return Object.freeze({
        status: "completed" as const,
        cards: Object.freeze(selected),
      });
    },
  });
}

function searchTerms(value: string): readonly string[] {
  const terms = value.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return Object.freeze([...new Set(terms.filter((term) => term.length > 1))]);
}

function lexicalScore(content: string, terms: readonly string[]): number {
  const haystack = content.toLocaleLowerCase();
  return terms.reduce(
    (score, term) => score + Number(haystack.includes(term)),
    0,
  );
}

function putImmutable(
  store: Map<string, InMemoryEvidenceInputV1>,
  id: string,
  value: InMemoryEvidenceInputV1,
): void {
  const current = store.get(id);
  if (
    current !== undefined &&
    evidenceReceipt(current) !== evidenceReceipt(value)
  ) {
    throw namedError("MemoryReferenceEvidenceConflict");
  }
  store.set(id, value);
}

function evidenceReceipt(input: InMemoryEvidenceInputV1): string {
  const receipt: JsonValue = {
    evidenceRef: input.evidenceRef,
    sourceKind: input.sourceKind,
    sourceSeq: input.sourceSeq,
    authority: input.authority,
    hitContent: input.hitContent,
    createdAt: input.createdAt,
  };
  return canonicalJsonStringifyV1(receipt);
}

function freezeEvidence(
  input: InMemoryEvidenceInputV1,
): InMemoryEvidenceInputV1 {
  return Object.freeze({ ...input });
}

function freezeCard(input: InMemoryCardInputV1): InMemoryCardInputV1 {
  return Object.freeze({
    ...input,
    sources: Object.freeze(
      input.sources.map((source) => Object.freeze({ ...source })),
    ),
  });
}

function assertEvidence(input: InMemoryEvidenceInputV1): void {
  if (!input.evidenceRef.trim() || !input.hitContent.trim()) {
    throw namedError("MemoryReferenceEvidenceInvalid");
  }
}

function assertCard(input: InMemoryCardInputV1): void {
  if (!input.id.trim() || !input.statement.trim() || input.sources.length < 1) {
    throw namedError("MemoryReferenceCardInvalid");
  }
}

function assertScope(
  actual: MemoryProductScopeV1,
  expected: MemoryProductScopeV1,
): void {
  if (
    actual.tenantId !== expected.tenantId ||
    actual.userId !== expected.userId ||
    actual.workspaceId !== expected.workspaceId ||
    actual.repositoryId !== expected.repositoryId
  ) {
    throw namedError("MemoryReferenceScopeMismatch");
  }
}

function abortError(): Error {
  const error = new Error("Memory reference search aborted");
  error.name = "AbortError";
  return error;
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}
