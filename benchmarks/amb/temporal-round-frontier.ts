import {
  type MemorySourceLocalHydratedEvidenceV1,
  type MemoryTemporalRoundPostingV1,
  createMemoryTemporalRoundPostingV1,
} from "@paw/memory-plugin";

import type { AmbDialogueAnchorV1 } from "./source-local-dialogue-projection.js";

type TemporalIntervalV1 = Readonly<{
  lower: string;
  upper: string;
  precision?: "day" | "year";
}>;

export const AMB_TEMPORAL_ROUND_FRONTIER_RANKER_VERSION_V1 =
  "paw.amb-temporal-round-frontier-ranker.v3:baseline-monotonic-source-fair-dual-lane-immutable-authority" as const;

export interface AmbTemporalRoundCandidateV1 {
  readonly anchor: AmbDialogueAnchorV1;
  readonly content: string;
  readonly observedAt?: string;
}

export interface AmbTemporalRoundLaneV1 {
  readonly kind: "original_query" | "requirement";
  readonly evidenceRefs: readonly string[];
}

export interface AmbTemporalRoundFrontierRankingV1 {
  readonly rankerVersion: typeof AMB_TEMPORAL_ROUND_FRONTIER_RANKER_VERSION_V1;
  readonly anchors: readonly AmbDialogueAnchorV1[];
  readonly frontierEvidenceRefs: readonly string[];
  readonly baselineReservedEvidenceRefs: readonly string[];
}

/**
 * Compiles frontier identity from immutable L0. Candidate content remains a
 * ranking projection only and can never author a posting digest.
 */
export function compileAmbImmutableTemporalRoundPostingsV1(input: {
  readonly candidates: readonly AmbTemporalRoundCandidateV1[];
  readonly hydrated: readonly MemorySourceLocalHydratedEvidenceV1[];
  readonly episodeOrders: readonly Readonly<{
    sourceId: string;
    episodeOrder: number;
  }>[];
}): readonly MemoryTemporalRoundPostingV1[] {
  const candidateRefs = input.candidates.map(
    (candidate) => candidate.anchor.evidenceRef,
  );
  const hydratedByRef = new Map(
    input.hydrated.map((row) => [row.evidenceRef, row] as const),
  );
  const episodeOrderBySource = new Map(
    input.episodeOrders.map((item) => [item.sourceId, item.episodeOrder]),
  );
  if (
    new Set(candidateRefs).size !== candidateRefs.length ||
    hydratedByRef.size !== input.hydrated.length ||
    input.hydrated.length !== input.candidates.length ||
    input.hydrated.some((row) => !candidateRefs.includes(row.evidenceRef)) ||
    episodeOrderBySource.size !== input.episodeOrders.length
  ) {
    throw namedError("AmbTemporalRoundFrontierImmutablePartitionInvalid");
  }
  return Object.freeze(
    input.candidates.map((candidate) => {
      const { anchor } = candidate;
      const row = hydratedByRef.get(anchor.evidenceRef);
      if (
        !row ||
        anchor.evidenceRef !==
          `${anchor.documentId}#source-${anchor.sourceSeq}` ||
        row.sourceKind !== anchor.sourceKind ||
        row.turnOrder !== anchor.sourceSeq ||
        row.observedAt !== candidate.observedAt
      ) {
        throw namedError("AmbTemporalRoundFrontierImmutableMetadataInvalid");
      }
      const episodeOrder = episodeOrderBySource.get(anchor.documentId);
      return createMemoryTemporalRoundPostingV1({
        sourceId: anchor.documentId,
        evidenceRef: anchor.evidenceRef,
        role: row.sourceKind,
        contentDigest: row.contentHash,
        ...(row.observedAt === undefined ? {} : { observedAt: row.observedAt }),
        ...(episodeOrder === undefined ? {} : { episodeOrder }),
        turnOrder: row.turnOrder,
        timeBasis:
          row.observedAt === undefined ? "unbound" : "source_observed_at",
      });
    }),
  );
}

/**
 * Ranks exact turns already enumerated from an immutable source lock. The
 * result is candidate ordering only: it grants neither support nor closure.
 */
export function rankAmbTemporalRoundFrontierV1(input: {
  readonly originalQuery: string;
  readonly requirementText: string;
  readonly temporalMode: "any" | "latest" | "as_of" | "history" | "range";
  readonly queryScopeInterval: TemporalIntervalV1 | null;
  readonly baselineAnchors: readonly AmbDialogueAnchorV1[];
  readonly candidates: readonly AmbTemporalRoundCandidateV1[];
  readonly lanes: readonly AmbTemporalRoundLaneV1[];
  readonly sourcePriorityIds: readonly string[];
  readonly maxAnchors: number;
}): AmbTemporalRoundFrontierRankingV1 {
  if (
    !Number.isSafeInteger(input.maxAnchors) ||
    input.maxAnchors < 1 ||
    input.maxAnchors > 8 ||
    new Set(input.candidates.map((item) => item.anchor.evidenceRef)).size !==
      input.candidates.length ||
    new Set(input.lanes.map((lane) => lane.kind)).size !== input.lanes.length ||
    input.sourcePriorityIds.length === 0 ||
    new Set(input.sourcePriorityIds).size !== input.sourcePriorityIds.length ||
    input.candidates.some(
      (candidate) =>
        !input.sourcePriorityIds.includes(candidate.anchor.documentId),
    )
  ) {
    throw namedError("AmbTemporalRoundFrontierInputInvalid");
  }
  const ranksByLane = new Map(
    input.lanes.map((lane) => [
      lane.kind,
      new Map(
        lane.evidenceRefs.map((evidenceRef, index) => [evidenceRef, index + 1]),
      ),
    ]),
  );
  const queryTerms = terms(`${input.originalQuery}\n${input.requirementText}`);
  const ranked = [...input.candidates].sort((left, right) => {
    const leftLaneRanks = laneRanks(left.anchor.evidenceRef, ranksByLane);
    const rightLaneRanks = laneRanks(right.anchor.evidenceRef, ranksByLane);
    return (
      rightLaneRanks.length - leftLaneRanks.length ||
      windowRank(right, input.queryScopeInterval) -
        windowRank(left, input.queryScopeInterval) ||
      reciprocalRank(rightLaneRanks) - reciprocalRank(leftLaneRanks) ||
      lexicalCoverage(right.content, queryTerms) -
        lexicalCoverage(left.content, queryTerms) ||
      temporalTieBreak(right, input.temporalMode) -
        temporalTieBreak(left, input.temporalMode) ||
      left.anchor.evidenceRef.localeCompare(right.anchor.evidenceRef)
    );
  });
  const baselineReserved = stableUniqueAnchors(input.baselineAnchors).slice(
    0,
    input.maxAnchors,
  );
  const baselineRefs = new Set(
    input.baselineAnchors.map((anchor) => anchor.evidenceRef),
  );
  const frontierSlots = input.maxAnchors - baselineReserved.length;
  const fairFrontier = sourceFairRoundRobin(
    ranked
      .map((item) => item.anchor)
      .filter((anchor) => !baselineRefs.has(anchor.evidenceRef)),
    input.sourcePriorityIds,
    frontierSlots,
  );
  const anchors = [...baselineReserved, ...fairFrontier];
  return Object.freeze({
    rankerVersion: AMB_TEMPORAL_ROUND_FRONTIER_RANKER_VERSION_V1,
    anchors: Object.freeze(anchors),
    frontierEvidenceRefs: Object.freeze(
      anchors
        .map((anchor) => anchor.evidenceRef)
        .filter((evidenceRef) => !baselineRefs.has(evidenceRef)),
    ),
    baselineReservedEvidenceRefs: Object.freeze(
      baselineReserved.map((anchor) => anchor.evidenceRef),
    ),
  });
}

function laneRanks(
  evidenceRef: string,
  ranksByLane: ReadonlyMap<string, ReadonlyMap<string, number>>,
): number[] {
  return [...ranksByLane.values()].flatMap((ranks) => {
    const rank = ranks.get(evidenceRef);
    return rank === undefined ? [] : [rank];
  });
}

function reciprocalRank(ranks: readonly number[]): number {
  return ranks.reduce((total, rank) => total + 1 / (60 + rank), 0);
}

function windowRank(
  candidate: AmbTemporalRoundCandidateV1,
  interval: TemporalIntervalV1 | null,
): number {
  if (!interval) return 1;
  const observedAt = candidate.observedAt
    ? Date.parse(candidate.observedAt)
    : Number.NaN;
  if (!Number.isFinite(observedAt)) return 0;
  return observedAt >= Date.parse(interval.lower) &&
    observedAt < Date.parse(interval.upper)
    ? 2
    : 1;
}

function temporalTieBreak(
  candidate: AmbTemporalRoundCandidateV1,
  mode: "any" | "latest" | "as_of" | "history" | "range",
): number {
  if (mode !== "latest" && mode !== "as_of") return 0;
  const observedAt = candidate.observedAt
    ? Date.parse(candidate.observedAt)
    : Number.NaN;
  return Number.isFinite(observedAt) ? observedAt : 0;
}

function terms(value: string): ReadonlySet<string> {
  const stop = new Set([
    "about",
    "after",
    "before",
    "did",
    "does",
    "from",
    "have",
    "what",
    "when",
    "where",
    "which",
    "with",
    "would",
    "your",
  ]);
  return new Set(
    value
      .toLocaleLowerCase("en-US")
      .match(/[\p{L}\p{N}]{3,}/gu)
      ?.filter((term) => !stop.has(term)) ?? [],
  );
}

function lexicalCoverage(
  content: string,
  queryTerms: ReadonlySet<string>,
): number {
  if (queryTerms.size === 0) return 0;
  const contentTerms = terms(content);
  let matched = 0;
  for (const term of queryTerms) {
    if (contentTerms.has(term)) matched += 1;
  }
  return matched / queryTerms.size;
}

function sourceFairRoundRobin(
  anchors: readonly AmbDialogueAnchorV1[],
  sourcePriorityIds: readonly string[],
  limit: number,
): readonly AmbDialogueAnchorV1[] {
  if (limit <= 0) return Object.freeze([]);
  const queues = new Map(
    sourcePriorityIds.map((sourceId) => [
      sourceId,
      anchors.filter((anchor) => anchor.documentId === sourceId),
    ]),
  );
  const rankByRef = new Map(
    anchors.map((anchor, index) => [anchor.evidenceRef, index]),
  );
  const sourceOrder = [...sourcePriorityIds]
    .filter((sourceId) => (queues.get(sourceId)?.length ?? 0) > 0)
    .sort((left, right) => {
      const leftRank = rankByRef.get(queues.get(left)?.[0]?.evidenceRef ?? "");
      const rightRank = rankByRef.get(
        queues.get(right)?.[0]?.evidenceRef ?? "",
      );
      return (
        (leftRank ?? Number.MAX_SAFE_INTEGER) -
        (rightRank ?? Number.MAX_SAFE_INTEGER)
      );
    });
  const selected: AmbDialogueAnchorV1[] = [];
  for (let offset = 0; selected.length < limit; offset += 1) {
    let added = false;
    for (const sourceId of sourceOrder) {
      const anchor = queues.get(sourceId)?.[offset];
      if (!anchor) continue;
      selected.push(anchor);
      added = true;
      if (selected.length === limit) break;
    }
    if (!added) break;
  }
  return Object.freeze(selected);
}

function stableUniqueAnchors(
  anchors: readonly AmbDialogueAnchorV1[],
): AmbDialogueAnchorV1[] {
  const refs = new Set<string>();
  return anchors.filter((anchor) => {
    if (refs.has(anchor.evidenceRef)) return false;
    refs.add(anchor.evidenceRef);
    return true;
  });
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}
