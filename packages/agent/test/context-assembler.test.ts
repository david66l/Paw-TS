import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { type ChatMessage, InMemoryAppStateStore } from "@paw/core";

import {
  type HostStateV1,
  assembleModelContextV1,
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
        { role: "user", content: "[Context Package] is my requested title" },
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
      message.content.startsWith("[Status Snapshot v1]\n");
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
  });
});
