/** Task checkpoint wire values. */
import type { TASK_CHECKPOINT_SCHEMA_VERSION_V1 } from "./versions.js";

export interface TaskCheckpointItemV1 {
  readonly statement: string;
  readonly sourceSeqs: readonly number[];
}

/** Structured compact state for the current run, never long-term memory. */
export interface TaskCheckpointV1 {
  readonly schemaVersion: typeof TASK_CHECKPOINT_SCHEMA_VERSION_V1;
  readonly goal?: TaskCheckpointItemV1;
  readonly confirmedFacts: readonly TaskCheckpointItemV1[];
  readonly currentHypotheses: readonly TaskCheckpointItemV1[];
  readonly ruledOut: readonly TaskCheckpointItemV1[];
  readonly changedFiles: readonly TaskCheckpointItemV1[];
  readonly verification: readonly TaskCheckpointItemV1[];
  readonly unresolved: readonly TaskCheckpointItemV1[];
  readonly nextAction?: TaskCheckpointItemV1;
}

export type TaskCheckpointDistillationStatusV1 =
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown"
  | "truncated";
