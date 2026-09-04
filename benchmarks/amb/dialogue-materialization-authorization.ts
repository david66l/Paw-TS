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
import { logicalSourceLocalEvidenceRefV1 } from "./immutable-evidence-address.js";
