/**
 * CompletionPolicy — honest run completion from TaskState evidence.
 */

import type {
  CompletionOutcome,
  RunEvidence,
  RunResult,
  RunStatus,
} from "@paw/core";
import type { TaskState } from "../task-state.js";
import type { VerificationDecision } from "./verification-gate.js";

export interface CompletionDecision {
  readonly status: Extract<
    RunStatus,
    "completed" | "failed" | "aborted" | "incomplete"
  >;
  readonly outcome: CompletionOutcome;
  readonly reason: string;
  readonly message: string;
  readonly evidence: RunEvidence;
}

export function evidenceFromTaskState(
  state: TaskState,
  skipVerifyReason?: string,
): RunEvidence {
  return {
    filesChanged: [...state.filesChanged],
    commandsRun: state.commandsRun.map((c) => ({
      command: c.command,
      ok: c.ok,
      summary: c.summary,
    })),
    testResults: state.testResults.map((t) => ({
      command: t.command,
      passed: t.passed,
      summary: t.summary,
    })),
    ...(skipVerifyReason ? { skipVerifyReason } : {}),
    ...((state.fileLockConflicts?.length ?? 0) > 0
      ? { fileLockConflicts: [...state.fileLockConflicts] }
      : {}),
  };
}

export interface DecideCompletionInput {
  readonly intent:
    | "final_answer"
    | "budget_exhausted"
    | "abort"
    | "error"
    | "max_steps_after_tools";
  readonly message: string;
  readonly taskState: TaskState;
  readonly verification?: VerificationDecision;
  /** True when the run used tools at least once (coding path). */
  readonly hasEverUsedTools?: boolean;
}

/**
 * Decide final Run status/outcome. Never marks budget exhaustion as completed.
 */
export function decideCompletion(
  input: DecideCompletionInput,
): CompletionDecision {
  const skipReason =
    input.verification?.ok && input.verification.mode === "skipped"
      ? input.verification.skipVerifyReason
      : undefined;
  const evidence = evidenceFromTaskState(input.taskState, skipReason);
  const message = input.message.trim() || "(empty)";

  if (input.intent === "abort") {
    return {
      status: "aborted",
      outcome: "aborted",
      reason: "user_or_model_abort",
      message,
      evidence,
    };
  }

  if (input.intent === "error") {
    return {
      status: "failed",
      outcome: "failed",
      reason: "runtime_error",
      message,
      evidence,
    };
  }

  if (
    input.intent === "budget_exhausted" ||
    input.intent === "max_steps_after_tools"
  ) {
    return {
      status: "incomplete",
      outcome: "budget_exhausted",
      reason:
        input.intent === "max_steps_after_tools"
          ? "max_steps_reached_after_tools"
          : "max_steps_exhausted_without_final",
      message,
      evidence,
    };
  }

  // final_answer
  if (input.verification && !input.verification.ok) {
    return {
      status: "incomplete",
      outcome: "incomplete",
      reason: "verification_required",
      message: `${message}\n\n[incomplete: ${input.verification.nudge}]`,
      evidence,
    };
  }

  if (input.verification?.ok && input.verification.mode === "tests_passed") {
    return {
      status: "completed",
      outcome: "verified",
      reason: "tests_passed",
      message,
      evidence,
    };
  }

  if (input.verification?.ok && input.verification.mode === "skipped") {
    return {
      status: "completed",
      outcome: "model_declared",
      reason: "skip_verify",
      message,
      evidence,
    };
  }

  if (
    input.verification?.ok &&
    input.verification.mode === "external_pending"
  ) {
    return {
      status: "completed",
      outcome: "model_declared",
      reason: "external_verification_pending",
      message,
      evidence,
    };
  }

  // No mutation / read-only or dialogue completion
  if (evidence.filesChanged.length === 0) {
    // Used tools but produced no file changes — still allow model_declared,
    // but coding evals should treat empty patch separately.
    return {
      status: "completed",
      outcome: "model_declared",
      reason: input.hasEverUsedTools
        ? "final_answer_no_file_changes"
        : "final_answer_dialogue",
      message,
      evidence,
    };
  }

  return {
    status: "completed",
    outcome: "model_declared",
    reason: "final_answer",
    message,
    evidence,
  };
}

export function toRunResult(
  runId: string,
  decision: CompletionDecision,
): RunResult {
  return {
    runId,
    status: decision.status,
    message: decision.message,
    outcome: decision.outcome,
    completionReason: decision.reason,
    evidence: decision.evidence,
  };
}
