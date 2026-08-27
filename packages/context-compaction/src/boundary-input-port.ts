import type { LoopInputPort, LoopSafeBoundary } from "@paw/agent-loop";
import type {
  JournalContextPlanV1,
  JournalContextPlannerV1,
} from "@paw/runtime";

import {
  type ContextCompactionPolicyV1,
  DEFAULT_CONTEXT_COMPACTION_POLICY_V1,
  freezeContextCompactionPolicyV1,
} from "./policy.js";
import {
  type ContextCompactionPlanV1,
  planContextCompactionV1,
} from "./range-planner.js";

type JournalContextSnapshotV1 = Parameters<JournalContextPlannerV1["plan"]>[0];

export interface ContextCompactionSnapshotSourceV1 {
  readInputSnapshot(): Promise<JournalContextSnapshotV1>;
}

export interface ContextCompactionBoundaryDecisionV1 {
  readonly boundary: Exclude<LoopSafeBoundary, "before_first_model_request">;
  readonly context: JournalContextPlanV1;
  readonly compaction: ContextCompactionPlanV1;
}

export interface ContextCompactionInputPortOptionsV1 {
  readonly baseInput: LoopInputPort;
  readonly snapshots: ContextCompactionSnapshotSourceV1;
  readonly context: JournalContextPlannerV1;
  readonly signal: AbortSignal;
  readonly policy?: ContextCompactionPolicyV1;
  /** May run distillation and append checkpoint facts before input promotion. */
  readonly onDecision: (
    decision: ContextCompactionBoundaryDecisionV1,
  ) => void | Promise<void>;
  /** Best-effort observation; compaction failure must fall back to base input. */
  readonly onError?: (
    error: unknown,
    boundary: Exclude<LoopSafeBoundary, "before_first_model_request">,
  ) => void | Promise<void>;
}

/**
 * Non-invasive safe-boundary middleware.
 *
 * Planning and optional distillation happen before the base inbox can promote
 * newer input. Any extension failure falls through to the existing L3 request
 * omission path and never blocks input coordination.
 */
export function createContextCompactionInputPortV1(
  options: ContextCompactionInputPortOptionsV1,
): LoopInputPort {
  const baseInput = captureInput(options.baseInput);
  const readInputSnapshot = captureSnapshotSource(options.snapshots);
  const planContext = captureContextPlanner(options.context);
  const onDecision = captureCallback(options.onDecision, "decision");
  const onError =
    options.onError === undefined
      ? undefined
      : captureCallback(options.onError, "error");
  const policy = freezeContextCompactionPolicyV1(
    options.policy ?? DEFAULT_CONTEXT_COMPACTION_POLICY_V1,
  );
  const signal = options.signal;
  if (!signal || typeof signal.aborted !== "boolean") {
    throw new Error("Context compaction signal is invalid");
  }

  return Object.freeze({
    async reportSafeBoundary(boundary: LoopSafeBoundary) {
      if (boundary !== "before_first_model_request" && !signal.aborted) {
        try {
          const snapshot = await readInputSnapshot();
          if (!signal.aborted) {
            const context = await planContext(snapshot, { signal });
            if (!signal.aborted) {
              await onDecision(
                Object.freeze({
                  boundary,
                  context,
                  compaction: planContextCompactionV1(context, policy),
                }),
              );
            }
          }
        } catch (error) {
          if (onError) {
            try {
              await onError(error, boundary);
            } catch {
              // Observability is not allowed to block the canonical inbox.
            }
          }
        }
      }
      await baseInput.reportSafeBoundary(boundary);
    },
    consumePromotedInputIds: baseInput.consumePromotedInputIds,
  });
}

function captureInput(input: LoopInputPort): LoopInputPort {
  if (
    !input ||
    typeof input.reportSafeBoundary !== "function" ||
    typeof input.consumePromotedInputIds !== "function"
  ) {
    throw new Error("Context compaction base input is invalid");
  }
  return Object.freeze({
    reportSafeBoundary: input.reportSafeBoundary.bind(input),
    consumePromotedInputIds: input.consumePromotedInputIds.bind(input),
  });
}

function captureSnapshotSource(
  source: ContextCompactionSnapshotSourceV1,
): ContextCompactionSnapshotSourceV1["readInputSnapshot"] {
  if (!source || typeof source.readInputSnapshot !== "function") {
    throw new Error("Context compaction snapshot source is invalid");
  }
  return source.readInputSnapshot.bind(source);
}

function captureContextPlanner(
  context: JournalContextPlannerV1,
): JournalContextPlannerV1["plan"] {
  if (!context || typeof context.plan !== "function") {
    throw new Error("Context compaction planner is invalid");
  }
  return context.plan.bind(context);
}

function captureCallback<TCallback extends (...args: never[]) => unknown>(
  callback: TCallback,
  name: string,
): TCallback {
  if (typeof callback !== "function") {
    throw new Error(`Context compaction ${name} callback is invalid`);
  }
  return callback.bind(undefined) as TCallback;
}
