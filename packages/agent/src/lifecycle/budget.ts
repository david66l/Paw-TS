/**
 * LifecycleBudget — first-class step / timeout / child / idle-fuse budgets.
 * CLI, factory, SWE-Exp, and resume should resolve through here instead of
 * scattering magic numbers.
 */

import { MULTI_AGENT_LIMITS } from "../orchestrator/constants.js";

export interface LifecycleBudget {
  /** Max model↔tool turns for the root agent. */
  readonly maxSteps: number;
  /** Optional wall-clock timeout (ms). */
  readonly timeoutMs?: number;
  /** Default maxSteps for child agents. */
  readonly childMaxSteps: number;
  /**
   * After this many idle-fuse trips in one run, hard-stop as incomplete
   * (not just inject a recovery hint).
   */
  readonly idleFuseHardStopTrips: number;
}

export const DEFAULT_LIFECYCLE_BUDGET: LifecycleBudget = {
  maxSteps: 32,
  childMaxSteps: MULTI_AGENT_LIMITS.maxChildSteps,
  idleFuseHardStopTrips: 2,
};

/** Long-run / SWE-Exp style defaults (still overridable). */
export const HEADLESS_LIFECYCLE_BUDGET: LifecycleBudget = {
  maxSteps: 64,
  timeoutMs: 20 * 60_000,
  childMaxSteps: MULTI_AGENT_LIMITS.maxChildSteps,
  idleFuseHardStopTrips: 2,
};

export function resolveLifecycleBudget(
  partial?: Partial<LifecycleBudget>,
): LifecycleBudget {
  const base = DEFAULT_LIFECYCLE_BUDGET;
  return {
    maxSteps:
      partial?.maxSteps !== undefined && Number.isFinite(partial.maxSteps)
        ? Math.max(1, Math.floor(partial.maxSteps))
        : base.maxSteps,
    ...(partial?.timeoutMs !== undefined && Number.isFinite(partial.timeoutMs)
      ? { timeoutMs: Math.max(1_000, Math.floor(partial.timeoutMs)) }
      : base.timeoutMs !== undefined
        ? { timeoutMs: base.timeoutMs }
        : {}),
    childMaxSteps:
      partial?.childMaxSteps !== undefined &&
      Number.isFinite(partial.childMaxSteps)
        ? Math.max(1, Math.floor(partial.childMaxSteps))
        : base.childMaxSteps,
    idleFuseHardStopTrips:
      partial?.idleFuseHardStopTrips !== undefined &&
      Number.isFinite(partial.idleFuseHardStopTrips)
        ? Math.max(1, Math.floor(partial.idleFuseHardStopTrips))
        : base.idleFuseHardStopTrips,
  };
}

/**
 * Build an AbortSignal that fires at timeoutMs, optionally chaining a parent.
 * Caller must clear() to avoid timer leaks.
 */
export function createBudgetAbort(
  timeoutMs: number | undefined,
  parent?: AbortSignal,
): { readonly signal: AbortSignal; readonly clear: () => void } {
  const ac = new AbortController();
  const onParentAbort = () => {
    try {
      ac.abort(parent?.reason);
    } catch {
      ac.abort();
    }
  };
  if (parent) {
    if (parent.aborted) onParentAbort();
    else parent.addEventListener("abort", onParentAbort, { once: true });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMs !== undefined && timeoutMs > 0) {
    timer = setTimeout(() => {
      try {
        ac.abort(new Error(`LifecycleBudget timeout after ${timeoutMs}ms`));
      } catch {
        ac.abort();
      }
    }, timeoutMs);
    timer.unref?.();
  }
  return {
    signal: ac.signal,
    clear: () => {
      if (timer) clearTimeout(timer);
      if (parent) parent.removeEventListener("abort", onParentAbort);
    },
  };
}
