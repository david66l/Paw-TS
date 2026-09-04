const IMMUTABLE_DOCUMENT_PREFIX = "amb:document/";

/** Convert a physical AMB archive address into the core's source-local family. */
export function logicalSourceLocalEvidenceRefV1(
  evidenceRef: string,
): string | undefined {
  const match = /^amb:document\/([^#]+)#(?:source|atom)-(\d+)$/u.exec(
    evidenceRef,
  );
  if (!match || !match[1] || !match[2]) return undefined;
  return `${match[1]}#source-${match[2]}`;
}

/** Strict source ownership check shared by the AMB adapter and core verifier. */
export function ambSourceLocalEvidenceRefBelongsToSourceV1(
  sourceId: string,
  evidenceRef: string,
): boolean {
  const logical =
    logicalSourceLocalEvidenceRefV1(evidenceRef) ??
    (/^[^#]+#source-\d+$/u.test(evidenceRef) ? evidenceRef : undefined);
  const match = /^([^#]+)#source-\d+$/u.exec(logical ?? "");
  return match?.[1] === sourceId;
}

/** Resolve a logical source-local address to the current immutable alias. */
export function immutableSourceTurnEvidenceRefV1(
  evidenceRef: string,
): string | undefined {
  if (evidenceRef.startsWith(IMMUTABLE_DOCUMENT_PREFIX)) return undefined;
  const match = /^([^#]+)#source-(\d+)$/u.exec(evidenceRef);
  if (!match || !match[1] || !match[2]) return undefined;
  return `${IMMUTABLE_DOCUMENT_PREFIX}${match[1]}#source-${match[2]}`;
}

/**
 * Old AMB indexes archived immutable turns as `#atom-N`. Keep this exact
 * logical-to-physical compatibility mapping content-free.
 */
export function legacyImmutableTurnEvidenceRefV1(
  evidenceRef: string,
): string | undefined {
  if (evidenceRef.startsWith(IMMUTABLE_DOCUMENT_PREFIX)) return undefined;
  const match = /^([^#]+)#source-(\d+)$/u.exec(evidenceRef);
  if (!match || !match[1] || !match[2]) return undefined;
  return `${IMMUTABLE_DOCUMENT_PREFIX}${match[1]}#atom-${match[2]}`;
}
