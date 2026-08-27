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
  createCodeIntelligenceToolPluginV1,
  createFrozenToolRegistryV1,
  createHarnessToolExecutorV1,
  createWorkspaceInspectionToolPluginV2,
  createWorkspaceMutationToolPluginV1,
} from "../src/index.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("phase-one and code-intelligence runtime tool plugins", () => {
  test("execute through one permission, checkpoint, lock, and Harness path", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paw-coding-plugins-"));
    roots.push(root);
    fs.writeFileSync(
      path.join(root, "a.ts"),
      "export function before(): number { return 1; }\n",
    );
    fs.writeFileSync(path.join(root, "notes.txt"), "not an LSP source\n");
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], {
      cwd: root,
    });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
    execFileSync("git", ["add", "a.ts", "notes.txt"], { cwd: root });
    execFileSync("git", ["commit", "--quiet", "-m", "initial"], {
      cwd: root,
    });

    const recorded: ToolAuthorizationRecordedFactV1[][] = [];
    const executor = createHarnessToolExecutorV1({
      sessionId: "session-coding-plugins",
      runId: "run-coding-plugins",
      registry: createFrozenToolRegistryV1({
        plugins: [
          createWorkspaceInspectionToolPluginV2(),
          createWorkspaceMutationToolPluginV1(),
          createCodeIntelligenceToolPluginV1(),
        ],
        shellSandbox: OFF_SHELL_SANDBOX,
      }),
      permissions: new FrozenPermissionEngineV1({
        policyVersion: "coding-plugins.v1",
        defaultAction: "deny",
        rules: [
          {
            id: "allow-read",
            layer: "user",
            category: "read",
            action: "allow",
          },
          {
            id: "allow-write",
            layer: "user",
            category: "write",
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
    const patch =
      "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-export function before(): number { return 1; }\n+export function after(): number { return 2; }\n";

    const patchSettlements = await executor.executeSettled(
      [call("patch", "workspace_apply_patch", { patch })],
      { turn: 1, signal: new AbortController().signal },
    );
    expect(patchSettlements[0]?.status).toBe("success");
    expect(resultOf(patchSettlements[0]).payload).toMatchObject({
      ok: true,
      results: [{ path: "a.ts", ok: true, changed: true }],
    });
    expect(fs.readFileSync(path.join(root, "a.ts"), "utf8")).toContain(
      "function after",
    );

    const readSettlements = await executor.executeSettled(
      [
        call("symbol", "workspace_symbol_search", {
          query: "after",
          max_results: 10,
        }),
        call("log", "workspace_git_log", { max_count: 5 }),
        call("lsp", "workspace_lsp", {
          file: "notes.txt",
          method: "hover",
          line: 0,
          character: 0,
        }),
      ],
      { turn: 2, signal: new AbortController().signal },
    );
    expect(readSettlements.map((settlement) => settlement.status)).toEqual([
      "success",
      "success",
      "success",
    ]);
    expect(resultOf(readSettlements[0]).payload).toMatchObject({
      matches: [
        {
          file: "a.ts",
          symbols: [
            expect.objectContaining({ name: "after", kind: "function" }),
          ],
        },
      ],
    });
    expect(resultOf(readSettlements[1]).payload).toMatchObject({
      commits: [expect.objectContaining({ message: "initial" })],
    });
    expect(resultOf(readSettlements[2])).toMatchObject({
      ok: false,
      payload: { error: expect.stringContaining("no LSP server known") },
    });
    expect(recorded.flat()).toHaveLength(5);
    expect(
      recorded
        .flat()
        .filter((fact) => fact.type === "tool.effect_checkpoint_allocated"),
    ).toHaveLength(1);
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
  if (!settlement?.result) throw new Error("expected a completed tool result");
  return settlement.result;
}
