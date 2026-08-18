import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  type ChatMessage,
  InMemoryAppStateStore,
  MAX_STEPS_WARNING,
} from "@paw/core";
import { SessionMemoryStore } from "@paw/memory";

import {
  type HostStateV1,
  assembleModelContextV1,
  selectEphemeralControlV1,
} from "../src/context-assembler.js";
import { AgentOrchestrator } from "../src/orchestrator.js";
import {
  TaskStateManager,
  formatTaskStateForContext,
} from "../src/task-state.js";

describe("ContextAssembler v1", () => {
  test("returns a request snapshot without mutating durable transcript", () => {
    const durable: ChatMessage[] = [
      { role: "system", content: "system" },
      { role: "user", content: "goal" },
    ];

    const assembled = assembleModelContextV1({
      durable: { messages: durable },
    });

    expect(assembled).toEqual(durable);
    expect(assembled).not.toBe(durable);
    expect(assembled[0]).not.toBe(durable[0]);
  });

  test("preserves attachments and atomic native turn metadata", () => {
    const nativeToolTurn = {
      schemaVersion: 1 as const,
      protocol: "openai-compatible" as const,
      assistantContent: "inspect",
      reasoningPassback: "provider state",
      calls: [
        {
          callId: "call-a",
          providerName: "read_file",
          rawArguments: '{"path":"a.ts"}',
        },
      ],
      results: [{ callId: "call-a", content: "A" }],
    };
    const durable: ChatMessage[] = [
      {
        role: "user",
        content: "see attachment",
        attachments: [
          { type: "file", name: "note.txt", content: "attachment body" },
        ],
      },
      {
        role: "assistant",
        content: "fallback",
        nativeToolTurn,
      },
    ];

    const assembled = assembleModelContextV1({
      durable: { messages: durable },
      hostState: { status: "fresh status" },
    });

    expect(assembled).toHaveLength(3);
    expect(assembled[0]?.attachments).toBe(durable[0]?.attachments);
    expect(assembled[1]?.content).toBe("[Host State v1]\nfresh status");
    expect(assembled[2]?.nativeToolTurn).toBe(nativeToolTurn);
  });

  test("never inserts host state before leading system messages", () => {
    const assembled = assembleModelContextV1({
      durable: { messages: [{ role: "system", content: "system" }] },
      hostState: { status: "fresh status" },
    });

    expect(assembled.map((message) => message.role)).toEqual([
      "system",
      "user",
    ]);
  });

  test("renders typed host facts and only one ephemeral control", () => {
    const hostState: HostStateV1 = {
      taskBrief: {
        currentObjective: "fix the failing parser",
        stage: "implementation",
        openItems: ["add regression test"],
      },
      constraints: ["do not change the public API"],
    };

    const assembled = assembleModelContextV1({
      durable: { messages: [{ role: "user", content: "original request" }] },
      hostState,
      control: { kind: "test_warden", text: "pytest is still failing" },
    });

    expect(assembled).toHaveLength(3);
    expect(assembled[0]?.content).toContain("[Host State v1]");
    expect(assembled[1]?.content).toBe("original request");
    expect(assembled[0]?.content).toContain("fix the failing parser");
    expect(assembled[2]?.content).toBe(
      "[Ephemeral Control v1]\nkind: test_warden\npytest is still failing",
    );
  });

  test("selects one control by stable urgency priority", () => {
    expect(
      selectEphemeralControlV1([
        { kind: "progress", text: "change hypothesis" },
        { kind: "test_warden", text: "tests failed" },
        {
          kind: "completion_gate",
          gate: "verification",
          text: "verify before completion",
        },
        { kind: "readiness", text: "repair candidate" },
        { kind: "protocol_recovery", text: "retry protocol" },
      ]),
    ).toEqual({ kind: "protocol_recovery", text: "retry protocol" });
    expect(
      selectEphemeralControlV1([
        { kind: "progress", text: "first" },
        { kind: "progress", text: "second" },
      ]),
    ).toEqual({ kind: "progress", text: "first" });
    expect(
      selectEphemeralControlV1([
        { kind: "test_warden", text: "   " },
        undefined,
      ]),
    ).toBeUndefined();
    expect(
      selectEphemeralControlV1([{ kind: "status", text: "tests passed" }]),
    ).toEqual({ kind: "status", text: "tests passed" });
    const completionOnly = assembleModelContextV1({
      durable: { messages: [] },
      control: {
        kind: "completion_gate",
        gate: "acceptance",
        text: "resolve criterion C1",
      },
    });
    expect(completionOnly[0]?.content).toBe(
      "[Ephemeral Control v1]\nkind: completion_gate\ngate: acceptance\nresolve criterion C1",
    );
  });

  test("uses canonical host order and removes only exact legacy projections", () => {
    const legacyAcceptance = `Acceptance ledger updated: direct check.\n\n${formatTaskStateForContext(new TaskStateManager("goal").snapshot())}`;
    const legacyPlan =
      'Plan updated: bootstrap.\n\nCurrent plan (JSON):\n{"workflow_id":"run-1","revision":1,"items":[],"items_total":0,"truncated":false,"next_pending":null,"all_complete":true}';
    const legacyEmptyReasonPlan =
      'Plan updated: .\n\nCurrent plan (JSON):\n{"workflow_id":"run-1","revision":1,"items":[],"items_total":0,"truncated":false,"next_pending":null,"all_complete":true}';
    const legacyParallelPlan =
      'Plan updated: parallel.\n\n\nPending items that do not depend on each other can be investigated in parallel via workspace.run_agent (read-only sub-agents return one-page summaries).\nCurrent plan (JSON):\n{"workflow_id":"run-1","revision":1,"items":[],"items_total":0,"truncated":false,"next_pending":null,"all_complete":true}';
    const nearCollisionParallelPlan = legacyParallelPlan.replace(
      "summaries).\nCurrent",
      "summaries).\n\nCurrent",
    );
    const largeTaskState = new TaskStateManager("large plan");
    largeTaskState.setPlan(
      Array.from({ length: 30 }, (_, index) => ({
        id: `plan-${index + 1}`,
        task_id: `step ${index + 1}`,
        status: index < 24 ? "completed" : "pending",
        depends_on: [],
      })),
    );
    const legacyLargeAcceptance = `Acceptance ledger updated: direct check.\n\n${formatTaskStateForContext(largeTaskState.snapshot())}`;
    const legacyContextGuard =
      "[Context guard] History budget exhausted (123 / 100 tokens). New tool outputs will be truncated and archived as [archived id=N] references — use context.recall to restore the full text when needed. Prefer short commands and targeted reads.";
    const legacyImplementation =
      "[Implementation checkpoint] Half of the available model turns have been used without a recorded source change. Consolidate the evidence into the smallest plausible implementation soon. If one specific unseen source span or materially different diagnostic is still required to edit safely, gather it now; avoid exact repeats and broad browsing. Then edit the product source and run the narrowest existing test.";
    const legacyConvergence =
      "[Convergence checkpoint] 4 model turns remain. Preserve the existing solution state and close the loop. Run the narrowest high-signal acceptance or regression test against the current source revision. Prefer an existing repository test or a direct command; do not build and debug a separate helper harness. Do not rely on a test that predates the latest edit.";
    const impossibleContextGuard = legacyContextGuard.replace(
      "123 / 100",
      "1 / 2",
    );
    const assembled = assembleModelContextV1({
      durable: {
        messages: [
          { role: "user", content: "[Context Package]\nold facts" },
          { role: "user", content: "[Status Snapshot v1]\nold status" },
          { role: "user", content: "[Context Package] is my requested title" },
          { role: "user", content: "[My bracketed request] keep this" },
          { role: "user", content: legacyAcceptance },
          { role: "user", content: legacyPlan },
          { role: "user", content: legacyEmptyReasonPlan },
          { role: "user", content: legacyParallelPlan },
          { role: "user", content: legacyLargeAcceptance },
          { role: "user", content: legacyContextGuard },
          { role: "user", content: legacyImplementation },
          { role: "user", content: legacyConvergence },
          { role: "user", content: MAX_STEPS_WARNING },
          { role: "user", content: `${legacyAcceptance} please explain` },
          { role: "user", content: `${legacyPlan} please explain` },
          { role: "user", content: nearCollisionParallelPlan },
          { role: "user", content: `${legacyContextGuard}\nplease explain` },
          { role: "user", content: impossibleContextGuard },
          { role: "user", content: `${legacyImplementation} changed` },
          {
            role: "user",
            content: legacyConvergence.replace("4 model", "13 model"),
          },
          { role: "user", content: `${MAX_STEPS_WARNING}\nextra` },
          { role: "assistant", content: "working" },
        ],
      },
      hostState: {
        status: "[Status Snapshot v1]\nfresh status",
        taskProgress: "[Current State]\nNext step: test",
        planSnapshot: {
          json: '{"workflow_id":"run-1","items":[]}',
          parallelismAvailable: true,
        },
        constraints: ["keep API stable"],
        taskBrief: { stage: "verify" },
      },
    });

    expect(assembled.map((message) => message.content)).toEqual([
      "[Context Package] is my requested title",
      "[My bracketed request] keep this",
      `${legacyAcceptance} please explain`,
      `${legacyPlan} please explain`,
      nearCollisionParallelPlan,
      `${legacyContextGuard}\nplease explain`,
      impossibleContextGuard,
      `${legacyImplementation} changed`,
      legacyConvergence.replace("4 model", "13 model"),
      `${MAX_STEPS_WARNING}\nextra`,
      '[Host State v1]\n[Task Brief]\nstage: verify\n[Constraints]\n- keep API stable\n[Current State]\nNext step: test\n[Plan Snapshot]\nPending items that do not depend on each other can be investigated in parallel via workspace.run_agent (read-only sub-agents return one-page summaries).\nCurrent plan (JSON):\n{"workflow_id":"run-1","items":[]}\n[Status Snapshot v1]\nfresh status',
      "working",
    ]);
  });

  test("eval hook sees the exact array passed to the primary model", async () => {
    let hookMessages: readonly ChatMessage[] | undefined;
    let providerMessages:
      | readonly import("@paw/models").ChatMessage[]
      | undefined;
    const orchestrator = new AgentOrchestrator({
      model: {
        label: "context-assembler-request-identity",
        async complete(messages) {
          providerMessages = messages;
          return { text: '{"action":"final_answer","summary":"done"}' };
        },
      },
      evalHooks: {
        beforeModelCall: ({ messages }) => {
          hookMessages = messages;
        },
      },
      retrySleep: async () => {},
    });

    await orchestrator.run({
      runId: "context-assembler-request-identity",
      goal: "answer once",
      workspaceRoot: mkdtempSync(path.join(tmpdir(), "paw-context-assembler-")),
      maxSteps: 1,
    });

    expect(hookMessages).toBeDefined();
    expect(providerMessages).toBe(hookMessages);
  });

  test("fresh request renders the original goal and verbatim constraint once", async () => {
    let providerMessages:
      | readonly import("@paw/models").ChatMessage[]
      | undefined;
    const orchestrator = new AgentOrchestrator({
      model: {
        label: "context-assembler-no-duplicates",
        async complete(messages) {
          providerMessages = messages;
          return { text: '{"action":"final_answer","summary":"done"}' };
        },
      },
      retrySleep: async () => {},
    });

    await orchestrator.run({
      runId: "context-assembler-no-duplicates",
      goal: "Inspect GOAL_ONCE_7F3.\nDo not modify LOCKED_ONCE_91A.",
      workspaceRoot: mkdtempSync(path.join(tmpdir(), "paw-context-once-")),
      maxSteps: 1,
    });

    const requestText = providerMessages
      ?.map((message) => message.content)
      .join("\n");
    expect(requestText?.split("GOAL_ONCE_7F3")).toHaveLength(2);
    expect(requestText?.split("LOCKED_ONCE_91A")).toHaveLength(2);
  });

  test("v2 preflight TestWarden is request-only ephemeral control", async () => {
    const workspaceRoot = mkdtempSync(path.join(tmpdir(), "paw-control-v2-"));
    mkdirSync(path.join(workspaceRoot, ".paw"), { recursive: true });
    writeFileSync(
      path.join(workspaceRoot, ".paw", "memory-config.json"),
      JSON.stringify({ enable: false }),
      "utf8",
    );
    let providerMessages: readonly ChatMessage[] = [];
    const durableControlCounts: number[] = [];
    const orchestrator = new AgentOrchestrator({
      loopKernelVersion: "v2",
      model: {
        label: "v2-ephemeral-preflight",
        async complete(messages) {
          providerMessages = messages;
          return { text: '{"action":"final_answer","summary":"done"}' };
        },
      },
      evalHooks: {
        beforeModelCall: ({ contextManager }) => {
          durableControlCounts.push(
            contextManager
              .buildMessages()
              .filter((message) => message.content.includes("[TestWarden]"))
              .length,
          );
        },
      },
      retrySleep: async () => {},
    });

    await orchestrator.run({
      runId: "v2-ephemeral-preflight",
      goal: "Inspect this empty fixture.",
      workspaceRoot,
      maxSteps: 1,
    });

    const controls = providerMessages.filter((message) =>
      message.content.startsWith("[Ephemeral Control v1]"),
    );
    expect(controls).toHaveLength(1);
    expect(controls[0]?.content).toContain("kind: test_warden");
    expect(controls[0]?.content).toContain("[TestWarden]");
    expect(providerMessages.at(-1)).toBe(controls[0]);
    expect(durableControlCounts).toEqual([0]);
  });

  test("v2 ProgressAdvice appears once without growing durable history", async () => {
    const workspaceRoot = mkdtempSync(
      path.join(tmpdir(), "paw-control-progress-"),
    );
    mkdirSync(path.join(workspaceRoot, ".paw"), { recursive: true });
    writeFileSync(
      path.join(workspaceRoot, ".paw", "memory-config.json"),
      JSON.stringify({ enable: false }),
      "utf8",
    );
    for (const name of ["a.txt", "b.txt", "c.txt", "d.txt"]) {
      writeFileSync(path.join(workspaceRoot, name), name, "utf8");
    }
    const responses = [
      '{"tool":"workspace.read_file","args":{"path":"a.txt"}}',
      '{"tool":"workspace.read_file","args":{"path":"b.txt"}}',
      '{"tool":"workspace.read_file","args":{"path":"c.txt"}}',
      '{"tool":"workspace.read_file","args":{"path":"d.txt"}}',
      '{"action":"final_answer","summary":"inspected"}',
    ];
    const requestControls: string[] = [];
    const durableProgressCounts: number[] = [];
    const orchestrator = new AgentOrchestrator({
      loopKernelVersion: "v2",
      model: {
        label: "v2-ephemeral-progress",
        async complete(messages) {
          const control = messages.find((message) =>
            message.content.startsWith("[Ephemeral Control v1]"),
          );
          if (control) requestControls.push(control.content);
          return { text: responses.shift() ?? "" };
        },
      },
      evalHooks: {
        beforeModelCall: ({ contextManager }) => {
          durableProgressCounts.push(
            contextManager
              .buildMessages()
              .filter((message) => message.content.includes("[ProgressAdvice:"))
              .length,
          );
        },
      },
      retrySleep: async () => {},
    });

    await orchestrator.run({
      runId: "v2-ephemeral-progress",
      goal: "Inspect four files before deciding.",
      workspaceRoot,
      maxSteps: 5,
    });

    expect(
      requestControls.filter((content) => content.includes("kind: progress")),
    ).toHaveLength(1);
    expect(requestControls.join("\n")).toContain(
      "[ProgressAdvice:inspect_gap]",
    );
    expect(durableProgressCounts.every((count) => count === 0)).toBe(true);
  });

  test("format recovery survives interruption once and stays out of durable history", async () => {
    const workspaceRoot = mkdtempSync(
      path.join(tmpdir(), "paw-format-recovery-resume-"),
    );
    mkdirSync(path.join(workspaceRoot, ".paw"), { recursive: true });
    writeFileSync(
      path.join(workspaceRoot, ".paw", "memory-config.json"),
      JSON.stringify({ enable: false }),
      "utf8",
    );
    const runId = "format-recovery-resume";
    const stateStore = new InMemoryAppStateStore();
    const abort = new AbortController();
    const first = new AgentOrchestrator({
      appStateStore: stateStore,
      model: {
        label: "malformed-tool-call",
        async complete() {
          return { text: '{"tool":"workspace.read_file","args":' };
        },
      },
      onEvent(envelope) {
        if (envelope.event.type === "model.done") abort.abort();
      },
      retrySleep: async () => {},
    });

    const interrupted = await first.run({
      runId,
      goal: "Inspect the workspace.",
      workspaceRoot,
      maxSteps: 3,
      abortSignal: abort.signal,
    });
    expect(interrupted.status).toBe("aborted");
    expect(stateStore.load(runId)?.loopControl).toMatchObject({
      protocolRecovery: { formatErrorNudges: 1 },
      pendingControl: { kind: "protocol_recovery" },
    });
    expect(
      stateStore
        .load(runId)
        ?.messages.some((message) =>
          message.content.startsWith(
            "[Your last output could not be parsed as a tool call",
          ),
        ),
    ).toBe(false);

    let request: readonly ChatMessage[] = [];
    const resumed = new AgentOrchestrator({
      appStateStore: stateStore,
      model: {
        label: "format-recovery-resumed",
        async complete(messages) {
          request = messages;
          return { text: '{"action":"final_answer","summary":"done"}' };
        },
      },
      retrySleep: async () => {},
    });
    await resumed.resumeRun({ runId, workspaceRoot });

    expect(
      request.filter((message) =>
        message.content.includes(
          "[Your last output could not be parsed as a tool call",
        ),
      ),
    ).toHaveLength(1);
    expect(stateStore.load(runId)?.loopControl).toMatchObject({
      protocolRecovery: { formatErrorNudges: 1 },
    });
    expect(stateStore.load(runId)?.loopControl).not.toHaveProperty(
      "pendingControl",
    );
  });

  test("no-action recovery survives interruption and a valid action resets it", async () => {
    const workspaceRoot = mkdtempSync(
      path.join(tmpdir(), "paw-no-action-resume-"),
    );
    mkdirSync(path.join(workspaceRoot, ".paw"), { recursive: true });
    writeFileSync(
      path.join(workspaceRoot, ".paw", "memory-config.json"),
      JSON.stringify({ enable: false }),
      "utf8",
    );
    writeFileSync(path.join(workspaceRoot, "note.txt"), "hello\n", "utf8");
    const runId = "no-action-recovery-resume";
    const stateStore = new InMemoryAppStateStore();
    const abort = new AbortController();
    const responses = [
      '{"tool":"workspace.read_file","args":{"path":"note.txt"}}',
      "I inspected the file and will now report it.",
    ];
    let doneCount = 0;
    const first = new AgentOrchestrator({
      appStateStore: stateStore,
      model: {
        label: "no-action-after-tool",
        async complete() {
          return { text: responses.shift() ?? "" };
        },
      },
      onEvent(envelope) {
        if (envelope.event.type === "model.done" && ++doneCount === 2) {
          abort.abort();
        }
      },
      retrySleep: async () => {},
    });

    const interrupted = await first.run({
      runId,
      goal: "Read note.txt and report it.",
      workspaceRoot,
      maxSteps: 4,
      abortSignal: abort.signal,
    });
    expect(interrupted.status).toBe("aborted");
    expect(stateStore.load(runId)?.loopControl).toMatchObject({
      protocolRecovery: { noActionNudges: 1, hasEverUsedTools: true },
      pendingControl: { kind: "protocol_recovery" },
    });
    expect(
      stateStore
        .load(runId)
        ?.messages.some((message) =>
          message.content.startsWith(
            "[You stopped without a final_answer action.",
          ),
        ),
    ).toBe(false);

    let request: readonly ChatMessage[] = [];
    const resumed = new AgentOrchestrator({
      appStateStore: stateStore,
      model: {
        label: "no-action-recovery-resumed",
        async complete(messages) {
          request = messages;
          return {
            text: '{"action":"final_answer","summary":"note.txt says hello"}',
          };
        },
      },
      retrySleep: async () => {},
    });
    await resumed.resumeRun({ runId, workspaceRoot });

    expect(
      request.filter((message) =>
        message.content.includes("[You stopped without a final_answer action."),
      ),
    ).toHaveLength(1);
    expect(stateStore.load(runId)?.loopControl).not.toHaveProperty(
      "pendingControl",
    );
    expect(stateStore.load(runId)?.loopControl).not.toHaveProperty(
      "protocolRecovery.noActionNudges",
    );
  });

  test("ask_user persists a valid-action reset before pausing and resume starts at attempt one", async () => {
    const workspaceRoot = mkdtempSync(
      path.join(tmpdir(), "paw-no-action-ask-user-"),
    );
    mkdirSync(path.join(workspaceRoot, ".paw"), { recursive: true });
    writeFileSync(
      path.join(workspaceRoot, ".paw", "memory-config.json"),
      JSON.stringify({ enable: false }),
      "utf8",
    );
    const runId = "no-action-ask-user-reset";
    const stateStore = new InMemoryAppStateStore();
    stateStore.save({
      runId,
      goal: "Ask which color to use, then report it.",
      workspaceRoot,
      turn: 0,
      maxSteps: 4,
      messages: [
        { role: "user", content: "Ask which color to use, then report it." },
      ],
      loopControl: {
        schemaVersion: "paw.loop-control.v1",
        protocolRecovery: { noActionNudges: 1, hasEverUsedTools: true },
        pendingControl: {
          kind: "protocol_recovery",
          text: "legacy attempt one",
        },
      },
      savedAt: Date.now(),
    });
    const pausing = new AgentOrchestrator({
      appStateStore: stateStore,
      model: {
        label: "valid-ask-user",
        async complete() {
          return {
            text: '{"action":"ask_user","question":"Which color?","context":{},"timeout_sec":null}',
          };
        },
      },
      retrySleep: async () => {},
    });

    const paused = await pausing.resumeRun({ runId, workspaceRoot });
    expect(paused).toMatchObject({
      status: "incomplete",
      completionReason: "user_input_required",
    });
    const waiting = stateStore.load(runId);
    expect(waiting?.interaction).toMatchObject({ status: "waiting_user" });
    expect(waiting?.loopControl).not.toHaveProperty("pendingControl");
    expect(waiting?.loopControl).not.toHaveProperty(
      "protocolRecovery.noActionNudges",
    );
    const requestId = waiting?.interaction?.requestId;
    if (!requestId) throw new Error("missing waiting request id");

    await pausing.submitUserReply({ runId, requestId, reply: "blue" });
    const requests: (readonly ChatMessage[])[] = [];
    const responses = [
      "I will now report the selected color.",
      '{"action":"final_answer","summary":"Blue selected."}',
    ];
    const resumed = new AgentOrchestrator({
      appStateStore: stateStore,
      model: {
        label: "ask-user-resumed",
        async complete(messages) {
          requests.push(messages);
          return { text: responses.shift() ?? "" };
        },
      },
      retrySleep: async () => {},
    });
    await resumed.resumeRun({ runId, workspaceRoot });

    const recovery = requests[1]?.find((message) =>
      message.content.includes("[You stopped without a final_answer action."),
    );
    expect(recovery?.content).toContain("kind: protocol_recovery");
    expect(recovery?.content).not.toContain(
      "Your previous response again contained no executable action",
    );
  });

  for (const loopKernelVersion of ["v1", "v2"] as const) {
    test(`${loopKernelVersion} ask_user resolver failure preserves its committed cursor and recovery reset`, async () => {
      const workspaceRoot = mkdtempSync(
        path.join(tmpdir(), "paw-no-action-ask-failure-"),
      );
      mkdirSync(path.join(workspaceRoot, ".paw"), { recursive: true });
      writeFileSync(
        path.join(workspaceRoot, ".paw", "memory-config.json"),
        JSON.stringify({ enable: false }),
        "utf8",
      );
      const runId = `no-action-ask-user-failure-${loopKernelVersion}`;
      const stateStore = new InMemoryAppStateStore();
      stateStore.save({
        runId,
        goal: "Ask a question.",
        workspaceRoot,
        turn: 0,
        maxSteps: 3,
        messages: [{ role: "user", content: "Ask a question." }],
        loopControl: {
          schemaVersion: "paw.loop-control.v1",
          protocolRecovery: { noActionNudges: 1, hasEverUsedTools: true },
          pendingControl: {
            kind: "protocol_recovery",
            text: "legacy attempt one",
          },
        },
        savedAt: Date.now(),
      });
      const orchestrator = new AgentOrchestrator({
        loopKernelVersion,
        appStateStore: stateStore,
        resolveAskUser: async () => {
          throw new Error("simulated resolver failure");
        },
        model: {
          label: "ask-user-failure",
          async complete() {
            return {
              text: '{"action":"ask_user","question":"Continue?","context":{},"timeout_sec":null}',
            };
          },
        },
        retrySleep: async () => {},
      });

      const result = await orchestrator.resumeRun({ runId, workspaceRoot });
      expect(result.status).toBe("failed");
      const saved = stateStore.load(runId);
      expect(saved?.turn).toBe(1);
      expect(saved?.interaction).toMatchObject({ status: "waiting_user" });
      expect(saved?.loopControl).not.toHaveProperty("pendingControl");
      expect(saved?.loopControl).not.toHaveProperty(
        "protocolRecovery.noActionNudges",
      );
    });
  }

  for (const loopKernelVersion of ["v1", "v2"] as const) {
    for (const fixture of [
      {
        name: "format",
        marker:
          '[Your last output could not be parsed as a tool call and was NOT executed.]\nReason: invalid JSON.\nCorrect format is a single JSON object, no surrounding text or code fences:\n{"tool":"workspace.read_file","args":{"path":"<file>"}}\nFix the format and retry the call, or if you are done reply with:\n{"action":"final_answer","summary":"<your complete findings>"}',
      },
      {
        name: "no-action",
        marker:
          '[You stopped without a final_answer action. If you have completed the task, output: {"action":"final_answer","summary":"<your complete findings here>"}. If not done, continue — call the next tool or take the next action.]',
      },
    ] as const) {
      test(`${loopKernelVersion} migrates an unconsumed legacy ${fixture.name} recovery once`, async () => {
        const workspaceRoot = mkdtempSync(
          path.join(tmpdir(), `paw-legacy-${loopKernelVersion}-`),
        );
        mkdirSync(path.join(workspaceRoot, ".paw"), { recursive: true });
        writeFileSync(
          path.join(workspaceRoot, ".paw", "memory-config.json"),
          JSON.stringify({ enable: false }),
          "utf8",
        );
        const runId = `legacy-${loopKernelVersion}-${fixture.name}`;
        const stateStore = new InMemoryAppStateStore();
        const legitimate = `${fixture.marker.split("\n")[0]} please explain this label`;
        stateStore.save({
          runId,
          goal: "Inspect the legacy state.",
          workspaceRoot,
          turn: 0,
          maxSteps: 1,
          messages: [
            { role: "user", content: "Inspect the legacy state." },
            { role: "user", content: legitimate },
            { role: "user", content: fixture.marker },
          ],
          savedAt: Date.now(),
        });
        const requests: (readonly ChatMessage[])[] = [];
        const orchestrator = new AgentOrchestrator({
          loopKernelVersion,
          appStateStore: stateStore,
          model: {
            label: `legacy-${loopKernelVersion}-${fixture.name}`,
            async complete(messages) {
              requests.push(messages);
              return { text: '{"action":"final_answer","summary":"done"}' };
            },
          },
          retrySleep: async () => {},
        });

        await orchestrator.resumeRun({ runId, workspaceRoot });

        expect(
          requests[0]?.filter((message) =>
            message.content.startsWith(
              `[Ephemeral Control v1]\nkind: protocol_recovery\n${fixture.marker}`,
            ),
          ),
        ).toHaveLength(1);
        const saved = stateStore.load(runId);
        expect(
          saved?.messages.some((message) => message.content === fixture.marker),
        ).toBe(false);
        expect(
          saved?.messages.some((message) => message.content === legitimate),
        ).toBe(true);
        expect(saved?.loopControl).not.toHaveProperty("pendingControl");
      });
    }
  }

  test("completion gate survives provider failure, is delivered once, and never becomes durable", async () => {
    const workspaceRoot = mkdtempSync(
      path.join(tmpdir(), "paw-completion-gate-resume-"),
    );
    mkdirSync(path.join(workspaceRoot, ".paw"), { recursive: true });
    writeFileSync(
      path.join(workspaceRoot, ".paw", "memory-config.json"),
      JSON.stringify({ enable: false }),
      "utf8",
    );
    const runId = "completion-gate-provider-failure";
    const stateStore = new InMemoryAppStateStore();
    const abort = new AbortController();
    const first = new AgentOrchestrator({
      appStateStore: stateStore,
      model: {
        label: "completion-gate-first",
        async complete() {
          return { text: '{"action":"final_answer","summary":"done"}' };
        },
      },
      onEvent(envelope) {
        if (envelope.event.type === "model.done") abort.abort();
      },
      retrySleep: async () => {},
    });
    await first.run({
      runId,
      goal: "[require_mutation] change the implementation",
      workspaceRoot,
      maxSteps: 4,
      abortSignal: abort.signal,
    });
    expect(stateStore.load(runId)?.loopControl).toMatchObject({
      completionGates: { verifyNudges: 1 },
      pendingControl: {
        kind: "completion_gate",
        gate: "verification",
      },
    });

    const failedRequests: (readonly ChatMessage[])[] = [];
    const failing = new AgentOrchestrator({
      appStateStore: stateStore,
      model: {
        label: "completion-gate-provider-down",
        async complete(messages) {
          failedRequests.push(messages);
          throw new Error("provider unavailable");
        },
      },
      retrySleep: async () => {},
    });
    await failing.resumeRun({ runId, workspaceRoot });
    expect(
      failedRequests[0]?.filter(
        (message) =>
          message.content.includes("kind: completion_gate") &&
          message.content.includes("gate: verification"),
      ),
    ).toHaveLength(1);
    expect(stateStore.load(runId)?.loopControl).toHaveProperty(
      "pendingControl",
    );

    const resumedRequests: (readonly ChatMessage[])[] = [];
    const resumed = new AgentOrchestrator({
      appStateStore: stateStore,
      model: {
        label: "completion-gate-consume",
        async complete(messages) {
          resumedRequests.push(messages);
          return { text: '{"action":"abort","reason":"stop test"}' };
        },
      },
      retrySleep: async () => {},
    });
    await resumed.resumeRun({ runId, workspaceRoot });
    expect(
      resumedRequests[0]?.filter(
        (message) =>
          message.content.includes("kind: completion_gate") &&
          message.content.includes("gate: verification"),
      ),
    ).toHaveLength(1);
    const saved = stateStore.load(runId);
    expect(saved?.loopControl).not.toHaveProperty("pendingControl");
    expect(
      saved?.messages.some((message) =>
        message.content.startsWith("[VerificationGate]"),
      ),
    ).toBe(false);
  });

  test("late guidance retries after provider failure, then checkpoints only a successful delivery", async () => {
    const workspaceRoot = mkdtempSync(
      path.join(tmpdir(), "paw-late-guidance-resume-"),
    );
    mkdirSync(path.join(workspaceRoot, ".paw"), { recursive: true });
    writeFileSync(
      path.join(workspaceRoot, ".paw", "memory-config.json"),
      JSON.stringify({ enable: false }),
      "utf8",
    );
    writeFileSync(
      path.join(workspaceRoot, "a.ts"),
      "export const a = 1;",
      "utf8",
    );
    const runId = "late-guidance-provider-failure";
    const goal = "Fix the parser bug";
    const initialTaskState = new TaskStateManager(goal).snapshot();
    const stateStore = new InMemoryAppStateStore();
    stateStore.save({
      runId,
      goal,
      workspaceRoot,
      turn: 3,
      maxSteps: 6,
      messages: [{ role: "user", content: goal }],
      taskState: {
        ...initialTaskState,
        filesRead: ["a.ts", "b.ts", "c.ts"],
      },
      savedAt: Date.now(),
    });

    const failedRequests: (readonly ChatMessage[])[] = [];
    const failing = new AgentOrchestrator({
      appStateStore: stateStore,
      model: {
        label: "late-guidance-provider-down",
        async complete(messages) {
          failedRequests.push(messages);
          throw new Error("provider unavailable");
        },
      },
      retrySleep: async () => {},
    });
    await failing.resumeRun({ runId, workspaceRoot });
    expect(
      failedRequests[0]?.filter((message) =>
        message.content.includes("[Implementation checkpoint]"),
      ),
    ).toHaveLength(1);
    expect(stateStore.load(runId)?.loopControl).not.toHaveProperty(
      "lateGuidance.implementationDelivered",
    );

    const resumedRequests: (readonly ChatMessage[])[] = [];
    let calls = 0;
    const resumed = new AgentOrchestrator({
      appStateStore: stateStore,
      model: {
        label: "late-guidance-consume",
        async complete(messages) {
          resumedRequests.push(messages);
          calls += 1;
          return calls === 1
            ? {
                text: '{"tool":"workspace.read_file","args":{"path":"a.ts"}}',
              }
            : { text: '{"action":"abort","reason":"stop test"}' };
        },
      },
      retrySleep: async () => {},
    });
    await resumed.resumeRun({ runId, workspaceRoot });
    expect(
      resumedRequests[0]?.filter((message) =>
        message.content.includes("[Implementation checkpoint]"),
      ),
    ).toHaveLength(1);
    expect(
      resumedRequests[1]?.some((message) =>
        message.content.includes("[Implementation checkpoint]"),
      ),
    ).toBe(false);
    const saved = stateStore.load(runId);
    expect(saved?.loopControl).toMatchObject({
      lateGuidance: { implementationDelivered: true },
    });
    expect(
      saved?.messages.some((message) =>
        message.content.includes("[Implementation checkpoint]"),
      ),
    ).toBe(false);
  });

  test("resume removes legacy host projections from runtime and next save", async () => {
    const workspaceRoot = mkdtempSync(
      path.join(tmpdir(), "paw-context-resume-"),
    );
    mkdirSync(path.join(workspaceRoot, ".paw"), { recursive: true });
    writeFileSync(
      path.join(workspaceRoot, ".paw", "memory-config.json"),
      JSON.stringify({ enable: false }),
      "utf8",
    );
    const runId = "context-assembler-legacy-resume";
    const stateStore = new InMemoryAppStateStore();
    stateStore.save({
      runId,
      goal: "Inspect the saved state.",
      workspaceRoot,
      turn: 0,
      maxSteps: 1,
      messages: [
        { role: "user", content: "[Context Package]\nlegacy task facts" },
        { role: "user", content: "[Status Snapshot v1]\nlegacy telemetry" },
        {
          role: "user",
          content:
            "[ProgressAdvice:inspect_gap] last 4 turns: no product progress",
        },
        {
          role: "user",
          content:
            "[TestWarden] No Python test files detected; the test warden is inactive for this workspace.",
        },
        {
          role: "user",
          content: `[LoopV2Readiness:needs_work key=${"b".repeat(64)}]\nlegacy repair`,
        },
        {
          role: "user",
          content:
            "[ProviderProtocol:empty_response] The provider returned no visible text or executable action. Retry once with complete tool calls, an explicit control action, or a visible candidate response.",
        },
        {
          role: "user",
          content:
            "[LoopControl:turn_boundary] Your previous natural-language response ended the provider turn but did not submit a completion candidate. Continue with the next required tool/action. If the task is actually ready, submit the structured final_answer action explicitly.",
        },
        {
          role: "user",
          content:
            '[Your last output could not be parsed as a tool call and was NOT executed.]\nReason: invalid JSON.\nCorrect format is a single JSON object, no surrounding text or code fences:\n{"tool":"workspace.read_file","args":{"path":"<file>"}}\nFix the format and retry the call, or if you are done reply with:\n{"action":"final_answer","summary":"<your complete findings>"}',
        },
        {
          role: "user",
          content:
            '[You stopped without a final_answer action. If you have completed the task, output: {"action":"final_answer","summary":"<your complete findings here>"}. If not done, continue — call the next tool or take the next action.]',
        },
        {
          role: "user",
          content:
            '[Protocol recovery attempt 3: do not narrate the action you intend to take. Emit the valid tool-call JSON now. If and only if the task is complete, emit {"action":"final_answer","summary":"<complete result>"}.]',
        },
        { role: "user", content: "[Context Package] is my requested title" },
        { role: "user", content: "[TestWarden] please explain this label" },
        { role: "user", content: "[ProviderProtocol] explain this label" },
        {
          role: "user",
          content:
            "[ProviderProtocol:empty_response] please explain this label",
        },
        {
          role: "user",
          content: "[LoopControl:turn_boundary] explain this label",
        },
        {
          role: "user",
          content:
            "[LoopControl:turn_boundary] Your previous natural-language response ended the provider turn unexpectedly; explain why",
        },
        {
          role: "user",
          content:
            "[Your last output could not be parsed as a tool call and was NOT executed.] please explain this label",
        },
        {
          role: "user",
          content:
            "[Protocol recovery attempt 3: please explain how recovery works]",
        },
        {
          role: "user",
          content:
            '[Protocol recovery attempt 1: do not narrate the action you intend to take. Emit the valid tool-call JSON now. If and only if the task is complete, emit {"action":"final_answer","summary":"<complete result>"}.]',
        },
        { role: "user", content: "Inspect the saved state." },
      ],
      savedAt: Date.now(),
    });
    let providerMessages: readonly ChatMessage[] = [];
    const durableSnapshots: (readonly ChatMessage[])[] = [];
    const orchestrator = new AgentOrchestrator({
      appStateStore: stateStore,
      model: {
        label: "legacy-projection-resume",
        async complete(messages) {
          providerMessages = messages;
          return { text: '{"action":"final_answer","summary":"done"}' };
        },
      },
      evalHooks: {
        beforeModelCall: ({ contextManager }) => {
          durableSnapshots.push(contextManager.buildMessages());
        },
      },
      retrySleep: async () => {},
    });

    await orchestrator.resumeRun({ runId });

    const isLegacyProjection = (message: ChatMessage) =>
      message.content === "[Context Package]" ||
      message.content.startsWith("[Context Package]\n") ||
      message.content === "[Status Snapshot v1]" ||
      message.content.startsWith("[Status Snapshot v1]\n") ||
      message.content.startsWith("[ProgressAdvice:inspect_gap] ") ||
      message.content.startsWith(
        "[TestWarden] No Python test files detected;",
      ) ||
      message.content.startsWith("[LoopV2Readiness:needs_work key=") ||
      message.content ===
        "[ProviderProtocol:empty_response] The provider returned no visible text or executable action. Retry once with complete tool calls, an explicit control action, or a visible candidate response." ||
      message.content ===
        "[LoopControl:turn_boundary] Your previous natural-language response ended the provider turn but did not submit a completion candidate. Continue with the next required tool/action. If the task is actually ready, submit the structured final_answer action explicitly." ||
      message.content.startsWith(
        "[Your last output could not be parsed as a tool call and was NOT executed.]\nReason:",
      ) ||
      message.content ===
        '[You stopped without a final_answer action. If you have completed the task, output: {"action":"final_answer","summary":"<your complete findings here>"}. If not done, continue — call the next tool or take the next action.]' ||
      message.content ===
        '[Protocol recovery attempt 3: do not narrate the action you intend to take. Emit the valid tool-call JSON now. If and only if the task is complete, emit {"action":"final_answer","summary":"<complete result>"}.]';
    expect(providerMessages.some(isLegacyProjection)).toBe(false);
    expect(
      durableSnapshots.some((messages) => messages.some(isLegacyProjection)),
    ).toBe(false);
    const saved = stateStore.load(runId);
    expect(saved?.messages.some(isLegacyProjection)).toBe(false);
    expect(
      saved?.messages.some(
        (message) =>
          message.content === "[Context Package] is my requested title",
      ),
    ).toBe(true);
    expect(
      saved?.messages.some(
        (message) =>
          message.content === "[TestWarden] please explain this label",
      ),
    ).toBe(true);
    expect(
      saved?.messages.some(
        (message) =>
          message.content === "[ProviderProtocol] explain this label",
      ),
    ).toBe(true);
    expect(
      saved?.messages.some(
        (message) =>
          message.content ===
          "[ProviderProtocol:empty_response] please explain this label",
      ),
    ).toBe(true);
    expect(
      saved?.messages.some(
        (message) =>
          message.content === "[LoopControl:turn_boundary] explain this label",
      ),
    ).toBe(true);
    expect(
      saved?.messages.some(
        (message) =>
          message.content ===
          "[LoopControl:turn_boundary] Your previous natural-language response ended the provider turn unexpectedly; explain why",
      ),
    ).toBe(true);
    expect(
      saved?.messages.some(
        (message) =>
          message.content ===
          "[Your last output could not be parsed as a tool call and was NOT executed.] please explain this label",
      ),
    ).toBe(true);
    expect(
      saved?.messages.some(
        (message) =>
          message.content ===
          "[Protocol recovery attempt 3: please explain how recovery works]",
      ),
    ).toBe(true);
    expect(
      saved?.messages.some(
        (message) =>
          message.content ===
          '[Protocol recovery attempt 1: do not narrate the action you intend to take. Emit the valid tool-call JSON now. If and only if the task is complete, emit {"action":"final_answer","summary":"<complete result>"}.]',
      ),
    ).toBe(true);
  });

  test("cold resume memory is request-only HostState and absent from system and durable history", async () => {
    const workspaceRoot = mkdtempSync(path.join(tmpdir(), "paw-cold-memory-"));
    mkdirSync(path.join(workspaceRoot, ".paw"), { recursive: true });
    writeFileSync(
      path.join(workspaceRoot, ".paw", "memory-config.json"),
      JSON.stringify({ enable: false }),
      "utf8",
    );
    const runId = "cold-memory-host-state";
    new SessionMemoryStore({ workspaceRoot }).save(runId, {
      session: runId,
      project: "test",
      updatedAt: Date.now(),
      task: "cold task sentinel",
      currentState: "cold state sentinel",
    });
    const stateStore = new InMemoryAppStateStore();
    stateStore.save({
      runId,
      goal: "continue the task",
      workspaceRoot,
      turn: 0,
      maxSteps: 1,
      messages: [{ role: "user", content: "continue the task" }],
      savedAt: Date.now(),
    });
    let request: readonly ChatMessage[] = [];
    const orchestrator = new AgentOrchestrator({
      appStateStore: stateStore,
      model: {
        label: "cold-memory-host-state",
        async complete(messages) {
          request = messages;
          return { text: '{"action":"abort","reason":"test complete"}' };
        },
      },
    });

    await orchestrator.resumeRun({ runId, workspaceRoot });

    expect(
      request.filter((message) =>
        message.content.includes("cold task sentinel"),
      ),
    ).toHaveLength(1);
    expect(
      request.find((message) => message.role === "system")?.content,
    ).not.toContain("cold task sentinel");
    expect(
      request.find((message) => message.content.includes("cold task sentinel"))
        ?.content,
    ).toContain("[Previous Session Memory]");
    expect(
      stateStore
        .load(runId)
        ?.messages.some((message) =>
          message.content.includes("[Previous session context]"),
        ),
    ).toBe(false);
  });

  test("rewind drops a later memory hint checkpoint", async () => {
    const workspaceRoot = mkdtempSync(
      path.join(tmpdir(), "paw-memory-rewind-"),
    );
    mkdirSync(path.join(workspaceRoot, ".paw"), { recursive: true });
    writeFileSync(
      path.join(workspaceRoot, ".paw", "memory-config.json"),
      JSON.stringify({ enable: false }),
      "utf8",
    );
    const runId = "memory-hint-rewind";
    const stateStore = new InMemoryAppStateStore();
    stateStore.save({
      runId,
      goal: "continue",
      workspaceRoot,
      turn: 1,
      maxSteps: 2,
      messages: [{ role: "user", content: "continue" }],
      memoryHint: {
        schemaVersion: "paw.memory-hint.v1",
        kind: "action_failed",
        text: "later failure sentinel",
      },
      savedAt: Date.now(),
    });
    let request: readonly ChatMessage[] = [];
    const orchestrator = new AgentOrchestrator({
      appStateStore: stateStore,
      model: {
        label: "memory-hint-rewind",
        async complete(messages) {
          request = messages;
          return { text: '{"action":"abort","reason":"test complete"}' };
        },
      },
    });

    await orchestrator.resumeRun({ runId, workspaceRoot, fromTurn: 0 });

    expect(
      request.some((message) =>
        message.content.includes("later failure sentinel"),
      ),
    ).toBe(false);
    expect(stateStore.load(runId)?.memoryHint).toBeUndefined();
  });

  test("memory hint survives provider failure once, new checkpoint wins legacy, and success consumes it", async () => {
    const workspaceRoot = mkdtempSync(
      path.join(tmpdir(), "paw-memory-hint-resume-"),
    );
    mkdirSync(path.join(workspaceRoot, ".paw"), { recursive: true });
    writeFileSync(
      path.join(workspaceRoot, ".paw", "memory-config.json"),
      JSON.stringify({ enable: false }),
      "utf8",
    );
    const runId = "memory-hint-provider-failure";
    const legacyXml =
      '<agent-memory source="semantic" id="old" status="verified">\nlegacy sentinel\n</agent-memory>';
    const stateStore = new InMemoryAppStateStore();
    stateStore.save({
      runId,
      goal: "continue",
      workspaceRoot,
      turn: 0,
      maxSteps: 2,
      messages: [
        { role: "user", content: `[Memory hint]\n${legacyXml}` },
        { role: "assistant", content: "tool action" },
        { role: "user", content: "tool observation" },
      ],
      memoryHint: {
        schemaVersion: "paw.memory-hint.v1",
        kind: "action_failed",
        text: "new checkpoint sentinel",
      },
      savedAt: Date.now(),
    });
    const failedRequests: (readonly ChatMessage[])[] = [];
    const failing = new AgentOrchestrator({
      appStateStore: stateStore,
      model: {
        label: "memory-hint-provider-failure",
        async complete(messages) {
          failedRequests.push(messages);
          throw new Error("provider unavailable");
        },
      },
      retrySleep: async () => {},
    });

    await failing.resumeRun({ runId, workspaceRoot });

    expect(
      failedRequests[0]?.filter((message) =>
        message.content.includes("new checkpoint sentinel"),
      ),
    ).toHaveLength(1);
    expect(
      failedRequests[0]?.some((message) =>
        message.content.includes("legacy sentinel"),
      ),
    ).toBe(false);
    expect(stateStore.load(runId)?.memoryHint).toMatchObject({
      kind: "action_failed",
      text: "new checkpoint sentinel",
    });

    let consumedRequest: readonly ChatMessage[] = [];
    const resumed = new AgentOrchestrator({
      appStateStore: stateStore,
      model: {
        label: "memory-hint-consume",
        async complete(messages) {
          consumedRequest = messages;
          return { text: '{"action":"abort","reason":"test complete"}' };
        },
      },
    });
    await resumed.resumeRun({ runId, workspaceRoot });
    expect(
      consumedRequest.filter((message) =>
        message.content.includes("new checkpoint sentinel"),
      ),
    ).toHaveLength(1);
    expect(stateStore.load(runId)?.memoryHint).toBeUndefined();
    expect(
      stateStore
        .load(runId)
        ?.messages.some((message) => message.content.includes("[Memory hint]")),
    ).toBe(false);
  });
});
