import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { type ChatMessage, InMemoryAppStateStore } from "@paw/core";

import {
  type HostStateV1,
  assembleModelContextV1,
  selectEphemeralControlV1,
} from "../src/context-assembler.js";
import { AgentOrchestrator } from "../src/orchestrator.js";

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
  });

  test("uses canonical host order and removes only exact legacy projections", () => {
    const assembled = assembleModelContextV1({
      durable: {
        messages: [
          { role: "user", content: "[Context Package]\nold facts" },
          { role: "user", content: "[Status Snapshot v1]\nold status" },
          { role: "user", content: "[Context Package] is my requested title" },
          { role: "user", content: "[My bracketed request] keep this" },
          { role: "assistant", content: "working" },
        ],
      },
      hostState: {
        status: "[Status Snapshot v1]\nfresh status",
        taskProgress: "[Current State]\nNext step: test",
        constraints: ["keep API stable"],
        taskBrief: { stage: "verify" },
      },
    });

    expect(assembled.map((message) => message.content)).toEqual([
      "[Context Package] is my requested title",
      "[My bracketed request] keep this",
      "[Host State v1]\n[Task Brief]\nstage: verify\n[Constraints]\n- keep API stable\n[Current State]\nNext step: test\n[Status Snapshot v1]\nfresh status",
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
});
