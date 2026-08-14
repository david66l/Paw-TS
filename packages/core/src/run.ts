/**
 * Run 边界类型。
 * =============
 *
 * Run 是单次 Agent 执行的最小单元。
 *
 * RunSpec：orchestrator.run() 的输入。
 * RunResult：orchestrator.run() 的输出（含完成契约与证据）。
 */

export type RunStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "aborted"
  | "incomplete"
  | "unimplemented";

/** How / why the run ended (CompletionPolicy outcome). */
export type CompletionOutcome =
  | "verified"
  | "model_declared"
  | "budget_exhausted"
  | "aborted"
  | "incomplete"
  | "failed";

export interface RunCommandEvidence {
  readonly command: string;
  readonly ok: boolean;
  readonly summary: string;
}

export interface RunTestEvidence {
  readonly command: string;
  readonly passed: boolean;
  /** Structured verification result; optional for backwards compatibility. */
  readonly outcome?: "passed" | "code_failed" | "harness_failed";
  /** Why a failed verification was classified as code or harness failure. */
  readonly failureKind?:
    | "missing_dependency"
    | "runner_unavailable"
    | "test_discovery"
    | "invocation_error"
    | "test_failure";
  /** Whether one bounded command-level recovery may still produce evidence. */
  readonly retryability?: "retryable" | "terminal";
  readonly summary: string;
}

/** Structured evidence attached to RunResult for eval / resume / memory. */
export interface RunEvidence {
  readonly filesChanged: readonly string[];
  readonly commandsRun: readonly RunCommandEvidence[];
  readonly testResults: readonly RunTestEvidence[];
  readonly skipVerifyReason?: string;
  /** Paths that hit parallel file-lock conflicts during the run. */
  readonly fileLockConflicts?: readonly string[];
}

/**
 * Trusted, caller-supplied acceptance state. This is deliberately structured
 * input: the orchestrator must not guess lifecycle gates by parsing prose from
 * the model-visible goal.
 */
export interface RunAcceptanceCriterionSeed {
  readonly text: string;
  readonly source: "user" | "repository" | "verification";
  readonly ref?: string;
  /** External criteria remain visible, but a trusted external verifier closes them. */
  readonly verificationAuthority?: "agent" | "external";
}

export interface RunSpec {
  readonly runId: string;
  /** 用户可见的本次 Run 目标。 */
  readonly goal: string;
  /** Observable conditions known by the trusted caller before the first turn. */
  readonly initialAcceptanceCriteria?: readonly RunAcceptanceCriterionSeed[];
  /** 工作区根目录的绝对或相对路径；由 harness 解析。 */
  readonly workspaceRoot?: string;
  /**
   * 最大 model→(可选 tool) 轮数。省略时，orchestrator 读取
   * `.paw/settings.local.json` 中的 `max_steps`（如果存在），否则使用默认值（32）。
   */
  readonly maxSteps?: number;
  /** 中断信号：abort 后，模型 HTTP 和循环在轮次之间停止。 */
  readonly abortSignal?: AbortSignal;
  /** 提供此状态时，orchestrator 从保存的状态恢复而非全新启动。 */
  readonly resumeFromState?: import("./app-state.js").AppState;
  /**
   * 桌面多轮：复用已有 Memory TaskSession（beginTask.resumeTaskId）。
   */
  readonly resumeMemoryTaskId?: string;
  /**
   * 为 true 时 run 结束不调用 completeTask（会话继续）；
   * 由宿主在「新对话 / 结束会话」时显式 complete。
   */
  readonly deferMemoryComplete?: boolean;
  /** 桌面会话 id：用于绑定 conversation → memory taskId。 */
  readonly conversationId?: string;
}

export interface RunResult {
  readonly runId: string;
  readonly status: RunStatus;
  readonly message: string;
  /** CompletionPolicy outcome (when lifecycle is wired). */
  readonly outcome?: CompletionOutcome;
  /** Human/machine reason for the outcome. */
  readonly completionReason?: string;
  /** Task evidence snapshot at completion. */
  readonly evidence?: RunEvidence;
}
