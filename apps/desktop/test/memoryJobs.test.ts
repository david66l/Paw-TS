import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type MemoryJob,
  type MemoryJobLocator,
  type MemoryJobStore,
  createDesktopMemoryWorker,
  enqueueDesktopMemoryJob,
} from "../agent-host/memory-jobs.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (
      path.dirname(root) !== path.resolve(os.tmpdir()) ||
      !path.basename(root).startsWith("paw-memory-jobs-")
    )
      throw new Error("Unexpected fixture path");
    fs.rmSync(root, { recursive: true, force: true });
  }
});
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "paw-memory-jobs-"));
  roots.push(directory);
  const locator: MemoryJobLocator = {
    workspaceRoot: directory,
    runId: "desktop-next-test",
    configHash: "a".repeat(64),
    sourceThroughSeq: 10,
  };
  const jobs = new Map<string, MemoryJob>();
  let available = true;
  let claimed = false;
  const completions: string[] = [];
  const store: MemoryJobStore = {
    async put(id, job) {
      if (!available) throw new Error("db unavailable");
      if (!jobs.has(id))
        jobs.set(id, { ...job, id, token: "token", attempts: 1 });
    },
    async claim() {
      if (claimed) return undefined;
      claimed = true;
      return [...jobs.values()][0];
    },
    async finish(_job, status) {
      completions.push(status);
    },
  };
  return {
    directory,
    locator,
    jobs,
    store,
    completions,
    offline() {
      available = false;
    },
    online() {
      available = true;
    },
  };
}
test("durable ingress survives DB failure, restart and duplicate enqueue without task contents or credentials", async () => {
  const f = fixture();
  const id = enqueueDesktopMemoryJob(f.directory, f.locator);
  expect(enqueueDesktopMemoryJob(f.directory, f.locator)).toBe(id);
  expect(fs.readdirSync(f.directory)).toEqual([`${id}.json`]);
  let calls = 0;
  const options = {
    ...f,
    idle: () => true,
    run: async () => {
      calls++;
      return { status: "completed" as const };
    },
  };
  f.offline();
  await expect(createDesktopMemoryWorker(options).tick()).rejects.toThrow(
    "db unavailable",
  );
  expect(fs.existsSync(path.join(f.directory, `${id}.json`))).toBe(true);
  f.online();
  const worker = createDesktopMemoryWorker(options);
  await worker.tick();
  await worker.tick();
  expect(calls).toBe(1);
  expect(f.completions).toEqual(["completed"]);
  expect(fs.readdirSync(f.directory)).toEqual([]);
});
test("worker waits for foreground tasks, bounds concurrency and aborts on shutdown", async () => {
  const f = fixture();
  enqueueDesktopMemoryJob(f.directory, f.locator);
  let idle = false;
  let called = 0;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const worker = createDesktopMemoryWorker({
    ...f,
    idle: () => idle,
    async run(_job, signal) {
      called++;
      entered();
      await new Promise<void>((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      );
      return { status: "completed" };
    },
  });
  await worker.tick();
  expect(called).toBe(0);
  idle = true;
  const running = worker.tick();
  await started;
  await worker.tick();
  expect(called).toBe(1);
  worker.stop();
  await running;
  expect(f.completions).toEqual(["retry"]);
  await worker.tick();
  expect(called).toBe(1);
});

test("foreground work preempts memory and waits for the underlying journal lease cleanup", async () => {
  const f = fixture();
  enqueueDesktopMemoryJob(f.directory, f.locator);
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let released = false;
  const worker = createDesktopMemoryWorker({
    ...f,
    idle: () => true,
    async run(_job, signal) {
      entered();
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      released = true;
      signal.throwIfAborted();
      return { status: "completed" };
    },
  });
  const running = worker.tick();
  await started;
  await worker.yieldToForeground();
  expect(released).toBe(true);
  await running;
  expect(f.completions).toEqual(["retry"]);
  worker.stop();
});
