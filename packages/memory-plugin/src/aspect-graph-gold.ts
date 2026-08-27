import type { JsonValue } from "@paw/protocol";

import {
  type MemoryAspectGraphSnapshotV1,
  type MemoryEvidenceEdgeTypeV1,
  measureMemoryAspectGraphV1,
  projectMemoryAspectStateV1,
  resolveMemoryAspectIdsV1,
} from "./aspect-graph.js";
import { hashCanonicalJsonV1 } from "./canonical.js";

export const PAW_MEMORY_ASPECT_GRAPH_GOLD_VERSION_V1 =
  "paw.memory-aspect-graph-gold.v1" as const;
export const PAW_MEMORY_ASPECT_GRAPH_GOLD_EVAL_VERSION_V1 =
  "paw.memory-aspect-graph-gold-eval.v1" as const;

export interface MemoryAspectPairGoldV1 {
  readonly leftClaimId: string;
  readonly rightClaimId: string;
  readonly sameAspect: boolean;
}

export interface MemoryEvidenceEdgeGoldV1 {
  readonly fromClaimId: string;
  readonly toClaimId: string;
  readonly edgeType: MemoryEvidenceEdgeTypeV1;
  readonly present: boolean;
}

export interface MemoryCurrentStateGoldV1 {
  /** The anchors must have exactly one subject/context/aspect state in common. */
  readonly anchorClaimIds: readonly string[];
  readonly asOf: string;
  readonly currentClaimIds: readonly string[];
}

export interface MemoryAspectGraphGoldV1 {
  readonly schemaVersion: typeof PAW_MEMORY_ASPECT_GRAPH_GOLD_VERSION_V1;
  readonly annotationSetId: string;
  readonly corpusRevision: string;
  readonly pairs: readonly MemoryAspectPairGoldV1[];
  readonly edges: readonly MemoryEvidenceEdgeGoldV1[];
  readonly currentStates: readonly MemoryCurrentStateGoldV1[];
}

export interface MemoryAspectGoldClassificationMetricsV1 {
  readonly total: number;
  readonly correct: number;
  readonly truePositive: number;
  readonly trueNegative: number;
  readonly falsePositive: number;
  readonly falseNegative: number;
  readonly accuracy: number;
  readonly precision: number;
  readonly recall: number;
  readonly f1: number;
}

export interface MemoryAspectGraphGoldEvaluationV1 {
  readonly schemaVersion: typeof PAW_MEMORY_ASPECT_GRAPH_GOLD_EVAL_VERSION_V1;
  readonly annotationSetId: string;
  readonly corpusRevision: string;
  readonly pairwise: MemoryAspectGoldClassificationMetricsV1;
  readonly evidenceEdges: MemoryAspectGoldClassificationMetricsV1;
  readonly currentState: MemoryAspectGoldClassificationMetricsV1;
  readonly currentStateCaseCount: number;
  readonly currentStateExactMatch: number;
}

export function deriveMemoryAspectCorpusRevisionV1(
  snapshot: MemoryAspectGraphSnapshotV1,
): string {
  measureMemoryAspectGraphV1(snapshot);
  return hashCanonicalJsonV1({
    schemaVersion: "paw.memory-aspect-corpus.v1",
    claims: snapshot.claims.map((claim) => ({
      id: claim.id,
      kind: claim.kind,
      validFrom: claim.validFrom,
      validTo: claim.validTo ?? null,
      ingestedAt: claim.ingestedAt,
      evidenceRefs: claim.evidenceRefs,
    })) as unknown as JsonValue,
  });
}

export function createMemoryAspectGraphGoldV1(
  input: Readonly<{
    snapshot: MemoryAspectGraphSnapshotV1;
    annotationSetId: string;
    pairs?: readonly MemoryAspectPairGoldV1[];
    edges?: readonly MemoryEvidenceEdgeGoldV1[];
    currentStates?: readonly MemoryCurrentStateGoldV1[];
  }>,
): MemoryAspectGraphGoldV1 {
  const claimIds = new Set(input.snapshot.claims.map((claim) => claim.id));
  const pairs = normalizePairs(input.pairs ?? [], claimIds);
  const edges = normalizeEdges(input.edges ?? [], claimIds);
  const currentStates = normalizeCurrentStates(
    input.currentStates ?? [],
    claimIds,
  );
  if (pairs.length + edges.length + currentStates.length === 0) {
    throw namedError("MemoryAspectGoldAnnotationsMissing");
  }
  return Object.freeze({
    schemaVersion: PAW_MEMORY_ASPECT_GRAPH_GOLD_VERSION_V1,
    annotationSetId: text(
      input.annotationSetId,
      "MemoryAspectGoldSetIdInvalid",
    ),
    corpusRevision: deriveMemoryAspectCorpusRevisionV1(input.snapshot),
    pairs,
    edges,
    currentStates,
  });
}

export function parseMemoryAspectGraphGoldV1(
  value: unknown,
  snapshot: MemoryAspectGraphSnapshotV1,
): MemoryAspectGraphGoldV1 {
  const root = exactRecord(value, [
    "schemaVersion",
    "annotationSetId",
    "corpusRevision",
    "pairs",
    "edges",
    "currentStates",
  ]);
  if (root.schemaVersion !== PAW_MEMORY_ASPECT_GRAPH_GOLD_VERSION_V1) {
    throw namedError("MemoryAspectGoldVersionInvalid");
  }
  const gold = createMemoryAspectGraphGoldV1({
    snapshot,
    annotationSetId: stringValue(root.annotationSetId),
    pairs: arrayValue(root.pairs).map((item) => {
      const record = exactRecord(item, [
        "leftClaimId",
        "rightClaimId",
        "sameAspect",
      ]);
      return {
        leftClaimId: stringValue(record.leftClaimId),
        rightClaimId: stringValue(record.rightClaimId),
        sameAspect: booleanValue(record.sameAspect),
      };
    }),
    edges: arrayValue(root.edges).map((item) => {
      const record = exactRecord(item, [
        "fromClaimId",
        "toClaimId",
        "edgeType",
        "present",
      ]);
      return {
        fromClaimId: stringValue(record.fromClaimId),
        toClaimId: stringValue(record.toClaimId),
        edgeType: edgeTypeValue(record.edgeType),
        present: booleanValue(record.present),
      };
    }),
    currentStates: arrayValue(root.currentStates).map((item) => {
      const record = exactRecord(item, [
        "anchorClaimIds",
        "asOf",
        "currentClaimIds",
      ]);
      return {
        anchorClaimIds: arrayValue(record.anchorClaimIds).map(stringValue),
        asOf: stringValue(record.asOf),
        currentClaimIds: arrayValue(record.currentClaimIds).map(stringValue),
      };
    }),
  });
  if (root.corpusRevision !== gold.corpusRevision) {
    throw namedError("MemoryAspectGoldCorpusRevisionMismatch");
  }
  return gold;
}

export function evaluateMemoryAspectGraphGoldV1(
  snapshot: MemoryAspectGraphSnapshotV1,
  gold: MemoryAspectGraphGoldV1,
): MemoryAspectGraphGoldEvaluationV1 {
  if (deriveMemoryAspectCorpusRevisionV1(snapshot) !== gold.corpusRevision) {
    throw namedError("MemoryAspectGoldCorpusRevisionMismatch");
  }
  const pairOutcomes = gold.pairs.map((item) => ({
    expected: item.sameAspect,
    actual: claimsShareAspect(snapshot, item.leftClaimId, item.rightClaimId),
  }));
  const activeEdges = new Set(
    snapshot.edges
      .filter(
        (edge) =>
          !snapshot.lifecycleEvents.some(
            (event) =>
              event.targetKind === "edge" && event.targetId === edge.id,
          ),
      )
      .map((edge) => edgeKey(edge.fromClaimId, edge.toClaimId, edge.edgeType)),
  );
  const edgeOutcomes = gold.edges.map((item) => ({
    expected: item.present,
    actual: activeEdges.has(
      edgeKey(item.fromClaimId, item.toClaimId, item.edgeType),
    ),
  }));
  const currentOutcomes: Array<{ expected: boolean; actual: boolean }> = [];
  let exact = 0;
  for (const item of gold.currentStates) {
    const actual = currentClaimsForAnchors(
      snapshot,
      item.anchorClaimIds,
      item.asOf,
    );
    const expected = new Set(item.currentClaimIds);
    for (const claimId of new Set([...actual, ...expected])) {
      currentOutcomes.push({
        expected: expected.has(claimId),
        actual: actual.has(claimId),
      });
    }
    if (sameSet(actual, expected)) exact += 1;
  }
  return Object.freeze({
    schemaVersion: PAW_MEMORY_ASPECT_GRAPH_GOLD_EVAL_VERSION_V1,
    annotationSetId: gold.annotationSetId,
    corpusRevision: gold.corpusRevision,
    pairwise: classificationMetrics(pairOutcomes),
    evidenceEdges: classificationMetrics(edgeOutcomes),
    currentState: classificationMetrics(currentOutcomes),
    currentStateCaseCount: gold.currentStates.length,
    currentStateExactMatch:
      gold.currentStates.length === 0 ? 0 : exact / gold.currentStates.length,
  });
}

function claimsShareAspect(
  snapshot: MemoryAspectGraphSnapshotV1,
  leftClaimId: string,
  rightClaimId: string,
): boolean {
  const left = new Set(
    resolvedClaimStates(snapshot, leftClaimId).map(stateIdentity),
  );
  return resolvedClaimStates(snapshot, rightClaimId).some((state) =>
    left.has(stateIdentity(state)),
  );
}

interface ResolvedClaimStateV1 {
  readonly aspectId: string;
  readonly subjectKey: string;
  readonly contextKey: string;
}

function resolvedClaimStates(
  snapshot: MemoryAspectGraphSnapshotV1,
  claimId: string,
  asOf?: string,
): readonly ResolvedClaimStateV1[] {
  const result = new Map<string, ResolvedClaimStateV1>();
  const retracted = new Set(
    snapshot.lifecycleEvents
      .filter(
        (event) =>
          event.targetKind === "membership" &&
          (asOf === undefined ||
            Date.parse(event.occurredAt) <= Date.parse(asOf)),
      )
      .map((event) => event.targetId),
  );
  const aspects = new Map(
    snapshot.aspects.map((aspect) => [aspect.id, aspect]),
  );
  for (const membership of snapshot.memberships) {
    if (retracted.has(membership.id) || membership.claimId !== claimId)
      continue;
    const aspect = aspects.get(membership.aspectId);
    const effectiveAspectIds =
      aspect?.status === "redirected"
        ? resolveMemoryAspectIdsV1(snapshot, membership.aspectId)
        : [membership.aspectId];
    for (const aspectId of effectiveAspectIds) {
      const state = Object.freeze({
        aspectId,
        subjectKey: membership.subjectKey,
        contextKey: membership.contextKey,
      });
      result.set(stateIdentity(state), state);
    }
  }
  return Object.freeze(
    [...result.values()].sort((a, b) =>
      stateIdentity(a).localeCompare(stateIdentity(b)),
    ),
  );
}

function currentClaimsForAnchors(
  snapshot: MemoryAspectGraphSnapshotV1,
  anchorClaimIds: readonly string[],
  asOf: string,
): ReadonlySet<string> {
  const statesByAnchor = anchorClaimIds.map(
    (claimId) =>
      new Map(
        resolvedClaimStates(snapshot, claimId, asOf).map((state) => [
          stateIdentity(state),
          state,
        ]),
      ),
  );
  const first = statesByAnchor[0];
  if (first === undefined)
    throw namedError("MemoryAspectGoldCurrentStateAnchorMissing");
  const shared = [...first].filter(([key]) =>
    statesByAnchor.slice(1).every((states) => states.has(key)),
  );
  if (shared.length !== 1) {
    throw namedError("MemoryAspectGoldCurrentStateAnchorAmbiguous");
  }
  const state = shared[0]?.[1];
  if (state === undefined) {
    throw namedError("MemoryAspectGoldCurrentStateAnchorAmbiguous");
  }
  return new Set(
    projectMemoryAspectStateV1({
      snapshot,
      aspectId: state.aspectId,
      asOf,
      subjectKey: state.subjectKey,
      contextKey: state.contextKey,
    }).currentClaimIds,
  );
}

function stateIdentity(state: ResolvedClaimStateV1): string {
  return `${state.subjectKey}\n${state.contextKey}\n${state.aspectId}`;
}

function normalizePairs(
  pairs: readonly MemoryAspectPairGoldV1[],
  claimIds: ReadonlySet<string>,
): readonly MemoryAspectPairGoldV1[] {
  const result = new Map<string, MemoryAspectPairGoldV1>();
  for (const pair of pairs) {
    assertKnownClaim(pair.leftClaimId, claimIds);
    assertKnownClaim(pair.rightClaimId, claimIds);
    if (pair.leftClaimId === pair.rightClaimId) {
      throw namedError("MemoryAspectGoldPairSelfReference");
    }
    const [leftClaimId, rightClaimId] = [
      pair.leftClaimId,
      pair.rightClaimId,
    ].sort();
    const normalized = Object.freeze({
      leftClaimId: leftClaimId as string,
      rightClaimId: rightClaimId as string,
      sameAspect: booleanValue(pair.sameAspect),
    });
    const key = `${normalized.leftClaimId}\n${normalized.rightClaimId}`;
    const previous = result.get(key);
    if (previous && previous.sameAspect !== normalized.sameAspect) {
      throw namedError("MemoryAspectGoldPairConflict");
    }
    result.set(key, normalized);
  }
  return Object.freeze([...result.values()].sort(comparePair));
}

function normalizeEdges(
  edges: readonly MemoryEvidenceEdgeGoldV1[],
  claimIds: ReadonlySet<string>,
): readonly MemoryEvidenceEdgeGoldV1[] {
  const result = new Map<string, MemoryEvidenceEdgeGoldV1>();
  for (const edge of edges) {
    assertKnownClaim(edge.fromClaimId, claimIds);
    assertKnownClaim(edge.toClaimId, claimIds);
    if (edge.fromClaimId === edge.toClaimId) {
      throw namedError("MemoryAspectGoldEdgeSelfReference");
    }
    const normalized = Object.freeze({
      fromClaimId: edge.fromClaimId,
      toClaimId: edge.toClaimId,
      edgeType: edgeTypeValue(edge.edgeType),
      present: booleanValue(edge.present),
    });
    const key = edgeKey(
      normalized.fromClaimId,
      normalized.toClaimId,
      normalized.edgeType,
    );
    const previous = result.get(key);
    if (previous && previous.present !== normalized.present) {
      throw namedError("MemoryAspectGoldEdgeConflict");
    }
    result.set(key, normalized);
  }
  return Object.freeze([...result.values()].sort(compareEdge));
}

function normalizeCurrentStates(
  states: readonly MemoryCurrentStateGoldV1[],
  claimIds: ReadonlySet<string>,
): readonly MemoryCurrentStateGoldV1[] {
  const result = new Map<string, MemoryCurrentStateGoldV1>();
  for (const state of states) {
    const anchorClaimIds = [...new Set(state.anchorClaimIds)].sort();
    if (anchorClaimIds.length === 0) {
      throw namedError("MemoryAspectGoldCurrentStateAnchorMissing");
    }
    for (const claimId of anchorClaimIds) assertKnownClaim(claimId, claimIds);
    const currentClaimIds = [...new Set(state.currentClaimIds)].sort();
    for (const claimId of currentClaimIds) assertKnownClaim(claimId, claimIds);
    const asOf = isoTime(state.asOf);
    const normalized = Object.freeze({
      anchorClaimIds: Object.freeze(anchorClaimIds),
      asOf,
      currentClaimIds: Object.freeze(currentClaimIds),
    });
    const key = `${normalized.anchorClaimIds.join("\n")}\n${normalized.asOf}`;
    const previous = result.get(key);
    if (
      previous &&
      !sameSet(new Set(previous.currentClaimIds), new Set(currentClaimIds))
    ) {
      throw namedError("MemoryAspectGoldCurrentStateConflict");
    }
    result.set(key, normalized);
  }
  return Object.freeze([...result.values()].sort(compareCurrentState));
}

function classificationMetrics(
  outcomes: readonly { expected: boolean; actual: boolean }[],
): MemoryAspectGoldClassificationMetricsV1 {
  let truePositive = 0;
  let trueNegative = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  for (const outcome of outcomes) {
    if (outcome.expected && outcome.actual) truePositive += 1;
    else if (!outcome.expected && !outcome.actual) trueNegative += 1;
    else if (!outcome.expected && outcome.actual) falsePositive += 1;
    else falseNegative += 1;
  }
  const total = outcomes.length;
  const correct = truePositive + trueNegative;
  const precision =
    truePositive + falsePositive === 0
      ? 0
      : truePositive / (truePositive + falsePositive);
  const recall =
    truePositive + falseNegative === 0
      ? 0
      : truePositive / (truePositive + falseNegative);
  return Object.freeze({
    total,
    correct,
    truePositive,
    trueNegative,
    falsePositive,
    falseNegative,
    accuracy: total === 0 ? 0 : correct / total,
    precision,
    recall,
    f1:
      precision + recall === 0
        ? 0
        : (2 * precision * recall) / (precision + recall),
  });
}

function comparePair(
  left: MemoryAspectPairGoldV1,
  right: MemoryAspectPairGoldV1,
): number {
  return (
    left.leftClaimId.localeCompare(right.leftClaimId) ||
    left.rightClaimId.localeCompare(right.rightClaimId)
  );
}

function compareEdge(
  left: MemoryEvidenceEdgeGoldV1,
  right: MemoryEvidenceEdgeGoldV1,
): number {
  return edgeKey(left.fromClaimId, left.toClaimId, left.edgeType).localeCompare(
    edgeKey(right.fromClaimId, right.toClaimId, right.edgeType),
  );
}

function compareCurrentState(
  left: MemoryCurrentStateGoldV1,
  right: MemoryCurrentStateGoldV1,
): number {
  return (
    left.anchorClaimIds
      .join("\n")
      .localeCompare(right.anchorClaimIds.join("\n")) ||
    left.asOf.localeCompare(right.asOf)
  );
}

function edgeKey(
  fromClaimId: string,
  toClaimId: string,
  edgeType: MemoryEvidenceEdgeTypeV1,
): string {
  const [canonicalFrom, canonicalTo] =
    edgeType === "same_state" && fromClaimId.localeCompare(toClaimId) > 0
      ? [toClaimId, fromClaimId]
      : [fromClaimId, toClaimId];
  return `${edgeType}\n${canonicalFrom}\n${canonicalTo}`;
}

function assertKnownClaim(id: string, claimIds: ReadonlySet<string>): void {
  if (!claimIds.has(id)) throw namedError("MemoryAspectGoldClaimMissing");
}

function edgeTypeValue(value: unknown): MemoryEvidenceEdgeTypeV1 {
  if (
    value === "same_state" ||
    value === "supersedes" ||
    value === "contradicts" ||
    value === "supports" ||
    value === "qualifies" ||
    value === "caused_by" ||
    value === "derived_from"
  )
    return value;
  throw namedError("MemoryAspectGoldEdgeTypeInvalid");
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw namedError("MemoryAspectGoldRecordInvalid");
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (!sameSet(new Set(actual), new Set(expected)))
    throw namedError("MemoryAspectGoldRecordFieldsInvalid");
  return record;
}

function arrayValue(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw namedError("MemoryAspectGoldArrayInvalid");
  return value;
}

function stringValue(value: unknown): string {
  if (typeof value !== "string")
    throw namedError("MemoryAspectGoldStringInvalid");
  return value;
}

function booleanValue(value: unknown): boolean {
  if (typeof value !== "boolean")
    throw namedError("MemoryAspectGoldBooleanInvalid");
  return value;
}

function text(value: string, errorName: string): string {
  if (!value.trim() || value.length > 160) throw namedError(errorName);
  return value.trim().normalize("NFKC");
}

function isoTime(value: string): string {
  if (!value.trim() || !Number.isFinite(Date.parse(value)))
    throw namedError("MemoryAspectGoldTimeInvalid");
  return new Date(value).toISOString();
}

function sameSet<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): boolean {
  return left.size === right.size && [...left].every((item) => right.has(item));
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}
