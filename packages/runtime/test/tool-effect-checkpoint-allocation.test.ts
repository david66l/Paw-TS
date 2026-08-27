import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";
import { OFF_SHELL_SANDBOX, UNDO_LAST_EDIT } from "@paw/harness";
import type { InputFactV1 } from "@paw/protocol";

import {
  FrozenPermissionEngineV1,
  MonotonicCheckpointSequenceV1,
  type RuntimeToolCallV1,
  type ToolAuthorizationRecordedFactV1,
  createFrozenToolRegistryV1,
  createHarnessToolExecutorV1,
  createToolCheckpointNamespaceIdV1,
  projectCheckpointSequenceHighWaterV1,
} from "../src/index.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("durable tool effect checkpoint allocation", () => {
  test("concurrent batches serialize allocation and canonical recording", async () => {
    const root = workspace();
    fs.writeFileSync(path.join(root, "a.txt"), "a");
    fs.writeFileSync(path.join(root, "b.txt"), "b");
    const batches: ToolAuthorizationRecordedFactV1[][] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let enteredFirst!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      enteredFirst = resolve;
    });
    let recorderCalls = 0;
    const executor = createHarnessToolExecutorV1({
      sessionId: "session-concurrent-allocation",
      runId: "run-concurrent-allocation",
      registry: registry(),
      permissions: allowAll(),
      permissionRecorder: {
        async record(facts) {
          recorderCalls += 1;
          batches.push([...facts]);
          if (recorderCalls === 1) {
            enteredFirst();
            await firstGate;
          }
        },
      },
      context: { workspaceRoot: root, shellSandbox: OFF_SHELL_SANDBOX },
      checkpointSequence: new MonotonicCheckpointSequenceV1(),
    });

    const first = executor.executeSettled(
      [editCall("edit-a", "a.txt", "a", "A")],
      { turn: 1, signal: new AbortController().signal },
    );
    await firstEntered;
    const second = executor.executeSettled(
      [editCall("edit-b", "b.txt", "b", "B")],
      { turn: 2, signal: new AbortController().signal },
    );
    await Promise.resolve();
    expect(recorderCalls).toBe(1);
    releaseFirst();
    await Promise.all([first, second]);

    expect(recorderCalls).toBe(2);
    expect(
      batches.map((batch) =>
        batch
          .filter((fact) => fact.type === "tool.effect_checkpoint_allocated")
          .map((fact) => fact.checkpointSeq),
      ),
    ).toEqual([[1], [2]]);
  });

  test("commits source-ordered permission and allocation facts atomically before every checkpoint or effect", async () => {
    const root = workspace();
    fs.writeFileSync(path.join(root, "a.txt"), "a");
    fs.writeFileSync(path.join(root, "b.txt"), "b");
    const batches: ToolAuthorizationRecordedFactV1[][] = [];
    const trace: string[] = [];
    const checkpointNamespace = createToolCheckpointNamespaceIdV1({
      workspaceRoot: root,
      sessionId: "session-atomic-allocation",
      runId: "run-atomic-allocation",
    });
    const executor = createHarnessToolExecutorV1({
      sessionId: "session-atomic-allocation",
      runId: "run-atomic-allocation",
      registry: registry(),
      permissions: allowAll(),
      permissionRecorder: {
        async record(facts) {
          trace.push("record");
          expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("a");
          expect(fs.readFileSync(path.join(root, "b.txt"), "utf8")).toBe("b");
          expect(
            fs.existsSync(
              path.join(root, ".paw", "checkpoints", checkpointNamespace),
            ),
          ).toBe(false);
          batches.push([...facts]);
        },
      },
      context: { workspaceRoot: root, shellSandbox: OFF_SHELL_SANDBOX },
      checkpointSequence: new MonotonicCheckpointSequenceV1(),
      effectPolicy: {
        prepare() {
          trace.push("effect");
        },
        settle() {
          return { allowed: true };
        },
      },
    });

    const settlements = await executor.executeSettled(
      [
        editCall("edit-a", "a.txt", "a", "A"),
        call("invalid-middle", "missing_tool", {}),
        editCall("edit-b", "b.txt", "b", "B"),
      ],
      { turn: 4, signal: new AbortController().signal },
    );

    expect(settlements.map((item) => item.status)).toEqual([
      "success",
      "failed",
      "success",
    ]);
    expect(batches).toHaveLength(1);
    expect(
      batches[0]?.map((fact) => [
        fact.type,
        fact.callId,
        fact.sourceIndex,
        fact.type === "tool.effect_checkpoint_allocated"
          ? fact.checkpointSeq
          : undefined,
      ]),
    ).toEqual([
      ["tool.permission_resolved", "edit-a", 0, undefined],
      ["tool.effect_checkpoint_allocated", "edit-a", 0, 1],
      ["tool.permission_resolved", "edit-b", 2, undefined],
      ["tool.effect_checkpoint_allocated", "edit-b", 2, 2],
    ]);
    expect(trace[0]).toBe("record");
    expect(trace.filter((item) => item === "record")).toHaveLength(1);
    expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("A");
    expect(fs.readFileSync(path.join(root, "b.txt"), "utf8")).toBe("B");
    expect(
      fs.existsSync(
        path.join(
          root,
          ".paw",
          "checkpoints",
          checkpointNamespace,
          "1",
          "_meta.json",
        ),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(
          root,
          ".paw",
          "checkpoints",
          checkpointNamespace,
          "2",
          "_meta.json",
        ),
      ),
    ).toBe(true);
  });

  test("a recorder failure produces zero checkpoint and zero workspace effect", async () => {
    const root = workspace();
    fs.writeFileSync(path.join(root, "a.txt"), "before");
    const checkpointNamespace = createToolCheckpointNamespaceIdV1({
      workspaceRoot: root,
      sessionId: "session-recorder-failure",
      runId: "run-recorder-failure",
    });
    const executor = createHarnessToolExecutorV1({
      sessionId: "session-recorder-failure",
      runId: "run-recorder-failure",
      registry: registry(),
      permissions: allowAll(),
      permissionRecorder: {
        async record() {
          throw new Error("journal commit failed");
        },
      },
      context: { workspaceRoot: root, shellSandbox: OFF_SHELL_SANDBOX },
      checkpointSequence: new MonotonicCheckpointSequenceV1(),
    });

    const [settlement] = await executor.executeSettled(
      [editCall("edit", "a.txt", "before", "after")],
      { turn: 1, signal: new AbortController().signal },
    );

    expect(settlement).toMatchObject({
      status: "failed",
      error: { name: "PermissionFactCommitFailed" },
    });
    expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("before");
    expect(
      fs.existsSync(
        path.join(root, ".paw", "checkpoints", checkpointNamespace),
      ),
    ).toBe(false);
  });

  test("a committed allocation survives crash-like failure or cancellation and resumes at max plus one", async () => {
    for (const mode of ["throw-after-commit", "cancel-after-commit"] as const) {
      const root = workspace();
      fs.writeFileSync(path.join(root, "a.txt"), "before");
      fs.writeFileSync(path.join(root, "b.txt"), "before");
      const committed: ToolAuthorizationRecordedFactV1[] = [];
      const controller = new AbortController();
      const first = createHarnessToolExecutorV1({
        sessionId: `session-${mode}`,
        runId: `run-${mode}`,
        registry: registry(),
        permissions: allowAll(),
        permissionRecorder: {
          async record(facts) {
            committed.push(...facts);
            if (mode === "cancel-after-commit") {
              controller.abort("cancelled after canonical commit");
              return;
            }
            throw new Error("simulated crash after canonical commit");
          },
        },
        context: { workspaceRoot: root, shellSandbox: OFF_SHELL_SANDBOX },
        checkpointSequence: new MonotonicCheckpointSequenceV1(),
      });

      const [firstSettlement] = await first.executeSettled(
        [editCall("edit-a", "a.txt", "before", "after")],
        { turn: 1, signal: controller.signal },
      );
      expect(firstSettlement?.status).toBe(
        mode === "cancel-after-commit" ? "cancelled" : "failed",
      );
      expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("before");
      const highWater = projectCheckpointSequenceHighWaterV1(committed);
      expect(highWater).toBe(1);

      const resumedFacts: ToolAuthorizationRecordedFactV1[] = [];
      const resumedController = new AbortController();
      const resumed = createHarnessToolExecutorV1({
        sessionId: `session-${mode}`,
        runId: `run-${mode}`,
        registry: registry(),
        permissions: allowAll(),
        permissionRecorder: {
          async record(facts) {
            resumedFacts.push(...facts);
            resumedController.abort("stop before effect");
          },
        },
        context: { workspaceRoot: root, shellSandbox: OFF_SHELL_SANDBOX },
        checkpointSequence: new MonotonicCheckpointSequenceV1(highWater),
      });

      await resumed.executeSettled(
        [editCall("edit-b", "b.txt", "before", "after")],
        { turn: 2, signal: resumedController.signal },
      );
      expect(
        resumedFacts.find(
          (fact) => fact.type === "tool.effect_checkpoint_allocated",
        ),
      ).toMatchObject({ callId: "edit-b", checkpointSeq: 2 });
      expect(fs.readFileSync(path.join(root, "b.txt"), "utf8")).toBe("before");
    }
  });

  test("read-only, denied, and undo calls never allocate an effect checkpoint", async () => {
    const root = workspace();
    fs.writeFileSync(path.join(root, "a.txt"), "content");

    const readFacts = await executeAndRecord(
      root,
      "run-read",
      registry(),
      allowAll(),
      call("read", "workspace_read_file", { path: "a.txt" }),
    );
    expect(allocations(readFacts)).toEqual([]);

    const deniedFacts = await executeAndRecord(
      root,
      "run-deny",
      registry(),
      denyWrites(),
      editCall("denied", "a.txt", "content", "changed"),
    );
    expect(allocations(deniedFacts)).toEqual([]);

    const undoFacts = await executeAndRecord(
      root,
      "run-undo",
      undoRegistry(root),
      allowAll(),
      call("undo", "workspace_undo_last_edit", {}),
    );
    expect(allocations(undoFacts)).toEqual([]);
  });

  test("the pure high-water projection returns max, permits gaps, and rejects damaged sequences", () => {
    expect(projectCheckpointSequenceHighWaterV1([])).toBe(0);
    expect(
      projectCheckpointSequenceHighWaterV1([
        allocationFact("call-1", 1),
        allocationFact("call-2", 7),
      ]),
    ).toBe(7);

    for (const facts of [
      [allocationFact("call-1", 1), allocationFact("call-2", 1)],
      [allocationFact("call-1", 2), allocationFact("call-2", 1)],
      [allocationFact("call-1", 0)],
      [allocationFact("call-1", 1), allocationFact("call-1", 2)],
    ]) {
      expect(() => projectCheckpointSequenceHighWaterV1(facts)).toThrow();
    }
  });

  test("the monotonic allocator fails before exceeding safe integer range", () => {
    const sequence = new MonotonicCheckpointSequenceV1(Number.MAX_SAFE_INTEGER);
    expect(() => sequence.next()).toThrow("checkpoint sequence is exhausted");
    expect(() => sequence.next()).toThrow("checkpoint sequence is exhausted");
  });
});

async function executeAndRecord(
  root: string,
  runId: string,
  toolRegistry: ReturnType<typeof registry> | ReturnType<typeof undoRegistry>,
  permissions: FrozenPermissionEngineV1,
  toolCall: RuntimeToolCallV1,
): Promise<ToolAuthorizationRecordedFactV1[]> {
  const facts: ToolAuthorizationRecordedFactV1[] = [];
  const executor = createHarnessToolExecutorV1({
    sessionId: `session-${runId}`,
    runId,
    registry: toolRegistry,
    permissions,
    permissionRecorder: {
      async record(batch) {
        facts.push(...batch);
      },
    },
    context: { workspaceRoot: root, shellSandbox: OFF_SHELL_SANDBOX },
    checkpointSequence: new MonotonicCheckpointSequenceV1(),
  });
  await executor.executeSettled([toolCall], {
    turn: 1,
    signal: new AbortController().signal,
  });
  return facts;
}

function allocations(facts: readonly ToolAuthorizationRecordedFactV1[]) {
  return facts.filter(
    (fact) => fact.type === "tool.effect_checkpoint_allocated",
  );
}

function allocationFact(callId: string, checkpointSeq: number): InputFactV1 {
  return {
    type: "tool.effect_checkpoint_allocated",
    callId,
    turn: 1,
    sourceIndex: 0,
    checkpointSeq,
  };
}

function registry() {
  return createFrozenToolRegistryV1({ shellSandbox: OFF_SHELL_SANDBOX });
}

function undoRegistry(root: string): ReturnType<typeof registry> {
  const base = registry();
  const entry = base.entries[0];
  if (!entry) throw new Error("expected a registry entry fixture");
  return {
    ...base,
    validateAndClassify(call) {
      return {
        ok: true,
        value: {
          call,
          entry,
          internalName: UNDO_LAST_EDIT,
          args: {},
          classification: {
            lockDomain: root,
            effectClass: "write",
            permissionCategory: "write",
            concurrencyMode: "exclusive",
            resources: [{ key: `${root}/a.txt`, access: "write" }],
          },
        },
      };
    },
  };
}

function allowAll(): FrozenPermissionEngineV1 {
  return new FrozenPermissionEngineV1({
    policyVersion: "allow-all-v1",
    defaultAction: "deny",
    rules: [
      { id: "allow-read", layer: "user", category: "read", action: "allow" },
      {
        id: "allow-write",
        layer: "user",
        category: "write",
        action: "allow",
      },
      {
        id: "allow-shell",
        layer: "user",
        category: "shell",
        action: "allow",
      },
    ],
  });
}

function denyWrites(): FrozenPermissionEngineV1 {
  return new FrozenPermissionEngineV1({
    policyVersion: "deny-writes-v1",
    defaultAction: "deny",
    rules: [
      { id: "deny-write", layer: "user", category: "write", action: "deny" },
    ],
  });
}

function editCall(
  id: string,
  file: string,
  oldString: string,
  newString: string,
): RuntimeToolCallV1 {
  return call(id, "workspace_edit_file", {
    path: file,
    old_string: oldString,
    new_string: newString,
  });
}

function call(
  id: string,
  name: string,
  args: Readonly<Record<string, unknown>>,
): RuntimeToolCallV1 {
  return { id, name, arguments: args, argumentsValid: true };
}

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paw-allocation-test-"));
  roots.push(root);
  return root;
}
