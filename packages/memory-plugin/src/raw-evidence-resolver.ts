import type { SessionInputSnapshot } from "@paw/agent-loop";
import type {
  InputFactV1,
  JsonValue,
  MemoryRawEvidenceSpanV1,
} from "@paw/protocol";

import { canonicalJsonStringifyV1, hashTextV1 } from "./canonical.js";
import type {
  MemoryRawEvidenceArchiveV1,
  MemoryRawEvidenceRequestV1,
} from "./raw-evidence-archive.js";

export interface MemoryRawEvidenceResolutionV1 {
  readonly resolutionRevision: string;
  readonly spans: readonly MemoryRawEvidenceSpanV1[];
}

export async function resolveMemoryRawEvidenceV1(
  input: Readonly<{
    snapshot: SessionInputSnapshot<InputFactV1>;
    queryId: string;
    archive: MemoryRawEvidenceArchiveV1;
    maxSpans: number;
    maxChars: number;
    signal: AbortSignal;
  }>,
): Promise<MemoryRawEvidenceResolutionV1> {
  assertBudget(input.maxSpans, input.maxChars);
  const requests = collectRequests(input.snapshot, input.queryId).slice(
    0,
    input.maxSpans,
  );
  const resolved = await input.archive.resolve(requests, input.signal);
  return boundMemoryRawEvidenceSpansV1({
    requests,
    resolved,
    maxSpans: input.maxSpans,
    maxChars: input.maxChars,
  });
}

export function boundMemoryRawEvidenceSpansV1(
  input: Readonly<{
    requests: readonly MemoryRawEvidenceRequestV1[];
    resolved: readonly MemoryRawEvidenceSpanV1[];
    maxSpans: number;
    maxChars: number;
  }>,
): MemoryRawEvidenceResolutionV1 {
  assertBudget(input.maxSpans, input.maxChars);
  const requests = input.requests.slice(0, input.maxSpans);
  const requested = new Map(
    requests.map((request) => [request.evidenceRef, request] as const),
  );
  const spans: MemoryRawEvidenceSpanV1[] = [];
  const seen = new Set<string>();
  let chars = 0;
  for (const span of input.resolved) {
    const request = requested.get(span.evidenceRef);
    if (!request || seen.has(span.evidenceRef)) {
      throw namedError("MemoryRawEvidenceArchiveEscapedRequest");
    }
    if (!span.content.trim() || hashTextV1(span.content) !== span.contentHash) {
      throw namedError("MemoryRawEvidenceResolvedSpanInvalid");
    }
    const remaining = input.maxChars - chars;
    if (remaining <= 0) break;
    const content = span.content.slice(0, remaining);
    if (!content) continue;
    spans.push(
      Object.freeze({
        evidenceRef: span.evidenceRef,
        memoryIds: request.memoryIds,
        content,
        contentHash: hashTextV1(content),
      }),
    );
    seen.add(span.evidenceRef);
    chars += content.length;
  }
  const frozen = Object.freeze(spans);
  return Object.freeze({
    resolutionRevision: hashTextV1(
      canonicalJsonStringifyV1(
        frozen.map((span) => ({
          evidenceRef: span.evidenceRef,
          memoryIds: span.memoryIds,
          contentHash: span.contentHash,
        })) as unknown as JsonValue,
      ),
    ),
    spans: frozen,
  });
}

export function collectMemoryRawEvidenceRequestsV1(
  snapshot: SessionInputSnapshot<InputFactV1>,
  queryId: string,
): readonly MemoryRawEvidenceRequestV1[] {
  return collectRequests(snapshot, queryId);
}

function collectRequests(
  snapshot: SessionInputSnapshot<InputFactV1>,
  queryId: string,
): readonly MemoryRawEvidenceRequestV1[] {
  const ordered: Array<{ evidenceRef: string; memoryId: string }> = [];
  const retrieval = [...snapshot.entries]
    .reverse()
    .find(
      (entry) =>
        entry.fact.type === "memory.retrieval_settled" &&
        entry.fact.queryId === queryId,
    );
  if (retrieval?.fact.type === "memory.retrieval_settled") {
    for (const card of retrieval.fact.cards) {
      for (const source of card.sources) {
        ordered.push({ evidenceRef: source.ref, memoryId: card.id });
      }
    }
  }
  const topic = [...snapshot.entries]
    .reverse()
    .find(
      (entry) =>
        entry.fact.type === "memory.topic_evidence_settled" &&
        entry.fact.queryId === queryId,
    );
  if (topic?.fact.type === "memory.topic_evidence_settled") {
    for (const state of topic.fact.evidenceStates) {
      for (const evidenceRef of state.evidenceRefs) {
        ordered.push({ evidenceRef, memoryId: state.memoryId });
      }
    }
  }
  const byRef = new Map<string, Set<string>>();
  for (const item of ordered) {
    if (!item.evidenceRef.trim() || item.evidenceRef.length > 1_024) continue;
    const ids = byRef.get(item.evidenceRef) ?? new Set<string>();
    ids.add(item.memoryId);
    byRef.set(item.evidenceRef, ids);
  }
  return Object.freeze(
    [...byRef.entries()].map(([evidenceRef, ids]) =>
      Object.freeze({
        evidenceRef,
        memoryIds: Object.freeze([...ids].sort()),
      }),
    ),
  );
}

function assertBudget(maxSpans: number, maxChars: number): void {
  if (
    !Number.isSafeInteger(maxSpans) ||
    maxSpans < 1 ||
    maxSpans > 16 ||
    !Number.isSafeInteger(maxChars) ||
    maxChars < 256 ||
    maxChars > 16_384
  ) {
    throw namedError("MemoryRawEvidenceBudgetInvalid");
  }
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}
