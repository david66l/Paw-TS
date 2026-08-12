/**
 * TaskLifecycle — control-plane helpers for observe → act → verify → complete.
 */

import type { RunResult } from "@paw/core";
import type { TaskState } from "../task-state.js";
import { formatTaskStateForContext } from "../task-state.js";
import {
  decideCompletion,
  evidenceFromTaskState,
  toRunResult,
  type CompletionDecision,
  type DecideCompletionInput,
} from "./completion-policy.js";
import {
  checkVerification,
  extractSkipVerifyReason,
  goalRequiresMutation,
  ALLOW_SKIP_VERIFY_MARKER,
  REQUIRE_MUTATION_MARKER,
  type VerificationDecision,
} from "./verification-gate.js";
import {
  formatRecoveryHints,
  idleFuseTripped,
  recoveryHintForToolResult,
  updateFailureSignatures,
  IDLE_FUSE_ESCALATION,
  type RecoveryHint,
} from "./tool-recovery.js";
import type { ToolRunResult } from "@paw/harness";
import {
  createBudgetAbort,
  resolveLifecycleBudget,
  DEFAULT_LIFECYCLE_BUDGET,
  HEADLESS_LIFECYCLE_BUDGET,
  type LifecycleBudget,
} from "./budget.js";

export {
  decideCompletion,
  evidenceFromTaskState,
  toRunResult,
  checkVerification,
  extractSkipVerifyReason,
  goalRequiresMutation,
  ALLOW_SKIP_VERIFY_MARKER,
  REQUIRE_MUTATION_MARKER,
  recoveryHintForToolResult,
  formatRecoveryHints,
  updateFailureSignatures,
  idleFuseTripped,
  IDLE_FUSE_ESCALATION,
  createBudgetAbort,
  resolveLifecycleBudget,
  DEFAULT_LIFECYCLE_BUDGET,
  HEADLESS_LIFECYCLE_BUDGET,
};
export type {
  CompletionDecision,
  VerificationDecision,
  RecoveryHint,
  LifecycleBudget,
};

/** Task state block for Context Package (control-plane visibility). */
export function taskStateContextSection(state: TaskState): string {
  return formatTaskStateForContext(state);
}

export function evaluateFinalAnswer(
  message: string,
  taskState: TaskState,
  hasEverUsedTools: boolean,
): {
  readonly verification: VerificationDecision;
  readonly decision: CompletionDecision | null;
  /** When verification fails, nudge instead of completing. */
  readonly shouldNudge: boolean;
  readonly nudgeMessage?: string;
} {
  const skip = extractSkipVerifyReason(message);
  const verification = checkVerification(taskState, {
    skipVerifyReason: skip,
  });
  if (!verification.ok) {
    return {
      verification,
      decision: null,
      shouldNudge: true,
      nudgeMessage: `[VerificationGate] ${verification.nudge}`,
    };
  }
  const decision = decideCompletion({
    intent: "final_answer",
    message,
    taskState,
    verification,
    hasEverUsedTools,
  });
  return { verification, decision, shouldNudge: false };
}

export function evaluateBudgetExhaustion(
  message: string,
  taskState: TaskState,
  intent: DecideCompletionInput["intent"] = "budget_exhausted",
): CompletionDecision {
  return decideCompletion({
    intent,
    message,
    taskState,
    hasEverUsedTools: true,
  });
}

export function runResultFromDecision(
  runId: string,
  decision: CompletionDecision,
): RunResult {
  return toRunResult(runId, decision);
}

export function collectToolRecoveryMessage(
  calls: readonly { readonly tool: string }[],
  results: readonly ToolRunResult[],
  failureSignatures?: readonly string[],
): {
  readonly message: string | null;
  readonly signatures: readonly string[];
  readonly fuseTripped: boolean;
} {
  const hints: RecoveryHint[] = [];
  for (let i = 0; i < calls.length; i++) {
    const hint = recoveryHintForToolResult(calls[i]!.tool, results[i]!);
    if (hint) hints.push(hint);
  }
  const signatures = updateFailureSignatures(
    failureSignatures,
    calls,
    results,
  );
  const fuse = idleFuseTripped(signatures);
  const base = formatRecoveryHints(hints);
  if (fuse) {
    return {
      message: [base, IDLE_FUSE_ESCALATION].filter(Boolean).join("\n"),
      signatures,
      fuseTripped: true,
    };
  }
  return { message: base, signatures, fuseTripped: false };
}
