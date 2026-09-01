import { rankMemoryEvidenceCandidatesV2 } from "./candidate-ranking.js";
import { type JsonValue, hashCanonicalJsonV1 } from "./canonical.js";
import {
  type MemoryEvidenceCandidateFusionV2,
  type MemoryEvidenceCandidateRankListV2,
  PAW_MEMORY_EVIDENCE_CANDIDATE_FUSION_VERSION_V2,
} from "./evidence-contracts.js";
import type { MemoryEvidenceIndexSearchResultV1 } from "./evidence-resolution-contracts.js";
import type { MemoryEvidenceRoleConstraintV3 } from "./query-plan-contracts.js";

export const PAW_MEMORY_REQUIREMENT_FAIR_ACQUISITION_POLICY_VERSION_V1 =
  "paw.memory-requirement-fair-acquisition.v1:monotone-original-reservation" as const;

/**
 * Static policy identity. The policy reserves one original-query source, then
 * gives every requirement one source opportunity per round before any leaf can
 * consume a second opportunity. Remaining slots are filled by global RRF.
 */
export const PAW_MEMORY_REQUIREMENT_FAIR_ACQUISITION_POLICY_REVISION_V1 =
  hashCanonicalJsonV1({
    policyVersion: PAW_MEMORY_REQUIREMENT_FAIR_ACQUISITION_POLICY_VERSION_V1,
    originalReservation: "top-1",
    requirementAllocation: "round-robin-by-plan-order",
    requirementLaneOrdering: "global-rrf-within-lane-eligible-sources",
    remainder: "global-rrf",
    sourceCap: "caller-owned",
    evidenceCap: "per-source-caller-owned",
  });

export interface MemoryRequirementAcquisitionLaneV1 {
  readonly requirementId: string;
  readonly roleConstraint: MemoryEvidenceRoleConstraintV3;
  /** Bound leaf constraint, including the trusted query cutoff. */
  readonly temporalBindingRevision: string;
  /** Already projected through the requirement's authority boundary. */
  readonly result: MemoryEvidenceIndexSearchResultV1;
}

export interface MemoryRequirementFairAcquisitionReportV1 {
  readonly policyVersion: typeof PAW_MEMORY_REQUIREMENT_FAIR_ACQUISITION_POLICY_VERSION_V1;
  readonly policyRevision: string;
  /** Content-free execution identity used by resolver and locator caches. */
  readonly acquisitionRevision: string;
  readonly originalLaneMode: "role_filtered" | "origin_authorized_unfiltered";
  readonly originalReservedSourceId?: string;
  readonly requirementContributions: readonly Readonly<{
    requirementId: string;
    roleConstraint: MemoryEvidenceRoleConstraintV3;
    temporalBindingRevision: string;
    selectedSourceIds: readonly string[];
  }>[];
  readonly selectedSourceIds: readonly string[];
  readonly telemetry: Readonly<{
    requirementLaneCount: number;
    requirementLaneOpportunityCount: number;
    globallyFilledSourceCount: number;
    returnedSourceCount: number;
    returnedEvidenceCount: number;
  }>;
}

export interface MemoryRequirementFairAcquisitionV1 {
  readonly fusion: MemoryEvidenceCandidateFusionV2;
  readonly report: MemoryRequirementFairAcquisitionReportV1;
}

/**
 * Deterministic pre-lock acquisition. Authority and temporal validation are
 * intentionally caller-owned and represented in each immutable lane. This
 * function allocates only already-returned candidate addresses; it does not
 * search, hydrate, certify dialogue, or change semantic support.
 */
export function buildMemoryRequirementFairAcquisitionV1(input: {
  readonly queryRevision: string;
  readonly originRevision: string;
  readonly evidenceTimeUpperBoundRevision: string;
  readonly originalRoleConstraint: MemoryEvidenceRoleConstraintV3;
  readonly originalLaneMode: "role_filtered" | "origin_authorized_unfiltered";
  readonly original: MemoryEvidenceIndexSearchResultV1;
  readonly requirements: readonly MemoryRequirementAcquisitionLaneV1[];
  readonly maxSources: number;
  readonly maxEvidencePerSource: number;
}): MemoryRequirementFairAcquisitionV1 {
  assertAcquisitionInput(input);

  const originalLists = namespacedLists(input.original.lists, "original", 1);
  const requirementLists = input.requirements.map((lane, laneIndex) =>
    namespacedLists(lane.result.lists, `requirement-${laneIndex}`, 0.8),
  );
  const allLists = Object.freeze([
    ...originalLists,
    ...requirementLists.flat(),
  ]);
  const uniqueSourceCount = countUniqueSources(allLists);
  const globalFusion = rankMemoryEvidenceCandidatesV2({
    lists: allLists,
    // The ranker already examines every candidate. Retaining the full bounded
    // address union here lets the allocator make reservations before the final
    // source cap is applied; it does not open another retrieval aperture.
    maxSources: Math.max(1, uniqueSourceCount),
    maxEvidencePerSource: input.maxEvidencePerSource,
  });
  const originalFusion = rankMemoryEvidenceCandidatesV2({
    lists: originalLists,
    maxSources: input.maxSources,
    maxEvidencePerSource: input.maxEvidencePerSource,
  });
  // A lane owns eligibility, not a private relevance scale. Within that
  // eligible set, preserve global cross-lane consensus so a source supported
  // by original + requirement retrieval is not displaced by a leaf-only hit.
  const requirementSourceOrders = requirementLists.map((lists) => {
    const eligible = new Set(
      lists.flatMap((list) =>
        list.candidates.map((candidate) => candidate.sourceId.trim()),
      ),
    );
    return globalFusion.sources.filter((source) =>
      eligible.has(source.sourceId),
    );
  });

  const selectedSourceIds: string[] = [];
  const selected = new Set<string>();
  const addSource = (sourceId: string | undefined): boolean => {
    if (
      sourceId === undefined ||
      selected.has(sourceId) ||
      selectedSourceIds.length >= input.maxSources
    ) {
      return false;
    }
    selected.add(sourceId);
    selectedSourceIds.push(sourceId);
    return true;
  };

  const originalReservedSourceId = originalFusion.sources[0]?.sourceId;
  addSource(originalReservedSourceId);

  const contributions = input.requirements.map(() => [] as string[]);
  let requirementLaneOpportunityCount = 0;
  for (
    let depth = 0;
    depth < input.maxSources && selectedSourceIds.length < input.maxSources;
    depth += 1
  ) {
    let anyLaneHadCandidate = false;
    for (const [laneIndex, sources] of requirementSourceOrders.entries()) {
      const sourceId = sources[depth]?.sourceId;
      if (sourceId === undefined) continue;
      anyLaneHadCandidate = true;
      requirementLaneOpportunityCount += 1;
      if (addSource(sourceId)) contributions[laneIndex]?.push(sourceId);
      if (selectedSourceIds.length >= input.maxSources) break;
    }
    if (!anyLaneHadCandidate) break;
  }

  const fairSelectedCount = selectedSourceIds.length;
  for (const source of globalFusion.sources) {
    addSource(source.sourceId);
    if (selectedSourceIds.length >= input.maxSources) break;
  }
  const globallyFilledSourceCount =
    selectedSourceIds.length - fairSelectedCount;
  const sourceById = new Map(
    globalFusion.sources.map((source) => [source.sourceId, source] as const),
  );
  const sources = Object.freeze(
    selectedSourceIds.map((sourceId) => {
      const source = sourceById.get(sourceId);
      if (!source) throw namedError("MemoryRequirementFairSourceMissing");
      return source;
    }),
  );
  const fusion = Object.freeze({
    policyVersion: PAW_MEMORY_EVIDENCE_CANDIDATE_FUSION_VERSION_V2,
    sources,
    telemetry: Object.freeze({
      ...globalFusion.telemetry,
      returnedSourceCount: sources.length,
      returnedEvidenceCount: sources.reduce(
        (total, source) => total + source.evidence.length,
        0,
      ),
    }),
  }) satisfies MemoryEvidenceCandidateFusionV2;

  const requirementContributions = Object.freeze(
    input.requirements.map((lane, index) =>
      Object.freeze({
        requirementId: lane.requirementId,
        roleConstraint: lane.roleConstraint,
        temporalBindingRevision: lane.temporalBindingRevision,
        selectedSourceIds: Object.freeze([...(contributions[index] ?? [])]),
      }),
    ),
  );
  const discoveryRevision = hashCanonicalJsonV1({
    original: discoveryListIdentity(originalLists),
    requirements: requirementLists.map(discoveryListIdentity),
  } as unknown as JsonValue);
  const acquisitionIdentity = {
    policyVersion: PAW_MEMORY_REQUIREMENT_FAIR_ACQUISITION_POLICY_VERSION_V1,
    policyRevision: PAW_MEMORY_REQUIREMENT_FAIR_ACQUISITION_POLICY_REVISION_V1,
    queryRevision: input.queryRevision,
    originRevision: input.originRevision,
    evidenceTimeUpperBoundRevision: input.evidenceTimeUpperBoundRevision,
    originalRoleConstraint: input.originalRoleConstraint,
    originalLaneMode: input.originalLaneMode,
    originalReservedSourceId: originalReservedSourceId ?? "none",
    requirementLanes: input.requirements.map((lane) => ({
      requirementId: lane.requirementId,
      roleConstraint: lane.roleConstraint,
      temporalBindingRevision: lane.temporalBindingRevision,
    })),
    discoveryRevision,
    selectedSourceIds,
    selectedEvidenceRefs: sources.map((source) => ({
      sourceId: source.sourceId,
      evidenceRefs: source.evidence.map((candidate) => candidate.evidenceRef),
    })),
    maxSources: input.maxSources,
    maxEvidencePerSource: input.maxEvidencePerSource,
  } as const;
  const report = Object.freeze({
    policyVersion: PAW_MEMORY_REQUIREMENT_FAIR_ACQUISITION_POLICY_VERSION_V1,
    policyRevision: PAW_MEMORY_REQUIREMENT_FAIR_ACQUISITION_POLICY_REVISION_V1,
    acquisitionRevision: hashCanonicalJsonV1(
      acquisitionIdentity as unknown as JsonValue,
    ),
    originalLaneMode: input.originalLaneMode,
    ...(originalReservedSourceId === undefined
      ? {}
      : { originalReservedSourceId }),
    requirementContributions,
    selectedSourceIds: Object.freeze([...selectedSourceIds]),
    telemetry: Object.freeze({
      requirementLaneCount: input.requirements.length,
      requirementLaneOpportunityCount,
      globallyFilledSourceCount,
      returnedSourceCount: sources.length,
      returnedEvidenceCount: fusion.telemetry.returnedEvidenceCount,
    }),
  }) satisfies MemoryRequirementFairAcquisitionReportV1;
  return Object.freeze({ fusion, report });
}

function namespacedLists(
  lists: readonly MemoryEvidenceCandidateRankListV2[],
  laneId: string,
  weightMultiplier: number,
): readonly MemoryEvidenceCandidateRankListV2[] {
  return Object.freeze(
    lists.map((list, index) =>
      Object.freeze({
        ...list,
        retrieverId: `${list.retrieverId}:${laneId}-${index}`,
        weight: list.weight * weightMultiplier,
      }),
    ),
  );
}

function countUniqueSources(
  lists: readonly MemoryEvidenceCandidateRankListV2[],
): number {
  return new Set(
    lists.flatMap((list) =>
      list.candidates.map((candidate) => candidate.sourceId.trim()),
    ),
  ).size;
}

function discoveryListIdentity(
  lists: readonly MemoryEvidenceCandidateRankListV2[],
): JsonValue {
  return lists.map((list) => ({
    channel: list.channel,
    retrieverId: list.retrieverId,
    weight: list.weight,
    candidates: list.candidates.map((candidate) => ({
      candidateId: candidate.candidateId,
      sourceId: candidate.sourceId,
      evidenceRef: candidate.evidenceRef,
      sourceKind: candidate.sourceKind,
      authority: candidate.authority,
      observedAt: candidate.observedAt ?? "unknown",
    })),
  })) as unknown as JsonValue;
}

function assertAcquisitionInput(input: {
  readonly queryRevision: string;
  readonly originRevision: string;
  readonly evidenceTimeUpperBoundRevision: string;
  readonly originalRoleConstraint: MemoryEvidenceRoleConstraintV3;
  readonly requirements: readonly MemoryRequirementAcquisitionLaneV1[];
  readonly maxSources: number;
  readonly maxEvidencePerSource: number;
}): void {
  const ids = new Set<string>();
  if (
    !input.queryRevision.trim() ||
    !input.originRevision.trim() ||
    !input.evidenceTimeUpperBoundRevision.trim() ||
    !new Set(["user", "assistant", "any"]).has(input.originalRoleConstraint) ||
    !Number.isSafeInteger(input.maxSources) ||
    input.maxSources < 1 ||
    input.maxSources > 16 ||
    !Number.isSafeInteger(input.maxEvidencePerSource) ||
    input.maxEvidencePerSource < 1 ||
    input.maxEvidencePerSource > 16 ||
    input.requirements.length > 4
  ) {
    throw namedError("MemoryRequirementFairAcquisitionInputInvalid");
  }
  for (const lane of input.requirements) {
    if (
      !lane.requirementId.trim() ||
      ids.has(lane.requirementId) ||
      !new Set(["user", "assistant", "any"]).has(lane.roleConstraint) ||
      !lane.temporalBindingRevision.trim()
    ) {
      throw namedError("MemoryRequirementFairAcquisitionInputInvalid");
    }
    ids.add(lane.requirementId);
  }
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}
