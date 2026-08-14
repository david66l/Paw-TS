import type { MaterializedCandidateArtifactV2 } from "./artifact-materializer.js";
import type {
  CandidateReadinessPolicyV2,
  CandidateReadinessV2,
  CandidateReviewPayloadV2,
} from "./candidate-certification.js";
import { buildCandidateReviewPayloadV2 } from "./candidate-certification.js";
import { materializeTerminalCandidateSnapshotsV2 } from "./candidate-snapshots.js";
import { sha256Canonical } from "./canonical.js";
import {
  type LoopV2ShadowArtifactPolicyV1,
  buildLoopV2ShadowArtifactV1,
} from "./shadow-artifact.js";
import type { LoopV2ShadowReport } from "./shadow-runtime.js";

export const LOOP_V2_LIVE_CANDIDATE_SCHEMA_VERSION = 1 as const;

/**
 * Strict derived view of one live candidate. The implementing model's final
 * prose is intentionally absent; identity comes only from projected facts.
 */
export interface LoopV2LiveCandidateAssessmentV1 {
  readonly schemaVersion: typeof LOOP_V2_LIVE_CANDIDATE_SCHEMA_VERSION;
  readonly kind: "paw.loop-v2-live-candidate";
  readonly candidateId: string;
  readonly candidateInputHash: string;
  readonly mutationRevision: number;
  readonly proposedAtSeq: number;
  readonly reportHash: string;
  readonly stateHash: string;
  readonly policy: LoopV2ShadowArtifactPolicyV1;
  readonly facts: {
    readonly evidence: number;
    readonly mutations: number;
    readonly verification: number;
  };
  readonly artifact: {
    readonly status: "none" | MaterializedCandidateArtifactV2["status"];
    readonly patchHash?: string;
    readonly changedPaths: readonly string[];
    readonly errors: readonly string[];
  };
  readonly readiness: CandidateReadinessV2;
  readonly assessmentHash: string;
}

export function assessLoopV2LiveCandidateV1(
  report: LoopV2ShadowReport,
  policy: CandidateReadinessPolicyV2 = {},
): LoopV2LiveCandidateAssessmentV1 {
  const candidate = report.state.currentCandidate;
  if (!candidate) {
    throw new Error("Loop v2 live assessment requires candidate.proposed");
  }
  // The existing strict artifact builder replays the projected state, checks
  // all blob/report hashes, materializes the journal, and recomputes readiness.
  const checked = buildLoopV2ShadowArtifactV1(report, policy);
  const readiness = checked.assessment.readiness;
  if (!readiness) {
    throw new Error("Loop v2 live candidate readiness is missing");
  }
  const withoutHash = {
    schemaVersion: LOOP_V2_LIVE_CANDIDATE_SCHEMA_VERSION,
    kind: "paw.loop-v2-live-candidate" as const,
    candidateId: candidate.id,
    candidateInputHash: candidate.candidateInputHash,
    mutationRevision: candidate.mutationRevision,
    proposedAtSeq: candidate.proposedAtSeq,
    reportHash: report.reportHash,
    stateHash: report.stateHash,
    policy: checked.policy,
    facts: {
      evidence: checked.assessment.facts.evidence,
      mutations: checked.assessment.facts.mutations,
      verification: checked.assessment.facts.verification,
    },
    artifact: checked.assessment.artifact,
    readiness,
  };
  return {
    ...withoutHash,
    assessmentHash: sha256Canonical(withoutHash),
  };
}

/** Strict reviewer payload whose identity must equal the persisted candidate. */
export function buildLoopV2LiveReviewPayloadV1(
  report: LoopV2ShadowReport,
): CandidateReviewPayloadV2 {
  buildLoopV2ShadowArtifactV1(report);
  const candidate = report.state.currentCandidate;
  if (!candidate) {
    throw new Error("Loop v2 live review payload requires candidate.proposed");
  }
  const payload = buildCandidateReviewPayloadV2(
    report.state,
    materializeTerminalCandidateSnapshotsV2(report.state, report.artifactBlobs),
  );
  if (
    payload.candidateInputHash !== candidate.candidateInputHash ||
    payload.input.mutationRevision !== candidate.mutationRevision
  ) {
    throw new Error(
      `Loop v2 live review payload identity mismatch: ${payload.candidateInputHash} != ${candidate.candidateInputHash}`,
    );
  }
  return payload;
}
