import {
  type MemoryAspectGraphSnapshotV1,
  measureMemoryAspectGraphV1,
  projectMemoryAspectStateV1,
  resolveMemoryAspectIdsV1,
} from "./aspect-graph.js";

export const PAW_MEMORY_ASPECT_GRAPH_EVAL_VERSION_V1 =
  "paw.memory-aspect-graph-eval.v1" as const;

export interface MemoryAspectGraphBinaryMetricsV1 {
  readonly truePositive: number;
  readonly falsePositive: number;
  readonly falseNegative: number;
  readonly precision: number;
  readonly recall: number;
  readonly f1: number;
}

export interface MemoryAspectCurrentStateCaseV1 {
  readonly predictedAspectId: string;
  readonly goldAspectId: string;
  readonly asOf: string;
}

export interface MemoryAspectGraphEvaluationV1 {
  readonly schemaVersion: typeof PAW_MEMORY_ASPECT_GRAPH_EVAL_VERSION_V1;
  /** Claim pairs sharing at least one resolved aspect; label names may differ. */
  readonly aspectPairwise: MemoryAspectGraphBinaryMetricsV1;
  /** Exact active typed edges, keyed by source claim, target claim, and type. */
  readonly evidenceEdges: MemoryAspectGraphBinaryMetricsV1;
  readonly currentState: MemoryAspectGraphBinaryMetricsV1;
  readonly currentStateExactMatch: number;
  readonly currentStateCaseCount: number;
}

/**
 * Evaluates structure independently from retrieval and answer generation.
 * Gold and predicted graphs may use different aspect IDs and labels because
 * pairwise co-membership is compared through immutable claim IDs.
 */
export function evaluateMemoryAspectGraphStructureV1(
  input: Readonly<{
    predicted: MemoryAspectGraphSnapshotV1;
    gold: MemoryAspectGraphSnapshotV1;
    currentStateCases?: readonly MemoryAspectCurrentStateCaseV1[];
  }>,
): MemoryAspectGraphEvaluationV1 {
  measureMemoryAspectGraphV1(input.predicted);
  measureMemoryAspectGraphV1(input.gold);
  const aspectPairwise = compareSets(
    claimPairSet(input.predicted),
    claimPairSet(input.gold),
  );
  const evidenceEdges = compareSets(
    activeEdgeSet(input.predicted),
    activeEdgeSet(input.gold),
  );

  const predictedStates = new Set<string>();
  const goldStates = new Set<string>();
  let exact = 0;
  for (const [index, evaluationCase] of (
    input.currentStateCases ?? []
  ).entries()) {
    const predicted = projectMemoryAspectStateV1({
      snapshot: input.predicted,
      aspectId: evaluationCase.predictedAspectId,
      asOf: evaluationCase.asOf,
    }).currentClaimIds;
    const gold = projectMemoryAspectStateV1({
      snapshot: input.gold,
      aspectId: evaluationCase.goldAspectId,
      asOf: evaluationCase.asOf,
    }).currentClaimIds;
    for (const id of predicted) predictedStates.add(`${index}\n${id}`);
    for (const id of gold) goldStates.add(`${index}\n${id}`);
    if (sameSet(new Set(predicted), new Set(gold))) exact += 1;
  }
  const currentStateCaseCount = input.currentStateCases?.length ?? 0;
  return Object.freeze({
    schemaVersion: PAW_MEMORY_ASPECT_GRAPH_EVAL_VERSION_V1,
    aspectPairwise,
    evidenceEdges,
    currentState: compareSets(predictedStates, goldStates),
    currentStateExactMatch:
      currentStateCaseCount === 0 ? 0 : exact / currentStateCaseCount,
    currentStateCaseCount,
  });
}

function claimPairSet(
  snapshot: MemoryAspectGraphSnapshotV1,
): ReadonlySet<string> {
  const claimsByAspect = new Map<string, Set<string>>();
  const retracted = new Set(
    snapshot.lifecycleEvents
      .filter((event) => event.targetKind === "membership")
      .map((event) => event.targetId),
  );
  const aspects = new Map(
    snapshot.aspects.map((aspect) => [aspect.id, aspect]),
  );
  for (const membership of snapshot.memberships) {
    if (retracted.has(membership.id)) continue;
    const aspect = aspects.get(membership.aspectId);
    const effectiveAspectIds =
      aspect?.status === "redirected"
        ? resolveMemoryAspectIdsV1(snapshot, membership.aspectId)
        : [membership.aspectId];
    for (const aspectId of effectiveAspectIds) {
      const key = `${membership.subjectKey}\n${membership.contextKey}\n${aspectId}`;
      const claims = claimsByAspect.get(key) ?? new Set<string>();
      claims.add(membership.claimId);
      claimsByAspect.set(key, claims);
    }
  }
  const result = new Set<string>();
  for (const claims of claimsByAspect.values()) {
    const ids = [...claims].sort();
    for (let left = 0; left < ids.length; left += 1) {
      for (let right = left + 1; right < ids.length; right += 1) {
        result.add(`${ids[left] as string}\n${ids[right] as string}`);
      }
    }
  }
  return result;
}

function activeEdgeSet(
  snapshot: MemoryAspectGraphSnapshotV1,
): ReadonlySet<string> {
  return new Set(
    snapshot.edges
      .filter(
        (edge) =>
          !snapshot.lifecycleEvents.some(
            (event) =>
              event.targetKind === "edge" && event.targetId === edge.id,
          ),
      )
      .map((edge) => {
        const [fromClaimId, toClaimId] =
          edge.edgeType === "same_state" &&
          edge.fromClaimId.localeCompare(edge.toClaimId) > 0
            ? [edge.toClaimId, edge.fromClaimId]
            : [edge.fromClaimId, edge.toClaimId];
        return `${edge.edgeType}\n${edge.stateKeyId ?? "unscoped"}\n${fromClaimId}\n${toClaimId}`;
      }),
  );
}

function compareSets(
  predicted: ReadonlySet<string>,
  gold: ReadonlySet<string>,
): MemoryAspectGraphBinaryMetricsV1 {
  let truePositive = 0;
  for (const item of predicted) {
    if (gold.has(item)) truePositive += 1;
  }
  const falsePositive = predicted.size - truePositive;
  const falseNegative = gold.size - truePositive;
  const precision =
    predicted.size === 0
      ? gold.size === 0
        ? 1
        : 0
      : truePositive / predicted.size;
  const recall =
    gold.size === 0 ? (predicted.size === 0 ? 1 : 0) : truePositive / gold.size;
  const f1 =
    precision + recall === 0
      ? 0
      : (2 * precision * recall) / (precision + recall);
  return Object.freeze({
    truePositive,
    falsePositive,
    falseNegative,
    precision,
    recall,
    f1,
  });
}

function sameSet(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): boolean {
  return left.size === right.size && [...left].every((item) => right.has(item));
}
