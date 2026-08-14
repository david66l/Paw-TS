import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AgentToolCallAction, RunEvent } from "@paw/core";
import type { ToolRunResult } from "@paw/harness";

import { executeToolBatchV2 } from "../src/loop-v2/index.js";
import { commitToolExecutionResult } from "../src/orchestrator/tool-runner.js";
import { TaskStateManager } from "../src/task-state.js";

interface PreparedCall {
  readonly index: number;
}

interface SettledCall {
  readonly result: ToolRunResult;
  readonly capture?: {
    readonly status: "complete";
    readonly paths: readonly string[];
    readonly beforeContents: Readonly<Record<string, string | null>>;
    readonly afterContents: Readonly<Record<string, string | null>>;
  };
}

function toolCall(
  tool: string,
  args: Readonly<Record<string, unknown>>,
): AgentToolCallAction {
  return { type: "tool_call", tool, args };
}

describe("Loop Kernel v2 live tool commit seam", () => {
  test("exclusive barrier includes TaskState, durable result event, and projector port", async () => {
    const workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "paw-v2-live-commit-"),
    );
    const sourcePath = path.join(workspaceRoot, "source.ts");
    fs.writeFileSync(sourcePath, "zero\n", "utf8");
    const calls = [
      toolCall("workspace.read_file", { path: "source.ts" }),
      toolCall("workspace.edit_file", {
        path: "source.ts",
        old_string: "zero",
        new_string: "one",
      }),
      toolCall("workspace.edit_file", {
        path: "source.ts",
        old_string: "one",
        new_string: "two",
      }),
      toolCall("workspace.read_file", { path: "source.ts" }),
    ];
    const trace: string[] = [];
    const taskState = new TaskStateManager("change source twice");
    const projected: Array<{
      readonly callId: string;
      readonly repositoryRevision: string;
      readonly concurrentMutation: boolean;
    }> = [];

    try {
      const scheduled = calls.map((call, index) => ({
        callId: `call-${index}`,
        tool: call.tool,
        args: call.args as Readonly<Record<string, unknown>>,
      }));
      const result = await executeToolBatchV2<
        PreparedCall,
        SettledCall,
        ToolRunResult
      >(scheduled, {
        classify(call) {
          return call.tool === "workspace.read_file"
            ? { kind: "parallel" }
            : { kind: "exclusive", scope: ["source.ts"] };
        },
        async prepare(_call, index) {
          trace.push(`${index}:prepare`);
          return { kind: "dispatch", prepared: { index } };
        },
        async dispatch(prepared) {
          const index = prepared.index;
          trace.push(`${index}:body:start`);
          if (index === 0 || index === 3) {
            const content = fs.readFileSync(sourcePath, "utf8");
            trace.push(`${index}:body:end`);
            return {
              result: {
                ok: true,
                summary: "read source.ts",
                payload: { content },
              },
            };
          }
          const before = fs.readFileSync(sourcePath, "utf8");
          const after = index === 1 ? "one\n" : "two\n";
          fs.writeFileSync(sourcePath, after, "utf8");
          trace.push(`${index}:body:end`);
          return {
            result: {
              ok: true,
              summary: "edited source.ts",
              payload: {
                path: "source.ts",
                linesAdded: 1,
                linesRemoved: 1,
              },
            },
            capture: {
              status: "complete",
              paths: ["source.ts"],
              beforeContents: { "source.ts": before },
              afterContents: { "source.ts": after },
            },
          };
        },
        async commit(_scheduled, settled, index) {
          trace.push(`${index}:commit:start`);
          const sourceCall = calls[index];
          if (!sourceCall) throw new Error(`missing source call ${index}`);
          commitToolExecutionResult(
            sourceCall,
            settled.result,
            index,
            {
              emit(event: RunEvent) {
                if (event.type === "tool.result") {
                  trace.push(`${index}:event`);
                }
              },
              runId: "v2-live-commit",
              workspaceRoot,
              turn: 4,
              taskState,
              observeLoopV2ToolCommit(input) {
                trace.push(`${index}:projector`);
                projected.push({
                  callId: input.callId,
                  repositoryRevision: input.repositoryRevision,
                  concurrentMutation: input.concurrentMutation,
                });
              },
            },
            {
              concurrentMutation: false,
              mutationCapture: settled.capture,
            },
          );
          trace.push(`${index}:commit:end`);
          return settled.result;
        },
        async skip(_call, index) {
          return {
            result: {
              ok: false,
              summary: `skipped ${index}`,
              payload: { skipped: true },
            },
          };
        },
      });

      expect(result.committed.map((entry) => entry.index)).toEqual([
        0, 1, 2, 3,
      ]);
      expect(taskState.snapshot().mutationRevision).toBe(2);
      expect(fs.readFileSync(sourcePath, "utf8")).toBe("two\n");
      expect(projected.map((entry) => entry.callId)).toEqual([
        "legacy:v2-live-commit:turn:4:call:0",
        "legacy:v2-live-commit:turn:4:call:1",
        "legacy:v2-live-commit:turn:4:call:2",
        "legacy:v2-live-commit:turn:4:call:3",
      ]);
      expect(projected.map((entry) => entry.repositoryRevision)).toEqual([
        "run:v2-live-commit:mutation:0",
        "run:v2-live-commit:mutation:0",
        "run:v2-live-commit:mutation:1",
        "run:v2-live-commit:mutation:2",
      ]);
      expect(projected.every((entry) => !entry.concurrentMutation)).toBeTrue();

      for (const index of [0, 1, 2]) {
        expect(trace.indexOf(`${index}:projector`)).toBeLessThan(
          trace.indexOf(`${index}:commit:end`),
        );
        expect(trace.indexOf(`${index}:commit:end`)).toBeLessThan(
          trace.indexOf(`${index + 1}:body:start`),
        );
      }
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});
