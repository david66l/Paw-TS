/**
 * Run boundary types (v2 §8.3 Task / Plan / Run — here only Run execution slice).
 * Expand when porting orchestrator + store.
 */

export type RunStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "unimplemented";

export interface RunSpec {
  readonly runId: string;
  /** User-visible goal for this run. */
  readonly goal: string;
  /** Absolute or cwd-relative workspace root; harness resolves. */
  readonly workspaceRoot?: string;
  /**
   * Max model→(optional tool) rounds. When omitted, orchestrator reads
   * `max_steps` from `.paw/settings.local.json` when present, else a default.
   */
  readonly maxSteps?: number;
  /** When aborted, model HTTP and the loop stop between turns. */
  readonly abortSignal?: AbortSignal;
  /** When provided, the orchestrator resumes from this saved state instead of starting fresh. */
  readonly resumeFromState?: import("./app-state.js").AppState;
}

export interface RunResult {
  readonly runId: string;
  readonly status: RunStatus;
  readonly message: string;
}
