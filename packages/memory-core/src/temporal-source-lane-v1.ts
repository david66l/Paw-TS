import { hashCanonicalJsonV1 } from "./canonical.js";

/**
 * A bounded, independent source-acquisition lane for temporal execution.
 *
 * This is deliberately a source lock only. It cannot produce a factual
 * answer, mutate a shared evidence packet, or cause a reader injection. A
 * host may use its selected sources in a separately audited temporal executor.
 */
export const PAW_MEMORY_TEMPORAL_SOURCE_LANE_POLICY_V1 =
  "paw.memory-temporal-source-lane.v1:independent-read-only-source-lock" as const;

export const PAW_MEMORY_TEMPORAL_SOURCE_LANE_MAX_SOURCES_V1 = 16;
export const PAW_MEMORY_TEMPORAL_SOURCE_LANE_MAX_CANDIDATES_V1 = 64;

export type MemoryTemporalSourceLaneRejectedReasonV1 =
  | "invalid_input"
  | "candidate_set_mismatch"
  | "candidate_postdates_cutoff";

/** A source-span retriever candidate. Content is intentionally excluded. */
export interface MemoryTemporalSourceLaneCandidateV1 {
  readonly sourceId: string;
  readonly evidenceRef: string;
  /** Unique, positive rank from the retrieval channel. Smaller is better. */
  readonly rank: number;
  /** Host-known source observation time, when the source has one. */
  readonly observedAt?: string;
}

export interface MemoryTemporalSourceLaneRequestV1 {
  readonly query: string;
  /** Host-owned cutoff; selected candidates must not postdate it. */
  readonly queryTimeCutoff: string;
  readonly candidates: readonly MemoryTemporalSourceLaneCandidateV1[];
  /** Defaults to 16 and is deliberately bounded by the policy maximum. */
  readonly maxSources?: number;
}

export interface MemoryTemporalSourceLaneSourceV1 {
  readonly sourceId: string;
  readonly firstEvidenceRef: string;
  readonly firstCandidateRank: number;
  readonly observedAt?: string;
}

export interface MemoryTemporalSourceLaneCertificateV1 {
  readonly policyVersion: typeof PAW_MEMORY_TEMPORAL_SOURCE_LANE_POLICY_V1;
  readonly queryRevision: string;
  readonly queryTimeCutoff: string;
  readonly maxSources: number;
  readonly candidateSetRevision: string;
  /** Ordered, de-duplicated source lock for a separate temporal lane only. */
  readonly selectedSources: readonly MemoryTemporalSourceLaneSourceV1[];
  readonly sourceLockRevision: string;
  readonly certificateRevision: string;
}

export type MemoryTemporalSourceLaneBuildResultV1 =
  | Readonly<{
      status: "selected";
      certificate: MemoryTemporalSourceLaneCertificateV1;
    }>
  | Readonly<{
      status: "rejected";
      rejectedReason: MemoryTemporalSourceLaneRejectedReasonV1;
    }>;

/**
 * Freezes a deterministic, de-duplicated source lock from one already-ranked
 * retrieval channel. No caller-visible memory context is changed by this
 * function; the certificate is safe to use first in a shadow evaluation.
 */
export function buildMemoryTemporalSourceLaneV1(
  input: MemoryTemporalSourceLaneRequestV1,
): MemoryTemporalSourceLaneBuildResultV1 {
  try {
    return Object.freeze({
      status: "selected" as const,
      certificate: compileCertificate(input),
    });
  } catch (error) {
    return Object.freeze({
      status: "rejected" as const,
      rejectedReason: rejectionReason(error),
    });
  }
}

/** Rebuilds the source lock from immutable retrieval metadata. */
export function validateMemoryTemporalSourceLaneCertificateV1(input: {
  readonly request: MemoryTemporalSourceLaneRequestV1;
  readonly certificate: MemoryTemporalSourceLaneCertificateV1;
}): boolean {
  const result = buildMemoryTemporalSourceLaneV1(input.request);
  return (
    result.status === "selected" && same(result.certificate, input.certificate)
  );
}

function compileCertificate(
  input: MemoryTemporalSourceLaneRequestV1,
): MemoryTemporalSourceLaneCertificateV1 {
  const maxSources =
    input.maxSources ?? PAW_MEMORY_TEMPORAL_SOURCE_LANE_MAX_SOURCES_V1;
  if (
    !input.query.trim() ||
    !isTimestamp(input.queryTimeCutoff) ||
    !Number.isSafeInteger(maxSources) ||
    maxSources < 1 ||
    maxSources > PAW_MEMORY_TEMPORAL_SOURCE_LANE_MAX_SOURCES_V1
  ) {
    reject("invalid_input");
  }
  const candidates = validateCandidates(
    input.candidates,
    input.queryTimeCutoff,
  );
  const selectedSources = selectSources(candidates, maxSources);
  const candidateSetRevision = hashCanonicalJsonV1({
    schemaVersion: "paw.memory-temporal-source-lane-candidates.v1",
    candidates,
  } as never);
  const sourceLockRevision = hashCanonicalJsonV1({
    schemaVersion: "paw.memory-temporal-source-lane-source-lock.v1",
    selectedSources,
  } as never);
  const identity = {
    policyVersion: PAW_MEMORY_TEMPORAL_SOURCE_LANE_POLICY_V1,
    queryRevision: hashCanonicalJsonV1({
      schemaVersion: "paw.memory-temporal-source-lane-query.v1",
      query: input.query,
    } as never),
    queryTimeCutoff: new Date(input.queryTimeCutoff).toISOString(),
    maxSources,
    candidateSetRevision,
    selectedSources,
    sourceLockRevision,
  };
  return Object.freeze({
    ...identity,
    certificateRevision: hashCanonicalJsonV1(identity as never),
  });
}

function validateCandidates(
  input: readonly MemoryTemporalSourceLaneCandidateV1[],
  queryTimeCutoff: string,
): readonly MemoryTemporalSourceLaneCandidateV1[] {
  if (
    input.length === 0 ||
    input.length > PAW_MEMORY_TEMPORAL_SOURCE_LANE_MAX_CANDIDATES_V1
  ) {
    reject("candidate_set_mismatch");
  }
  const evidenceRefs = new Set<string>();
  const ranks = new Set<number>();
  const cutoff = Date.parse(queryTimeCutoff);
  const candidates = input.map((candidate) => {
    if (
      !candidate.sourceId.trim() ||
      !candidate.evidenceRef.trim() ||
      !Number.isSafeInteger(candidate.rank) ||
      candidate.rank < 1 ||
      evidenceRefs.has(candidate.evidenceRef) ||
      ranks.has(candidate.rank)
    ) {
      reject("candidate_set_mismatch");
    }
    evidenceRefs.add(candidate.evidenceRef);
    ranks.add(candidate.rank);
    if (
      candidate.observedAt !== undefined &&
      (!isTimestamp(candidate.observedAt) ||
        Date.parse(candidate.observedAt) > cutoff)
    ) {
      reject("candidate_postdates_cutoff");
    }
    return Object.freeze({ ...candidate });
  });
  return Object.freeze(
    candidates.sort(
      (left, right) =>
        left.rank - right.rank ||
        left.evidenceRef.localeCompare(right.evidenceRef),
    ),
  );
}

function selectSources(
  candidates: readonly MemoryTemporalSourceLaneCandidateV1[],
  maxSources: number,
): readonly MemoryTemporalSourceLaneSourceV1[] {
  const selected: MemoryTemporalSourceLaneSourceV1[] = [];
  const seenSourceIds = new Set<string>();
  for (const candidate of candidates) {
    if (seenSourceIds.has(candidate.sourceId)) continue;
    seenSourceIds.add(candidate.sourceId);
    selected.push(
      Object.freeze({
        sourceId: candidate.sourceId,
        firstEvidenceRef: candidate.evidenceRef,
        firstCandidateRank: candidate.rank,
        ...(candidate.observedAt === undefined
          ? {}
          : { observedAt: new Date(candidate.observedAt).toISOString() }),
      }),
    );
    if (selected.length >= maxSources) break;
  }
  return Object.freeze(selected);
}

function isTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function same(left: unknown, right: unknown): boolean {
  return (
    hashCanonicalJsonV1(left as never) === hashCanonicalJsonV1(right as never)
  );
}

function reject(reason: MemoryTemporalSourceLaneRejectedReasonV1): never {
  throw new TemporalSourceLaneRejection(reason);
}

class TemporalSourceLaneRejection extends Error {
  constructor(readonly reason: MemoryTemporalSourceLaneRejectedReasonV1) {
    super(reason);
  }
}

function rejectionReason(
  error: unknown,
): MemoryTemporalSourceLaneRejectedReasonV1 {
  return error instanceof TemporalSourceLaneRejection
    ? error.reason
    : "invalid_input";
}
