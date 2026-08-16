import {
  type MaterializedCandidateArtifactV2,
  artifactContentHashV2,
  artifactEvidenceV2,
  createArtifactContentBlobV2,
  materializeCandidateArtifactV2,
} from "./artifact-materializer.js";
import {
  type CandidateReadinessPolicyV2,
  type CandidateReadinessV2,
  evaluateCandidateReadinessV2,
} from "./candidate-certification.js";
import { canonicalJson, sha256Canonical } from "./canonical.js";
import {
  controlInputFromLoopV2EnvelopeV1,
  controlStateHashV1,
  replayControlFactsV1,
} from "./control-reducer.js";
import { decisionStateHash } from "./projector.js";
import { replayLoopV2 } from "./replay.js";
import { type RunOutcomeV2, deriveRunOutcomeV2 } from "./run-outcome.js";
import type {
  LoopV2ShadowReason,
  LoopV2ShadowReport,
} from "./shadow-runtime.js";
import { createLoopV2ShadowObserver } from "./shadow-runtime.js";

export const LOOP_V2_SHADOW_ARTIFACT_SCHEMA_VERSION = 1 as const;

export interface LoopV2ShadowAssessmentV1 {
  readonly legacyTerminal: LoopV2ShadowReport["legacyTerminal"];
  readonly coverage: LoopV2ShadowReport["coverage"] & {
    readonly projectedRatio: number;
    readonly gapsByReason: Readonly<
      Partial<Record<LoopV2ShadowReason, number>>
    >;
  };
  readonly facts: {
    readonly evidence: number;
    readonly mutations: number;
    readonly verification: number;
    readonly candidateProposed: boolean;
  };
  readonly artifact: {
    readonly status: "none" | MaterializedCandidateArtifactV2["status"];
    readonly patchHash?: string;
    readonly changedPaths: readonly string[];
    readonly errors: readonly string[];
  };
  readonly readiness?: CandidateReadinessV2;
  readonly v2Outcome: RunOutcomeV2;
  readonly comparison:
    | "legacy_completed_v2_ready_for_review"
    | "legacy_completed_v2_not_ready"
    | "legacy_completed_without_candidate"
    | "legacy_noncompleted_v2_candidate"
    | "aligned_noncompleted";
}

export interface LoopV2ShadowArtifactV1 {
  readonly schemaVersion: typeof LOOP_V2_SHADOW_ARTIFACT_SCHEMA_VERSION;
  readonly kind: "paw.loop-v2-shadow";
  readonly policy: LoopV2ShadowArtifactPolicyV1;
  readonly report: LoopV2ShadowReport;
  readonly assessment: LoopV2ShadowAssessmentV1;
  readonly artifactHash: string;
}

export interface LoopV2ShadowArtifactPolicyV1 {
  readonly requireProductMutation: boolean;
  readonly verificationAuthority: "local" | "external" | "not_required";
  readonly requiredVerificationScopes: readonly string[];
}

/** Build one self-contained, deterministic artifact suitable for JSON storage. */
export function buildLoopV2ShadowArtifactV1(
  report: LoopV2ShadowReport,
  policy: CandidateReadinessPolicyV2 = {},
): LoopV2ShadowArtifactV1 {
  assertLoopV2ShadowReportIntegrity(report);
  const normalizedPolicy = normalizePolicy(policy);
  const assessment = assessLoopV2ShadowReportV1(report, normalizedPolicy);
  const withoutHash = {
    schemaVersion: LOOP_V2_SHADOW_ARTIFACT_SCHEMA_VERSION,
    kind: "paw.loop-v2-shadow" as const,
    policy: normalizedPolicy,
    report,
    assessment,
  };
  return { ...withoutHash, artifactHash: sha256Canonical(withoutHash) };
}

export function serializeLoopV2ShadowArtifactV1(
  artifact: LoopV2ShadowArtifactV1,
): string {
  assertLoopV2ShadowArtifactV1(artifact);
  return `${canonicalJson(artifact)}\n`;
}

export function parseLoopV2ShadowArtifactV1(
  serialized: string,
): LoopV2ShadowArtifactV1 {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error("Loop v2 shadow artifact is not valid JSON");
  }
  assertLoopV2ShadowArtifactV1(value);
  return structuredClone(value);
}

/** Replay a persisted legacy event trace without invoking a model or tools. */
export function replayLegacyTraceToLoopV2ShadowV1(
  runId: string,
  trace: readonly unknown[],
): LoopV2ShadowReport {
  if (!runId.trim()) throw new Error("Loop v2 shadow replay runId is missing");
  if (trace.length === 0) {
    throw new Error("Loop v2 shadow replay trace is empty");
  }
  const observer = createLoopV2ShadowObserver(runId);
  for (const [index, raw] of trace.entries()) {
    const envelope = asRecord(raw, `trace envelope ${index}`);
    const event = asRecord(envelope.event, `trace event ${index}`);
    if (
      envelope.runId !== runId ||
      !Number.isSafeInteger(envelope.seq) ||
      typeof envelope.ts !== "number" ||
      !Number.isFinite(envelope.ts) ||
      typeof event.type !== "string" ||
      !event.type
    ) {
      throw new Error(`Loop v2 shadow trace envelope ${index} is invalid`);
    }
    observer.observe({
      runId,
      seq: envelope.seq as number,
      ts: envelope.ts,
      event: event as { readonly type: string },
    });
  }
  return observer.snapshot();
}

export function assessLoopV2ShadowReportV1(
  report: LoopV2ShadowReport,
  policy: CandidateReadinessPolicyV2 = {},
): LoopV2ShadowAssessmentV1 {
  const candidateProposed = report.state.currentCandidate !== undefined;
  const mutations = Object.values(report.state.mutations);
  const materialized = candidateProposed
    ? materializeCandidateArtifactV2(mutations, report.artifactBlobs, {
        status: "unavailable",
        detail: "shadow artifact uses the mutation journal as primary evidence",
      })
    : undefined;
  const artifactEvidence = materialized
    ? artifactEvidenceV2(materialized)
    : undefined;
  const readiness =
    candidateProposed && artifactEvidence
      ? evaluateCandidateReadinessV2(report.state, artifactEvidence, policy)
      : undefined;
  const terminalStatus = report.legacyTerminal?.status;
  const interruptedBy =
    terminalStatus === "failed" || terminalStatus === "aborted"
      ? terminalStatus
      : undefined;
  const v2Outcome = deriveRunOutcomeV2({
    candidateProposed,
    ...(readiness ? { readiness } : {}),
    ...(artifactEvidence ? { artifact: artifactEvidence } : {}),
    verificationRequired: !(
      policy.verificationAuthority === "not_required" ||
      policy.requireAuthoritativeVerification === false
    ),
    ...(interruptedBy
      ? {
          interruptedBy,
          interruptionReason: `legacy_${interruptedBy}`,
        }
      : {}),
  });
  const gapsByReason: Partial<Record<LoopV2ShadowReason, number>> = {};
  for (const diagnostic of report.diagnostics) {
    if (diagnostic.disposition !== "gap") continue;
    gapsByReason[diagnostic.reason] =
      (gapsByReason[diagnostic.reason] ?? 0) + 1;
  }
  const sortedGaps = Object.fromEntries(
    Object.entries(gapsByReason).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  ) as Partial<Record<LoopV2ShadowReason, number>>;
  return {
    legacyTerminal: report.legacyTerminal,
    coverage: {
      ...report.coverage,
      projectedRatio:
        report.coverage.observed === 0
          ? 0
          : report.coverage.projected / report.coverage.observed,
      gapsByReason: sortedGaps,
    },
    facts: {
      evidence: Object.keys(report.state.evidence).length,
      mutations: mutations.length,
      verification: Object.keys(report.state.verification).length,
      candidateProposed,
    },
    artifact: materialized
      ? {
          status: materialized.status,
          patchHash: materialized.patchHash,
          changedPaths: materialized.changedPaths,
          errors: materialized.errors,
        }
      : { status: "none", changedPaths: [], errors: [] },
    ...(readiness ? { readiness } : {}),
    v2Outcome,
    comparison: compareTerminal(report, readiness, candidateProposed),
  };
}

export function assertLoopV2ShadowArtifactV1(
  value: unknown,
): asserts value is LoopV2ShadowArtifactV1 {
  const record = asRecord(value, "artifact");
  if (record.schemaVersion !== LOOP_V2_SHADOW_ARTIFACT_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported loop v2 shadow artifact schema: ${String(record.schemaVersion)}`,
    );
  }
  if (record.kind !== "paw.loop-v2-shadow") {
    throw new Error("Invalid loop v2 shadow artifact kind");
  }
  const report = record.report as LoopV2ShadowReport;
  assertLoopV2ShadowReportIntegrity(report);
  const policy = asRecord(record.policy, "artifact policy");
  const expected = buildLoopV2ShadowArtifactV1(
    report,
    policy as unknown as CandidateReadinessPolicyV2,
  );
  if (canonicalJson(record.assessment) !== canonicalJson(expected.assessment)) {
    throw new Error("Loop v2 shadow assessment does not match its report");
  }
  if (record.artifactHash !== expected.artifactHash) {
    throw new Error("Loop v2 shadow artifact hash mismatch");
  }
}

function normalizePolicy(
  policy: CandidateReadinessPolicyV2,
): LoopV2ShadowArtifactPolicyV1 {
  if (
    policy.requireProductMutation !== undefined &&
    typeof policy.requireProductMutation !== "boolean"
  ) {
    throw new Error("Loop v2 shadow requireProductMutation must be boolean");
  }
  if (
    policy.verificationAuthority !== undefined &&
    policy.verificationAuthority !== "local" &&
    policy.verificationAuthority !== "external" &&
    policy.verificationAuthority !== "not_required"
  ) {
    throw new Error("Loop v2 shadow verificationAuthority is invalid");
  }
  if (
    policy.requiredVerificationScopes !== undefined &&
    (!Array.isArray(policy.requiredVerificationScopes) ||
      policy.requiredVerificationScopes.some(
        (scope) => typeof scope !== "string",
      ))
  ) {
    throw new Error(
      "Loop v2 shadow requiredVerificationScopes must be strings",
    );
  }
  const requireProductMutation = policy.requireProductMutation ?? true;
  const verificationAuthority =
    policy.verificationAuthority ??
    (policy.requireAuthoritativeVerification === false ||
    !requireProductMutation
      ? "not_required"
      : "local");
  return {
    requireProductMutation,
    verificationAuthority,
    requiredVerificationScopes: [
      ...new Set(
        (policy.requiredVerificationScopes ?? [])
          .map((scope) => scope.trim())
          .filter(Boolean),
      ),
    ].sort(),
  };
}

export function assertLoopV2ShadowReportIntegrity(
  report: LoopV2ShadowReport,
): void {
  const record = asRecord(report, "report");
  if (typeof record.runId !== "string" || !record.runId.trim()) {
    throw new Error("Loop v2 shadow report runId is missing");
  }
  if (!Array.isArray(record.projectedEvents)) {
    throw new Error("Loop v2 shadow projectedEvents must be an array");
  }
  const replay = replayLoopV2(record.runId, report.projectedEvents);
  if (canonicalJson(replay.state) !== canonicalJson(report.state)) {
    throw new Error("Loop v2 shadow projected state mismatch");
  }
  if (decisionStateHash(report.state) !== report.stateHash) {
    throw new Error("Loop v2 shadow state hash mismatch");
  }
  if (
    (report.controlState === undefined) !==
    (report.controlStateHash === undefined)
  ) {
    throw new Error("Loop v2 shadow control state is incomplete");
  }
  if (report.controlState && report.controlStateHash) {
    const inputs = report.projectedEvents.flatMap((event) => {
      const input = controlInputFromLoopV2EnvelopeV1(event);
      return input ? [input] : [];
    });
    const controlReplay = replayControlFactsV1(record.runId, inputs);
    if (
      canonicalJson(controlReplay.state) !== canonicalJson(report.controlState)
    ) {
      throw new Error("Loop v2 shadow control state mismatch");
    }
    if (controlStateHashV1(report.controlState) !== report.controlStateHash) {
      throw new Error("Loop v2 shadow control state hash mismatch");
    }
  }
  if (!Array.isArray(report.artifactBlobs)) {
    throw new Error("Loop v2 shadow artifactBlobs must be an array");
  }
  const refs = new Set<string>();
  for (const blob of report.artifactBlobs) {
    const expectedBlob =
      blob && typeof blob.content === "string"
        ? createArtifactContentBlobV2(blob.content)
        : undefined;
    if (
      !blob ||
      typeof blob.ref !== "string" ||
      typeof blob.content !== "string" ||
      typeof blob.contentHash !== "string" ||
      refs.has(blob.ref) ||
      artifactContentHashV2(blob.content) !== blob.contentHash ||
      expectedBlob?.ref !== blob.ref
    ) {
      throw new Error("Loop v2 shadow artifact blob integrity mismatch");
    }
    refs.add(blob.ref);
  }
  for (const ref of referencedContentArtifacts(report)) {
    if (!refs.has(ref)) {
      throw new Error(`Loop v2 shadow content artifact ref is missing: ${ref}`);
    }
  }
  if (!Array.isArray(report.diagnostics)) {
    throw new Error("Loop v2 shadow diagnostics must be an array");
  }
  const counts = {
    observed: report.diagnostics.length,
    projected: report.diagnostics.filter(
      (diagnostic) => diagnostic.disposition === "projected",
    ).length,
    gaps: report.diagnostics.filter(
      (diagnostic) => diagnostic.disposition === "gap",
    ).length,
    ignored: report.diagnostics.filter(
      (diagnostic) => diagnostic.disposition === "ignored",
    ).length,
  };
  let priorSourceSeq = 0;
  for (const diagnostic of report.diagnostics) {
    if (
      !Number.isSafeInteger(diagnostic.sourceSeq) ||
      diagnostic.sourceSeq <= priorSourceSeq ||
      diagnostic.sourceSeq > report.sourceThroughSeq
    ) {
      throw new Error("Loop v2 shadow diagnostic source sequence is invalid");
    }
    priorSourceSeq = diagnostic.sourceSeq;
  }
  if (
    !Number.isSafeInteger(report.sourceThroughSeq) ||
    report.sourceThroughSeq < 0 ||
    (report.legacyTerminal !== undefined &&
      (report.legacyTerminal.sourceSeq > report.sourceThroughSeq ||
        report.legacyTerminal.sourceSeq < 1))
  ) {
    throw new Error("Loop v2 shadow source boundary is invalid");
  }
  if (canonicalJson(counts) !== canonicalJson(report.coverage)) {
    throw new Error("Loop v2 shadow coverage does not match diagnostics");
  }
  const { reportHash: _reportHash, ...withoutHash } = report;
  if (sha256Canonical(withoutHash) !== report.reportHash) {
    throw new Error("Loop v2 shadow report hash mismatch");
  }
}

function referencedContentArtifacts(
  report: LoopV2ShadowReport,
): readonly string[] {
  const refs: string[] = [];
  for (const evidence of Object.values(report.state.evidence)) {
    const ref = evidence.observation.artifactRef;
    if (ref) refs.push(ref);
  }
  for (const verification of Object.values(report.state.verification)) {
    refs.push(verification.outputArtifactRef);
  }
  for (const mutation of Object.values(report.state.mutations)) {
    for (const ref of Object.values(mutation.beforeContentRefs)) {
      if (ref) refs.push(ref);
    }
    for (const ref of Object.values(mutation.afterContentRefs)) {
      if (ref) refs.push(ref);
    }
  }
  return refs;
}

function compareTerminal(
  report: LoopV2ShadowReport,
  readiness: CandidateReadinessV2 | undefined,
  candidateProposed: boolean,
): LoopV2ShadowAssessmentV1["comparison"] {
  const legacyCompleted = report.legacyTerminal?.status === "completed";
  if (legacyCompleted && readiness?.readyForSemanticReview) {
    return "legacy_completed_v2_ready_for_review";
  }
  if (legacyCompleted && candidateProposed) {
    return "legacy_completed_v2_not_ready";
  }
  if (legacyCompleted) return "legacy_completed_without_candidate";
  if (candidateProposed) return "legacy_noncompleted_v2_candidate";
  return "aligned_noncompleted";
}

function asRecord(
  value: unknown,
  label: string,
): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Loop v2 shadow ${label} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}
