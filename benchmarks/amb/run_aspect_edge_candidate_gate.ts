import { createHash } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

import {
  type MemoryAspectEdgeLinkingInputV1,
  type MemoryAspectGraphSnapshotV1,
  type MemoryEvidenceEdgeGoldV1,
  type MemoryFacetShadowSnapshotV2,
  type PawNextMemoryScopeV1,
  applyMemoryAspectGraphMutationV1,
  buildMemoryAspectEdgeCandidatesV1,
  createMemoryAspectGraphGoldV1,
  createMemoryEvidenceEdgeV1,
  deriveMemoryAspectLinkStatementHashV1,
  evaluateMemoryAspectEdgeAdmissionV1,
  evaluateMemoryAspectGraphGoldV1,
  measureMemoryAspectGraphV1,
  memoryEntryToFacetObservationV2,
  parseMemoryAspectGraphGoldV1,
  projectMemoryAspectStateLineageV1,
} from "@paw/memory-plugin";
import type { MemoryEntry } from "@paw/memory/longterm";

const sourcePath = resolve(
  process.env.PAW_AMB_ASPECT_EDGE_SOURCE ??
    "benchmarks/amb/runs/aspect-linker-malia-recovered-v6.json",
);
const facetReportPath = resolve(
  process.env.PAW_AMB_ASPECT_FACET_REPORT ??
    "benchmarks/amb/runs/facet-shadow-malia-full-v5.json",
);
const goldPath = resolve(
  process.env.PAW_AMB_ASPECT_GOLD ??
    "benchmarks/amb/gold/aspect-graph/malia-structure-v1.json",
);
const outputPath = resolve(
  process.env.PAW_AMB_ASPECT_EDGE_CANDIDATE_OUTPUT ??
    "benchmarks/amb/runs/aspect-edge-candidate-malia-v1.json",
);
const logPath = resolve(
  process.env.PAW_AMB_ASPECT_EDGE_CANDIDATE_LOG ??
    "logs/amb/aspect-edge-candidate-malia-v1.jsonl",
);
const maxTargetsPerPacket = boundedInteger(
  process.env.PAW_AMB_ASPECT_EDGE_MAX_TARGETS,
  5,
  1,
  12,
);

mkdirSync(dirname(outputPath), { recursive: true });
mkdirSync(dirname(logPath), { recursive: true });
await main();

async function main(): Promise<void> {
  const startedAt = Date.now();
  const sourceReport = objectValue(readJson(sourcePath));
  const snapshot = sourceReport.snapshot as MemoryAspectGraphSnapshotV1;
  measureMemoryAspectGraphV1(snapshot);
  const facetReport = objectValue(readJson(facetReportPath));
  const facetSnapshot = facetReport.snapshot as MemoryFacetShadowSnapshotV2;
  const facetScope = objectValue(facetReport.scope);
  const userId = required(
    process.env.PAW_AMB_ASPECT_USER_ID,
    "PAW_AMB_ASPECT_USER_ID",
  );
  if (shortHash(userId) !== stringValue(facetScope.userIdHash)) {
    throw namedError("AspectEdgeCandidateUserScopeMismatch");
  }
  const scope: PawNextMemoryScopeV1 = Object.freeze({
    tenantId: stringValue(facetScope.tenantId),
    userId,
    workspaceId: stringValue(facetScope.workspaceId),
    repositoryId: stringValue(facetScope.repositoryId),
  });
  const catalog = facetSnapshot.entries
    .map((entry) => memoryEntryToFacetObservationV2(entry as MemoryEntry))
    .map((observation) =>
      Object.freeze({
        claimId: observation.id,
        statement: observation.statement,
        statementHash: deriveMemoryAspectLinkStatementHashV1(
          observation.statement,
        ),
      }),
    );
  const observedAt = latestGraphTime(snapshot);
  const build = buildMemoryAspectEdgeCandidatesV1({
    scope,
    snapshot,
    observedAt,
    catalog,
    maxTargetsPerPacket,
  });
  const gold = parseMemoryAspectGraphGoldV1(readJson(goldPath), snapshot);
  const positiveGold = gold.edges.filter((edge) => edge.present);
  const negativeGold = gold.edges.filter((edge) => !edge.present);
  const structurallyEligible = positiveGold.filter(
    (edge) => structuralBlockReason(snapshot, edge, observedAt) === null,
  );
  const candidateMatched = structurallyEligible.flatMap((edge) => {
    const packet = matchingPacket(build.packets, edge);
    return packet === undefined ? [] : [{ edge, packet }];
  });
  const eligibleCandidateRecall = ratio(
    candidateMatched.length,
    structurallyEligible.length,
  );
  const fullGoldCandidateCoverage = ratio(
    candidateMatched.length,
    positiveGold.length,
  );
  const eligibleGoldTargetRanks = candidateMatched.map(
    ({ edge, packet }) =>
      1 +
      packet.targets.findIndex((target) =>
        target.allowedProposals.some(
          (proposal) =>
            proposal.edgeType === edge.edgeType &&
            ((proposal.fromClaimId === edge.fromClaimId &&
              proposal.toClaimId === edge.toClaimId) ||
              (edge.edgeType === "same_state" &&
                proposal.fromClaimId === edge.toClaimId &&
                proposal.toClaimId === edge.fromClaimId)),
        ),
      ),
  );
  const negativeExposureCount = negativeGold.filter(
    (edge) => matchingPairPacket(build.packets, edge) !== undefined,
  ).length;
  const claims = new Map(snapshot.claims.map((claim) => [claim.id, claim]));
  const oracleEdges = candidateMatched.map(({ edge, packet }) => {
    const from = requiredValue(claims, edge.fromClaimId);
    const to = requiredValue(claims, edge.toClaimId);
    return createMemoryEvidenceEdgeV1({
      scope,
      fromClaimId: edge.fromClaimId,
      toClaimId: edge.toClaimId,
      edgeType: edge.edgeType,
      stateScope: {
        subjectKey: packet.subjectKey,
        aspectId: packet.aspectId,
        contextKey: packet.contextKey,
      },
      confidence: 1,
      evidenceRefs: [
        ...new Set([...from.evidenceRefs, ...to.evidenceRefs]),
      ].sort(),
      effectiveFrom: latestIso(observedAt, from.validFrom, to.validFrom),
      createdAt: observedAt,
    });
  });
  const oracleAdmission = evaluateMemoryAspectEdgeAdmissionV1({
    snapshot,
    edges: oracleEdges,
    catalog,
  });
  const admittedOracleEdgeIds = new Set(oracleAdmission.admittedEdgeIds);
  const admittedOracleEdges = oracleEdges.filter((edge) =>
    admittedOracleEdgeIds.has(edge.id),
  );
  const oracleSnapshot = applyMemoryAspectGraphMutationV1({
    snapshot,
    expectedRevision: snapshot.revision,
    edges: admittedOracleEdges,
  });
  const relationGold = createMemoryAspectGraphGoldV1({
    snapshot: oracleSnapshot,
    annotationSetId: `${gold.annotationSetId}:edge-oracle`,
    pairs: gold.pairs,
    edges: gold.edges,
  });
  const relationEvaluation = evaluateMemoryAspectGraphGoldV1(
    oracleSnapshot,
    relationGold,
  );
  const lineageCurrent = evaluateLineageCurrent(
    oracleSnapshot,
    gold.currentStates,
  );
  const blockedPositiveEdges = positiveGold
    .filter(
      (edge) => structuralBlockReason(snapshot, edge, observedAt) !== null,
    )
    .map((edge) => ({
      fromClaimId: edge.fromClaimId,
      toClaimId: edge.toClaimId,
      edgeType: edge.edgeType,
      reasonCode: structuralBlockReason(snapshot, edge, observedAt),
    }));
  const output = Object.freeze({
    schemaVersion: "paw.amb-aspect-edge-candidate-gate-report.v1",
    diagnosticOnly: true,
    persistenceWrites: false,
    sourceArm: "aspect-linker-recovered-v6-edge-candidate-oracle",
    sourceReportHash: fileHash(sourcePath),
    facetReportHash: fileHash(facetReportPath),
    goldFileHash: fileHash(goldPath),
    annotationSetId: gold.annotationSetId,
    graphRevision: snapshot.revision,
    candidateRevision: build.candidateRevision,
    observedAt,
    maxTargetsPerPacket,
    metrics: build.metrics,
    positiveGoldCount: positiveGold.length,
    structurallyEligiblePositiveCount: structurallyEligible.length,
    candidateMatchedPositiveCount: candidateMatched.length,
    blockedPositiveCount: blockedPositiveEdges.length,
    eligibleCandidateRecall,
    fullGoldCandidateCoverage,
    eligibleGoldTargetRanks,
    maxEligibleGoldTargetRank: Math.max(0, ...eligibleGoldTargetRanks),
    negativeGoldCount: negativeGold.length,
    negativeExposureCount,
    negativeExposure: ratio(negativeExposureCount, negativeGold.length),
    blockedPositiveEdges,
    oracle: {
      proposedEdgeCount: oracleEdges.length,
      admittedEdgeCount: admittedOracleEdges.length,
      admissionReasonCounts: countReasons(oracleAdmission.decisions),
      pairwise: relationEvaluation.pairwise,
      evidenceEdges: relationEvaluation.evidenceEdges,
      lineageCurrent,
    },
    durationMs: Math.max(0, Date.now() - startedAt),
  });
  atomicWriteJson(outputPath, output);
  log("run_completed", {
    schemaVersion: "paw.amb-aspect-edge-candidate-gate-event.v1",
    sourceGraphRevision: snapshot.revision,
    candidateRevision: build.candidateRevision,
    packetCount: build.metrics.packetCount,
    targetCount: build.metrics.targetCount,
    positiveGoldCount: positiveGold.length,
    structurallyEligiblePositiveCount: structurallyEligible.length,
    candidateMatchedPositiveCount: candidateMatched.length,
    blockedPositiveCount: blockedPositiveEdges.length,
    negativeGoldCount: negativeGold.length,
    negativeExposureCount,
    edgeAccuracy: relationEvaluation.evidenceEdges.accuracy,
    lineageCurrentExactMatch: lineageCurrent.exactMatch,
    lineageCurrentAmbiguousCaseCount: lineageCurrent.ambiguousCaseCount,
    outputPathHash: shortHash(outputPath),
    durationMs: output.durationMs,
  });
}

function matchingPacket(
  packets: readonly MemoryAspectEdgeLinkingInputV1[],
  edge: MemoryEvidenceEdgeGoldV1,
): MemoryAspectEdgeLinkingInputV1 | undefined {
  return packets.find((packet) =>
    packet.targets.some((target) =>
      target.allowedProposals.some(
        (proposal) =>
          proposal.edgeType === edge.edgeType &&
          ((proposal.fromClaimId === edge.fromClaimId &&
            proposal.toClaimId === edge.toClaimId) ||
            (edge.edgeType === "same_state" &&
              proposal.fromClaimId === edge.toClaimId &&
              proposal.toClaimId === edge.fromClaimId)),
      ),
    ),
  );
}

function matchingPairPacket(
  packets: readonly MemoryAspectEdgeLinkingInputV1[],
  edge: MemoryEvidenceEdgeGoldV1,
): MemoryAspectEdgeLinkingInputV1 | undefined {
  return packets.find(
    (packet) =>
      (packet.source.claimId === edge.fromClaimId &&
        packet.targets.some((target) => target.claimId === edge.toClaimId)) ||
      (packet.source.claimId === edge.toClaimId &&
        packet.targets.some((target) => target.claimId === edge.fromClaimId)),
  );
}

function structuralBlockReason(
  snapshot: MemoryAspectGraphSnapshotV1,
  edge: MemoryEvidenceEdgeGoldV1,
  asOf: string,
): string | null {
  const retracted = new Set(
    snapshot.lifecycleEvents
      .filter(
        (event) =>
          event.targetKind === "membership" &&
          Date.parse(event.occurredAt) <= Date.parse(asOf),
      )
      .map((event) => event.targetId),
  );
  const activeAspects = new Set(
    snapshot.aspects
      .filter((aspect) => aspect.status === "active")
      .map((aspect) => aspect.id),
  );
  const memberships = snapshot.memberships.filter(
    (membership) =>
      !retracted.has(membership.id) &&
      activeAspects.has(membership.aspectId) &&
      Date.parse(membership.createdAt) <= Date.parse(asOf),
  );
  const from = memberships.filter(
    (membership) => membership.claimId === edge.fromClaimId,
  );
  const to = memberships.filter(
    (membership) => membership.claimId === edge.toClaimId,
  );
  if (from.length === 0 || to.length === 0) return "missing_membership";
  const scopes = new Set(
    from.map(
      (membership) =>
        `${membership.subjectKey}\n${membership.aspectId}\n${membership.contextKey}`,
    ),
  );
  if (
    !to.some((membership) =>
      scopes.has(
        `${membership.subjectKey}\n${membership.aspectId}\n${membership.contextKey}`,
      ),
    )
  ) {
    return "split_aspect";
  }
  const fromRoles = new Set(from.map((membership) => membership.role));
  const toRoles = new Set(to.map((membership) => membership.role));
  if (
    edge.edgeType !== "supports" &&
    (!hasStateRole(fromRoles) || !hasStateRole(toRoles))
  ) {
    return "role_incompatible";
  }
  return null;
}

function hasStateRole(roles: ReadonlySet<string>): boolean {
  return roles.has("state") || roles.has("fact");
}

function evaluateLineageCurrent(
  snapshot: MemoryAspectGraphSnapshotV1,
  currentStates: readonly Readonly<{
    anchorClaimIds: readonly string[];
    asOf: string;
    currentClaimIds: readonly string[];
  }>[],
) {
  let exactCount = 0;
  let ambiguousCaseCount = 0;
  const cases = currentStates.map((item) => {
    try {
      const projection = projectMemoryAspectStateLineageV1({
        snapshot,
        anchorClaimIds: item.anchorClaimIds,
        asOf: new Date(item.asOf).toISOString(),
      });
      const actual = [...projection.currentClaimIds].sort();
      const expected = [...item.currentClaimIds].sort();
      const exact = sameStrings(actual, expected);
      if (exact) exactCount += 1;
      return { status: "evaluated" as const, exact, actual, expected };
    } catch (error) {
      ambiguousCaseCount += 1;
      return {
        status: "ambiguous" as const,
        exact: false,
        reasonCode: stableReason(error),
      };
    }
  });
  return Object.freeze({
    caseCount: currentStates.length,
    evaluatedCaseCount: currentStates.length - ambiguousCaseCount,
    ambiguousCaseCount,
    exactCount,
    exactMatch: ratio(exactCount, currentStates.length),
    cases,
  });
}

function countReasons(
  decisions: readonly Readonly<{ reasonCode: string }>[],
): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const decision of decisions) {
    counts[decision.reasonCode] = (counts[decision.reasonCode] ?? 0) + 1;
  }
  return Object.freeze(counts);
}

function latestGraphTime(snapshot: MemoryAspectGraphSnapshotV1): string {
  const values = [
    ...snapshot.claims.flatMap((claim) => [claim.validFrom, claim.ingestedAt]),
    ...snapshot.memberships.map((membership) => membership.createdAt),
  ];
  return new Date(
    Math.max(...values.map((value) => Date.parse(value))),
  ).toISOString();
}

function latestIso(...values: readonly string[]): string {
  return new Date(
    Math.max(...values.map((value) => Date.parse(value))),
  ).toISOString();
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function requiredValue<T>(map: ReadonlyMap<string, T>, id: string): T {
  const value = map.get(id);
  if (value === undefined) throw namedError("AspectEdgeCandidateClaimMissing");
  return value;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function atomicWriteJson(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}

function log(event: string, detail: Readonly<Record<string, unknown>>): void {
  appendFileSync(
    logPath,
    `${JSON.stringify({ at: new Date().toISOString(), event, detail })}\n`,
    "utf8",
  );
}

function fileHash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function objectValue(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw namedError("AspectEdgeCandidateObjectInvalid");
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw namedError("AspectEdgeCandidateStringInvalid");
  }
  return value;
}

function required(value: string | undefined, name: string): string {
  if (value === undefined || !value.trim()) throw namedError(`${name}Missing`);
  return value.trim();
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw namedError("AspectEdgeCandidateIntegerInvalid");
  }
  return parsed;
}

function stableReason(error: unknown): string {
  return error instanceof Error && error.name
    ? error.name
    : "AspectEdgeCandidateUnknownFailure";
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}
