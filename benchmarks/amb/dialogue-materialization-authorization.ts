import { logicalSourceLocalEvidenceRefV1 } from "./immutable-evidence-address.js";

export interface AmbDialogueMaterializationAuthorizedItemV1 {
  readonly sourceId: string;
  readonly evidenceRef: string;
  readonly turnOrder: number;
  readonly evidenceUse: "assistant_report" | "shared_dialogue_artifact";
  readonly allowedModes: readonly ["dialogue_materialization"];
}

export interface AmbCanonicalDialogueAuthorizationV1 {
  readonly status: "completed" | "conflict";
  readonly items: readonly AmbDialogueMaterializationAuthorizedItemV1[];
  readonly duplicateCount: number;
  readonly conflictCount: number;
}

export interface AmbDialoguePairProofV1 {
  readonly sourceId: string;
  readonly assistantEvidenceRef: string;
  readonly assistantContentHash: string;
  readonly assistantTurnOrder: number;
  readonly assistantRole: "assistant_output";
  readonly predecessorEvidenceRef: string;
  readonly predecessorContentHash: string;
  readonly predecessorTurnOrder: number;
  readonly predecessorRole: "user_input";
  readonly relation: "immediate_predecessor";
  readonly allowedModes: readonly ["dialogue_pair_context"];
  readonly evidenceTimeUpperBound: string | null;
  readonly verifierVersion: string;
  readonly verificationRevision: string;
  readonly dialogueCertificateRevision: string;
}

export interface AmbCanonicalDialoguePairProofV1
  extends Omit<AmbDialoguePairProofV1, "dialogueCertificateRevision"> {
  readonly dialogueCertificateRevisions: readonly string[];
}

export interface AmbCanonicalDialoguePairProofResultV1 {
  readonly status: "completed" | "conflict";
  readonly pairs: readonly AmbCanonicalDialoguePairProofV1[];
  readonly duplicateCount: number;
  readonly lineageCount: number;
  readonly conflictCount: number;
}

/** A normal AMB packet has at most a handful of aliases per immutable turn. */
export const AMB_DIALOGUE_PAIR_MAX_RAW_PROOFS_V1 = 128;
export const AMB_DIALOGUE_PAIR_MAX_LINEAGE_REVISIONS_V1 = 16;

const LOWERCASE_SHA256 = /^[0-9a-f]{64}$/u;

export function canonicalAmbDialogueEvidenceRefV1(
  evidenceRef: string,
): string | undefined {
  return (
    logicalSourceLocalEvidenceRefV1(evidenceRef) ??
    (/^[^#]+#source-\d+$/u.test(evidenceRef) ? evidenceRef : undefined)
  );
}

/**
 * Canonicalizes the already-validated final-packet authorization projection.
 * Exact duplicates may arise when multiple requirements commit the same
 * binding. A canonical evidence address is still one reader capability; any
 * disagreement about that capability is ambiguous and closes the certificate.
 */
export function canonicalizeAmbDialogueAuthorizationV1(
  items: readonly AmbDialogueMaterializationAuthorizedItemV1[],
): AmbCanonicalDialogueAuthorizationV1 {
  const byEvidenceRef = new Map<
    string,
    AmbDialogueMaterializationAuthorizedItemV1
  >();
  let duplicateCount = 0;
  let conflictCount = 0;
  for (const item of items) {
    const existing = byEvidenceRef.get(item.evidenceRef);
    if (!existing) {
      byEvidenceRef.set(item.evidenceRef, Object.freeze({ ...item }));
      continue;
    }
    if (sameAuthorizationItem(existing, item)) {
      duplicateCount += 1;
      continue;
    }
    conflictCount += 1;
  }
  return Object.freeze({
    status: conflictCount === 0 ? "completed" : "conflict",
    items:
      conflictCount === 0
        ? Object.freeze([...byEvidenceRef.values()])
        : Object.freeze([]),
    duplicateCount,
    conflictCount,
  });
}

/**
 * Coalesces raw-address proof lineage only after the bridge has validated every
 * proof against its authorized parent and committed supporting context.
 * Canonical aliases may share a capability, but no semantic disagreement is
 * hidden: a conflict, malformed revision, lineage reuse, or bound overflow
 * closes the complete pair projection.
 */
export function canonicalizeAmbDialoguePairProofsV1(
  proofs: readonly AmbDialoguePairProofV1[],
): AmbCanonicalDialoguePairProofResultV1 {
  if (proofs.length > AMB_DIALOGUE_PAIR_MAX_RAW_PROOFS_V1) {
    return conflictPairProjection(1);
  }
  const groups = new Map<
    string,
    {
      readonly semantic: Omit<
        AmbDialoguePairProofV1,
        "dialogueCertificateRevision"
      >;
      readonly revisions: Set<string>;
    }
  >();
  const revisionOwners = new Map<string, string>();
  let duplicateCount = 0;
  let conflictCount = 0;
  for (const proof of proofs) {
    const revision = proof.dialogueCertificateRevision;
    if (!LOWERCASE_SHA256.test(revision)) {
      conflictCount += 1;
      continue;
    }
    const key = canonicalDialoguePairKey(proof);
    const revisionOwner = revisionOwners.get(revision);
    if (revisionOwner !== undefined && revisionOwner !== key) {
      conflictCount += 1;
      continue;
    }
    revisionOwners.set(revision, key);
    const { dialogueCertificateRevision: _revision, ...semantic } = proof;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        semantic: Object.freeze(semantic),
        revisions: new Set([revision]),
      });
      continue;
    }
    if (!sameDialoguePairSemantics(existing.semantic, semantic)) {
      conflictCount += 1;
      continue;
    }
    if (existing.revisions.has(revision)) {
      duplicateCount += 1;
      continue;
    }
    existing.revisions.add(revision);
    if (existing.revisions.size > AMB_DIALOGUE_PAIR_MAX_LINEAGE_REVISIONS_V1) {
      conflictCount += 1;
    }
  }
  if (conflictCount > 0)
    return conflictPairProjection(conflictCount, duplicateCount);
  const pairs = [...groups.values()]
    .map(({ semantic, revisions }) =>
      Object.freeze({
        ...semantic,
        dialogueCertificateRevisions: Object.freeze([...revisions].sort()),
      }),
    )
    .sort(compareDialoguePairs);
  return Object.freeze({
    status: "completed",
    pairs: Object.freeze(pairs),
    duplicateCount,
    lineageCount: revisionOwners.size,
    conflictCount: 0,
  });
}

function conflictPairProjection(
  conflictCount: number,
  duplicateCount = 0,
): AmbCanonicalDialoguePairProofResultV1 {
  return Object.freeze({
    status: "conflict",
    pairs: Object.freeze([]),
    duplicateCount,
    lineageCount: 0,
    conflictCount,
  });
}

function canonicalDialoguePairKey(
  pair: Pick<
    AmbDialoguePairProofV1,
    "sourceId" | "assistantEvidenceRef" | "predecessorEvidenceRef"
  >,
): string {
  return JSON.stringify([
    pair.sourceId,
    pair.assistantEvidenceRef,
    pair.predecessorEvidenceRef,
  ]);
}

function sameDialoguePairSemantics(
  left: Omit<AmbDialoguePairProofV1, "dialogueCertificateRevision">,
  right: Omit<AmbDialoguePairProofV1, "dialogueCertificateRevision">,
): boolean {
  return (
    left.sourceId === right.sourceId &&
    left.assistantEvidenceRef === right.assistantEvidenceRef &&
    left.assistantContentHash === right.assistantContentHash &&
    left.assistantTurnOrder === right.assistantTurnOrder &&
    left.assistantRole === right.assistantRole &&
    left.predecessorEvidenceRef === right.predecessorEvidenceRef &&
    left.predecessorContentHash === right.predecessorContentHash &&
    left.predecessorTurnOrder === right.predecessorTurnOrder &&
    left.predecessorRole === right.predecessorRole &&
    left.relation === right.relation &&
    left.allowedModes.length === 1 &&
    right.allowedModes.length === 1 &&
    left.allowedModes[0] === right.allowedModes[0] &&
    left.evidenceTimeUpperBound === right.evidenceTimeUpperBound &&
    left.verifierVersion === right.verifierVersion &&
    left.verificationRevision === right.verificationRevision
  );
}

function compareDialoguePairs(
  left: AmbCanonicalDialoguePairProofV1,
  right: AmbCanonicalDialoguePairProofV1,
): number {
  return (
    left.sourceId.localeCompare(right.sourceId) ||
    left.assistantTurnOrder - right.assistantTurnOrder ||
    left.assistantEvidenceRef.localeCompare(right.assistantEvidenceRef) ||
    left.predecessorEvidenceRef.localeCompare(right.predecessorEvidenceRef)
  );
}

function sameAuthorizationItem(
  left: AmbDialogueMaterializationAuthorizedItemV1,
  right: AmbDialogueMaterializationAuthorizedItemV1,
): boolean {
  return (
    left.sourceId === right.sourceId &&
    left.evidenceRef === right.evidenceRef &&
    left.turnOrder === right.turnOrder &&
    left.evidenceUse === right.evidenceUse &&
    left.allowedModes.length === 1 &&
    right.allowedModes.length === 1 &&
    left.allowedModes[0] === right.allowedModes[0]
  );
}
