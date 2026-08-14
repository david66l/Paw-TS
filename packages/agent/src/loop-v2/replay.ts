import { sha256Canonical } from "./canonical.js";
import {
  createWorkingDecisionStateV2,
  decisionStateHash,
  projectLoopV2Event,
  projectionHash,
} from "./projector.js";
import {
  LOOP_V2_SCHEMA_VERSION,
  type LoopV2Checkpoint,
  type LoopV2Envelope,
  type LoopV2ProjectionStep,
  type WorkingDecisionStateV2,
} from "./schema.js";

export interface LoopV2ReplayResult {
  readonly state: WorkingDecisionStateV2;
  readonly steps: readonly LoopV2ProjectionStep[];
  readonly decisionStateHash: string;
  readonly projectionHash: string;
}

export function replayLoopV2(
  runId: string,
  events: readonly LoopV2Envelope[],
  checkpoint?: LoopV2Checkpoint,
): LoopV2ReplayResult {
  let state = checkpoint
    ? restoreLoopV2Checkpoint(runId, checkpoint)
    : createWorkingDecisionStateV2(runId);
  const steps: LoopV2ProjectionStep[] = [];
  for (const envelope of events) {
    const projected = projectLoopV2Event(state, envelope);
    state = projected.state;
    steps.push({
      seq: envelope.seq,
      eventType: envelope.event.type,
      delta: projected.delta,
      decisionStateHash: decisionStateHash(state),
    });
  }
  return {
    state,
    steps,
    decisionStateHash: decisionStateHash(state),
    projectionHash: projectionHash(state),
  };
}

export function createLoopV2Checkpoint(
  state: WorkingDecisionStateV2,
): LoopV2Checkpoint {
  const detached = structuredClone(state);
  return {
    schemaVersion: LOOP_V2_SCHEMA_VERSION,
    runId: state.runId,
    lastSeq: state.lastSeq,
    state: detached,
    projectionHash: projectionHash(detached),
  };
}

export function restoreLoopV2Checkpoint(
  runId: string,
  checkpoint: LoopV2Checkpoint,
): WorkingDecisionStateV2 {
  if (checkpoint.schemaVersion !== LOOP_V2_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported loop v2 checkpoint schema: ${checkpoint.schemaVersion}`,
    );
  }
  if (checkpoint.runId !== runId || checkpoint.state.runId !== runId) {
    throw new Error(`Loop v2 checkpoint run mismatch: ${runId}`);
  }
  if (checkpoint.lastSeq !== checkpoint.state.lastSeq) {
    throw new Error("Loop v2 checkpoint seq does not match projected state");
  }
  const actualHash = projectionHash(checkpoint.state);
  if (actualHash !== checkpoint.projectionHash) {
    throw new Error("Loop v2 checkpoint projection hash mismatch");
  }
  return structuredClone(checkpoint.state);
}

export function loopV2ReplayArtifactHash(result: LoopV2ReplayResult): string {
  return sha256Canonical({
    state: result.state,
    steps: result.steps,
    decisionStateHash: result.decisionStateHash,
    projectionHash: result.projectionHash,
  });
}
