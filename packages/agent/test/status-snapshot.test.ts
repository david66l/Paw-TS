import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ChatMessage } from "@paw/models";

import { AgentOrchestrator } from "../src/orchestrator.js";
import {
  RunStatusTelemetryV1,
  STATUS_SNAPSHOT_PREFIX,
  formatStatusSnapshotV1,
  statusPaceV1,
} from "../src/status-snapshot.js";
import type { TaskState } from "../src/task-state.js";
import { TaskStateManager } from "../src/task-state.js";

const ENVIRONMENT = Object.freeze({
  cwd: "C:\\workspace",
  platform: "win32",
  arch: "x64",
  shell: "powershell.exe",
  node: "v24.0.0",
  bun: "1.2.0",
  python: "unprobed" as const,
});

describe("StatusSnapshotV1", () => {
  test("formats host-owned timing, environment, and authority deterministically", () => {
    const taskState = new TaskStateManager("Inspect the repository.");
    const telemetry = new RunStatusTelemetryV1({
      runId: "status-1",
      workspaceRoot: ENVIRONMENT.cwd,
      startedAt: 1_000,
      environment: ENVIRONMENT,
    });

    const text = formatStatusSnapshotV1(
      telemetry.snapshot(1, 10, taskState.snapshot(), 1_250),
    );

    expect(text).toContain(
      "schema=paw.status-snapshot.v1 authority=advisory_only",
    );
    expect(text).toContain("completion_authority=CompletionPolicy");
    expect(text).toContain("run=status-1 turn=2/10 elapsed_ms=250");
    expect(text).toContain("pace=investigate");
    expect(text).toContain("last_tool=none");
    expect(text).toContain("python=unprobed");
    expect(text).toContain("background_jobs=untracked");
  });

  test("detects exact repetition and tells the model to change hypothesis", () => {
    const taskState = new TaskStateManager("Diagnose a failure.");
    const telemetry = new RunStatusTelemetryV1({
      runId: "status-repeat",
      workspaceRoot: ENVIRONMENT.cwd,
      environment: ENVIRONMENT,
    });
    const calls = [
      {
        type: "tool_call",
        tool: "workspace.read_file",
        args: { path: "same.ts" },
      },
    ] as const;
    for (let index = 0; index < 3; index += 1) {
      telemetry.observeToolBatch(
        calls,
        [{ ok: true, summary: "same file", payload: {} }],
        30,
      );
    }

    const snapshot = telemetry.snapshot(3, 12, taskState.snapshot());
    expect(snapshot.tools).toMatchObject({
      calls: 3,
      failures: 0,
      consecutiveExactRepeats: 3,
    });
    expect(snapshot.pace).toBe("change_hypothesis");
    expect(snapshot.lastTool).toMatchObject({
      tool: "workspace.read_file",
      durationMs: 30,
      timedOut: false,
    });
  });

  test("reports settled failures and timeout signals without reading model prose", () => {
    const taskState = new TaskStateManager("Run a slow command.");
    const telemetry = new RunStatusTelemetryV1({
      runId: "status-timeout",
      workspaceRoot: ENVIRONMENT.cwd,
      environment: ENVIRONMENT,
    });
    telemetry.observeToolBatch(
      [
        {
          type: "tool_call",
          tool: "shell.exec",
          args: { command: "slow" },
        },
      ],
      [
        {
          ok: false,
          summary: "execution timed out",
          payload: { code: "E_TOOL_TIMEOUT" },
        },
      ],
      2_500,
    );

    const snapshot = telemetry.snapshot(1, 5, taskState.snapshot());
    expect(snapshot.tools).toMatchObject({
      calls: 1,
      failures: 1,
      consecutiveFailures: 1,
    });
    expect(snapshot.lastTool).toMatchObject({
      tool: "shell.exec",
      ok: false,
      durationMs: 2_500,
      timedOut: true,
    });
  });

  test("derives post-edit pace from current-revision verification facts", () => {
    const base = new TaskStateManager("Change the implementation.").snapshot();
    const atRevision = (overrides: Partial<TaskState>): TaskState => ({
      ...base,
      filesChanged: ["source.ts"],
      mutationRevision: 2,
      ...overrides,
    });

    expect(statusPaceV1(atRevision({}), 0, 0)).toBe("verify");
    expect(
      statusPaceV1(
        atRevision({
          testResults: [
            {
              command: "bun test",
              passed: false,
              outcome: "code_failed",
              summary: "failed",
              mutationRevision: 2,
            },
          ],
        }),
        0,
        0,
      ),
    ).toBe("repair");
    expect(
      statusPaceV1(
        atRevision({
          testResults: [
            {
              command: "bun test",
              passed: false,
              outcome: "harness_failed",
              summary: "runner missing",
              mutationRevision: 2,
            },
          ],
        }),
        0,
        0,
      ),
    ).toBe("stabilize_environment");
    expect(
      statusPaceV1(
        atRevision({
          testResults: [
            {
              command: "bun test",
              passed: true,
              outcome: "passed",
              summary: "passed",
              mutationRevision: 2,
            },
          ],
          diffInspectedRevision: 1,
        }),
        0,
        0,
      ),
    ).toBe("inspect_diff");
    expect(
      statusPaceV1(
        atRevision({
          testResults: [
            {
              command: "bun test",
              passed: true,
              outcome: "passed",
              summary: "passed",
              mutationRevision: 2,
            },
          ],
          diffInspectedRevision: 2,
        }),
        0,
        0,
      ),
    ).toBe("finish");
  });

  test("injects settled tool telemetry into the next real agent turn", async () => {
    const workspaceRoot = mkdtempSync(path.join(tmpdir(), "paw-status-"));
    mkdirSync(path.join(workspaceRoot, ".paw"));
    writeFileSync(
      path.join(workspaceRoot, ".paw", "memory-config.json"),
      JSON.stringify({ enable: false }),
      "utf8",
    );
    writeFileSync(path.join(workspaceRoot, "source.txt"), "evidence\n", "utf8");
    const snapshots: string[] = [];
    const statusWasTailAdjacent: boolean[] = [];
    let modelCalls = 0;
    const orchestrator = new AgentOrchestrator({
      memoryExtraction: "off",
      memoryLlm: "off",
      model: {
        label: "status-snapshot-fixture",
        async complete(messages: readonly ChatMessage[]) {
          modelCalls += 1;
          const snapshot = [...messages]
            .reverse()
            .find((message) =>
              message.content.startsWith(STATUS_SNAPSHOT_PREFIX),
            );
          if (snapshot) snapshots.push(snapshot.content);
          statusWasTailAdjacent.push(
            messages.at(-2)?.content.startsWith(STATUS_SNAPSHOT_PREFIX) ??
              false,
          );
          if (modelCalls === 1) {
            return {
              text: '{"tool":"workspace.read_file","args":{"path":"source.txt"}}',
            };
          }
          return {
            text: '{"action":"final_answer","summary":"Inspected source.txt."}',
          };
        },
      },
    });

    const result = await orchestrator.run({
      runId: "status-integration",
      goal: "Inspect source.txt and report what you found.",
      workspaceRoot,
      maxSteps: 3,
    });

    expect(result.status).toBe("completed");
    expect(snapshots).toHaveLength(2);
    expect(statusWasTailAdjacent).toEqual([true, true]);
    expect(snapshots[0]).toContain("tools calls=0 failures=0");
    expect(snapshots[1]).toContain("tools calls=1 failures=0");
    expect(snapshots[1]).toContain(
      "last_tool=workspace.read_file ok=true duration_ms=",
    );
  });
});
