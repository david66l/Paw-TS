/**
 * Old AMB indexes archived immutable turns as `#atom-N`. Source-local search
 * addresses the same turns as `#source-N`. Keep this compatibility mapping
 * exact and content-free; all prose still comes from the immutable archive.
 */
export function legacyImmutableTurnEvidenceRefV1(
  evidenceRef: string,
): string | undefined {
  const match = /^(.*)#source-(\d+)$/u.exec(evidenceRef);
  if (!match || !match[1] || !match[2]) return undefined;
  return `${match[1]}#atom-${match[2]}`;
}
