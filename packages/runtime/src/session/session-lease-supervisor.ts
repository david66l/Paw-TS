import type { FileSessionExecutionLeaseV1 } from "./session-execution-lease.js";
import { assertFileSessionExecutionLeaseCapabilityV1 } from "./session-execution-lease.js";

export interface SessionLeaseScheduledTaskV1 {
  cancel(): void;
}

export interface SessionLeaseSchedulerV1 {
  now(): number;
  scheduleAt(deadlineMs: number, task: () => void): SessionLeaseScheduledTaskV1;
}

export interface SuperviseSessionLeaseOptionsV1<TResult> {
  readonly lease: FileSessionExecutionLeaseV1;
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly callerSignal?: AbortSignal;
  readonly scheduler: SessionLeaseSchedulerV1;
  readonly heartbeatPolicy: SessionLeaseHeartbeatPolicyV1;
  readonly work: (signal: AbortSignal) => Promise<TResult>;
}

export interface SessionLeaseHeartbeatPolicyV1 {
  readonly policyVersion: "paw.session-lease-heartbeat.v1";
  readonly ttlMs: number;
  readonly intervalMs: number;
}

export const DEFAULT_SESSION_LEASE_HEARTBEAT_POLICY_V1 = Object.freeze({
  policyVersion: "paw.session-lease-heartbeat.v1",
  ttlMs: 90_000,
  intervalMs: 20_000,
}) satisfies SessionLeaseHeartbeatPolicyV1;

export function freezeSessionLeaseHeartbeatPolicyV1(
  input: SessionLeaseHeartbeatPolicyV1,
): SessionLeaseHeartbeatPolicyV1 {
  if (input.policyVersion !== "paw.session-lease-heartbeat.v1") {
    throw new Error("Unsupported Session lease heartbeat policy version");
  }
  if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs <= 0) {
    throw new Error(
      "Session lease heartbeat ttlMs must be a positive safe integer",
    );
  }
  if (
    !Number.isSafeInteger(input.intervalMs) ||
    input.intervalMs <= 0 ||
    input.intervalMs > Math.floor(input.ttlMs / 3)
  ) {
    throw new Error(
      "Session lease heartbeat intervalMs must be positive and at most ttlMs / 3",
    );
  }
  return Object.freeze({
    policyVersion: input.policyVersion,
    ttlMs: input.ttlMs,
    intervalMs: input.intervalMs,
  });
}

export const WALL_CLOCK_SESSION_LEASE_SCHEDULER_ID_V1 =
  "paw.wall-clock-session-lease-scheduler.v1" as const;

export const WALL_CLOCK_SESSION_LEASE_SCHEDULER_V1: SessionLeaseSchedulerV1 =
  Object.freeze({
    now: Date.now,
    scheduleAt(deadlineMs: number, task: () => void) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let cancelled = false;
      const arm = (): void => {
        if (cancelled) return;
        const remainingMs = Math.max(0, deadlineMs - Date.now());
        if (remainingMs > 2_147_483_647) {
          timer = setTimeout(arm, 2_147_483_647);
          return;
        }
        timer = setTimeout(task, remainingMs);
      };
      arm();
      return Object.freeze({
        cancel: () => {
          cancelled = true;
          if (timer) clearTimeout(timer);
        },
      });
    },
  });

/**
 * Run one Session owner while renewing its issued cross-process lease.
 *
 * The scheduler is one-shot. A new deadline is installed only after the prior
 * renewal settles, so heartbeats never overlap. This function never releases
 * the lease; composition retains sole cleanup ownership.
 */
export async function superviseSessionLeaseV1<TResult>(
  options: SuperviseSessionLeaseOptionsV1<TResult>,
): Promise<TResult> {
  const capability = assertFileSessionExecutionLeaseCapabilityV1(
    options.lease,
    options.workspaceRoot,
    options.sessionId,
    options.runId,
  );
  const heartbeatPolicy = freezeSessionLeaseHeartbeatPolicyV1(
    options.heartbeatPolicy,
  );
  assertSupervisorConfig(
    options.scheduler,
    heartbeatPolicy,
    capability.readLeaseDurationMs(),
  );
  capability.assertHeld();

  const controller = new AbortController();
  const detachSignals = forwardFirstAbortReason(controller, [
    options.callerSignal,
    capability.signal,
  ]);
  let scheduled: SessionLeaseScheduledTaskV1 | undefined;
  let inFlight: Promise<void> | undefined;
  let stopped = false;
  let renewError: unknown;

  const abortForRenewFailure = (error: unknown): void => {
    if (renewError === undefined) renewError = error;
    abortOnce(controller, error);
  };
  const scheduleNext = (): boolean => {
    if (stopped || renewError !== undefined) return false;
    let deadlineMs: number;
    let timerArmed = false;
    let fired = false;
    try {
      const now = options.scheduler.now();
      assertTimestamp(now, "scheduler now");
      deadlineMs = addTimestamp(now, heartbeatPolicy.intervalMs);
      assertTimestamp(deadlineMs, "heartbeat deadline");
      const candidate: unknown = options.scheduler.scheduleAt(
        deadlineMs,
        () => {
          if (fired) return;
          fired = true;
          if (!timerArmed) return;
          scheduled = undefined;
          if (stopped || inFlight) return;
          inFlight = capability
            .renew()
            .then(() => {
              if (!stopped) scheduleNext();
            })
            .catch(abortForRenewFailure)
            .finally(() => {
              inFlight = undefined;
            });
        },
      );
      if (!isScheduledTask(candidate)) {
        throw new Error(
          "Session lease scheduler returned no cancellation handle",
        );
      }
      if (fired) {
        candidate.cancel();
        throw new Error(
          "Session lease scheduler fired before its cancellation handle was installed",
        );
      }
      scheduled = candidate;
      timerArmed = true;
      return true;
    } catch (error) {
      scheduled = undefined;
      abortForRenewFailure(error);
      return false;
    }
  };

  if (!scheduleNext()) {
    stopped = true;
    scheduled?.cancel();
    scheduled = undefined;
    detachSignals();
    throw asError(renewError, "Session lease heartbeat failed to start");
  }
  let result: TResult | undefined;
  let workError: unknown;
  try {
    result = await options.work(controller.signal);
  } catch (error) {
    workError = error;
  } finally {
    stopped = true;
    scheduled?.cancel();
    scheduled = undefined;
    if (inFlight) await inFlight;
    detachSignals();
  }

  if (renewError !== undefined) {
    if (workError !== undefined) {
      throw new AggregateError(
        [workError, renewError],
        "Session lease renewal and supervised work both failed",
      );
    }
    throw asError(renewError, "Session lease renewal failed");
  }
  if (workError !== undefined) throw workError;
  return result as TResult;
}

function isScheduledTask(value: unknown): value is SessionLeaseScheduledTaskV1 {
  return (
    typeof value === "object" &&
    value !== null &&
    "cancel" in value &&
    typeof value.cancel === "function"
  );
}

function assertSupervisorConfig(
  scheduler: SessionLeaseSchedulerV1,
  heartbeatPolicy: SessionLeaseHeartbeatPolicyV1,
  leaseDurationMs: number,
): void {
  if (
    !scheduler ||
    typeof scheduler.now !== "function" ||
    typeof scheduler.scheduleAt !== "function"
  ) {
    throw new Error("Session lease heartbeat scheduler is invalid");
  }
  if (leaseDurationMs !== heartbeatPolicy.ttlMs) {
    throw new Error(
      "Session lease duration does not match the frozen heartbeat policy",
    );
  }
  assertTimestamp(scheduler.now(), "scheduler now");
}

function addTimestamp(value: number, durationMs: number): number {
  const result = value + durationMs;
  assertTimestamp(result, "heartbeat deadline");
  return result;
}

function forwardFirstAbortReason(
  target: AbortController,
  sources: readonly (AbortSignal | undefined)[],
): () => void {
  const cleanups: Array<() => void> = [];
  for (const source of sources) {
    if (!source) continue;
    if (source.aborted) {
      abortOnce(target, source.reason);
      break;
    }
    const listener = () => abortOnce(target, source.reason);
    source.addEventListener("abort", listener, { once: true });
    cleanups.push(() => source.removeEventListener("abort", listener));
  }
  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}

function abortOnce(controller: AbortController, reason: unknown): void {
  if (!controller.signal.aborted) controller.abort(reason);
}

function assertTimestamp(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `Session lease ${label} must be a non-negative safe integer`,
    );
  }
}

function asError(value: unknown, fallback: string): Error {
  return value instanceof Error
    ? value
    : new Error(`${fallback}: ${String(value)}`);
}
