import path from "node:path";

import type { RunEvidence, RunResult } from "@paw/core";

import { canonicalJson, sha256Canonical } from "./canonical.js";
import { renderHostReportV2 } from "./host-report.js";
import type { LoopV2LiveCandidateArtifactV1 } from "./live-artifact.js";
import { buildLoopV2LiveReviewPayloadV1 } from "./live-candidate.js";
import type { LoopV2LiveReviewArtifactV1 } from "./live-review-artifact.js";
import {
  type LoopV2AuthorityEligibilityV1,
  type LoopV2LiveTerminalArtifactV1,
  assertLoopV2LiveTerminalArtifactV1,
  assessLoopV2AuthorityEligibilityV1,
} from "./live-terminal-artifact.js";

export const LOOP_V2_RUN_RESULT_SHADOW_SCHEMA_VERSION = 1 as const;

export interface LoopV2RunResultShadowComparisonV1 {
  readonly authorityFieldsEqual: boolean;
  readonly evidencePreserved: boolean;
  readonly cutoverReady: boolean;
}

/**
 * Durable proof that an eligible v2 outcome can cross the public RunResult
 * boundary without losing the host's evidence ledger. It remains diagnostic.
 */
export interface LoopV2RunResultShadowArtifactV1 {
  readonly schemaVersion: typeof LOOP_V2_RUN_RESULT_SHADOW_SCHEMA_VERSION;
  readonly kind: "paw.loop-v2-run-result-shadow-artifact";
  readonly runId: string;
  readonly terminalArtifactHash: string;
  readonly eligibility: LoopV2AuthorityEligibilityV1;
  readonly legacyResult: RunResult;
  readonly mappedResult?: RunResult;
  readonly comparison: LoopV2RunResultShadowComparisonV1;
  readonly artifactHash: string;
}

export function loopV2RunResultShadowArtifactPath(
  workspaceRoot: string,
  runId: string,
): string {
  if (!workspaceRoot.trim() || !runId.trim()) {
    throw new Error(
      "Loop v2 RunResult shadow path requires workspace and runId",
    );
  }
  return path.join(
    path.resolve(workspaceRoot),
    ".paw",
    "loop-v2",
    "runs",
    sha256Canonical({ runId }),
    "run-result-shadow-v1.json",
  );
}

export function mapEligibleLoopV2RunResultV1(
  legacyResult: RunResult,
  terminal: LoopV2LiveTerminalArtifactV1,
  candidate: LoopV2LiveCandidateArtifactV1,
  review: LoopV2LiveReviewArtifactV1,
): RunResult {
  const normalizedLegacy = normalizeRunResult(legacyResult);
  assertLegacyMatchesTerminal(normalizedLegacy, terminal);
  const eligibility = assessLoopV2AuthorityEligibilityV1(
    terminal,
    candidate,
    review,
  );
  if (!eligibility.eligible) {
    throw new Error(
      `Loop v2 RunResult mapping requires eligibility: ${eligibility.reasons.join(",")}`,
    );
  }
  const payload = buildLoopV2LiveReviewPayloadV1(candidate.report);
  const report = renderHostReportV2({
    candidate: payload.input,
    outcome: terminal.v2Outcome,
    review: review.record.review,
  });
  return {
    runId: normalizedLegacy.runId,
    status: "completed",
    message: report.markdown,
    outcome: "verified",
    completionReason: terminal.v2Outcome.reasonCode,
    ...(normalizedLegacy.evidence
      ? { evidence: structuredClone(normalizedLegacy.evidence) }
      : {}),
  };
}

export function buildLoopV2RunResultShadowArtifactV1(
  legacyResult: RunResult,
  terminal: LoopV2LiveTerminalArtifactV1,
  candidate?: LoopV2LiveCandidateArtifactV1,
  review?: LoopV2LiveReviewArtifactV1,
): LoopV2RunResultShadowArtifactV1 {
  const normalizedLegacy = normalizeRunResult(legacyResult);
  assertLegacyMatchesTerminal(normalizedLegacy, terminal);
  assertLoopV2LiveTerminalArtifactV1(terminal, candidate, review);
  const eligibility = assessLoopV2AuthorityEligibilityV1(
    terminal,
    candidate,
    review,
  );
  const mappedResult =
    eligibility.eligible && candidate && review
      ? mapEligibleLoopV2RunResultV1(
          normalizedLegacy,
          terminal,
          candidate,
          review,
        )
      : undefined;
  const authorityFieldsEqual = Boolean(
    mappedResult &&
      mappedResult.runId === normalizedLegacy.runId &&
      mappedResult.status === normalizedLegacy.status &&
      mappedResult.outcome === normalizedLegacy.outcome,
  );
  const evidencePreserved = Boolean(
    mappedResult &&
      canonicalJson(mappedResult.evidence ?? null) ===
        canonicalJson(normalizedLegacy.evidence ?? null),
  );
  const comparison = {
    authorityFieldsEqual,
    evidencePreserved,
    cutoverReady:
      eligibility.eligible && authorityFieldsEqual && evidencePreserved,
  };
  const withoutHash = {
    schemaVersion: LOOP_V2_RUN_RESULT_SHADOW_SCHEMA_VERSION,
    kind: "paw.loop-v2-run-result-shadow-artifact" as const,
    runId: normalizedLegacy.runId,
    terminalArtifactHash: terminal.artifactHash,
    eligibility,
    legacyResult: normalizedLegacy,
    ...(mappedResult ? { mappedResult } : {}),
    comparison,
  };
  return { ...withoutHash, artifactHash: sha256Canonical(withoutHash) };
}

export function serializeLoopV2RunResultShadowArtifactV1(
  artifact: LoopV2RunResultShadowArtifactV1,
  terminal: LoopV2LiveTerminalArtifactV1,
  candidate?: LoopV2LiveCandidateArtifactV1,
  review?: LoopV2LiveReviewArtifactV1,
): string {
  assertLoopV2RunResultShadowArtifactV1(artifact, terminal, candidate, review);
  return `${canonicalJson(artifact)}\n`;
}

export function parseLoopV2RunResultShadowArtifactV1(
  serialized: string,
  terminal: LoopV2LiveTerminalArtifactV1,
  candidate?: LoopV2LiveCandidateArtifactV1,
  review?: LoopV2LiveReviewArtifactV1,
): LoopV2RunResultShadowArtifactV1 {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error("Loop v2 RunResult shadow artifact is not valid JSON");
  }
  assertLoopV2RunResultShadowArtifactV1(value, terminal, candidate, review);
  return structuredClone(value);
}

export function assertLoopV2RunResultShadowArtifactV1(
  value: unknown,
  terminal: LoopV2LiveTerminalArtifactV1,
  candidate?: LoopV2LiveCandidateArtifactV1,
  review?: LoopV2LiveReviewArtifactV1,
): asserts value is LoopV2RunResultShadowArtifactV1 {
  if (!isRecord(value)) {
    throw new Error("Loop v2 RunResult shadow artifact is not an object");
  }
  if (value.schemaVersion !== LOOP_V2_RUN_RESULT_SHADOW_SCHEMA_VERSION) {
    throw new Error("Unsupported loop v2 RunResult shadow artifact schema");
  }
  if (value.kind !== "paw.loop-v2-run-result-shadow-artifact") {
    throw new Error("Invalid loop v2 RunResult shadow artifact kind");
  }
  const expected = buildLoopV2RunResultShadowArtifactV1(
    value.legacyResult as RunResult,
    terminal,
    candidate,
    review,
  );
  if (canonicalJson(value) !== canonicalJson(expected)) {
    throw new Error(
      "Loop v2 RunResult shadow artifact does not match evidence",
    );
  }
}

function assertLegacyMatchesTerminal(
  legacy: RunResult,
  terminal: LoopV2LiveTerminalArtifactV1,
): void {
  if (legacy.runId !== terminal.runId) {
    throw new Error("Loop v2 RunResult shadow runId mismatch");
  }
  if (
    legacy.status !== terminal.legacyTerminal.status ||
    legacy.outcome !== terminal.legacyTerminal.outcome ||
    legacy.completionReason !== terminal.legacyTerminal.reasonCode
  ) {
    throw new Error("Loop v2 RunResult shadow legacy terminal mismatch");
  }
}

function normalizeRunResult(value: RunResult): RunResult {
  if (
    !isRecord(value) ||
    typeof value.runId !== "string" ||
    !value.runId.trim()
  ) {
    throw new Error("Loop v2 RunResult shadow legacy result is invalid");
  }
  if (
    value.status !== "completed" &&
    value.status !== "incomplete" &&
    value.status !== "failed" &&
    value.status !== "aborted"
  ) {
    throw new Error("Loop v2 RunResult shadow legacy status is invalid");
  }
  if (typeof value.message !== "string") {
    throw new Error("Loop v2 RunResult shadow legacy message is invalid");
  }
  return {
    runId: value.runId.trim(),
    status: value.status,
    message: value.message,
    ...(value.outcome ? { outcome: value.outcome } : {}),
    ...(value.completionReason
      ? { completionReason: value.completionReason }
      : {}),
    ...(value.evidence ? { evidence: normalizeEvidence(value.evidence) } : {}),
  };
}

function normalizeEvidence(value: RunEvidence): RunEvidence {
  if (
    !Array.isArray(value.filesChanged) ||
    !Array.isArray(value.commandsRun) ||
    !Array.isArray(value.testResults)
  ) {
    throw new Error("Loop v2 RunResult shadow evidence is invalid");
  }
  return structuredClone(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
