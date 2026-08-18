import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  type AgentToolCallAction,
  ContextManager,
  FileSystemSessionStore,
  type RunEvent,
  type RunEventEnvelope,
} from "@paw/core";
import type { ToolRunResult } from "@paw/harness";

import { executeToolBatchV2 } from "../src/loop-v2/index.js";
import { AgentOrchestrator } from "../src/orchestrator.js";
import {
  annotateUntrustedShellExitSummary,
  classifyToolExecutionV2,
  commitToolExecutionResult,
  executeToolCallsV2,
  finalizeToolExecutionContext,
} from "../src/orchestrator/tool-runner.js";
import { DefaultSubAgentLauncher } from "../src/sub-agent-launcher.js";
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
  test("exclusive barrier includes TaskState and the atomic durable decision fact", async () => {
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
                  const input = event.decisionCommit;
                  if (!input) throw new Error("missing durable decision commit");
                  trace.push(`${index}:projector`);
                  projected.push({
                    callId: input.callId,
                    repositoryRevision: input.repositoryRevision,
                    concurrentMutation: input.concurrentMutation,
                  });
                }
              },
              runId: "v2-live-commit",
              workspaceRoot,
              turn: 4,
              taskState,
              captureLoopV2Facts: true,
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

  test("explicit v2 routes a real mixed batch through source-ordered exclusive edits", async () => {
    const workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "paw-v2-live-orchestrator-"),
    );
    fs.writeFileSync(path.join(workspaceRoot, "source.txt"), "zero\n", "utf8");
    const events: RunEventEnvelope[] = [];
    let modelCalls = 0;
    const orchestrator = new AgentOrchestrator({
      loopKernelVersion: "v2",
      model: {
        label: "v2-live-mixed-fixture",
        async complete() {
          modelCalls += 1;
          if (modelCalls === 1) {
            return {
              text: [
                '{"tool":"workspace.read_file","args":{"path":"source.txt","offset":0,"limit":1}}',
                '{"tool":"workspace.edit_file","args":{"path":"source.txt","old_string":"zero","new_string":"one"}}',
                '{"tool":"workspace.edit_file","args":{"path":"source.txt","old_string":"one","new_string":"two"}}',
                '{"tool":"workspace.read_file","args":{"path":"source.txt","offset":1,"limit":1}}',
              ].join("\n"),
            };
          }
          return {
            text: '{"action":"final_answer","summary":"updated source [skip_verify: deterministic scheduler fixture]"}',
          };
        },
      },
      onEvent(event) {
        events.push(event);
      },
    });

    try {
      const result = await orchestrator.run({
        runId: "v2-live-mixed",
        goal: "change source.txt from zero to two\n[allow_skip_verify]",
        workspaceRoot,
        maxSteps: 4,
      });
      expect(result.status).toBe("completed");
      expect(modelCalls).toBe(2);
      expect(
        fs.readFileSync(path.join(workspaceRoot, "source.txt"), "utf8"),
      ).toBe("two\n");
      expect(
        events
          .filter((event) => event.event.type === "tool.result")
          .map((event) =>
            event.event.type === "tool.result" ? event.event.tool : "",
          ),
      ).toEqual([
        "workspace.read_file",
        "workspace.edit_file",
        "workspace.edit_file",
        "workspace.read_file",
      ]);
      const checkpointRoot = path.join(
        workspaceRoot,
        ".paw",
        "checkpoints",
        "v2-live-mixed",
      );
      expect(fs.readdirSync(checkpointRoot).sort()).toEqual(["1", "2"]);
      const durableEvents =
        new FileSystemSessionStore({ workspaceRoot }).loadRun(
          "v2-live-mixed",
        ) ?? [];
      const durableToolResults = durableEvents.filter(
        (event) => event.event.type === "tool.result",
      );
      expect(durableToolResults).toHaveLength(4);
      expect(
        durableToolResults.every(
          (event) =>
            event.event.type === "tool.result" &&
            event.event.decisionCommit?.schemaVersion ===
              "paw.tool-decision-commit.v1",
        ),
      ).toBeTrue();
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("a throwing event consumer cannot erase an executed tool from the durable journal", async () => {
    const workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "paw-v2-durable-before-delivery-"),
    );
    fs.writeFileSync(path.join(workspaceRoot, "value.txt"), "before\n", "utf8");
    const runId = "v2-durable-before-delivery";
    const orchestrator = new AgentOrchestrator({
      loopKernelVersion: "v2",
      memoryExtraction: "off",
      memoryLlm: "off",
      model: {
        label: "durable-before-delivery-fixture",
        async complete() {
          return {
            text: '{"tool":"workspace.edit_file","args":{"path":"value.txt","old_string":"before","new_string":"after"}}',
          };
        },
      },
      onEvent(envelope) {
        if (envelope.event.type === "tool.result") {
          throw new Error("consumer failed");
        }
      },
    });

    try {
      const result = await orchestrator.run({
        runId,
        goal: "change value.txt",
        workspaceRoot,
        maxSteps: 2,
      });
      expect(result.status).toBe("failed");
      expect(fs.readFileSync(path.join(workspaceRoot, "value.txt"), "utf8")).toBe(
        "after\n",
      );
      const journal =
        new FileSystemSessionStore({ workspaceRoot }).loadRunStrict(runId) ?? [];
      const committed = journal.find(
        (event) => event.event.type === "tool.result",
      );
      expect(committed?.event.type).toBe("tool.result");
      if (committed?.event.type === "tool.result") {
        expect(committed.event.decisionCommit?.mutationCapture?.status).toBe(
          "complete",
        );
      }
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("production classifier allows only declared reads to overlap", () => {
    expect(
      classifyToolExecutionV2(toolCall("workspace.grep", { pattern: "needle" }))
        .kind,
    ).toBe("parallel");
    expect(
      classifyToolExecutionV2(
        toolCall("workspace.run_shell", { command: "git status" }),
      ).kind,
    ).toBe("exclusive");
    expect(classifyToolExecutionV2(toolCall("mcp.unknown", {})).kind).toBe(
      "exclusive",
    );
  });

  test("a child changedFiles report advances the parent mutation revision", () => {
    const taskState = new TaskStateManager("delegate a source change");
    commitToolExecutionResult(
      toolCall("workspace.run_agent", {
        goal: "change child.ts",
        child_policy: "read_write",
      }),
      {
        ok: true,
        summary: "child changed one file",
        payload: { changedFiles: ["child.ts"] },
      },
      0,
      {
        emit: () => {},
        runId: "v2-child-mutation",
        workspaceRoot: os.tmpdir(),
        turn: 0,
        taskState,
      },
      {
        concurrentMutation: false,
        mutationCapture: {
          status: "gap",
          reason: "unbounded_mutation_surface",
        },
      },
    );
    expect(taskState.snapshot().mutationRevision).toBe(1);
    expect(taskState.snapshot().filesChanged).toEqual(["child.ts"]);
  });

  test("sub-agent launcher derives changedFiles from durable child events", async () => {
    const workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "paw-v2-child-changes-"),
    );
    let childCalls = 0;
    const launcher = new DefaultSubAgentLauncher({
      workspaceRoot,
      model: {
        label: "v2-writing-child",
        async complete() {
          childCalls += 1;
          return childCalls === 1
            ? {
                text: '{"tool":"workspace.write_file","args":{"path":"child.ts","content":"export const child = true;\\n"}}',
              }
            : {
                text: '{"action":"final_answer","summary":"child wrote file [skip_verify: deterministic child fixture]"}',
              };
        },
      },
      maxSteps: 3,
    });
    try {
      const child = await launcher.launch(
        "write child.ts\n[allow_skip_verify]",
        3,
        {
          args: { child_policy: "read_write" },
          parentRunId: "v2-child-parent",
          agentId: "child-v2-child-parent-0",
        },
      );
      expect(child.status).toBe("completed");
      expect(child.changedFiles).toEqual(["child.ts"]);
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("policy denial commits in source order without dropping a read sibling", async () => {
    const workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "paw-v2-policy-"),
    );
    fs.writeFileSync(path.join(workspaceRoot, "visible.txt"), "ok\n", "utf8");
    const calls = [
      toolCall("workspace.list_dir", { path: "." }),
      toolCall("workspace.write_file", {
        path: "blocked.txt",
        content: "no",
      }),
    ];
    const committed: string[] = [];
    try {
      const batch = await executeToolCallsV2(
        calls,
        {
          workspaceRoot,
          runId: "v2-policy",
          emit: () => {},
          checkpointSeq: { n: 0 },
          toolExecutionPolicy: ({ tool }) =>
            tool === "workspace.write_file"
              ? {
                  allowed: false,
                  reason: "fixture_deny",
                  message: "write denied",
                }
              : { allowed: true },
        },
        {},
        {
          commit(call) {
            committed.push(call.tool);
          },
        },
      );
      expect(committed).toEqual(["workspace.list_dir", "workspace.write_file"]);
      expect(batch.results.map((result) => result.ok)).toEqual([true, false]);
      expect(batch.results[1]?.summary).toContain("fixture_deny");
      expect(
        fs.existsSync(path.join(workspaceRoot, "blocked.txt")),
      ).toBeFalse();
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("a caller-forced approval keeps otherwise read-only calls exclusive", async () => {
    const workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "paw-v2-read-approval-"),
    );
    fs.mkdirSync(path.join(workspaceRoot, "a"));
    fs.mkdirSync(path.join(workspaceRoot, "b"));
    let activeApprovals = 0;
    let maxActiveApprovals = 0;
    const committed: string[] = [];
    try {
      const batch = await executeToolCallsV2(
        [
          toolCall("workspace.list_dir", { path: "a" }),
          toolCall("workspace.list_dir", { path: "b" }),
        ],
        {
          workspaceRoot,
          runId: "v2-read-approval",
          emit: () => {},
          checkpointSeq: { n: 0 },
        },
        {
          approvalPolicy: () => true,
          async resolveToolApproval(input) {
            activeApprovals += 1;
            maxActiveApprovals = Math.max(maxActiveApprovals, activeApprovals);
            await new Promise((resolve) => setTimeout(resolve, 5));
            committed.push(String((input.args as { path?: string }).path));
            activeApprovals -= 1;
            return true;
          },
        },
        { commit: () => {} },
      );
      expect(batch.results.map((result) => result.ok)).toEqual([true, true]);
      expect(maxActiveApprovals).toBe(1);
      expect(committed).toEqual(["a", "b"]);
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("audited no-effect shell closes an exclusive mutation capture", async () => {
    const workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "paw-v2-shell-audit-"),
    );
    const captures: unknown[] = [];
    try {
      const batch = await executeToolCallsV2(
        [
          toolCall("workspace.run_shell", {
            command: "node -e \"process.stdout.write('ok')\"",
          }),
        ],
        {
          workspaceRoot,
          runId: "v2-shell-audit",
          emit: () => {},
          checkpointSeq: { n: 0 },
          toolEffectPolicy: {
            appliesTo: () => true,
            prepare: () => ({ before: true }),
            settle(input) {
              const payload =
                input.result.payload &&
                typeof input.result.payload === "object" &&
                !Array.isArray(input.result.payload)
                  ? input.result.payload
                  : {};
              return {
                allowed: true,
                result: {
                  ...input.result,
                  payload: {
                    ...payload,
                    workspaceEffect: { changed: false, paths: [] },
                  },
                },
              };
            },
          },
        },
        {},
        {
          commit(_call, _result, capture) {
            captures.push(capture);
          },
        },
      );
      expect(batch.results[0]?.ok).toBeTrue();
      expect(captures).toEqual([
        {
          status: "complete",
          paths: [],
          beforeContents: {},
          afterContents: {},
        },
      ]);
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("pre-aborted production batch commits explicit skips and performs no write", async () => {
    const workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "paw-v2-abort-"),
    );
    const controller = new AbortController();
    controller.abort();
    const committed: ToolRunResult[] = [];
    try {
      const batch = await executeToolCallsV2(
        [
          toolCall("workspace.write_file", {
            path: "never.txt",
            content: "never",
          }),
          toolCall("workspace.list_dir", { path: "." }),
        ],
        {
          workspaceRoot,
          runId: "v2-abort",
          emit: () => {},
          checkpointSeq: { n: 0 },
          abortSignal: controller.signal,
        },
        {},
        {
          commit(_call, result) {
            committed.push(result);
          },
        },
      );
      expect(batch.aborted).toBeTrue();
      expect(committed).toHaveLength(2);
      expect(
        committed.every(
          (result) =>
            (result.payload as { code?: string }).code === "E_RUN_ABORTED",
        ),
      ).toBeTrue();
      expect(fs.existsSync(path.join(workspaceRoot, "never.txt"))).toBeFalse();
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("explicit v2 keeps run_agent, grep, and edit siblings in one ordered batch", async () => {
    const workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "paw-v2-mixed-child-"),
    );
    fs.writeFileSync(path.join(workspaceRoot, "source.txt"), "zero\n", "utf8");
    let parentCalls = 0;
    const events: RunEventEnvelope[] = [];
    const launcher = new DefaultSubAgentLauncher({
      workspaceRoot,
      model: {
        label: "v2-read-only-child",
        async complete() {
          return {
            text: '{"action":"final_answer","summary":"child inspected source"}',
          };
        },
      },
      maxSteps: 2,
    });
    const orchestrator = new AgentOrchestrator({
      loopKernelVersion: "v2",
      subAgentLauncher: launcher,
      model: {
        label: "v2-mixed-child-parent",
        async complete() {
          parentCalls += 1;
          if (parentCalls === 1) {
            return {
              text: [
                '{"tool":"workspace.run_agent","args":{"goal":"inspect source.txt","child_policy":"read_only"}}',
                '{"tool":"workspace.grep","args":{"pattern":"zero","path":"source.txt"}}',
                '{"tool":"workspace.run_agent","args":{"goal":"inspect repository conventions","child_policy":"read_only"}}',
                '{"tool":"workspace.edit_file","args":{"path":"source.txt","old_string":"zero","new_string":"done"}}',
              ].join("\n"),
            };
          }
          return {
            text: '{"action":"final_answer","summary":"mixed batch complete [skip_verify: deterministic scheduler fixture]"}',
          };
        },
      },
      onEvent(event) {
        events.push(event);
      },
    });

    try {
      const result = await orchestrator.run({
        runId: "v2-mixed-child",
        goal: "inspect then change source.txt\n[allow_skip_verify]",
        workspaceRoot,
        maxSteps: 4,
      });
      expect(result.status).toBe("completed");
      expect(
        fs.readFileSync(path.join(workspaceRoot, "source.txt"), "utf8"),
      ).toBe("done\n");
      const rootResults = events
        .filter((event) => event.event.type === "tool.result")
        .map((event) =>
          event.event.type === "tool.result" ? event.event.tool : "",
        );
      expect(rootResults).toEqual([
        "workspace.run_agent",
        "workspace.grep",
        "workspace.run_agent",
        "workspace.edit_file",
      ]);
      expect(
        events.some(
          (event) =>
            event.event.type === "tool.call" &&
            event.event.tool === "workspace.run_agent" &&
            event.event.callId === "child-v2-mixed-child-0",
        ),
      ).toBeTrue();
      expect(
        events.some(
          (event) =>
            event.event.type === "tool.call" &&
            event.event.tool === "workspace.run_agent" &&
            event.event.callId === "child-v2-mixed-child-2",
        ),
      ).toBeTrue();
      const journal = new FileSystemSessionStore({
        workspaceRoot,
      }).loadRunStrict("v2-mixed-child");
      expect(journal).not.toBeNull();
      expect(journal?.map((event) => event.seq)).toEqual(
        journal?.map((event) => event.seq).sort((left, right) => left - right),
      );
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});

describe("untrusted exit status inline annotation (Loop v2.1 §6.1/K3)", () => {
  const pipedCommand = "python tests/runtests.py i18n -v 1 2>&1 | tail -60";

  function shellResult(summary: string): ToolRunResult {
    return {
      ok: true,
      summary,
      payload: {
        exit_code: 0,
        stdout: "Ran 214 tests\n\nFAILED (failures=2, errors=1)\n",
        stderr: "",
      },
    };
  }

  test("piped verification command annotates the durable decision fact and model-visible summary", () => {
    const workspaceRoot = path.join(os.tmpdir(), "paw-untrusted-exit-ws");
    const call = toolCall("workspace.run_shell", { command: pipedCommand });
    const result = shellResult("run_shell: exit 0");
    const taskState = new TaskStateManager("fix django i18n prefix");
    const events: RunEvent[] = [];
    const durableResults: ToolRunResult[] = [];

    commitToolExecutionResult(
      call,
      result,
      0,
      {
        emit(event: RunEvent) {
          events.push(event);
          if (event.type === "tool.result" && event.decisionCommit) {
            durableResults.push(event.decisionCommit.result);
          }
        },
        runId: "untrusted-exit",
        workspaceRoot,
        turn: 30,
        taskState,
        captureLoopV2Facts: true,
      },
      { concurrentMutation: false },
    );

    // 1) durable tool.result 事实带内联标注与直接重跑指令
    const emitted = events.find(
      (event): event is Extract<RunEvent, { type: "tool.result" }> =>
        event.type === "tool.result",
    );
    expect(emitted).toBeDefined();
    expect(emitted?.summary).toContain("run_shell: exit 0");
    expect(emitted?.summary).toContain("[UntrustedExitStatus]");
    expect(emitted?.summary).toContain(
      "re-run the same runner directly without pipes",
    );

    // 2) 同一判定源：TaskState 验证分类仍为 harness_failed/untrusted_exit_status
    const verification = taskState.snapshot().testResults.at(-1);
    expect(verification?.outcome).toBe("harness_failed");
    expect(verification?.failureKind).toBe("untrusted_exit_status");

    // 3) durable v2 decision fact 收到同一份标注后的结果
    expect(durableResults[0]?.summary).toContain("[UntrustedExitStatus]");

    // 4) 模型可见上下文（下一轮 user 消息）包含标注
    const ctxMgr = new ContextManager();
    const final = finalizeToolExecutionContext([call], [result], {
      ctxMgr,
      emit() {},
      runId: "untrusted-exit",
      workspaceRoot,
      turn: 30,
      maxSteps: 96,
      specGoal: "fix django i18n prefix",
      text: "running the full suite",
      taskState,
    });
    expect(final.type).toBe("continue");
    const lastUser = ctxMgr.buildMessages().at(-1);
    expect(lastUser?.role).toBe("user");
    expect(lastUser?.content).toContain("[Tool workspace.run_shell completed]");
    expect(lastUser?.content).toContain("[UntrustedExitStatus]");
  });

  test("direct verification runs and piped non-verification commands stay unannotated", () => {
    const direct = annotateUntrustedShellExitSummary(
      toolCall("workspace.run_shell", {
        command: "python tests/runtests.py i18n -v 1",
      }),
      shellResult("run_shell: exit 0"),
    );
    expect(direct.summary).not.toContain("[UntrustedExitStatus]");

    const pipedNonVerification = annotateUntrustedShellExitSummary(
      toolCall("workspace.run_shell", {
        command: "ls django/conf/locale/ | grep -i sr",
      }),
      shellResult("run_shell: exit 0"),
    );
    expect(pipedNonVerification.summary).not.toContain("[UntrustedExitStatus]");

    // 非 shell 工具与重复标注不产生第二份事实
    const read = annotateUntrustedShellExitSummary(
      toolCall("workspace.read_file", { path: "a.ts" }),
      { ok: true, summary: "read a.ts", payload: {} },
    );
    expect(read.summary).toBe("read a.ts");

    const call = toolCall("workspace.run_shell", { command: pipedCommand });
    const once = annotateUntrustedShellExitSummary(
      call,
      shellResult("run_shell: exit 0"),
    );
    const twice = annotateUntrustedShellExitSummary(call, once);
    expect(twice.summary.match(/\[UntrustedExitStatus\]/g)?.length).toBe(1);
  });

  test("denied or never-executed piped commands carry no exit-status annotation", () => {
    // 沙箱拒绝（E_FATAL）：命令未执行，不存在可被遮蔽的退出码，
    // 标注只会稀释拒绝原因（真实轨迹 msvhlvzc seq=15028/15031）。
    const denied = annotateUntrustedShellExitSummary(
      toolCall("workspace.run_shell", { command: pipedCommand }),
      {
        ok: false,
        summary: "run_shell: E_FATAL privilege escalation",
        payload: { code: "E_FATAL", error: "privilege escalation" },
      },
    );
    expect(denied.summary).toBe("run_shell: E_FATAL privilege escalation");

    const noPayload = annotateUntrustedShellExitSummary(
      toolCall("workspace.run_shell", { command: pipedCommand }),
      {
        ok: false,
        summary: "run_shell: E_FATAL privilege escalation",
        payload: undefined,
      },
    );
    expect(noPayload.summary).not.toContain("[UntrustedExitStatus]");
  });
});
