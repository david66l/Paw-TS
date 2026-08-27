export interface AmbQueryTimeCutoffV1 {
  readonly epochMs: number;
  readonly normalizedIso: string;
}

/**
 * Normalize the benchmark's point-in-time query contract. Invalid supplied
 * timestamps fail closed instead of silently turning an as-of query into a
 * latest-state query.
 */
export function parseAmbQueryTimeCutoffV1(
  value: unknown,
): AmbQueryTimeCutoffV1 | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("queryTimestamp must be a valid timestamp string");
  }
  const epochMs = Date.parse(value);
  if (!Number.isFinite(epochMs)) {
    throw new Error("queryTimestamp must be a valid timestamp string");
  }
  return Object.freeze({
    epochMs,
    normalizedIso: new Date(epochMs).toISOString(),
  });
}

/** Evidence with unknown chronology is not eligible for an as-of answer. */
export function isAmbDocumentVisibleAtQueryV1(
  documentCreated: string | undefined,
  cutoff: AmbQueryTimeCutoffV1 | undefined,
): boolean {
  if (!cutoff) return true;
  if (!documentCreated) return false;
  const createdEpochMs = Date.parse(documentCreated);
  return Number.isFinite(createdEpochMs) && createdEpochMs <= cutoff.epochMs;
}
