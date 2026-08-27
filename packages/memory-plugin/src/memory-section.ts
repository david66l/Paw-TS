import type { ModelContextSectionV1 } from "@paw/core";
import {
  type JsonValue,
  MEMORY_RETRIEVAL_POLICY_VERSION_V1,
  type MemoryRetrievalSettledFactV1,
} from "@paw/protocol";

import { canonicalJsonStringifyV1, hashTextV1 } from "./canonical.js";

export function createMemoryContextSectionV1(
  fact: MemoryRetrievalSettledFactV1,
  receiptSeq: number,
): ModelContextSectionV1 | undefined {
  if (
    fact.cards.length === 0 ||
    fact.status === "failed" ||
    fact.status === "disabled"
  ) {
    return undefined;
  }
  const content = canonicalJsonStringifyV1({
    schemaVersion: "paw.memory-cards.v1",
    queryId: fact.queryId,
    trigger: fact.trigger,
    status: fact.status,
    cards: fact.cards,
  } as unknown as JsonValue);
  return Object.freeze({
    schemaVersion: 1,
    kind: "memory_cards",
    id: `memory:${fact.queryId}`,
    policyVersion: MEMORY_RETRIEVAL_POLICY_VERSION_V1,
    sourceFromSeq: receiptSeq,
    sourceThroughSeq: receiptSeq,
    contentHash: hashTextV1(content),
    content,
  });
}
