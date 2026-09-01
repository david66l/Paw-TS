export type AmbDialogueAnchorKindV1 = "user_input" | "assistant_output";

export interface AmbDialogueAnchorV1 {
  readonly documentId: string;
  readonly sourceSeq: number;
  readonly evidenceRef: string;
  readonly sourceKind: AmbDialogueAnchorKindV1;
}

export interface AmbDialogueProjectionV1 {
  readonly discovery: AmbDialogueAnchorV1;
  readonly answer?: AmbDialogueAnchorV1;
}

export interface AmbDialogueProjectionTelemetryV1 {
  readonly directAssistantDiscoveryCount: number;
  readonly userDiscoveryCount: number;
  readonly promotedAssistantCount: number;
  readonly promotionDroppedNoAdjacentAssistant: number;
  readonly dedupedAssistantCount: number;
  readonly finalAssistantCandidateCount: number;
  readonly directCandidateDisplacedCount: number;
  readonly sourceFairPromptCount: number;
  readonly sourceFairAssistantCount: number;
  readonly sourceFairSourceCount: number;
}

export interface AmbDialoguePromptRankingV1 {
  readonly lane: "requirement" | "original_query";
  readonly anchors: readonly AmbDialogueAnchorV1[];
}

interface AggregatedPromptAnchorV1 {
  readonly anchor: AmbDialogueAnchorV1;
  readonly ranks: number[];
}

export function classifyAmbSourceLocalChannelHealthV1(input: {
  readonly directLexicalFailed: boolean;
  readonly directDenseFailed: boolean;
  readonly discoveryLexicalFailed: boolean;
  readonly discoveryDenseFailed: boolean;
}): {
  readonly resultDegradedChannels: readonly ("lexical" | "dense")[];
  readonly discoveryChannelDegraded: boolean;
} {
  return Object.freeze({
    resultDegradedChannels: Object.freeze([
      ...(input.directLexicalFailed ? (["lexical"] as const) : []),
      ...(input.directDenseFailed ? (["dense"] as const) : []),
    ]),
    discoveryChannelDegraded:
      input.discoveryLexicalFailed || input.discoveryDenseFailed,
  });
}

interface AggregatedAnchorV1 {
  readonly anchor: AmbDialogueAnchorV1;
  directRank?: number;
  promotionRank?: number;
}

const RRF_K = 60;

/**
 * Gives every locked source its own bounded prompt lane before sources compete.
 * The strongest single query lane wins first; RRF is only the deterministic
 * tie-break for prompts supported by both the planner leaf and original query.
 */
export function selectAmbSourceFairPromptAnchorsV1(input: {
  readonly sourcePriority: readonly string[];
  readonly rankingsBySource: ReadonlyMap<
    string,
    readonly AmbDialoguePromptRankingV1[]
  >;
  readonly maxPromptAnchorsPerSource: 1 | 2;
}): readonly AmbDialogueAnchorV1[] {
  const selected: AmbDialogueAnchorV1[] = [];
  for (const sourceId of input.sourcePriority) {
    const aggregated = new Map<string, AggregatedPromptAnchorV1>();
    for (const ranking of input.rankingsBySource.get(sourceId) ?? []) {
      stableUniqueAnchors(ranking.anchors).forEach((anchor, index) => {
        if (
          anchor.documentId !== sourceId ||
          anchor.sourceKind !== "user_input"
        ) {
          return;
        }
        const current = aggregated.get(anchor.evidenceRef);
        if (current) {
          current.ranks.push(index + 1);
        } else {
          aggregated.set(anchor.evidenceRef, {
            anchor,
            ranks: [index + 1],
          });
        }
      });
    }
    const ranked = [...aggregated.values()].sort(
      (left, right) =>
        strongestPromptScore(right) - strongestPromptScore(left) ||
        fusedPromptScore(right) - fusedPromptScore(left) ||
        Math.min(...left.ranks) - Math.min(...right.ranks) ||
        left.anchor.evidenceRef.localeCompare(right.anchor.evidenceRef),
    );
    selected.push(
      ...ranked
        .slice(0, input.maxPromptAnchorsPerSource)
        .map((candidate) => candidate.anchor),
    );
  }
  return Object.freeze(selected);
}

/**
 * Ranks answer-bearing evidence addresses. A user turn may be a discovery
 * signal, but it can only contribute to the immediately following assistant
 * turn in the same immutable conversation source.
 */
export function rankAmbDialogueEvidenceAnchorsV1(input: {
  readonly roleConstraint: string;
  readonly certifiedAssistantDialogueCandidate: boolean;
  readonly directAnchors: readonly AmbDialogueAnchorV1[];
  readonly projections: readonly AmbDialogueProjectionV1[];
  /** Already source-fair prompt-to-successor projections, in source priority. */
  readonly sourceFairProjections?: readonly AmbDialogueProjectionV1[];
  readonly maxAnchors: number;
}): {
  readonly anchors: readonly AmbDialogueAnchorV1[];
  readonly promotedAssistantEvidenceRefs: readonly string[];
  readonly sourceFairAssistantEvidenceRefs: readonly string[];
  readonly telemetry: AmbDialogueProjectionTelemetryV1;
} {
  const direct = stableUniqueAnchors(input.directAnchors);
  const projectionEligible =
    input.roleConstraint === "assistant" ||
    input.roleConstraint === "any" ||
    input.certifiedAssistantDialogueCandidate;
  const aggregated = new Map<string, AggregatedAnchorV1>();

  direct.forEach((anchor, index) => {
    aggregated.set(anchor.evidenceRef, {
      anchor,
      directRank: index + 1,
    });
  });

  const userDiscoveries = new Set<string>();
  const promotedAssistantEvidenceRefs = new Set<string>();
  let promotedAssistantCount = 0;
  let promotionDroppedNoAdjacentAssistant = 0;
  if (projectionEligible) {
    input.projections.forEach((projection, index) => {
      const { discovery, answer } = projection;
      if (discovery.sourceKind === "user_input") {
        userDiscoveries.add(discovery.evidenceRef);
      }
      if (!isStrictAdjacentAssistantProjection(discovery, answer)) {
        promotionDroppedNoAdjacentAssistant += 1;
        return;
      }
      promotedAssistantCount += 1;
      promotedAssistantEvidenceRefs.add(answer.evidenceRef);
      const current = aggregated.get(answer.evidenceRef);
      if (current) {
        current.promotionRank = Math.min(
          current.promotionRank ?? Number.POSITIVE_INFINITY,
          index + 1,
        );
      } else {
        aggregated.set(answer.evidenceRef, {
          anchor: answer,
          promotionRank: index + 1,
        });
      }
    });
  }

  const sourceFairAnswers = projectionEligible
    ? stableUniqueAnchors(
        (input.sourceFairProjections ?? []).flatMap((projection) =>
          isStrictAdjacentAssistantProjection(
            projection.discovery,
            projection.answer,
          )
            ? [projection.answer]
            : [],
        ),
      )
    : [];

  const ranked = [...aggregated.values()].sort(
    (left, right) =>
      fusedScore(right) - fusedScore(left) ||
      minimumRank(left) - minimumRank(right) ||
      left.anchor.evidenceRef.localeCompare(right.anchor.evidenceRef),
  );
  const reserved = projectionEligible
    ? [
        ...directReservations(input.roleConstraint, direct),
        ...sourceFairAnswers,
      ]
    : [];
  const anchors = stableUniqueAnchors([
    ...reserved,
    ...ranked.map((candidate) => candidate.anchor),
  ]).slice(0, input.maxAnchors);
  const finalRefs = new Set(anchors.map((anchor) => anchor.evidenceRef));
  const oldDirectTopK = direct.slice(0, input.maxAnchors);
  const uniqueAssistantRefs = new Set(
    [
      ...direct.filter((anchor) => anchor.sourceKind === "assistant_output"),
      ...input.projections.flatMap((projection) =>
        isStrictAdjacentAssistantProjection(
          projection.discovery,
          projection.answer,
        )
          ? [projection.answer]
          : [],
      ),
      ...sourceFairAnswers,
    ].map((anchor) => anchor.evidenceRef),
  );
  const rawAssistantSignals =
    direct.filter((anchor) => anchor.sourceKind === "assistant_output").length +
    promotedAssistantCount;

  return Object.freeze({
    anchors: Object.freeze(anchors),
    promotedAssistantEvidenceRefs: Object.freeze([
      ...promotedAssistantEvidenceRefs,
    ]),
    sourceFairAssistantEvidenceRefs: Object.freeze(
      sourceFairAnswers.map((anchor) => anchor.evidenceRef),
    ),
    telemetry: Object.freeze({
      directAssistantDiscoveryCount: direct.filter(
        (anchor) => anchor.sourceKind === "assistant_output",
      ).length,
      userDiscoveryCount: userDiscoveries.size,
      promotedAssistantCount,
      promotionDroppedNoAdjacentAssistant,
      dedupedAssistantCount: Math.max(
        0,
        rawAssistantSignals - uniqueAssistantRefs.size,
      ),
      finalAssistantCandidateCount: anchors.filter(
        (anchor) => anchor.sourceKind === "assistant_output",
      ).length,
      directCandidateDisplacedCount: oldDirectTopK.filter(
        (anchor) => !finalRefs.has(anchor.evidenceRef),
      ).length,
      sourceFairPromptCount:
        input.sourceFairProjections?.filter(
          (projection) => projection.discovery.sourceKind === "user_input",
        ).length ?? 0,
      sourceFairAssistantCount: sourceFairAnswers.length,
      sourceFairSourceCount: new Set(
        sourceFairAnswers.map((anchor) => anchor.documentId),
      ).size,
    }),
  });
}

function isStrictAdjacentAssistantProjection(
  discovery: AmbDialogueAnchorV1,
  answer: AmbDialogueAnchorV1 | undefined,
): answer is AmbDialogueAnchorV1 {
  return (
    hasMatchingLogicalAddress(discovery) &&
    answer !== undefined &&
    hasMatchingLogicalAddress(answer) &&
    discovery.sourceKind === "user_input" &&
    answer.sourceKind === "assistant_output" &&
    answer.documentId === discovery.documentId &&
    answer.sourceSeq === discovery.sourceSeq + 1
  );
}

function directReservations(
  roleConstraint: string,
  direct: readonly AmbDialogueAnchorV1[],
): readonly AmbDialogueAnchorV1[] {
  const assistant = direct.find(
    (anchor) => anchor.sourceKind === "assistant_output",
  );
  const user = direct.find((anchor) => anchor.sourceKind === "user_input");
  if (roleConstraint === "assistant") return assistant ? [assistant] : [];
  if (roleConstraint === "any") {
    return [assistant, user].filter(
      (anchor): anchor is AmbDialogueAnchorV1 => anchor !== undefined,
    );
  }
  return [user, assistant].filter(
    (anchor): anchor is AmbDialogueAnchorV1 => anchor !== undefined,
  );
}

function stableUniqueAnchors(
  anchors: readonly AmbDialogueAnchorV1[],
): AmbDialogueAnchorV1[] {
  const seen = new Set<string>();
  return anchors.filter((anchor) => {
    if (!hasMatchingLogicalAddress(anchor) || seen.has(anchor.evidenceRef)) {
      return false;
    }
    seen.add(anchor.evidenceRef);
    return true;
  });
}

function hasMatchingLogicalAddress(anchor: AmbDialogueAnchorV1): boolean {
  return (
    Number.isSafeInteger(anchor.sourceSeq) &&
    anchor.sourceSeq > 0 &&
    anchor.evidenceRef === `${anchor.documentId}#source-${anchor.sourceSeq}`
  );
}

function fusedScore(candidate: AggregatedAnchorV1): number {
  return (
    (candidate.directRank === undefined
      ? 0
      : 1 / (RRF_K + candidate.directRank)) +
    (candidate.promotionRank === undefined
      ? 0
      : 1 / (RRF_K + candidate.promotionRank))
  );
}

function minimumRank(candidate: AggregatedAnchorV1): number {
  return Math.min(
    candidate.directRank ?? Number.POSITIVE_INFINITY,
    candidate.promotionRank ?? Number.POSITIVE_INFINITY,
  );
}

function strongestPromptScore(candidate: AggregatedPromptAnchorV1): number {
  return Math.max(...candidate.ranks.map((rank) => 1 / (RRF_K + rank)));
}

function fusedPromptScore(candidate: AggregatedPromptAnchorV1): number {
  return candidate.ranks.reduce(
    (total, rank) => total + 1 / (RRF_K + rank),
    0,
  );
}
