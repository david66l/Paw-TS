import type { ModelContextSectionV1 } from "@paw/core";
import {
  type JsonValue,
  MEMORY_RAW_EVIDENCE_POLICY_VERSION_V1,
  type MemoryRawEvidenceSettledFactV1,
} from "@paw/protocol";

import { canonicalJsonStringifyV1, hashTextV1 } from "./canonical.js";

export function createMemoryRawEvidenceSectionV1(
  fact: MemoryRawEvidenceSettledFactV1,
  receiptSeq: number,
): ModelContextSectionV1 | undefined {
  if (fact.status !== "completed" || fact.spans.length === 0) return undefined;
  const content = canonicalJsonStringifyV1({
    schemaVersion: "paw.memory-raw-evidence.v1",
    queryId: fact.queryId,
    resolutionRevision: fact.resolutionRevision,
    spans: fact.spans,
  } as unknown as JsonValue);
  return Object.freeze({
    schemaVersion: 1,
    kind: "memory_cards",
    id: `memory-raw-evidence:${fact.queryId}`,
    policyVersion: MEMORY_RAW_EVIDENCE_POLICY_VERSION_V1,
    sourceFromSeq: receiptSeq,
    sourceThroughSeq: receiptSeq,
    contentHash: hashTextV1(content),
    content,
  });
}
