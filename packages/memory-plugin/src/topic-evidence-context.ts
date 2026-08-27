import type { ModelContextSectionV1 } from "@paw/core";
import {
  type JsonValue,
  MEMORY_TOPIC_EVIDENCE_POLICY_VERSION_V1,
  type MemoryTopicEvidenceSettledFactV1,
} from "@paw/protocol";

import { canonicalJsonStringifyV1, hashTextV1 } from "./canonical.js";

export function createMemoryTopicEvidenceSectionsV1(
  fact: MemoryTopicEvidenceSettledFactV1,
  receiptSeq: number,
): readonly ModelContextSectionV1[] {
  if (fact.status === "failed" || fact.indexEntries.length === 0) {
    return Object.freeze([]);
  }
  const indexContent = canonicalJsonStringifyV1({
    schemaVersion: "paw.memory-topic-index.v1",
    scopeFingerprint: fact.scopeFingerprint,
    indexRevision: fact.indexRevision,
    topics: fact.indexEntries,
  } as unknown as JsonValue);
  const sections: ModelContextSectionV1[] = [
    Object.freeze({
      schemaVersion: 1,
      kind: "memory_cards",
      id: `memory-topic-index:${fact.indexRevision}`,
      policyVersion: MEMORY_TOPIC_EVIDENCE_POLICY_VERSION_V1,
      sourceFromSeq: receiptSeq,
      sourceThroughSeq: receiptSeq,
      contentHash: hashTextV1(indexContent),
      content: indexContent,
    }),
  ];
  if (fact.status === "completed" && fact.evidenceStates.length > 0) {
    const evidenceContent = canonicalJsonStringifyV1({
      schemaVersion: "paw.memory-topic-evidence.v1",
      queryId: fact.queryId,
      indexRevision: fact.indexRevision,
      states: fact.evidenceStates,
    } as unknown as JsonValue);
    sections.push(
      Object.freeze({
        schemaVersion: 1,
        kind: "memory_cards",
        id: `memory-topic-evidence:${fact.queryId}`,
        policyVersion: MEMORY_TOPIC_EVIDENCE_POLICY_VERSION_V1,
        sourceFromSeq: receiptSeq,
        sourceThroughSeq: receiptSeq,
        contentHash: hashTextV1(evidenceContent),
        content: evidenceContent,
      }),
    );
  }
  return Object.freeze(sections);
}
