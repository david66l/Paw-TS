import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ChatMessage } from "@paw/core";

import {
  assembleModelContextV1,
  type HostStateFactV1,
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
    });

    expect(assembled).toEqual(durable);
    expect(assembled[0]?.attachments).toBe(durable[0]?.attachments);
    expect(assembled[1]?.nativeToolTurn).toBe(nativeToolTurn);
  });

  test("renders typed host facts and only one ephemeral control", () => {
    const hostState: HostStateFactV1[] = [
      {
        kind: "task_brief",
        currentObjective: "fix the failing parser",
        stage: "implementation",
        openItems: ["add regression test"],
      },
      { kind: "constraints", items: ["do not change the public API"] },
    ];

    const assembled = assembleModelContextV1({
      durable: { messages: [{ role: "user", content: "original request" }] },
      hostState,
      control: { kind: "test_warden", text: "pytest is still failing" },
    });

    expect(assembled).toHaveLength(3);
    expect(assembled[1]?.content).toContain("[Host State v1]");
    expect(assembled[1]?.content).toContain("fix the failing parser");
    expect(assembled[2]?.content).toBe(
      "[Ephemeral Control v1]\nkind: test_warden\npytest is still failing",
    );
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
});
