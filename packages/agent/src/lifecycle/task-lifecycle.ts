/**
 * TaskLifecycle — control-plane helpers for observe → act → verify → complete.
 */

import type { RunResult } from "@paw/core";
import type { ToolRunResult } from "@paw/harness";
import type { TaskState } from "../task-state.js";
import { formatTaskStateForContext } from "../task-state.js";
import {
  type AcceptanceGateDecision,
  checkAcceptanceCriteria,
} from "./acceptance-gate.js";
import {
  DEFAULT_LIFECYCLE_BUDGET,
  HEADLESS_LIFECYCLE_BUDGET,
  type LifecycleBudget,
  createBudgetAbort,
  resolveLifecycleBudget,
} from "./budget.js";
import {
  type CompletionDecision,
  type DecideCompletionInput,
  decideCompletion,
  decideIncomplete,
  evidenceFromTaskState,
  toRunResult,
} from "./completion-policy.js";
import { isControlPlaneToolResult } from "./control-plane.js";
import {
  IDLE_FUSE_ESCALATION,
  type RecoveryHint,
  formatRecoveryHints,
  idleFuseTripped,
  recoveryHintForToolResult,
  updateFailureSignatures,
} from "./tool-recovery.js";
import {
  ALLOW_SKIP_VERIFY_MARKER,
  REQUIRE_MUTATION_MARKER,
  type VerificationDecision,
  type VerificationPolicy,
  checkVerification,
  extractSkipVerifyReason,
  goalRequiresMutation,
} from "./verification-gate.js";

export {
  decideCompletion,
  decideIncomplete,
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
  checkAcceptanceCriteria,
};
export type {
  CompletionDecision,
  VerificationDecision,
  VerificationPolicy,
  RecoveryHint,
  LifecycleBudget,
  AcceptanceGateDecision,
};

/** Task state block for Context Package (control-plane visibility). */
export function taskStateContextSection(state: TaskState): string {
  return formatTaskStateForContext(state);
}

export function evaluateFinalAnswer(
  message: string,
  taskState: TaskState,
  hasEverUsedTools: boolean,
  verificationPolicy?: VerificationPolicy,
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
    policy: verificationPolicy,
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
  calls: readonly { readonly tool: string; readonly args?: unknown }[],
  results: readonly ToolRunResult[],
  failureSignatures?: readonly string[],
): {
  readonly message: string | null;
  readonly signatures: readonly string[];
  readonly fuseTripped: boolean;
} {
  const productPairs = results.flatMap((result, index) => {
    const call = calls[index];
    return !call || isControlPlaneToolResult(result) ? [] : [{ call, result }];
  });
  if (productPairs.length === 0) {
    return {
      message: null,
      signatures: failureSignatures ?? [],
      fuseTripped: false,
    };
  }
  const productCalls = productPairs.map(({ call }) => call);
  const productResults = productPairs.map(({ result }) => result);
  const hints: RecoveryHint[] = [];
  for (const { call, result } of productPairs) {
    const hint = recoveryHintForToolResult(call.tool, result);
    if (hint) hints.push(hint);
  }
  const signatures = updateFailureSignatures(
    failureSignatures,
    productCalls,
    productResults,
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
