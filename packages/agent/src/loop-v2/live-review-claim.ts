import path from "node:path";

import { semanticReviewKeyV2 } from "./candidate-certification.js";
import { canonicalJson, sha256Canonical } from "./canonical.js";
import {
  type LoopV2LiveCandidateArtifactV1,
  assertLoopV2LiveCandidateArtifactV1,
} from "./live-artifact.js";
import { buildLoopV2LiveReviewPayloadV1 } from "./live-candidate.js";

export const LOOP_V2_LIVE_REVIEW_CLAIM_SCHEMA_VERSION = 1 as const;

/** Durable at-most-once claim written before the external reviewer call. */
export interface LoopV2LiveReviewClaimV1 {
  readonly schemaVersion: typeof LOOP_V2_LIVE_REVIEW_CLAIM_SCHEMA_VERSION;
  readonly kind: "paw.loop-v2-live-review-claim";
  readonly runId: string;
  readonly candidateArtifactHash: string;
  readonly candidateInputHash: string;
  readonly mutationRevision: number;
  readonly reviewKey: string;
  readonly status: "claimed";
  readonly claimHash: string;
}

export function loopV2LiveReviewClaimPath(
  workspaceRoot: string,
  runId: string,
): string {
  if (!workspaceRoot.trim() || !runId.trim()) {
    throw new Error(
      "Loop v2 live review claim path requires workspace and runId",
    );
  }
  return path.join(
    path.resolve(workspaceRoot),
    ".paw",
    "loop-v2",
    "runs",
    sha256Canonical({ runId }),
    "review-claim-v1.json",
  );
}

export function buildLoopV2LiveReviewClaimV1(
  candidateArtifact: LoopV2LiveCandidateArtifactV1,
): LoopV2LiveReviewClaimV1 {
  assertLoopV2LiveCandidateArtifactV1(candidateArtifact);
  const payload = buildLoopV2LiveReviewPayloadV1(
    candidateArtifact.report,
    candidateArtifact.assessment.policy,
  );
  const withoutHash = {
    schemaVersion: LOOP_V2_LIVE_REVIEW_CLAIM_SCHEMA_VERSION,
    kind: "paw.loop-v2-live-review-claim" as const,
    runId: candidateArtifact.report.runId,
    candidateArtifactHash: candidateArtifact.artifactHash,
    candidateInputHash: payload.candidateInputHash,
    mutationRevision: payload.input.mutationRevision,
    reviewKey: semanticReviewKeyV2(
      payload.input.mutationRevision,
      payload.candidateInputHash,
    ),
    status: "claimed" as const,
  };
  return { ...withoutHash, claimHash: sha256Canonical(withoutHash) };
}

export function serializeLoopV2LiveReviewClaimV1(
  claim: LoopV2LiveReviewClaimV1,
  candidateArtifact: LoopV2LiveCandidateArtifactV1,
): string {
  assertLoopV2LiveReviewClaimV1(claim, candidateArtifact);
  return `${canonicalJson(claim)}\n`;
}

export function parseLoopV2LiveReviewClaimV1(
  serialized: string,
  candidateArtifact: LoopV2LiveCandidateArtifactV1,
): LoopV2LiveReviewClaimV1 {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error("Loop v2 live review claim is not valid JSON");
  }
  assertLoopV2LiveReviewClaimV1(value, candidateArtifact);
  return structuredClone(value);
}

export function assertLoopV2LiveReviewClaimV1(
  value: unknown,
  candidateArtifact: LoopV2LiveCandidateArtifactV1,
): asserts value is LoopV2LiveReviewClaimV1 {
  if (!isRecord(value)) {
    throw new Error("Loop v2 live review claim is not an object");
  }
  if (value.schemaVersion !== LOOP_V2_LIVE_REVIEW_CLAIM_SCHEMA_VERSION) {
    throw new Error("Unsupported loop v2 live review claim schema");
  }
  if (value.kind !== "paw.loop-v2-live-review-claim") {
    throw new Error("Invalid loop v2 live review claim kind");
  }
  if (value.candidateArtifactHash !== candidateArtifact.artifactHash) {
    throw new Error("Loop v2 live review claim candidate artifact mismatch");
  }
  const expected = buildLoopV2LiveReviewClaimV1(candidateArtifact);
  if (canonicalJson(value) !== canonicalJson(expected)) {
    throw new Error("Loop v2 live review claim does not match candidate");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
