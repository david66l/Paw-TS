import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { FileSystemAppStateStore } from "@paw/core";

import {
  EXECUTION_ENVIRONMENT_SCHEMA_V1,
  ExecutionEnvironmentRegistryV1,
  type ExecutionRuntimeV1,
  parseExecutionEnvironmentSnapshotV1,
} from "../src/execution-environment.js";
import { AgentOrchestrator } from "../src/orchestrator.js";
import {
  TaskStateManager,
  latestSubstantiveVerification,
} from "../src/task-state.js";

const RUNTIME: ExecutionRuntimeV1 = Object.freeze({
  platform: "win32",
  arch: "x64",
  shell: "cmd.exe",
  node: "v24.0.0",
  bun: "1.3.0",
  python: "Python 3.13.0",
});

const OFF_SANDBOX = Object.freeze({
  mode: "off" as const,
  network: "deny" as const,
  image: "debian:bookworm-slim",
});

describe("ExecutionEnvironmentRegistryV1", () => {
  test("records settled foreground shell facts without inventing a persistent session", () => {
    const registry = new ExecutionEnvironmentRegistryV1({
      runId: "env-1",
      workspaceRoot: "C:\\workspace",
      shellSandbox: OFF_SANDBOX,
      runtime: RUNTIME,
    });
    registry.observeToolResult(
      2,
      {
        type: "tool_call",
        tool: "workspace.run_shell",
        args: { command: "bun test", cwd: "packages/agent", timeout_sec: 30 },
      },
      {
        ok: true,
        summary: "run_shell: exit 0",
        payload: {
          exit_code: 0,
          cwd: "C:\\workspace\\packages\\agent",
        },
      },
    );

    const snapshot = registry.snapshot();
    expect(snapshot).toMatchObject({
      schemaVersion: EXECUTION_ENVIRONMENT_SCHEMA_V1,
      shellPersistence: "fresh_process_per_call",
      recovery: { compatible: true, issues: [] },
      backgroundJobs: {
        capability: "not_available",
        managed: 0,
        running: 0,
      },
    });
    expect(snapshot.events).toEqual([
      {
        seq: 1,
        type: "shell.completed",
        turn: 2,
        command: "bun test",
        cwd: "C:\\workspace\\packages\\agent",
        timeoutSec: 30,
        ok: true,
        exitCode: 0,
        timedOut: false,
        failureKind: "none",
      },
    ]);
  });

  test("replays exactly and exposes incompatible resume environments", () => {
    const first = new ExecutionEnvironmentRegistryV1({
      runId: "env-resume",
      workspaceRoot: "C:\\workspace",
      shellSandbox: OFF_SANDBOX,
      runtime: RUNTIME,
    });
    first.observeToolResult(
      0,
      {
        type: "tool_call",
        tool: "workspace.run_shell",
        args: { command: "bun test" },
      },
      {
        ok: false,
        summary: "run_shell: exit 1",
        payload: { exit_code: 1, cwd: "C:\\workspace" },
      },
    );
    const serialized = JSON.parse(JSON.stringify(first.snapshot()));
    expect(parseExecutionEnvironmentSnapshotV1(serialized)).toEqual(
      first.snapshot(),
    );

    const resumed = new ExecutionEnvironmentRegistryV1({
      runId: "env-resume",
      workspaceRoot: "D:\\moved",
      shellSandbox: {
        ...OFF_SANDBOX,
        mode: "strict",
        network: "full",
        image: "node:24",
      },
      runtime: { ...RUNTIME, shell: "pwsh.exe" },
      resumeSnapshot: serialized,
    }).snapshot();
    expect(resumed.events).toEqual(first.snapshot().events);
    expect(resumed.recovery.compatible).toBe(false);
    expect(resumed.recovery.issues).toEqual([
      "workspace_root_changed",
      "runtime_shell_changed",
      "sandbox_mode_changed",
      "sandbox_network_changed",
      "sandbox_image_changed",
    ]);
  });

  test("rejects corrupt ledgers rather than resetting shell history", () => {
    const registry = new ExecutionEnvironmentRegistryV1({
      runId: "env-corrupt",
      workspaceRoot: "C:\\workspace",
      shellSandbox: OFF_SANDBOX,
      runtime: RUNTIME,
    });
    registry.observeToolResult(
      0,
      {
        type: "tool_call",
        tool: "workspace.run_shell",
        args: { command: "bun test" },
      },
      { ok: true, summary: "run_shell: exit 0", payload: { exit_code: 0 } },
    );
    const corrupt = JSON.parse(JSON.stringify(registry.snapshot()));
    corrupt.events[0].seq = 7;
    expect(() => parseExecutionEnvironmentSnapshotV1(corrupt)).toThrow(
      /event 1/,
    );
  });

  test("invalidates green verification after an incompatible environment resume", () => {
    const task = new TaskStateManager("Verify the change.");
    const call = {
      type: "tool_call" as const,
      tool: "workspace.run_shell",
      args: { command: "bun test" },
    };
    task.recordToolResult(call, {
      ok: true,
      summary: "run_shell: exit 0",
      payload: { exit_code: 0 },
    });
    expect(latestSubstantiveVerification(task.snapshot())?.passed).toBe(true);

    task.recordExecutionEnvironmentChange(["sandbox_image_changed"]);
    expect(latestSubstantiveVerification(task.snapshot())).toBeUndefined();
    expect(task.snapshot()).toMatchObject({
      executionEnvironmentRevision: 1,
      executionEnvironmentIssues: ["sandbox_image_changed"],
    });

    task.recordToolResult(call, {
      ok: true,
      summary: "run_shell: exit 0",
      payload: { exit_code: 0 },
    });
    expect(latestSubstantiveVerification(task.snapshot())).toMatchObject({
      passed: true,
      executionEnvironmentRevision: 1,
    });
    expect(task.snapshot().executionEnvironmentIssues).toEqual([]);
  });

  test("wires settled shell facts through AppState and resume", async () => {
    const workspaceRoot = mkdtempSync(path.join(tmpdir(), "paw-exec-env-"));
    const pawDir = path.join(workspaceRoot, ".paw");
    mkdirSync(pawDir);
    writeFileSync(
      path.join(pawDir, "memory-config.json"),
      JSON.stringify({ enable: false }),
      "utf8",
    );
    const stateStore = new FileSystemAppStateStore({
      statesDir: path.join(pawDir, "states"),
    });
    let calls = 0;
    const first = new AgentOrchestrator({
      appStateStore: stateStore,
      memoryExtraction: "off",
      memoryLlm: "off",
      model: {
        label: "execution-environment-fixture",
        async complete() {
          calls += 1;
          return calls === 1
            ? {
                text: JSON.stringify({
                  tool: "workspace.run_shell",
                  args: { command: "node --version", cwd: "." },
                }),
              }
            : { text: '{"action":"final_answer","summary":"Checked Node."}' };
        },
      },
    });
    const result = await first.run({
      runId: "execution-environment-wiring",
      goal: "Check the Node version.",
      workspaceRoot,
      maxSteps: 3,
    });
    expect(result.status).toBe("completed");
    const saved = stateStore.load("execution-environment-wiring");
    const snapshot = parseExecutionEnvironmentSnapshotV1(
      saved?.executionEnvironment,
    );
    expect(snapshot?.events).toHaveLength(1);
    expect(snapshot?.events[0]).toMatchObject({
      type: "shell.completed",
      command: "node --version",
      ok: true,
      exitCode: 0,
    });

    const resumed = new ExecutionEnvironmentRegistryV1({
      runId: "execution-environment-wiring",
      workspaceRoot,
      shellSandbox: OFF_SANDBOX,
      runtime: snapshot?.runtime ?? RUNTIME,
      resumeSnapshot: saved?.executionEnvironment,
    }).snapshot();
    expect(resumed.recovery.compatible).toBe(true);
    expect(resumed.events).toHaveLength(1);
  });
});
