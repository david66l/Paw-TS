import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  EMPTY_RUN_JOURNAL_PREFIX_HASH_V1,
  type FileSessionExecutionLeaseV1,
  type SessionLeaseScheduledTaskV1,
  type SessionLeaseSchedulerV1,
  acquireFileSessionExecutionLeaseV1,
  releaseFileSessionExecutionLeaseV1,
  superviseSessionLeaseV1,
} from "../src/index.js";

const roots: string[] = [];
const POLICY = Object.freeze({
  policyVersion: "paw.session-lease-heartbeat.v1" as const,
  ttlMs: 90,
  intervalMs: 20,
});

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("Session lease heartbeat supervisor", () => {
  test("uses issued bound renewal, replans one shot and leaves release to composition", async () => {
    const root = workspace();
    const scheduler = new ManualLeaseScheduler(1_000);
    const lease = acquire(root, scheduler);
    let shadowRenewCalls = 0;
    Object.defineProperty(lease, "renew", {
      configurable: true,
      value: async () => {
        shadowRenewCalls += 1;
      },
    });
    const work = deferred<string>();

    const supervised = superviseSessionLeaseV1({
      lease,
      workspaceRoot: root,
      sessionId: "session",
      runId: "run",
      scheduler,
      heartbeatPolicy: POLICY,
      work: async () => work.promise,
    });
    expect(scheduler.pendingDeadlines()).toEqual([1_020]);

    scheduler.advanceTo(1_020);
    await flushMicrotasks();
    expect(shadowRenewCalls).toBe(0);
    expect(lease.expiresAt).toBe(1_110);
    expect(scheduler.pendingDeadlines()).toEqual([1_040]);
    scheduler.fireTaskAgain(0);
    await flushMicrotasks();
    expect(scheduler.pendingDeadlines()).toEqual([1_040]);

    work.resolve("done");
    await expect(supervised).resolves.toBe("done");
    expect(scheduler.pendingDeadlines()).toEqual([]);
    expect(lease.signal.aborted).toBe(false);

    let shadowReleaseCalls = 0;
    Object.defineProperty(lease, "release", {
      configurable: true,
      value: async () => {
        shadowReleaseCalls += 1;
        return "released";
      },
    });
    await expect(
      releaseFileSessionExecutionLeaseV1(lease, root, "session", "run"),
    ).resolves.toBe("released");
    expect(shadowReleaseCalls).toBe(0);
    scheduler.advanceTo(2_000);
    scheduler.fireAllForCancellationRace();
    await flushMicrotasks();
    expect(lease.expiresAt).toBe(1_110);
  });

  test("renewal loss aborts work and rejects even when work returns success", async () => {
    const root = workspace();
    const scheduler = new ManualLeaseScheduler(2_000);
    const lease = acquire(root, scheduler);
    let receivedReason: unknown;
    const supervised = superviseSessionLeaseV1({
      lease,
      workspaceRoot: root,
      sessionId: "session",
      runId: "run",
      scheduler,
      heartbeatPolicy: POLICY,
      work: async (signal) =>
        new Promise<string>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              receivedReason = signal.reason;
              resolve("ignored-abort");
            },
            { once: true },
          );
        }),
    });

    scheduler.advanceTo(2_090);
    await expect(supervised).rejects.toThrow("expired lease cannot be renewed");
    expect(receivedReason).toBeInstanceOf(Error);
    expect(scheduler.pendingDeadlines()).toEqual([]);
  });

  test("caller abort reaches work but heartbeat stops only after work returns", async () => {
    const root = workspace();
    const scheduler = new ManualLeaseScheduler(3_000);
    const lease = acquire(root, scheduler);
    const caller = new AbortController();
    const finish = deferred<void>();
    let workSignal: AbortSignal | undefined;
    const supervised = superviseSessionLeaseV1({
      lease,
      workspaceRoot: root,
      sessionId: "session",
      runId: "run",
      callerSignal: caller.signal,
      scheduler,
      heartbeatPolicy: POLICY,
      async work(signal) {
        workSignal = signal;
        await finish.promise;
        return "finished";
      },
    });

    const reason = new Error("caller stopped waiting");
    caller.abort(reason);
    expect(workSignal?.aborted).toBe(true);
    expect(workSignal?.reason).toBe(reason);
    scheduler.advanceTo(3_020);
    await flushMicrotasks();
    expect(lease.expiresAt).toBe(3_110);
    expect(scheduler.pendingDeadlines()).toEqual([3_040]);

    finish.resolve();
    await expect(supervised).resolves.toBe("finished");
    expect(scheduler.pendingDeadlines()).toEqual([]);
    await releaseFileSessionExecutionLeaseV1(lease, root, "session", "run");
  });

  test("work completion waits for an already-started renewal", async () => {
    const root = workspace();
    const scheduler = new ManualLeaseScheduler(3_500);
    const lease = acquire(root, scheduler);
    const finish = deferred<void>();
    const supervised = superviseSessionLeaseV1({
      lease,
      workspaceRoot: root,
      sessionId: "session",
      runId: "run",
      scheduler,
      heartbeatPolicy: POLICY,
      async work() {
        await finish.promise;
        return "done";
      },
    });

    scheduler.advanceTo(3_520);
    finish.resolve(undefined);
    await expect(supervised).resolves.toBe("done");
    expect(lease.expiresAt).toBe(3_610);
    expect(scheduler.pendingDeadlines()).toEqual([]);
    await releaseFileSessionExecutionLeaseV1(lease, root, "session", "run");
  });

  test("fails before work for identity or policy mismatch", async () => {
    const root = workspace();
    const scheduler = new ManualLeaseScheduler(4_000);
    const lease = acquire(root, scheduler);
    let workCalls = 0;
    const work = async () => {
      workCalls += 1;
    };

    await expect(
      superviseSessionLeaseV1({
        lease,
        workspaceRoot: root,
        sessionId: "wrong-session",
        runId: "run",
        scheduler,
        heartbeatPolicy: POLICY,
        work,
      }),
    ).rejects.toThrow("identity mismatch");
    await expect(
      superviseSessionLeaseV1({
        lease,
        workspaceRoot: root,
        sessionId: "session",
        runId: "run",
        scheduler,
        heartbeatPolicy: { ...POLICY, ttlMs: 120 },
        work,
      }),
    ).rejects.toThrow("does not match");
    expect(workCalls).toBe(0);
    expect(scheduler.pendingDeadlines()).toEqual([]);
    await releaseFileSessionExecutionLeaseV1(lease, root, "session", "run");
  });

  test("a throwing initial scheduler is a hard gate with no late renewal", async () => {
    const root = workspace();
    const clock = new ManualLeaseScheduler(5_000);
    const lease = acquire(root, clock);
    let lateTask: (() => void) | undefined;
    let workCalls = 0;
    const scheduler: SessionLeaseSchedulerV1 = {
      now: () => clock.now(),
      scheduleAt(_deadlineMs, task) {
        lateTask = task;
        throw new Error("scheduler unavailable");
      },
    };

    await expect(
      superviseSessionLeaseV1({
        lease,
        workspaceRoot: root,
        sessionId: "session",
        runId: "run",
        scheduler,
        heartbeatPolicy: POLICY,
        work: async () => {
          workCalls += 1;
        },
      }),
    ).rejects.toThrow("scheduler unavailable");
    expect(workCalls).toBe(0);
    lateTask?.();
    await flushMicrotasks();
    expect(lease.expiresAt).toBe(5_090);
    await releaseFileSessionExecutionLeaseV1(lease, root, "session", "run");
  });

  test("an initial scheduler without a cancel handle is a hard gate", async () => {
    const root = workspace();
    const clock = new ManualLeaseScheduler(6_000);
    const lease = acquire(root, clock);
    let lateTask: (() => void) | undefined;
    let workCalls = 0;
    const scheduler: SessionLeaseSchedulerV1 = {
      now: () => clock.now(),
      scheduleAt(_deadlineMs, task) {
        lateTask = task;
        return {} as SessionLeaseScheduledTaskV1;
      },
    };

    await expect(
      superviseSessionLeaseV1({
        lease,
        workspaceRoot: root,
        sessionId: "session",
        runId: "run",
        scheduler,
        heartbeatPolicy: POLICY,
        work: async () => {
          workCalls += 1;
        },
      }),
    ).rejects.toThrow("no cancellation handle");
    expect(workCalls).toBe(0);
    lateTask?.();
    await flushMicrotasks();
    expect(lease.expiresAt).toBe(6_090);
    await releaseFileSessionExecutionLeaseV1(lease, root, "session", "run");
  });

  test("released and expired leases fail before scheduling or work", async () => {
    for (const state of ["released", "expired"] as const) {
      const root = workspace();
      const clock = new ManualLeaseScheduler(
        state === "released" ? 7_000 : 8_000,
      );
      const lease = acquire(root, clock);
      if (state === "released") {
        await releaseFileSessionExecutionLeaseV1(lease, root, "session", "run");
      } else {
        clock.advanceTo(8_090);
      }
      let scheduleCalls = 0;
      let workCalls = 0;
      const scheduler: SessionLeaseSchedulerV1 = {
        now: () => clock.now(),
        scheduleAt() {
          scheduleCalls += 1;
          return Object.freeze({ cancel() {} });
        },
      };

      await expect(
        superviseSessionLeaseV1({
          lease,
          workspaceRoot: root,
          sessionId: "session",
          runId: "run",
          scheduler,
          heartbeatPolicy: POLICY,
          work: async () => {
            workCalls += 1;
          },
        }),
      ).rejects.toThrow(state === "released" ? "not held" : "expired");
      expect(scheduleCalls).toBe(0);
      expect(workCalls).toBe(0);
    }
  });

  test("an already-aborted caller keeps heartbeats alive until work settles", async () => {
    const root = workspace();
    const scheduler = new ManualLeaseScheduler(9_000);
    const lease = acquire(root, scheduler);
    const caller = new AbortController();
    const reason = new Error("already cancelled");
    caller.abort(reason);
    const finish = deferred<void>();
    let workSignal: AbortSignal | undefined;
    const supervised = superviseSessionLeaseV1({
      lease,
      workspaceRoot: root,
      sessionId: "session",
      runId: "run",
      callerSignal: caller.signal,
      scheduler,
      heartbeatPolicy: POLICY,
      async work(signal) {
        workSignal = signal;
        await finish.promise;
        return "done";
      },
    });

    expect(workSignal?.aborted).toBe(true);
    expect(workSignal?.reason).toBe(reason);
    scheduler.advanceTo(9_020);
    await flushMicrotasks();
    expect(lease.expiresAt).toBe(9_110);
    expect(scheduler.pendingDeadlines()).toEqual([9_040]);
    finish.resolve(undefined);
    await expect(supervised).resolves.toBe("done");
    await releaseFileSessionExecutionLeaseV1(lease, root, "session", "run");
  });

  test("a scheduler that fires synchronously fails closed before work", async () => {
    const root = workspace();
    const clock = new ManualLeaseScheduler(10_000);
    const lease = acquire(root, clock);
    let cancelCalls = 0;
    let workCalls = 0;
    const scheduler: SessionLeaseSchedulerV1 = {
      now: () => clock.now(),
      scheduleAt(_deadlineMs, task) {
        task();
        return Object.freeze({
          cancel() {
            cancelCalls += 1;
          },
        });
      },
    };

    await expect(
      superviseSessionLeaseV1({
        lease,
        workspaceRoot: root,
        sessionId: "session",
        runId: "run",
        scheduler,
        heartbeatPolicy: POLICY,
        work: async () => {
          workCalls += 1;
        },
      }),
    ).rejects.toThrow("fired before");
    expect(cancelCalls).toBe(1);
    expect(workCalls).toBe(0);
    expect(lease.expiresAt).toBe(10_090);
    await releaseFileSessionExecutionLeaseV1(lease, root, "session", "run");
  });
});

class ManualLeaseScheduler implements SessionLeaseSchedulerV1 {
  private tasks: Array<{
    readonly deadlineMs: number;
    readonly task: () => void;
    cancelled: boolean;
  }> = [];

  constructor(private nowMs: number) {}

  now(): number {
    return this.nowMs;
  }

  scheduleAt(
    deadlineMs: number,
    task: () => void,
  ): SessionLeaseScheduledTaskV1 {
    const entry = { deadlineMs, task, cancelled: false };
    this.tasks.push(entry);
    return Object.freeze({
      cancel: () => {
        entry.cancelled = true;
      },
    });
  }

  advanceTo(nowMs: number): void {
    if (nowMs < this.nowMs)
      throw new Error("manual clock cannot move backward");
    this.nowMs = nowMs;
    for (;;) {
      const next = this.tasks
        .filter((entry) => !entry.cancelled && entry.deadlineMs <= nowMs)
        .sort((left, right) => left.deadlineMs - right.deadlineMs)[0];
      if (!next) return;
      next.cancelled = true;
      next.task();
    }
  }

  pendingDeadlines(): number[] {
    return this.tasks
      .filter((entry) => !entry.cancelled)
      .map((entry) => entry.deadlineMs)
      .sort((left, right) => left - right);
  }

  fireAllForCancellationRace(): void {
    for (const entry of this.tasks) entry.task();
  }

  fireTaskAgain(index: number): void {
    const entry = this.tasks[index];
    if (!entry) throw new Error(`missing scheduled task ${index}`);
    entry.task();
  }
}

function acquire(
  root: string,
  scheduler: ManualLeaseScheduler,
): FileSessionExecutionLeaseV1 {
  const acquired = acquireFileSessionExecutionLeaseV1({
    workspaceRoot: root,
    sessionId: "session",
    runId: "run",
    ttlMs: POLICY.ttlMs,
    baseTailSeq: 0,
    basePrefixHash: EMPTY_RUN_JOURNAL_PREFIX_HASH_V1,
    clock: () => scheduler.now(),
  });
  if (acquired.status !== "acquired") throw new Error("expected lease");
  return acquired.lease;
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paw-lease-supervisor-"));
  roots.push(root);
  return root;
}
