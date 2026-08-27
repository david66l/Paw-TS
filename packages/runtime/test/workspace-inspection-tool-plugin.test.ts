import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";
import { OFF_SHELL_SANDBOX, type ToolRunResult } from "@paw/harness";

import {
  FrozenPermissionEngineV1,
  MonotonicCheckpointSequenceV1,
  type RuntimeToolCallV1,
  type ToolAuthorizationRecordedFactV1,
  createFrozenToolRegistryV1,
  createHarnessToolExecutorV1,
  createWorkspaceInspectionToolPluginV1,
} from "../src/index.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("workspace inspection runtime tool plugin", () => {
  test("executes all five tools through permissions, locks, and Harness transactions", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "paw-inspection-plugin-"),
    );
    roots.push(root);
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(
      path.join(root, "src", "a.ts"),
      "export const needle = 1;\n",
    );
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    execFileSync("git", ["add", "src/a.ts"], { cwd: root });
    fs.appendFileSync(path.join(root, "src", "a.ts"), "// changed\n");

    const recorded: ToolAuthorizationRecordedFactV1[][] = [];
    const executor = createHarnessToolExecutorV1({
      sessionId: "session-inspection",
      runId: "run-inspection",
      registry: createFrozenToolRegistryV1({
        plugins: [createWorkspaceInspectionToolPluginV1()],
        shellSandbox: OFF_SHELL_SANDBOX,
      }),
      permissions: new FrozenPermissionEngineV1({
        policyVersion: "inspection-read-only.v1",
        defaultAction: "deny",
        rules: [
          {
            id: "allow-read",
            layer: "user",
            category: "read",
            action: "allow",
          },
        ],
      }),
      permissionRecorder: {
        async record(facts) {
          recorded.push([...facts]);
        },
      },
      context: { workspaceRoot: root, shellSandbox: OFF_SHELL_SANDBOX },
      checkpointSequence: new MonotonicCheckpointSequenceV1(),
    });

    const settlements = await executor.executeSettled(
      [
        call("list", "workspace_list_dir", { path: "." }),
        call("search", "workspace_search", {
          path: ".",
          pattern: "needle",
        }),
        call("glob", "workspace_glob", {
          path: ".",
          pattern: "**/*.ts",
        }),
        call("status", "workspace_git_status", {}),
        call("diff", "workspace_git_diff", {}),
      ],
      { turn: 1, signal: new AbortController().signal },
    );

    expect(settlements.map((settlement) => settlement.status)).toEqual([
      "success",
      "success",
      "success",
      "success",
      "success",
    ]);
    expect(resultOf(settlements[0]).payload).toMatchObject({
      files: expect.arrayContaining(["src/"]),
    });
    expect(resultOf(settlements[1]).payload).toMatchObject({ match_count: 1 });
    expect(resultOf(settlements[2]).payload).toMatchObject({
      filenames: ["src/a.ts"],
    });
    expect(resultOf(settlements[3]).payload).toMatchObject({
      staged: ["src/a.ts"],
      modified: ["src/a.ts"],
    });
    expect(
      (resultOf(settlements[4]).payload as { diff?: string }).diff,
    ).toContain("// changed");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toHaveLength(5);
    expect(recorded[0]?.map((fact) => fact.type)).toEqual([
      "tool.permission_resolved",
      "tool.permission_resolved",
      "tool.permission_resolved",
      "tool.permission_resolved",
      "tool.permission_resolved",
    ]);
    expect(
      recorded[0]?.flatMap((fact) =>
        fact.type === "tool.permission_resolved" ? [fact.tool] : [],
      ),
    ).toEqual([
      "workspace_list_dir",
      "workspace_search",
      "workspace_glob",
      "workspace_git_status",
      "workspace_git_diff",
    ]);
  });
});

function call(
  id: string,
  name: string,
  args: Record<string, unknown>,
): RuntimeToolCallV1 {
  return { id, name, arguments: args, argumentsValid: true };
}

function resultOf(
  settlement:
    | { readonly status: string; readonly result?: ToolRunResult }
    | undefined,
): ToolRunResult {
  if (!settlement?.result) throw new Error("expected successful tool result");
  return settlement.result;
}
