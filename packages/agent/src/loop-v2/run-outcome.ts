import type {
  CandidateArtifactEvidenceV2,
  CandidateReadinessV2,
  SemanticReviewV2,
} from "./candidate-certification.js";

export interface RunOutcomeV2 {
  readonly executionStatus:
    | "completed"
    | "external_pending"
    | "incomplete"
    | "failed"
    | "aborted";
  readonly candidateStatus: "none" | "proposed" | "review_failed" | "certified";
  readonly localVerification:
    | "not_required"
    | "missing"
    | "passed"
    | "code_failed"
    | "harness_failed";
  readonly externalVerification:
    | "not_configured"
    | "pending"
    | "resolved"
    | "rejected";
  readonly artifactStatus: "none" | "valid" | "invalid";
  readonly reasonCode: string;
}

export interface DeriveRunOutcomeInputV2 {
  readonly candidateProposed: boolean;
  readonly readiness?: CandidateReadinessV2;
  readonly review?: SemanticReviewV2;
  readonly artifact?: CandidateArtifactEvidenceV2;
  readonly verificationRequired?: boolean;
  readonly externalVerification?: RunOutcomeV2["externalVerification"];
  readonly interruptedBy?: "failed" | "aborted";
  readonly interruptionReason?: string;
}

export function deriveRunOutcomeV2(
  input: DeriveRunOutcomeInputV2,
): RunOutcomeV2 {
  const externalVerification = input.externalVerification ?? "not_configured";
  const artifactStatus = deriveArtifactStatus(input);
  const localVerification = deriveLocalVerification(input);
  const candidateStatus = deriveCandidateStatus(input, artifactStatus);

  if (input.interruptedBy) {
    return {
      executionStatus: input.interruptedBy,
      candidateStatus,
      localVerification,
      externalVerification,
      artifactStatus,
      reasonCode:
        input.interruptionReason?.trim() ||
        (input.interruptedBy === "aborted" ? "user_aborted" : "runtime_failed"),
    };
  }

  if (candidateStatus !== "certified") {
    return {
      executionStatus: "incomplete",
      candidateStatus,
      localVerification,
      externalVerification,
      artifactStatus,
      reasonCode: candidateReason(input, artifactStatus),
    };
  }

  if (externalVerification === "pending") {
    return {
      executionStatus: "external_pending",
      candidateStatus,
      localVerification,
      externalVerification,
      artifactStatus,
      reasonCode: "external_verification_pending",
    };
  }

  return {
    executionStatus: "completed",
    candidateStatus,
    localVerification,
    externalVerification,
    artifactStatus,
    reasonCode:
      externalVerification === "rejected"
        ? "external_verification_rejected"
        : externalVerification === "resolved"
          ? "external_verification_resolved"
          : "candidate_certified",
  };
}

function deriveArtifactStatus(
  input: DeriveRunOutcomeInputV2,
): RunOutcomeV2["artifactStatus"] {
  if (!input.candidateProposed || !input.artifact) return "none";
  return input.artifact.reconstructible &&
    input.artifact.crossCheck !== "mismatch"
    ? "valid"
    : "invalid";
}

function deriveLocalVerification(
  input: DeriveRunOutcomeInputV2,
): RunOutcomeV2["localVerification"] {
  if (input.verificationRequired === false) return "not_required";
  return input.readiness?.localVerification ?? "missing";
}

function deriveCandidateStatus(
  input: DeriveRunOutcomeInputV2,
  artifactStatus: RunOutcomeV2["artifactStatus"],
): RunOutcomeV2["candidateStatus"] {
  if (!input.candidateProposed) return "none";
  if (!input.review) return "proposed";
  if (input.review.verdict !== "pass") return "review_failed";
  if (input.readiness?.readyForSemanticReview && artifactStatus === "valid") {
    return "certified";
  }
  return "proposed";
}

function candidateReason(
  input: DeriveRunOutcomeInputV2,
  artifactStatus: RunOutcomeV2["artifactStatus"],
): string {
  if (!input.candidateProposed) return "candidate_missing";
  if (artifactStatus === "invalid") return "artifact_invalid";
  if (!input.readiness?.readyForSemanticReview) {
    return input.readiness?.gaps[0]?.code ?? "candidate_not_ready";
  }
  if (!input.review) return "semantic_review_missing";
  if (input.review.verdict === "partial") return "semantic_review_partial";
  if (input.review.verdict === "fail") return "semantic_review_failed";
  return "candidate_not_certified";
}
