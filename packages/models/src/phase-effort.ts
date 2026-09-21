import type { LanguageModel } from "./language-model.js";
import type { ModelCompleteOptions } from "./model-options.js";
import { emitModelObservation } from "./observation.js";
import type { ChatMessage } from "./types.js";

/**
 * Phase-aware reasoning effort (desktop-harness-ab V15 follow-up).
 *
 * V15 isolated the max-effort stall to specific decision points: both max
 * samples stayed reasoning-only past 360 s while high samples emitted
 * complete tool calls. The recommended next experiment is an explicit,
 * recorded policy for selecting effort by execution phase. This wrapper is
 * that policy mechanism: the first N tool-bearing main-loop calls of a run
 * use the planning effort; every later call uses the execution effort.
 * Auxiliary complete() calls and tool-less streams pass through unchanged.
 *
 * It is opt-in and orthogonal to thinking recovery: if a planning call stalls,
 * the recovery retry keeps this phase's effort. Evaluate against fixed-effort
 * controls on full tasks before changing any default.
 */
export const PHASE_EFFORT_POLICY = "paw.phase-effort.experimental.v1" as const;

export type ReasoningEffortPhase = "planning" | "execution";

export interface PhaseEffortEvent {
  readonly call: number;
  readonly phase: ReasoningEffortPhase;
  readonly effort: "high" | "max";
}

export interface PhaseEffortOptions {
  readonly planningEffort: "high" | "max";
  readonly executionEffort: "high" | "max";
  /** Tool-bearing calls at indices 0..planningCalls-1 count as planning. */
  readonly planningCalls: number;
  readonly onEvent?: (event: PhaseEffortEvent) => void;
}

/** Instantiate once per run. The call counter is scoped to this wrapper. */
export function createPhaseEffortModel(
  model: LanguageModel,
  policy: PhaseEffortOptions,
): LanguageModel {
  if (
    !["high", "max"].includes(policy.planningEffort) ||
    !["high", "max"].includes(policy.executionEffort)
  ) {
    throw new Error("phase efforts must be high or max");
  }
  if (!Number.isSafeInteger(policy.planningCalls) || policy.planningCalls < 0) {
    throw new Error("planningCalls must be a nonnegative safe integer");
  }
  let call = 0;
  const report = (event: PhaseEffortEvent) => {
    try {
      policy.onEvent?.(event);
    } catch {
      /* Diagnostic sinks cannot change execution. */
    }
  };
  const stream = model.completeStream?.bind(model);
  return {
    label: model.label,
    capabilities: model.capabilities,
    runtimeProfile: model.runtimeProfile,
    complete: model.complete.bind(model),
    ...(stream
      ? {
          async *completeStream(messages: readonly ChatMessage[], options?: ModelCompleteOptions) {
            if (!options?.tools?.length) {
              yield* stream(messages, options);
              return;
            }
            const current = call;
            call += 1;
            const phase: ReasoningEffortPhase =
              current < policy.planningCalls ? "planning" : "execution";
            const effort = phase === "planning" ? policy.planningEffort : policy.executionEffort;
            report({ call: current, phase, effort });
            yield* stream(messages, {
              ...options,
              reasoningEffort: effort,
              onObservation(event) {
                emitModelObservation(options, event);
              },
            });
          },
        }
      : {}),
  };
}
