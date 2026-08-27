import {
  finalizeCheckpoint,
  requiresToolCheckpointV1,
  saveCheckpoint,
} from "@paw/core";

import type { HarnessContext } from "../context.js";
import type { ToolRunResult } from "./definitions.js";
import { executeTool } from "./execution.js";

/** Trusted, caller-supplied gate evaluated before approval or side effects. */
export interface ToolExecutionPolicyInput {
  readonly tool: string;
  readonly args: unknown;
  readonly workspaceRoot: string;
}

export type ToolExecutionPolicyDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reason: string;
      readonly message: string;
    };

export type ToolExecutionPolicy = (
  input: ToolExecutionPolicyInput,
) => ToolExecutionPolicyDecision | Promise<ToolExecutionPolicyDecision>;

export interface ToolEffectPolicyInput extends ToolExecutionPolicyInput {
  readonly result: ToolRunResult;
}

export type ToolEffectPolicyDecision =
  | { readonly allowed: true; readonly result?: ToolRunResult }
  | {
      readonly allowed: false;
      readonly reason: string;
      readonly message: string;
      readonly recovered: boolean;
    };

/**
 * Trusted before/after inspection for effects that cannot be decided from
 * arguments alone. The opaque value returned by `prepare` is handed to
 * `settle` unchanged.
 */
export interface ToolEffectPolicy {
  readonly appliesTo?: (input: ToolExecutionPolicyInput) => boolean;
  readonly prepare: (
    input: ToolExecutionPolicyInput,
  ) => unknown | Promise<unknown>;
  readonly settle: (
    input: ToolEffectPolicyInput,
    prepared: unknown,
  ) => ToolEffectPolicyDecision | Promise<ToolEffectPolicyDecision>;
}

/** Approval is an explicit decision made by the runtime/UI, never inferred here. */
export type ExplicitToolApprovalDecision =
  | { readonly approved: true }
  | {
      readonly approved: false;
      readonly reason: string;
      readonly message: string;
    };

export interface ToolExecutionTransactionInput {
  readonly callId: string;
  readonly runId: string;
  /** Canonical workspace/session/run-derived physical checkpoint namespace. */
  readonly checkpointNamespaceId: string;
  readonly tool: string;
  readonly args: unknown;
  readonly context: HarnessContext;
  readonly approval: ExplicitToolApprovalDecision;
  readonly signal: AbortSignal;
  /** Required for mutating tools other than undo. Allocated by the runtime. */
  readonly checkpointSeq?: number;
  readonly executionPolicy?: ToolExecutionPolicy;
  readonly effectPolicy?: ToolEffectPolicy;
}

export interface ToolTransactionCheckpointEvidence {
  readonly seq: number;
  readonly prepared: true;
  readonly finalized: boolean;
  readonly error?: string;
}

export interface ToolTransactionError {
  readonly name: string;
  readonly message: string;
}

export type ToolExecutionTransactionOutcome =
  | {
      readonly status: "completed";
      readonly callId: string;
      readonly executed: true;
      /** A normal `ok: false` tool result is still completed evidence. */
      readonly result: ToolRunResult;
      readonly checkpoint?: ToolTransactionCheckpointEvidence;
    }
  | {
      readonly status: "denied";
      readonly callId: string;
      readonly executed: false;
      readonly reason: string;
      readonly message: string;
    }
  | {
      readonly status: "rejected";
      readonly callId: string;
      readonly executed: true;
      readonly reason: string;
      readonly message: string;
      readonly recovered: boolean;
      readonly originalResult: ToolRunResult;
      readonly checkpoint?: ToolTransactionCheckpointEvidence;
    }
  | {
      readonly status: "cancelled";
      readonly callId: string;
      readonly executed: false;
      readonly reason: string;
      readonly checkpoint?: ToolTransactionCheckpointEvidence;
    }
  | {
      readonly status: "failed";
      readonly callId: string;
      readonly executed: false;
      readonly phase:
        "execution_policy" | "checkpoint_prepare" | "effect_prepare";
      readonly error: ToolTransactionError;
      readonly checkpoint?: ToolTransactionCheckpointEvidence;
    }
  | {
      readonly status: "unknown";
      readonly callId: string;
      readonly executed: true;
      readonly phase: "execute" | "effect_settle";
      readonly error: ToolTransactionError;
      readonly originalResult?: ToolRunResult;
      readonly checkpoint?: ToolTransactionCheckpointEvidence;
    };

function errorEvidence(error: unknown): ToolTransactionError {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: "Error", message: String(error) };
}

function cancellationReason(signal: AbortSignal): string {
  return signal.reason instanceof Error
    ? signal.reason.message
    : typeof signal.reason === "string" && signal.reason.trim()
      ? signal.reason
      : "tool call cancelled";
}

function finalizeEvidence(
  input: ToolExecutionTransactionInput,
  checkpoint: ToolTransactionCheckpointEvidence | undefined,
  toolSucceeded: boolean,
): ToolTransactionCheckpointEvidence | undefined {
  if (!checkpoint) return undefined;
  try {
    const finalized = finalizeCheckpoint(
      input.context.workspaceRoot,
      input.checkpointNamespaceId,
      checkpoint.seq,
      { toolSucceeded },
    );
    if (!finalized) {
      return {
        ...checkpoint,
        finalized: false,
        error: "prepared checkpoint disappeared before finalization",
      };
    }
    return { ...checkpoint, finalized: true };
  } catch (error) {
    return {
      ...checkpoint,
      finalized: false,
      error: errorEvidence(error).message,
    };
  }
}

/**
 * Executes exactly one tool call through a fixed safety transaction:
 * policy → explicit approval → checkpoint → effect prepare → execute →
 * effect settle → checkpoint finalize.
 */
export async function executeToolTransaction(
  input: ToolExecutionTransactionInput,
): Promise<ToolExecutionTransactionOutcome> {
  const policyInput: ToolExecutionPolicyInput = {
    tool: input.tool,
    args: input.args,
    workspaceRoot: input.context.workspaceRoot,
  };

  if (input.signal.aborted) {
    return {
      status: "cancelled",
      callId: input.callId,
      executed: false,
      reason: cancellationReason(input.signal),
    };
  }

  try {
    const decision = await input.executionPolicy?.(policyInput);
    if (decision && !decision.allowed) {
      return {
        status: "denied",
        callId: input.callId,
        executed: false,
        reason: decision.reason,
        message: decision.message,
      };
    }
  } catch (error) {
    return {
      status: "failed",
      callId: input.callId,
      executed: false,
      phase: "execution_policy",
      error: errorEvidence(error),
    };
  }

  if (!input.approval.approved) {
    return {
      status: "denied",
      callId: input.callId,
      executed: false,
      reason: input.approval.reason,
      message: input.approval.message,
    };
  }

  let checkpoint: ToolTransactionCheckpointEvidence | undefined;
  const needsCheckpoint = requiresToolCheckpointV1(input.tool);
  if (needsCheckpoint) {
    if (
      input.checkpointSeq === undefined ||
      !Number.isSafeInteger(input.checkpointSeq) ||
      input.checkpointSeq <= 0
    ) {
      return {
        status: "failed",
        callId: input.callId,
        executed: false,
        phase: "checkpoint_prepare",
        error: {
          name: "TypeError",
          message:
            "mutating tool transaction requires a positive checkpointSeq",
        },
      };
    }
    try {
      saveCheckpoint(
        input.context.workspaceRoot,
        input.checkpointNamespaceId,
        input.checkpointSeq,
        input.tool,
        input.args,
      );
      checkpoint = {
        seq: input.checkpointSeq,
        prepared: true,
        finalized: false,
      };
    } catch (error) {
      return {
        status: "failed",
        callId: input.callId,
        executed: false,
        phase: "checkpoint_prepare",
        error: errorEvidence(error),
      };
    }
  }

  let preparedEffect: unknown;
  let inspectEffect = false;
  try {
    inspectEffect = input.effectPolicy
      ? (input.effectPolicy.appliesTo?.(policyInput) ?? true)
      : false;
    if (input.effectPolicy && inspectEffect) {
      preparedEffect = await input.effectPolicy.prepare(policyInput);
    }
  } catch (error) {
    checkpoint = finalizeEvidence(input, checkpoint, false);
    return {
      status: "failed",
      callId: input.callId,
      executed: false,
      phase: "effect_prepare",
      error: errorEvidence(error),
      ...(checkpoint ? { checkpoint } : {}),
    };
  }

  if (input.signal.aborted) {
    checkpoint = finalizeEvidence(input, checkpoint, false);
    return {
      status: "cancelled",
      callId: input.callId,
      executed: false,
      reason: cancellationReason(input.signal),
      ...(checkpoint ? { checkpoint } : {}),
    };
  }

  let rawResult: ToolRunResult;
  try {
    rawResult = await executeTool(
      {
        ...input.context,
        parentRunId: input.runId,
        currentToolCallId: input.callId,
        checkpointNamespaceId: input.checkpointNamespaceId,
        abortSignal: input.signal,
        ...(input.tool === "workspace.run_shell"
          ? { shellCommandPreApproved: true }
          : {}),
      },
      input.tool,
      input.args,
    );
  } catch (error) {
    checkpoint = finalizeEvidence(input, checkpoint, false);
    return {
      status: "unknown",
      callId: input.callId,
      executed: true,
      phase: "execute",
      error: errorEvidence(error),
      ...(checkpoint ? { checkpoint } : {}),
    };
  }

  let result = rawResult;
  if (input.effectPolicy && inspectEffect) {
    try {
      const decision = await input.effectPolicy.settle(
        { ...policyInput, result: rawResult },
        preparedEffect,
      );
      if (!decision.allowed) {
        checkpoint = finalizeEvidence(input, checkpoint, false);
        return {
          status: "rejected",
          callId: input.callId,
          executed: true,
          reason: decision.reason,
          message: decision.message,
          recovered: decision.recovered,
          originalResult: rawResult,
          ...(checkpoint ? { checkpoint } : {}),
        };
      }
      result = decision.result ?? rawResult;
    } catch (error) {
      checkpoint = finalizeEvidence(input, checkpoint, false);
      return {
        status: "unknown",
        callId: input.callId,
        executed: true,
        phase: "effect_settle",
        error: errorEvidence(error),
        originalResult: rawResult,
        ...(checkpoint ? { checkpoint } : {}),
      };
    }
  }

  checkpoint = finalizeEvidence(input, checkpoint, result.ok);
  return {
    status: "completed",
    callId: input.callId,
    executed: true,
    result,
    ...(checkpoint ? { checkpoint } : {}),
  };
}
