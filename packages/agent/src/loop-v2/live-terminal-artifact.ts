import path from "node:path";

import type { CompletionOutcome } from "@paw/core";

import type { CandidateArtifactEvidenceV2 } from "./candidate-certification.js";
import { canonicalJson, sha256Canonical } from "./canonical.js";
import {
  type LoopV2LiveCandidateArtifactV1,
  assertLoopV2LiveCandidateArtifactV1,
} from "./live-artifact.js";
import {
  type LoopV2LiveReviewArtifactV1,
  assertLoopV2LiveReviewArtifactV1,
} from "./live-review-artifact.js";
import { type RunOutcomeV2, deriveRunOutcomeV2 } from "./run-outcome.js";

export const LOOP_V2_LIVE_TERMINAL_ARTIFACT_SCHEMA_VERSION = 1 as const;

export interface LoopV2LegacyTerminalV1 {
  readonly status: "completed" | "incomplete" | "failed" | "aborted";
  readonly outcome?: CompletionOutcome;
  readonly reasonCode?: string;
}

export type LoopV2TerminalComparisonV1 =
  | "equal"
  | "legacy_completed_v2_external_pending"
  | "legacy_more_permissive"
  | "v2_more_permissive"
  | "different_noncompletion";

/** Durable dual calculation. It is diagnostic until the explicit cutover. */
export interface LoopV2LiveTerminalArtifactV1 {
  readonly schemaVersion: typeof LOOP_V2_LIVE_TERMINAL_ARTIFACT_SCHEMA_VERSION;
  readonly kind: "paw.loop-v2-live-terminal-artifact";
  readonly runId: string;
  readonly candidateArtifactHash?: string;
  readonly reviewArtifactHash?: string;
  readonly legacyTerminal: LoopV2LegacyTerminalV1;
  readonly v2Outcome: RunOutcomeV2;
  readonly comparison: LoopV2TerminalComparisonV1;
  readonly artifactHash: string;
}

export interface BuildLoopV2LiveTerminalArtifactInputV1 {
  readonly runId: string;
  readonly legacyTerminal: LoopV2LegacyTerminalV1;
  readonly candidate?: LoopV2LiveCandidateArtifactV1;
  readonly review?: LoopV2LiveReviewArtifactV1;
}

export function loopV2LiveTerminalArtifactPath(
  workspaceRoot: string,
  runId: string,
): string {
  if (!workspaceRoot.trim() || !runId.trim()) {
    throw new Error(
      "Loop v2 live terminal artifact path requires workspace and runId",
    );
  }
  return path.join(
    path.resolve(workspaceRoot),
    ".paw",
    "loop-v2",
    "runs",
    sha256Canonical({ runId }),
    "terminal-v1.json",
  );
}

export function buildLoopV2LiveTerminalArtifactV1(
  input: BuildLoopV2LiveTerminalArtifactInputV1,
): LoopV2LiveTerminalArtifactV1 {
  const runId = input.runId.trim();
  if (!runId) throw new Error("Loop v2 live terminal runId is missing");
  const candidate = input.candidate;
  const review = input.review;
  if (candidate) {
    assertLoopV2LiveCandidateArtifactV1(candidate);
    if (candidate.report.runId !== runId) {
      throw new Error("Loop v2 live terminal candidate runId mismatch");
    }
  }
  if (review) {
    if (!candidate) {
      throw new Error("Loop v2 live terminal review requires a candidate");
    }
    assertLoopV2LiveReviewArtifactV1(review, candidate);
  }

  const legacyTerminal = normalizeLegacyTerminal(input.legacyTerminal);
  const interruptedBy =
    legacyTerminal.status === "completed" ? undefined : legacyTerminal.status;
  const artifact = candidateArtifactEvidence(candidate);
  const v2Outcome = deriveRunOutcomeV2({
    candidateProposed: candidate !== undefined,
    ...(candidate
      ? {
          readiness: candidate.assessment.readiness,
          verificationRequired:
            candidate.policy.verificationAuthority !== "not_required",
          externalVerification:
            candidate.policy.verificationAuthority === "external"
              ? ("pending" as const)
              : ("not_configured" as const),
        }
      : {}),
    ...(review ? { review: review.record.review } : {}),
    ...(artifact ? { artifact } : {}),
    ...(interruptedBy
      ? {
          interruptedBy,
          ...(legacyTerminal.reasonCode
            ? { interruptionReason: legacyTerminal.reasonCode }
            : {}),
        }
      : {}),
  });
  const withoutHash = {
    schemaVersion: LOOP_V2_LIVE_TERMINAL_ARTIFACT_SCHEMA_VERSION,
    kind: "paw.loop-v2-live-terminal-artifact" as const,
    runId,
    ...(candidate ? { candidateArtifactHash: candidate.artifactHash } : {}),
    ...(review ? { reviewArtifactHash: review.artifactHash } : {}),
    legacyTerminal,
    v2Outcome,
    comparison: compareLoopV2TerminalV1(legacyTerminal, v2Outcome),
  };
  return { ...withoutHash, artifactHash: sha256Canonical(withoutHash) };
}

export function serializeLoopV2LiveTerminalArtifactV1(
  artifact: LoopV2LiveTerminalArtifactV1,
  candidate?: LoopV2LiveCandidateArtifactV1,
  review?: LoopV2LiveReviewArtifactV1,
): string {
  assertLoopV2LiveTerminalArtifactV1(artifact, candidate, review);
  return `${canonicalJson(artifact)}\n`;
}

export function parseLoopV2LiveTerminalArtifactV1(
  serialized: string,
  candidate?: LoopV2LiveCandidateArtifactV1,
  review?: LoopV2LiveReviewArtifactV1,
): LoopV2LiveTerminalArtifactV1 {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error("Loop v2 live terminal artifact is not valid JSON");
  }
  assertLoopV2LiveTerminalArtifactV1(value, candidate, review);
  return structuredClone(value);
}

export function assertLoopV2LiveTerminalArtifactV1(
  value: unknown,
  candidate?: LoopV2LiveCandidateArtifactV1,
  review?: LoopV2LiveReviewArtifactV1,
): asserts value is LoopV2LiveTerminalArtifactV1 {
  if (!isRecord(value)) {
    throw new Error("Loop v2 live terminal artifact is not an object");
  }
  if (value.schemaVersion !== LOOP_V2_LIVE_TERMINAL_ARTIFACT_SCHEMA_VERSION) {
    throw new Error("Unsupported loop v2 live terminal artifact schema");
  }
  if (value.kind !== "paw.loop-v2-live-terminal-artifact") {
    throw new Error("Invalid loop v2 live terminal artifact kind");
  }
  const expected = buildLoopV2LiveTerminalArtifactV1({
    runId: String(value.runId ?? ""),
    legacyTerminal: value.legacyTerminal as LoopV2LegacyTerminalV1,
    ...(candidate ? { candidate } : {}),
    ...(review ? { review } : {}),
  });
  if (canonicalJson(value) !== canonicalJson(expected)) {
    throw new Error("Loop v2 live terminal artifact does not match evidence");
  }
}

export function compareLoopV2TerminalV1(
  legacy: LoopV2LegacyTerminalV1,
  outcome: RunOutcomeV2,
): LoopV2TerminalComparisonV1 {
  if (legacy.status === outcome.executionStatus) return "equal";
  if (
    legacy.status === "completed" &&
    outcome.executionStatus === "external_pending"
  ) {
    return "legacy_completed_v2_external_pending";
  }
  if (legacy.status === "completed") return "legacy_more_permissive";
  if (
    outcome.executionStatus === "completed" ||
    outcome.executionStatus === "external_pending"
  ) {
    return "v2_more_permissive";
  }
  return "different_noncompletion";
}

function candidateArtifactEvidence(
  candidate?: LoopV2LiveCandidateArtifactV1,
): CandidateArtifactEvidenceV2 | undefined {
  const status = candidate?.assessment.artifact.status;
  if (!candidate || status === "none") return undefined;
  return {
    reconstructible: status === "valid",
    crossCheck: "unavailable",
    artifactRef: candidate.artifactHash,
  };
}

function normalizeLegacyTerminal(
  value: LoopV2LegacyTerminalV1,
): LoopV2LegacyTerminalV1 {
  if (
    value.status !== "completed" &&
    value.status !== "incomplete" &&
    value.status !== "failed" &&
    value.status !== "aborted"
  ) {
    throw new Error("Loop v2 legacy terminal status is invalid");
  }
  const outcome = value.outcome;
  if (
    outcome !== undefined &&
    outcome !== "verified" &&
    outcome !== "model_declared" &&
    outcome !== "budget_exhausted" &&
    outcome !== "aborted" &&
    outcome !== "incomplete" &&
    outcome !== "failed"
  ) {
    throw new Error("Loop v2 legacy terminal outcome is invalid");
  }
  const reasonCode = value.reasonCode?.trim();
  return {
    status: value.status,
    ...(outcome ? { outcome } : {}),
    ...(reasonCode ? { reasonCode } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
