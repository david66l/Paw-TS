import type { CandidateReadinessPolicyV2 } from "./candidate-certification.js";
import { canonicalJson, sha256Canonical } from "./canonical.js";
import {
  type LoopV2LiveCandidateAssessmentV1,
  assessLoopV2LiveCandidateV1,
} from "./live-candidate.js";
import type { LoopV2ShadowArtifactPolicyV1 } from "./shadow-artifact.js";
import type { LoopV2ShadowReport } from "./shadow-runtime.js";

export const LOOP_V2_LIVE_ARTIFACT_SCHEMA_VERSION = 1 as const;

export function loopV2LiveArtifactPath(
  workspaceRoot: string,
  runId: string,
): string {
  if (!workspaceRoot.trim() || !runId.trim()) {
    throw new Error("Loop v2 live artifact path requires workspace and runId");
  }
  const runKey = sha256Canonical({ runId });
  return path.join(
    path.resolve(workspaceRoot),
    ".paw",
    "loop-v2",
    "runs",
    runKey,
    "candidate-v1.json",
  );
}

/** Self-contained persisted evidence for one explicit-v2 candidate. */
export interface LoopV2LiveCandidateArtifactV1 {
  readonly schemaVersion: typeof LOOP_V2_LIVE_ARTIFACT_SCHEMA_VERSION;
  readonly kind: "paw.loop-v2-live-artifact";
  readonly policy: LoopV2ShadowArtifactPolicyV1;
  readonly report: LoopV2ShadowReport;
  readonly assessment: LoopV2LiveCandidateAssessmentV1;
  readonly artifactHash: string;
}

export function buildLoopV2LiveCandidateArtifactV1(
  report: LoopV2ShadowReport,
  policy: CandidateReadinessPolicyV2 = {},
): LoopV2LiveCandidateArtifactV1 {
  const assessment = assessLoopV2LiveCandidateV1(report, policy);
  const withoutHash = {
    schemaVersion: LOOP_V2_LIVE_ARTIFACT_SCHEMA_VERSION,
    kind: "paw.loop-v2-live-artifact" as const,
    policy: assessment.policy,
    report,
    assessment,
  };
  return {
    ...withoutHash,
    artifactHash: sha256Canonical(withoutHash),
  };
}

export function serializeLoopV2LiveCandidateArtifactV1(
  artifact: LoopV2LiveCandidateArtifactV1,
): string {
  assertLoopV2LiveCandidateArtifactV1(artifact);
  return `${canonicalJson(artifact)}\n`;
}

export function parseLoopV2LiveCandidateArtifactV1(
  serialized: string,
): LoopV2LiveCandidateArtifactV1 {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error("Loop v2 live artifact is not valid JSON");
  }
  assertLoopV2LiveCandidateArtifactV1(value);
  return structuredClone(value);
}

export function assertLoopV2LiveCandidateArtifactV1(
  value: unknown,
): asserts value is LoopV2LiveCandidateArtifactV1 {
  if (!isRecord(value))
    throw new Error("Loop v2 live artifact is not an object");
  if (value.schemaVersion !== LOOP_V2_LIVE_ARTIFACT_SCHEMA_VERSION) {
    throw new Error("Unsupported loop v2 live artifact schema");
  }
  if (value.kind !== "paw.loop-v2-live-artifact") {
    throw new Error("Invalid loop v2 live artifact kind");
  }
  const expected = buildLoopV2LiveCandidateArtifactV1(
    value.report as LoopV2ShadowReport,
    value.policy as CandidateReadinessPolicyV2,
  );
  if (canonicalJson(value.assessment) !== canonicalJson(expected.assessment)) {
    throw new Error("Loop v2 live assessment does not match its report");
  }
  if (value.artifactHash !== expected.artifactHash) {
    throw new Error("Loop v2 live artifact hash mismatch");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
import path from "node:path";
