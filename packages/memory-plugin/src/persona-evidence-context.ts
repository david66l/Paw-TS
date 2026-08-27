import type { ModelContextSectionV1 } from "@paw/core";
import {
  type JsonValue,
  MEMORY_PERSONA_PROJECTION_POLICY_VERSION_V1,
  type MemoryPersonaProjectionSettledFactV1,
} from "@paw/protocol";

import { canonicalJsonStringifyV1, hashTextV1 } from "./canonical.js";

export function createMemoryPersonaEvidenceSectionV1(
  fact: MemoryPersonaProjectionSettledFactV1,
  receiptSeq: number,
): ModelContextSectionV1 | undefined {
  if (fact.status !== "completed" || fact.claims.length === 0) return undefined;
  const content = canonicalJsonStringifyV1({
    schemaVersion: "paw.memory-persona-evidence.v1",
    scopeFingerprint: fact.scopeFingerprint,
    projectionRevision: fact.projectionRevision,
    projectionKey: fact.projectionKey,
    claims: fact.claims,
    sourceCount: fact.sourceCount,
  } as unknown as JsonValue);
  return Object.freeze({
    schemaVersion: 1,
    kind: "memory_cards",
    id: `memory-persona:${fact.projectionKey}`,
    policyVersion: MEMORY_PERSONA_PROJECTION_POLICY_VERSION_V1,
    sourceFromSeq: receiptSeq,
    sourceThroughSeq: receiptSeq,
    contentHash: hashTextV1(content),
    content,
  });
}
