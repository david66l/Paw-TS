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
        { role: "user", content: "[Context Package] is my requested title" },
        { role: "user", content: "[TestWarden] please explain this label" },
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
      message.content.startsWith("[TestWarden] No Python test files detected;");
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
  });
});
