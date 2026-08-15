import { describe, expect, test } from "bun:test";

import {
  type ManagedJobOutcomeV1,
  ManagedJobRegistryV1,
} from "../src/jobs/managed-job-registry.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function startFake(
  registry: ManagedJobRegistryV1,
  ownerId: string,
  options?: {
    readonly kind?: string;
    readonly cancel?: (reason?: string) => void;
    readonly output?: () => string;
    readonly done?: ReturnType<typeof deferred<ManagedJobOutcomeV1>>;
  },
) {
  const done = options?.done ?? deferred<ManagedJobOutcomeV1>();
  const id = registry.start({
    ownerId,
    kind: options?.kind ?? "shell",
    label: "long test",
    run: () => ({
      cancel: options?.cancel ?? (() => done.resolve({ status: "killed" })),
      done: done.promise,
      ...(options?.output ? { readOutput: options.output } : {}),
    }),
  });
  return { id, done };
}

describe("ManagedJobRegistryV1", () => {
  test("preflights controller and starter before consuming an id", async () => {
    const registry = new ManagedJobRegistryV1();
    let starts = 0;
    expect(() =>
      registry.start({
        ownerId: "run-a",
        kind: "shell",
        label: "x",
        run: () => {
          starts += 1;
          throw new Error("should not start");
        },
      }),
    ).toThrow("no controller attached");
    expect(starts).toBe(0);

    registry.attachController("run-a");
    expect(() =>
      registry.start({
        ownerId: "run-a",
        kind: "shell",
        label: "x",
        run: () => {
          starts += 1;
          throw new Error("starter failed");
        },
      }),
    ).toThrow("starter failed");
    const job = startFake(registry, "run-a");
    expect(job.id).toBe("shell-1");
    job.done.resolve({ status: "completed" });
    await job.done.promise;
  });

  test("fences predictable ids by exact owner", async () => {
    const registry = new ManagedJobRegistryV1();
    registry.attachController("run-a");
    registry.attachController("run-b");
    const job = startFake(registry, "run-a");
    expect(() => registry.get("run-b", job.id)).toThrow(
      "belongs to another owner",
    );
    expect(registry.list("run-b")).toEqual([]);
    expect(registry.get("run-a", job.id).ownerId).toBe("run-a");
    job.done.resolve({ status: "completed" });
    await job.done.promise;
  });

  test("enforces active-job limits per owner", async () => {
    const registry = new ManagedJobRegistryV1({
      maxConcurrentJobsPerOwner: 1,
    });
    registry.attachController("run-a");
    const first = startFake(registry, "run-a");
    expect(() => startFake(registry, "run-a")).toThrow("limit reached");
    first.done.resolve({ status: "completed" });
    await first.done.promise;
    await Promise.resolve();
    const second = startFake(registry, "run-a");
    expect(second.id).toBe("shell-2");
    second.done.resolve({ status: "completed" });
    await second.done.promise;
  });

  test("read uses one producer-owned consuming cursor", async () => {
    const registry = new ManagedJobRegistryV1();
    registry.attachController("run-a");
    const chunks = ["first", "second", ""];
    const job = startFake(registry, "run-a", {
      output: () => chunks.shift() ?? "",
    });
    expect(registry.read("run-a", job.id).text).toBe("first");
    expect(registry.read("run-a", job.id).text).toBe("second");
    job.done.resolve({ status: "completed" });
    await job.done.promise;
  });

  test("kill exposes stopping and cancel throws cannot forge it", async () => {
    const registry = new ManagedJobRegistryV1();
    registry.attachController("run-a");
    const throwing = startFake(registry, "run-a", {
      cancel: () => {
        throw new Error("cancel failed");
      },
    });
    expect(() => registry.kill("run-a", throwing.id)).toThrow("cancel failed");
    expect(registry.get("run-a", throwing.id).status).toBe("running");
    throwing.done.resolve({ status: "failed" });
    await throwing.done.promise;

    const cancellableDone = deferred<ManagedJobOutcomeV1>();
    const cancellable = startFake(registry, "run-a", {
      done: cancellableDone,
      cancel: () => {},
    });
    expect(registry.kill("run-a", cancellable.id)).toBe("requested");
    expect(registry.get("run-a", cancellable.id).status).toBe("stopping");
    expect(registry.get("run-a", cancellable.id).reported).toBe(true);
    cancellableDone.resolve({ status: "killed" });
    await cancellableDone.promise;
  });

  test("wait is bounded and settlement releases all waiters", async () => {
    const registry = new ManagedJobRegistryV1();
    registry.attachController("run-a");
    const job = startFake(registry, "run-a");
    const timed = await registry.wait("run-a", job.id, 5);
    expect(timed.timedOut).toBe(true);
    expect(timed.snapshot.status).toBe("running");

    const waiting = registry.wait("run-a", job.id, 1_000);
    job.done.resolve({ status: "completed", detail: "exit code: 0" });
    const settled = await waiting;
    expect(settled.timedOut).toBe(false);
    expect(settled.snapshot.status).toBe("completed");
    expect(settled.snapshot.reported).toBe(true);
  });

  test("terminal commit wins once and listeners run after commit", async () => {
    const registry = new ManagedJobRegistryV1();
    registry.attachController("run-a");
    const seen: string[] = [];
    registry.onDone((snapshot) => {
      seen.push(
        `${snapshot.status}:${registry.get("run-a", snapshot.id).status}`,
      );
      throw new Error("contained listener");
    });
    const job = startFake(registry, "run-a");
    job.done.resolve({ status: "completed", detail: "first" });
    await job.done.promise;
    await Promise.resolve();
    expect(seen).toEqual(["completed:completed"]);
    expect(registry.get("run-a", job.id).detail).toBe("first");
    expect(registry.kill("run-a", job.id)).toBe("already_finished");
    expect(registry.get("run-a", job.id).status).toBe("completed");
  });

  test("owner teardown cancels, bounds noncompliant work, and removes records", async () => {
    const registry = new ManagedJobRegistryV1();
    registry.attachController("run-a");
    let cancelled = false;
    const never = deferred<ManagedJobOutcomeV1>();
    startFake(registry, "run-a", {
      done: never,
      cancel: () => {
        cancelled = true;
      },
    });
    await registry.disposeOwner("run-a", 5);
    expect(cancelled).toBe(true);
    expect(registry.list("run-a")).toEqual([]);
    expect(() => startFake(registry, "run-a")).toThrow(
      "no controller attached",
    );
  });
});
