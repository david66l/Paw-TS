import {
  type MemoryEvidenceCandidateFusionV2,
  type MemoryEvidenceCandidateRankListV2,
  type MemoryEvidenceCandidateV2,
  type MemoryEvidenceChannelV1,
  type MemoryEvidenceSourceFusionV1,
  type MemoryEvidenceSourceRankListV1,
  PAW_MEMORY_EVIDENCE_CANDIDATE_FUSION_VERSION_V2,
  PAW_MEMORY_EVIDENCE_FIRST_POLICY_VERSION_V1,
} from "./evidence-contracts.js";

const EVIDENCE_SOURCE_RRF_K = 60;

/**
 * Fuses independent raw-evidence and derived-index retrieval without making a
 * topic, aspect, or graph membership a prerequisite for source discovery.
 * This function ranks source pointers only; callers must read authoritative L0
 * evidence before presenting content to a model.
 */
export function rankMemoryEvidenceSourcesV1(input: {
  readonly lists: readonly MemoryEvidenceSourceRankListV1[];
  readonly maxSources: number;
}): MemoryEvidenceSourceFusionV1 {
  if (!Number.isSafeInteger(input.maxSources) || input.maxSources < 1) {
    throw namedError("MemoryEvidenceFirstSourceBudgetInvalid");
  }
  const scores = new Map<
    string,
    {
      score: number;
      channels: Set<MemoryEvidenceChannelV1>;
      bestRank: number;
    }
  >();
  const channelCandidates: Record<MemoryEvidenceChannelV1, Set<string>> = {
    l0: new Set<string>(),
    l1: new Set<string>(),
  };
  for (const list of input.lists) {
    if (!Number.isFinite(list.weight) || list.weight <= 0) {
      throw namedError("MemoryEvidenceFirstWeightInvalid");
    }
    const seen = new Set<string>();
    let distinctRank = 0;
    for (const rawSourceId of list.sourceIds) {
      const sourceId = rawSourceId.trim();
      if (!sourceId || seen.has(sourceId)) continue;
      seen.add(sourceId);
      distinctRank += 1;
      channelCandidates[list.channel].add(sourceId);
      const current = scores.get(sourceId) ?? {
        score: 0,
        channels: new Set<MemoryEvidenceChannelV1>(),
        bestRank: Number.POSITIVE_INFINITY,
      };
      current.score += list.weight / (EVIDENCE_SOURCE_RRF_K + distinctRank);
      current.channels.add(list.channel);
      current.bestRank = Math.min(current.bestRank, distinctRank);
      scores.set(sourceId, current);
    }
  }
  const ranked = [...scores.entries()]
    .map(([sourceId, value]) =>
      Object.freeze({
        sourceId,
        score: value.score,
        channelHits: value.channels.size,
        channels: Object.freeze([...value.channels].sort()),
        bestRank: value.bestRank,
      }),
    )
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.channelHits - left.channelHits ||
        left.bestRank - right.bestRank ||
        left.sourceId.localeCompare(right.sourceId),
    );
  const sources = Object.freeze(ranked.slice(0, input.maxSources));
  return Object.freeze({
    policyVersion: PAW_MEMORY_EVIDENCE_FIRST_POLICY_VERSION_V1,
    sources,
    telemetry: Object.freeze({
      inputListCount: input.lists.length,
      l0CandidateCount: channelCandidates.l0.size,
      l1CandidateCount: channelCandidates.l1.size,
      fusedCandidateCount: ranked.length,
      dualChannelCount: ranked.filter((item) => item.channelHits > 1).length,
      returnedCount: sources.length,
    }),
  });
}

/**
 * Fuses exact evidence addresses while ranking source documents by their best
 * hit in each independent retriever. This prevents a long document with many
 * near-duplicate spans from crowding out other sources, without discarding the
 * role, authority, time, or address needed for trustworthy hydration.
 */
export function rankMemoryEvidenceCandidatesV2(input: {
  readonly lists: readonly MemoryEvidenceCandidateRankListV2[];
  readonly maxSources: number;
  readonly maxEvidencePerSource: number;
}): MemoryEvidenceCandidateFusionV2 {
  if (!Number.isSafeInteger(input.maxSources) || input.maxSources < 1) {
    throw namedError("MemoryEvidenceCandidateSourceBudgetInvalid");
  }
  if (
    !Number.isSafeInteger(input.maxEvidencePerSource) ||
    input.maxEvidencePerSource < 1 ||
    input.maxEvidencePerSource > 16
  ) {
    throw namedError("MemoryEvidenceCandidatePerSourceBudgetInvalid");
  }
  const candidates = new Map<
    string,
    {
      candidate: MemoryEvidenceCandidateV2;
      score: number;
      lists: Set<string>;
      channels: Set<MemoryEvidenceChannelV1>;
      bestRank: number;
    }
  >();
  const sources = new Map<
    string,
    {
      score: number;
      channels: Set<MemoryEvidenceChannelV1>;
      bestRank: number;
      candidateIds: Set<string>;
    }
  >();
  const channelCandidates: Record<MemoryEvidenceChannelV1, Set<string>> = {
    l0: new Set<string>(),
    l1: new Set<string>(),
  };
  const seenRetrieverIds = new Set<string>();
  for (const list of input.lists) {
    const retrieverId = list.retrieverId.trim();
    if (!retrieverId || seenRetrieverIds.has(retrieverId)) {
      throw namedError("MemoryEvidenceCandidateRetrieverInvalid");
    }
    seenRetrieverIds.add(retrieverId);
    if (!Number.isFinite(list.weight) || list.weight <= 0) {
      throw namedError("MemoryEvidenceCandidateWeightInvalid");
    }
    const seenCandidates = new Set<string>();
    const bestSourceRanks = new Map<string, number>();
    let distinctRank = 0;
    for (const raw of list.candidates) {
      const candidate = normalizedEvidenceCandidateV2(raw);
      if (seenCandidates.has(candidate.candidateId)) continue;
      seenCandidates.add(candidate.candidateId);
      distinctRank += 1;
      channelCandidates[list.channel].add(candidate.candidateId);
      const current = candidates.get(candidate.candidateId);
      const reconciledCandidate = current
        ? reconcileEvidenceCandidateV2(current.candidate, candidate)
        : candidate;
      if (!reconciledCandidate) {
        throw evidenceCandidateIdentityConflictV2(
          current?.candidate,
          candidate,
        );
      }
      const state = current ?? {
        candidate: reconciledCandidate,
        score: 0,
        lists: new Set<string>(),
        channels: new Set<MemoryEvidenceChannelV1>(),
        bestRank: Number.POSITIVE_INFINITY,
      };
      state.candidate = reconciledCandidate;
      state.score += list.weight / (EVIDENCE_SOURCE_RRF_K + distinctRank);
      state.lists.add(retrieverId);
      state.channels.add(list.channel);
      state.bestRank = Math.min(state.bestRank, distinctRank);
      candidates.set(candidate.candidateId, state);
      bestSourceRanks.set(
        candidate.sourceId,
        Math.min(
          bestSourceRanks.get(candidate.sourceId) ?? Number.POSITIVE_INFINITY,
          distinctRank,
        ),
      );
      const source = sources.get(candidate.sourceId) ?? {
        score: 0,
        channels: new Set<MemoryEvidenceChannelV1>(),
        bestRank: Number.POSITIVE_INFINITY,
        candidateIds: new Set<string>(),
      };
      source.channels.add(list.channel);
      source.bestRank = Math.min(source.bestRank, distinctRank);
      source.candidateIds.add(candidate.candidateId);
      sources.set(candidate.sourceId, source);
    }
    for (const [sourceId, rank] of bestSourceRanks) {
      const source = sources.get(sourceId);
      if (!source) throw namedError("MemoryEvidenceSourceMissing");
      source.score += list.weight / (EVIDENCE_SOURCE_RRF_K + rank);
    }
  }
  const rankedCandidates = new Map(
    [...candidates.entries()].map(([candidateId, state]) => [
      candidateId,
      Object.freeze({
        ...state.candidate,
        score: state.score,
        listHits: state.lists.size,
        channels: Object.freeze([...state.channels].sort()),
        bestRank: state.bestRank,
      }),
    ]),
  );
  const rankedSources = [...sources.entries()]
    .map(([sourceId, state]) =>
      Object.freeze({
        sourceId,
        score: state.score,
        channelHits: state.channels.size,
        channels: Object.freeze([...state.channels].sort()),
        bestRank: state.bestRank,
        evidence: Object.freeze(
          [...state.candidateIds]
            .map((candidateId) => {
              const candidate = rankedCandidates.get(candidateId);
              if (!candidate) {
                throw namedError("MemoryEvidenceCandidateMissing");
              }
              return candidate;
            })
            .sort(
              (left, right) =>
                right.score - left.score ||
                right.listHits - left.listHits ||
                left.bestRank - right.bestRank ||
                left.candidateId.localeCompare(right.candidateId),
            )
            .slice(0, input.maxEvidencePerSource),
        ),
      }),
    )
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.channelHits - left.channelHits ||
        left.bestRank - right.bestRank ||
        left.sourceId.localeCompare(right.sourceId),
    );
  const selected = Object.freeze(rankedSources.slice(0, input.maxSources));
  return Object.freeze({
    policyVersion: PAW_MEMORY_EVIDENCE_CANDIDATE_FUSION_VERSION_V2,
    sources: selected,
    telemetry: Object.freeze({
      inputListCount: input.lists.length,
      l0CandidateCount: channelCandidates.l0.size,
      l1CandidateCount: channelCandidates.l1.size,
      fusedCandidateCount: candidates.size,
      fusedSourceCount: rankedSources.length,
      dualChannelSourceCount: rankedSources.filter(
        (source) => source.channelHits > 1,
      ).length,
      returnedSourceCount: selected.length,
      returnedEvidenceCount: selected.reduce(
        (total, source) => total + source.evidence.length,
        0,
      ),
    }),
  });
}

function normalizedEvidenceCandidateV2(
  input: MemoryEvidenceCandidateV2,
): MemoryEvidenceCandidateV2 {
  const candidateId = input.candidateId.trim();
  const sourceId = input.sourceId.trim();
  const evidenceRef = input.evidenceRef.trim();
  if (!candidateId || !sourceId || !evidenceRef) {
    throw namedError("MemoryEvidenceCandidateAddressInvalid");
  }
  return Object.freeze({
    ...input,
    candidateId,
    sourceId,
    evidenceRef,
    ...(input.observedAt?.trim()
      ? { observedAt: input.observedAt.trim() }
      : {}),
  });
}

function reconcileEvidenceCandidateV2(
  left: MemoryEvidenceCandidateV2,
  right: MemoryEvidenceCandidateV2,
): MemoryEvidenceCandidateV2 | undefined {
  if (
    left.sourceId !== right.sourceId ||
    left.evidenceRef !== right.evidenceRef ||
    left.sourceKind !== right.sourceKind ||
    left.observedAt !== right.observedAt
  ) {
    return undefined;
  }
  if (left.authority === right.authority) return left;

  // A dialogue retriever may certify an immutable turn after a coarse span
  // retriever has found the same address. Certification refines how that turn
  // may be used; it does not create a second evidence identity.
  const baseAuthority =
    left.sourceKind === "assistant_output"
      ? "context_only"
      : left.sourceKind === "user_input"
        ? "user_asserted"
        : undefined;
  if (
    baseAuthority &&
    ((left.authority === baseAuthority &&
      right.authority === "user_confirmed_dialogue") ||
      (right.authority === baseAuthority &&
        left.authority === "user_confirmed_dialogue"))
  ) {
    return left.authority === "user_confirmed_dialogue" ? left : right;
  }
  return undefined;
}

function evidenceCandidateIdentityConflictV2(
  left: MemoryEvidenceCandidateV2 | undefined,
  right: MemoryEvidenceCandidateV2,
): Error {
  const error = namedError("MemoryEvidenceCandidateIdentityConflict");
  Object.defineProperty(error, "candidateConflict", {
    enumerable: true,
    value: Object.freeze({
      sourceId: left?.sourceId === right.sourceId ? "same" : "different",
      evidenceRef:
        left?.evidenceRef === right.evidenceRef ? "same" : "different",
      sourceKind: Object.freeze([left?.sourceKind ?? "missing", right.sourceKind]),
      authority: Object.freeze([left?.authority ?? "missing", right.authority]),
      observedAt:
        left?.observedAt === right.observedAt ? "same" : "different",
    }),
  });
  return error;
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}
