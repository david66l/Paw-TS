import path from "node:path";

import type { SemanticReviewRecordV2 } from "./candidate-certification.js";
import {
  semanticReviewKeyV2,
  semanticReviewSubjectHashV2,
  validateSemanticReviewRecordV2,
} from "./candidate-certification.js";
import { canonicalJson, sha256Canonical } from "./canonical.js";
import {
  type LoopV2LiveCandidateArtifactV1,
  assertLoopV2LiveCandidateArtifactV1,
} from "./live-artifact.js";
import { buildLoopV2LiveReviewPayloadV1 } from "./live-candidate.js";

export const LOOP_V2_LIVE_REVIEW_ARTIFACT_SCHEMA_VERSION = 1 as const;

export interface LoopV2LiveReviewArtifactV1 {
  readonly schemaVersion: typeof LOOP_V2_LIVE_REVIEW_ARTIFACT_SCHEMA_VERSION;
  readonly kind: "paw.loop-v2-live-review-artifact";
  readonly runId: string;
  readonly candidateArtifactHash: string;
  readonly candidateInputHash: string;
  readonly mutationRevision: number;
  readonly reviewKey: string;
  readonly record: SemanticReviewRecordV2;
  /** A settled verdict rebound to newer verification facts, without a model call. */
  readonly reuse?: Readonly<{
    readonly fromReviewKey: string;
    readonly semanticSubjectHash: string;
  }>;
  readonly artifactHash: string;
}

export function loopV2LiveReviewArtifactPath(
  workspaceRoot: string,
  runId: string,
): string {
  if (!workspaceRoot.trim() || !runId.trim()) {
    throw new Error(
      "Loop v2 live review artifact path requires workspace and runId",
    );
  }
  return path.join(
    path.resolve(workspaceRoot),
    ".paw",
    "loop-v2",
    "runs",
    sha256Canonical({ runId }),
    "review-v1.json",
  );
}

/** Binds one canonical semantic verdict to one strict candidate artifact. */
export function buildLoopV2LiveReviewArtifactV1(
  candidateArtifact: LoopV2LiveCandidateArtifactV1,
  record: SemanticReviewRecordV2,
  reuse?: LoopV2LiveReviewArtifactV1["reuse"],
): LoopV2LiveReviewArtifactV1 {
  assertLoopV2LiveCandidateArtifactV1(candidateArtifact);
  const payload = buildLoopV2LiveReviewPayloadV1(
    candidateArtifact.report,
    candidateArtifact.assessment.policy,
  );
  const normalized = validateSemanticReviewRecordV2(record, payload);
  const reviewKey = semanticReviewKeyV2(
    payload.input.mutationRevision,
    payload.candidateInputHash,
  );
  if (reuse) {
    if (!reuse.fromReviewKey.trim() || reuse.fromReviewKey === reviewKey) {
      throw new Error("Loop v2 semantic review reuse source is invalid");
    }
    if (reuse.semanticSubjectHash !== semanticReviewSubjectHashV2(payload)) {
      throw new Error("Loop v2 semantic review reuse subject mismatch");
    }
  }
  const withoutHash = {
    schemaVersion: LOOP_V2_LIVE_REVIEW_ARTIFACT_SCHEMA_VERSION,
    kind: "paw.loop-v2-live-review-artifact" as const,
    runId: candidateArtifact.report.runId,
    candidateArtifactHash: candidateArtifact.artifactHash,
    candidateInputHash: payload.candidateInputHash,
    mutationRevision: payload.input.mutationRevision,
    reviewKey,
    record: normalized,
    ...(reuse ? { reuse: { ...reuse } } : {}),
  };
  return {
    ...withoutHash,
    artifactHash: sha256Canonical(withoutHash),
  };
}

export function serializeLoopV2LiveReviewArtifactV1(
  artifact: LoopV2LiveReviewArtifactV1,
  candidateArtifact: LoopV2LiveCandidateArtifactV1,
): string {
  assertLoopV2LiveReviewArtifactV1(artifact, candidateArtifact);
  return `${canonicalJson(artifact)}\n`;
}

export function parseLoopV2LiveReviewArtifactV1(
  serialized: string,
  candidateArtifact: LoopV2LiveCandidateArtifactV1,
): LoopV2LiveReviewArtifactV1 {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error("Loop v2 live review artifact is not valid JSON");
  }
  assertLoopV2LiveReviewArtifactV1(value, candidateArtifact);
  return structuredClone(value);
}

export function assertLoopV2LiveReviewArtifactV1(
  value: unknown,
  candidateArtifact: LoopV2LiveCandidateArtifactV1,
): asserts value is LoopV2LiveReviewArtifactV1 {
  if (!isRecord(value)) {
    throw new Error("Loop v2 live review artifact is not an object");
  }
  if (value.schemaVersion !== LOOP_V2_LIVE_REVIEW_ARTIFACT_SCHEMA_VERSION) {
    throw new Error("Unsupported loop v2 live review artifact schema");
  }
  if (value.kind !== "paw.loop-v2-live-review-artifact") {
    throw new Error("Invalid loop v2 live review artifact kind");
  }
  if (value.candidateArtifactHash !== candidateArtifact.artifactHash) {
    throw new Error("Loop v2 live review candidate artifact mismatch");
  }
  const expected = buildLoopV2LiveReviewArtifactV1(
    candidateArtifact,
    value.record as SemanticReviewRecordV2,
    isRecord(value.reuse)
      ? {
          fromReviewKey: String(value.reuse.fromReviewKey ?? ""),
          semanticSubjectHash: String(value.reuse.semanticSubjectHash ?? ""),
        }
      : undefined,
  );
  if (canonicalJson(value) !== canonicalJson(expected)) {
    throw new Error("Loop v2 live review artifact does not match candidate");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
