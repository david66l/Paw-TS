import { hashCanonicalJsonV1 } from "./canonical.js";

export interface MemoryEvidenceIndependenceIdentityInputV1 {
  readonly eventKey?: string;
  readonly sourceId: string;
  readonly episodeOrder?: number;
  readonly observedOrder?: number;
}

/** Host-derived identity shared by notebook proofs and bound source locks. */
export function memoryEvidenceIndependenceKeyV1(
  input: MemoryEvidenceIndependenceIdentityInputV1,
): string {
  const eventKey = input.eventKey?.trim();
  if (eventKey) return `event:${eventKey}`;
  const sourceId = input.sourceId.trim();
  const episodeOrder = input.episodeOrder ?? input.observedOrder;
  return episodeOrder === undefined
    ? `source:${sourceId}`
    : `source:${sourceId}\0episode:${episodeOrder}`;
}

export function memoryEvidenceIndependenceIdentityRevisionV1(
  input: MemoryEvidenceIndependenceIdentityInputV1,
): string {
  return hashCanonicalJsonV1({
    schemaVersion: "paw.memory-evidence-independence-identity.v1",
    identity: memoryEvidenceIndependenceKeyV1(input),
  } as never);
}
