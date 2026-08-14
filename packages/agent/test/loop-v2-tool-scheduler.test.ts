import { describe, expect, test } from "bun:test";
import {
  type ScheduledToolCallV2,
  type ToolExecutionModeV2,
  type ToolSchedulerHooksV2,
  executeToolBatchV2,
} from "../src/loop-v2/index.js";

interface Prepared {
  readonly callId: string;
}

interface Result {
  readonly value: string;
  readonly skipped?: boolean;
}

function call(
  callId: string,
  tool: string,
  args: Record<string, unknown> = {},
): ScheduledToolCallV2 {
  return { callId, tool, args };
}

function indexOf(trace: readonly string[], event: string): number {
  const index = trace.indexOf(event);
  expect(index).toBeGreaterThanOrEqual(0);
  return index;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (!predicate()) throw new Error("until: condition did not become true");
}

describe("Loop Kernel v2 tool scheduler", () => {
  test("R09 exclusive calls hold a barrier through audit, event, and projector commit", async () => {
    const trace: string[] = [];
    const calls = [
      call("read-a", "read", { path: "a.ts" }),
      call("edit-b", "edit", { path: "b.ts" }),
      call("read-b", "read", { path: "b.ts" }),
      call("test", "test", { scope: "b" }),
    ];
    const hooks: ToolSchedulerHooksV2<Prepared, Result, string> = {
      classify(item): ToolExecutionModeV2 {
        return item.tool === "read"
          ? { kind: "parallel" }
          : { kind: "exclusive", scope: ["b.ts"] };
      },
      async prepare(item) {
        trace.push(`${item.callId}:prepare`);
        return { kind: "dispatch", prepared: { callId: item.callId } };
      },
      async dispatch(prepared) {
        trace.push(`${prepared.callId}:body:start`);
        trace.push(`${prepared.callId}:body:end`);
        return { value: prepared.callId };
      },
      async commit(item, result, _index, mode) {
        trace.push(`${item.callId}:commit:start`);
        if (mode.kind === "exclusive") {
          trace.push(`${item.callId}:after-effect-audit`);
          trace.push(`${item.callId}:event-commit`);
          trace.push(`${item.callId}:projector-update`);
        }
        trace.push(`${item.callId}:commit:end`);
        return result.value;
      },
      async skip(item) {
        return { value: item.callId, skipped: true };
      },
    };

    const result = await executeToolBatchV2(calls, hooks, { maxParallel: 2 });

    expect(result.committed.map((entry) => entry.callId)).toEqual([
      "read-a",
      "edit-b",
      "read-b",
      "test",
    ]);
    expect(indexOf(trace, "read-a:commit:end")).toBeLessThan(
      indexOf(trace, "edit-b:body:start"),
    );
    expect(indexOf(trace, "edit-b:projector-update")).toBeLessThan(
      indexOf(trace, "edit-b:commit:end"),
    );
    expect(indexOf(trace, "edit-b:commit:end")).toBeLessThan(
      indexOf(trace, "read-b:body:start"),
    );
    expect(indexOf(trace, "read-b:commit:end")).toBeLessThan(
      indexOf(trace, "test:body:start"),
    );
  });

  test("R10 mixed read-only child, grep, and edit all execute with source-order commits", async () => {
    const trace: string[] = [];
    const child = deferred<Result>();
    const grep = deferred<Result>();
    const calls = [
      call("child", "run_agent", { policy: "read_only" }),
      call("grep", "grep", { pattern: "Scheduler" }),
      call("edit", "edit", { path: "scheduler.ts" }),
    ];
    const hooks: ToolSchedulerHooksV2<Prepared, Result, string> = {
      classify(item) {
        return item.callId === "edit"
          ? { kind: "exclusive" }
          : { kind: "parallel" };
      },
      async prepare(item) {
        trace.push(`${item.callId}:prepare`);
        return { kind: "dispatch", prepared: { callId: item.callId } };
      },
      async dispatch(prepared) {
        trace.push(`${prepared.callId}:start`);
        if (prepared.callId === "child") return child.promise;
        if (prepared.callId === "grep") return grep.promise;
        trace.push("edit:end");
        return { value: "edit" };
      },
      async commit(item, result) {
        trace.push(`${item.callId}:commit`);
        return result.value;
      },
      async skip(item) {
        return { value: item.callId, skipped: true };
      },
    };

    const running = executeToolBatchV2(calls, hooks, { maxParallel: 2 });
    await until(
      () => trace.includes("child:start") && trace.includes("grep:start"),
    );
    expect(trace).not.toContain("edit:start");
    grep.resolve({ value: "grep" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(trace).not.toContain("grep:commit");
    child.resolve({ value: "child" });
    const result = await running;

    expect(result.committed.map((entry) => entry.callId)).toEqual([
      "child",
      "grep",
      "edit",
    ]);
    expect(trace).toContain("child:start");
    expect(trace).toContain("grep:start");
    expect(trace).toContain("edit:start");
    expect(indexOf(trace, "child:commit")).toBeLessThan(
      indexOf(trace, "grep:commit"),
    );
    expect(indexOf(trace, "grep:commit")).toBeLessThan(
      indexOf(trace, "edit:start"),
    );
  });

  test("an explicitly denied call commits a result without dropping siblings", async () => {
    const dispatched: string[] = [];
    const result = await executeToolBatchV2<Prepared, Result, string>(
      [call("read", "read"), call("denied", "edit"), call("grep", "grep")],
      {
        classify(item) {
          return item.tool === "edit"
            ? { kind: "exclusive" }
            : { kind: "parallel" };
        },
        async prepare(item) {
          return item.callId === "denied"
            ? { kind: "settled", result: { value: "denied" } }
            : { kind: "dispatch", prepared: { callId: item.callId } };
        },
        async dispatch(prepared) {
          dispatched.push(prepared.callId);
          return { value: prepared.callId };
        },
        async commit(_item, settled) {
          return settled.value;
        },
        async skip(item) {
          return { value: item.callId, skipped: true };
        },
      },
    );

    expect(dispatched).toEqual(["read", "grep"]);
    expect(result.committed.map((entry) => entry.value)).toEqual([
      "read",
      "denied",
      "grep",
    ]);
  });

  test("unknown and throwing classifiers fail closed to exclusive", async () => {
    const active: string[] = [];
    let maxActive = 0;
    const result = await executeToolBatchV2<Prepared, Result, string>(
      [call("unknown", "unknown"), call("throwing", "throwing")],
      {
        classify(item) {
          if (item.callId === "throwing") throw new Error("bad classifier");
          return undefined;
        },
        async prepare(item) {
          return { kind: "dispatch", prepared: { callId: item.callId } };
        },
        async dispatch(prepared) {
          active.push(prepared.callId);
          maxActive = Math.max(maxActive, active.length);
          active.pop();
          return { value: prepared.callId };
        },
        async commit(_item, settled) {
          return settled.value;
        },
        async skip(item) {
          return { value: item.callId, skipped: true };
        },
      },
    );

    expect(maxActive).toBe(1);
    expect(result.committed.map((entry) => entry.mode.kind)).toEqual([
      "exclusive",
      "exclusive",
    ]);
  });

  test("pending calls are reclassified after an earlier ordered commit", async () => {
    let forceExclusive = false;
    const trace: string[] = [];
    const result = await executeToolBatchV2<Prepared, Result, string>(
      [call("first", "dynamic"), call("second", "dynamic")],
      {
        classify() {
          return forceExclusive ? { kind: "exclusive" } : { kind: "parallel" };
        },
        async prepare(item) {
          return { kind: "dispatch", prepared: { callId: item.callId } };
        },
        async dispatch(prepared) {
          trace.push(`${prepared.callId}:start`);
          return { value: prepared.callId };
        },
        async commit(item, settled) {
          trace.push(`${item.callId}:commit`);
          if (item.callId === "first") forceExclusive = true;
          return settled.value;
        },
        async skip(item) {
          return { value: item.callId, skipped: true };
        },
      },
      { maxParallel: 1 },
    );

    expect(result.committed.map((entry) => entry.mode.kind)).toEqual([
      "parallel",
      "exclusive",
    ]);
    expect(trace).toEqual([
      "first:start",
      "first:commit",
      "second:start",
      "second:commit",
    ]);
  });

  test("cancellation gives every unstarted model call an explicit ordered result", async () => {
    const controller = new AbortController();
    controller.abort();
    const dispatched: string[] = [];
    const skipped: string[] = [];
    const result = await executeToolBatchV2<Prepared, Result, string>(
      [call("one", "read"), call("two", "edit"), call("three", "grep")],
      {
        classify: () => ({ kind: "parallel" }),
        async prepare(item) {
          return { kind: "dispatch", prepared: { callId: item.callId } };
        },
        async dispatch(prepared) {
          dispatched.push(prepared.callId);
          return { value: prepared.callId };
        },
        async commit(_item, settled) {
          return settled.value;
        },
        async skip(item) {
          skipped.push(item.callId);
          return { value: item.callId, skipped: true };
        },
      },
      { signal: controller.signal },
    );

    expect(result.aborted).toBeTrue();
    expect(dispatched).toEqual([]);
    expect(skipped).toEqual(["one", "two", "three"]);
    expect(result.committed.map((entry) => entry.callId)).toEqual(skipped);
  });

  test("an infrastructure failure stops replenishment and drains started bodies", async () => {
    const first = deferred<Result>();
    const trace: string[] = [];
    const hooks: ToolSchedulerHooksV2<Prepared, Result, string> = {
      classify: () => ({ kind: "parallel" }),
      async prepare(item) {
        return { kind: "dispatch", prepared: { callId: item.callId } };
      },
      async dispatch(prepared) {
        trace.push(`${prepared.callId}:start`);
        if (prepared.callId === "first") return first.promise;
        if (prepared.callId === "failure")
          throw new Error("scheduler fixture failure");
        return { value: prepared.callId };
      },
      async commit(_item, settled) {
        return settled.value;
      },
      async skip(item) {
        return { value: item.callId, skipped: true };
      },
    };
    let settled = false;
    const running = executeToolBatchV2(
      [
        call("first", "read"),
        call("failure", "read"),
        call("unstarted", "read"),
      ],
      hooks,
      { maxParallel: 2 },
    ).finally(() => {
      settled = true;
    });

    await until(() => trace.includes("failure:start"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBeFalse();
    expect(trace).not.toContain("unstarted:start");
    first.resolve({ value: "first" });
    await expect(running).rejects.toThrow("scheduler fixture failure");
    expect(trace).not.toContain("unstarted:start");
  });

  test("duplicate call ids and invalid parallel limits fail before dispatch", async () => {
    const hooks: ToolSchedulerHooksV2<Prepared, Result, string> = {
      async prepare(item) {
        return { kind: "dispatch", prepared: { callId: item.callId } };
      },
      async dispatch(prepared) {
        return { value: prepared.callId };
      },
      async commit(_item, settled) {
        return settled.value;
      },
      async skip(item) {
        return { value: item.callId, skipped: true };
      },
    };
    await expect(
      executeToolBatchV2([call("same", "read"), call("same", "grep")], hooks),
    ).rejects.toThrow("duplicate callId");
    await expect(
      executeToolBatchV2([call("one", "read")], hooks, { maxParallel: 0 }),
    ).rejects.toThrow("maxParallel must be a positive integer");
  });
});
