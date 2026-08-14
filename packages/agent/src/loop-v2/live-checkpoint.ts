import path from "node:path";

import { canonicalJson, sha256Canonical } from "./canonical.js";
import { assertLoopV2ShadowReportIntegrity } from "./shadow-artifact.js";
import type { LoopV2ShadowReport } from "./shadow-runtime.js";

export const LOOP_V2_PROJECTION_CHECKPOINT_SCHEMA_VERSION = 1 as const;

export interface LoopV2ProjectionCheckpointV1 {
  readonly schemaVersion: typeof LOOP_V2_PROJECTION_CHECKPOINT_SCHEMA_VERSION;
  readonly kind: "paw.loop-v2-projection-checkpoint";
  readonly report: LoopV2ShadowReport;
  readonly checkpointHash: string;
}

export function loopV2ProjectionCheckpointPath(
  workspaceRoot: string,
  runId: string,
): string {
  if (!workspaceRoot.trim() || !runId.trim()) {
    throw new Error(
      "Loop v2 projection checkpoint path requires workspace and runId",
    );
  }
  return path.join(
    path.resolve(workspaceRoot),
    ".paw",
    "loop-v2",
    "runs",
    sha256Canonical({ runId }),
    "projection-v1.json",
  );
}

export function buildLoopV2ProjectionCheckpointV1(
  report: LoopV2ShadowReport,
): LoopV2ProjectionCheckpointV1 {
  assertLoopV2ShadowReportIntegrity(report);
  const withoutHash = {
    schemaVersion: LOOP_V2_PROJECTION_CHECKPOINT_SCHEMA_VERSION,
    kind: "paw.loop-v2-projection-checkpoint" as const,
    report,
  };
  return {
    ...withoutHash,
    checkpointHash: sha256Canonical(withoutHash),
  };
}

export function serializeLoopV2ProjectionCheckpointV1(
  checkpoint: LoopV2ProjectionCheckpointV1,
): string {
  assertLoopV2ProjectionCheckpointV1(checkpoint);
  return `${canonicalJson(checkpoint)}\n`;
}

export function parseLoopV2ProjectionCheckpointV1(
  serialized: string,
): LoopV2ProjectionCheckpointV1 {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error("Loop v2 projection checkpoint is not valid JSON");
  }
  assertLoopV2ProjectionCheckpointV1(value);
  return structuredClone(value);
}

export function assertLoopV2ProjectionCheckpointV1(
  value: unknown,
): asserts value is LoopV2ProjectionCheckpointV1 {
  if (!isRecord(value)) {
    throw new Error("Loop v2 projection checkpoint is not an object");
  }
  if (value.schemaVersion !== LOOP_V2_PROJECTION_CHECKPOINT_SCHEMA_VERSION) {
    throw new Error("Unsupported loop v2 projection checkpoint schema");
  }
  if (value.kind !== "paw.loop-v2-projection-checkpoint") {
    throw new Error("Invalid loop v2 projection checkpoint kind");
  }
  const expected = buildLoopV2ProjectionCheckpointV1(
    value.report as LoopV2ShadowReport,
  );
  if (value.checkpointHash !== expected.checkpointHash) {
    throw new Error("Loop v2 projection checkpoint hash mismatch");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
