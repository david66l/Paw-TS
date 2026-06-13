/**
 * EvalRunRecord — full trace of a single test case run.
 *
 * One record per repetition. Captures every turn's model input/output,
 * tool executions, and context snapshots for deterministic scoring.
 */

/** A single tool execution captured by the eval hooks. */
export interface EvalToolExecution {
  readonly tool: string;
  readonly args: unknown;
  readonly result: string;
  readonly ok: boolean;
  readonly durationMs: number;
}

/** Model input snapshot from beforeModelCall. */
export interface EvalModelInput {
  readonly messageCount: number;
  readonly systemPrompt?: string;
  readonly estimatedTokens: number;
}

/** Model output snapshot from afterModelCall. */
export interface EvalModelOutput {
  readonly rawText: string;
  readonly thinking?: string;
  readonly toolCalls?: readonly { tool: string; args: unknown }[];
  readonly usage?: { promptTokens?: number; completionTokens?: number };
  readonly latencyMs: number;
}

/** Context state snapshot captured before each model call. */
export interface EvalContextSnapshot {
  readonly historyTokens: number;
  readonly systemTokens: number;
  readonly totalTokens: number;
  readonly messageCount: number;
}

/** One turn's complete data. */
export interface EvalTurnRecord {
  readonly turnIndex: number;
  readonly modelInput: EvalModelInput;
  readonly modelOutput: EvalModelOutput;
  readonly toolExecutions: EvalToolExecution[];
  readonly contextSnapshot: EvalContextSnapshot;
}

/** Complete record for one test case run. */
export interface EvalRunRecord {
  readonly testCaseId: string;
  readonly repetitionIndex: number;
  readonly runId: string;
  readonly goal: string;
  readonly modelLabel: string;
  readonly status: "completed" | "failed" | "timeout" | "error";
  readonly finalAnswer?: string;
  readonly error?: string;
  readonly turns: EvalTurnRecord[];
  /** Total wall time for this run in ms. */
  readonly durationMs: number;
  /** The expected criteria for this test (carried for scoring). */
  readonly expected: unknown;
}
