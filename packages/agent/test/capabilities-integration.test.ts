/**
 * Integration test suite for paw-ts core capabilities:
 * 1. Agent workflow (multi-turn, parallel tools, plan system, approval)
 * 2. Memory system (session memory, auto memory, extraction)
 * 3. Context compression (compactor, pruner, anti-thrashing)
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { AgentOrchestrator } from "@paw/agent";
import type { ChatMessage, RunEventEnvelope } from "@paw/core";
import {
  AutoMemoryStore,
  ContextCompactor,
  SessionMemoryStore,
  estimateMessagesTokens,
  measureContextBudget,
  pruneToolResults,
  shouldCompactHistory,
} from "@paw/core";
import { FakeLanguageModel } from "@paw/models";
import { runCompressionAgent } from "../src/compression-agent.js";
import { extractMemories } from "../src/memory-extraction-agent.js";

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function tmpDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function cleanup(dir: string): void {
  if (existsSync(dir)) rmSync(dir, { recursive: true });
}

/** Build a deterministic mock model that cycles through responses. */
function cycleModel(responses: string[]) {
  let i = 0;
  return {
    label: "cycle",
    async complete(): Promise<{
      text: string;
      usage?: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
      };
    }> {
      const text =
        responses[i++] ?? '{"action":"final_answer","summary":"Done."}';
      return {
        text,
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      };
    },
  };
}

// ═════════════════════════════════════════════════════════════
// Suite 1: Agent Workflow
// ═════════════════════════════════════════════════════════════

describe("Agent Workflow", () => {
  test("multi-turn: list -> read -> write -> final_answer", async () => {
    const dir = tmpDir("paw-cap-mt-");
    writeFileSync(path.join(dir, "config.json"), '{"key":"value"}', "utf8");

    const responses = [
      // turn 1: list dir
      '{"tool":"workspace.list_dir","args":{"path":".","recursive":false}}',
      // turn 2: read config.json
      '{"tool":"workspace.read_file","args":{"path":"config.json"}}',
      // turn 3: write updated config
      '{"tool":"workspace.write_file","args":{"path":"config.json","content":"{\\"key\\":\\"updated\\"}"}}',
      // turn 4: final answer
      '{"action":"final_answer","summary":"Config updated."}',
    ];

    const events: RunEventEnvelope[] = [];
    const o = new AgentOrchestrator({
      model: cycleModel(responses),
      onEvent: (e) => events.push(e),
    });

    const r = await o.run({
      runId: "cap-mt1",
      goal: "update config.json",
      workspaceRoot: dir,
      maxSteps: 10,
    });

    expect(r.status).toBe("completed");
    expect(r.message).toBe("Config updated.");

    // Verify tool sequence
    const toolCalls = events.filter((e) => e.event.type === "tool.call");
    expect(toolCalls.length).toBe(3);
    expect(
      toolCalls[0]?.event.type === "tool.call" && toolCalls[0].event.tool,
    ).toBe("workspace.list_dir");
    expect(
      toolCalls[1]?.event.type === "tool.call" && toolCalls[1].event.tool,
    ).toBe("workspace.read_file");
    expect(
      toolCalls[2]?.event.type === "tool.call" && toolCalls[2].event.tool,
    ).toBe("workspace.write_file");

    // Verify file was actually written
    expect(readFileSync(path.join(dir, "config.json"), "utf8")).toBe(
      '{"key":"updated"}',
    );

    // Verify loop ticks (4 turns: 3 tools + 1 final)
    const ticks = events.filter((e) => e.event.type === "loop.tick");
    expect(ticks.length).toBe(4);

    cleanup(dir);
  });

  test("parallel tool calls: read two files in one turn", async () => {
    const dir = tmpDir("paw-cap-para-");
    writeFileSync(path.join(dir, "a.txt"), "alpha", "utf8");
    writeFileSync(path.join(dir, "b.txt"), "beta", "utf8");

    const responses = [
      // turn 1: parallel read both files
      '{"tool":"workspace.read_file","args":{"path":"a.txt"}}\n{"tool":"workspace.read_file","args":{"path":"b.txt"}}',
      // turn 2: final answer
      '{"action":"final_answer","summary":"Read both."}',
    ];

    const events: RunEventEnvelope[] = [];
    const o = new AgentOrchestrator({
      model: cycleModel(responses),
      onEvent: (e) => events.push(e),
    });

    const r = await o.run({
      runId: "cap-para1",
      goal: "read both a.txt and b.txt",
      workspaceRoot: dir,
      maxSteps: 6,
    });

    expect(r.status).toBe("completed");

    // Both reads in same turn
    const toolCalls = events.filter((e) => e.event.type === "tool.call");
    expect(toolCalls.length).toBe(2);
    const toolResults = events.filter((e) => e.event.type === "tool.result");
    expect(toolResults.length).toBe(2);

    // Should complete in 2 turns
    const ticks = events.filter((e) => e.event.type === "loop.tick");
    expect(ticks.length).toBe(2);

    cleanup(dir);
  });

  test("plan system: plan_update -> final_answer with snapshot", async () => {
    const dir = tmpDir("paw-cap-plan-");

    let capturedSnapshot = "";
    const model = {
      label: "plan-model",
      async complete(messages: readonly ChatMessage[]) {
        const callCount = messages.filter((m) => m.role === "assistant").length;
        if (callCount === 0) {
          return {
            text: JSON.stringify({
              action: "plan_update",
              reason: "bootstrap plan",
              new_items: [
                {
                  id: "plan-001",
                  task_id: "step-a",
                  status: "pending",
                  depends_on: [],
                },
                {
                  id: "plan-002",
                  task_id: "step-b",
                  status: "pending",
                  depends_on: ["plan-001"],
                },
              ],
              deprecated_items: [],
            }),
          };
        }
        // Capture snapshot from the user message
        const lastUser = [...messages].reverse().find((m) => m.role === "user");
        if (lastUser?.content.includes("Current plan (JSON):")) {
          capturedSnapshot = lastUser.content;
        }
        return { text: '{"action":"final_answer","summary":"Plan executed."}' };
      },
    };

    const events: RunEventEnvelope[] = [];
    const o = new AgentOrchestrator({
      model,
      onEvent: (e) => events.push(e),
    });

    const r = await o.run({
      runId: "cap-plan1",
      goal: "execute plan",
      workspaceRoot: dir,
      maxSteps: 6,
    });

    expect(r.status).toBe("completed");
    expect(r.message).toBe("Plan executed.");

    // Verify plan.updated event
    expect(events.some((e) => e.event.type === "plan.updated")).toBe(true);

    // Verify snapshot was embedded in follow-up message
    expect(capturedSnapshot).toContain("plan-001");
    expect(capturedSnapshot).toContain("plan-002");

    cleanup(dir);
  });

  test("tool approval: write_file denied when resolveToolApproval returns false", async () => {
    const dir = tmpDir("paw-cap-approval-");

    const events: RunEventEnvelope[] = [];
    const o = new AgentOrchestrator({
      model: new FakeLanguageModel(),
      approvalPolicy: () => true, // all tools need approval
      resolveToolApproval: async () => false, // deny all
      onEvent: (e) => events.push(e),
    });

    const r = await o.run({
      runId: "cap-app1",
      goal: "write file 'secret.txt' 'nope'",
      workspaceRoot: dir,
      maxSteps: 6,
    });

    expect(r.status).toBe("completed");
    expect(existsSync(path.join(dir, "secret.txt"))).toBe(false);

    const tr = events.find((e) => e.event.type === "tool.result");
    expect(tr?.event.type).toBe("tool.result");
    if (tr?.event.type === "tool.result") {
      expect(tr.event.ok).toBe(false);
      expect(tr.event.summary).toContain("denied");
    }

    cleanup(dir);
  });

  test("tool approval: run_shell approved when resolveToolApproval returns true", async () => {
    const dir = tmpDir("paw-cap-app-ok-");

    const events: RunEventEnvelope[] = [];
    const o = new AgentOrchestrator({
      model: new FakeLanguageModel(),
      approvalPolicy: () => true,
      resolveToolApproval: async () => true,
      onEvent: (e) => events.push(e),
    });

    const r = await o.run({
      runId: "cap-app2",
      goal: "run shell 'echo paw-cap-test'",
      workspaceRoot: dir,
      maxSteps: 6,
    });

    expect(r.status).toBe("completed");

    const tr = events.find((e) => e.event.type === "tool.result");
    expect(tr?.event.type).toBe("tool.result");
    if (tr?.event.type === "tool.result") {
      expect(tr.event.ok).toBe(true);
      expect(tr.event.tool).toBe("workspace.run_shell");
    }

    cleanup(dir);
  });

  test("abort signal interrupts mid-run", async () => {
    const dir = tmpDir("paw-cap-abort-");
    writeFileSync(path.join(dir, "x.txt"), "x");

    const ac = new AbortController();
    const events: RunEventEnvelope[] = [];
    const o = new AgentOrchestrator({
      model: new FakeLanguageModel(),
      onEvent: (e) => {
        events.push(e);
        if (e.event.type === "tool.result") {
          ac.abort();
        }
      },
    });

    const r = await o.run({
      runId: "cap-ab1",
      goal: "list the directory",
      workspaceRoot: dir,
      maxSteps: 8,
      abortSignal: ac.signal,
    });

    expect(r.status).toBe("failed");
    expect(r.message).toBe("Run aborted.");

    cleanup(dir);
  });
});

// ═════════════════════════════════════════════════════════════
// Suite 2: Memory System
// ═════════════════════════════════════════════════════════════

describe("Memory System", () => {
  let memDir: string;
  let sessionDir: string;
  let workspaceRoot: string;

  beforeEach(() => {
    workspaceRoot = tmpDir("paw-cap-mem-ws-");
    memDir = path.join(workspaceRoot, "mem-test");
    sessionDir = path.join(workspaceRoot, "session-test");
  });

  afterEach(() => {
    cleanup(workspaceRoot);
  });

  test("SessionMemoryStore: save, load, loadLatest", () => {
    const store = new SessionMemoryStore({
      workspaceRoot,
      sessionsDir: sessionDir,
    });

    const mem = {
      session: "run-001",
      project: "TestProject",
      updatedAt: Date.now(),
      task: "Refactor auth module",
      currentState: "In progress: extracted JWT logic",
      filesAndFunctions: [
        "src/auth.ts:verifyToken()",
        "src/middleware.ts:authMiddleware()",
      ],
      keyDecisions: ["Use RS256 instead of HS256 for production"],
      errorsAndFixes: ["Fixed circular dep by moving types to shared"],
      relevantContext: "User prefers functional programming style",
    };

    store.save("run-001", mem);
    const loaded = store.load("run-001");
    expect(loaded).not.toBeNull();
    expect(loaded?.session).toBe("run-001");
    expect(loaded?.project).toBe("TestProject");
    expect(loaded?.task).toBe("Refactor auth module");
    expect(loaded?.keyDecisions).toEqual([
      "Use RS256 instead of HS256 for production",
    ]);
    expect(loaded?.filesAndFunctions).toEqual([
      "src/auth.ts:verifyToken()",
      "src/middleware.ts:authMiddleware()",
    ]);

    // loadLatest should find it
    const latest = store.loadLatest();
    expect(latest?.session).toBe("run-001");

    // Verify file exists with proper markdown format
    const filePath = path.join(sessionDir, "run-001.md");
    expect(existsSync(filePath)).toBe(true);
    const raw = readFileSync(filePath, "utf8");
    expect(raw).toContain("---");
    expect(raw).toContain("session: run-001");
    expect(raw).toContain("# Session Memory");
    expect(raw).toContain("## Task");
    expect(raw).toContain("## Key Decisions");
  });

  test("SessionMemoryStore: round-trip preserves all fields", () => {
    const store = new SessionMemoryStore({
      workspaceRoot,
      sessionsDir: sessionDir,
    });

    const mem = {
      session: "run-002",
      project: "Paw",
      updatedAt: 1715689200000,
      task: "Test task",
      currentState: "Done",
      filesAndFunctions: ["a.ts:foo()"],
      keyDecisions: ["Use bun"],
      errorsAndFixes: ["None"],
      relevantContext: "Context",
    };

    store.save("run-002", mem);
    const loaded = store.load("run-002");
    expect(loaded).toEqual(mem);
  });

  test("AutoMemoryStore: save, load, list, buildIndex", () => {
    const store = new AutoMemoryStore({ workspaceRoot, memoryDir: memDir });

    const entry1: {
      name: string;
      description: string;
      type: "user" | "feedback" | "project" | "reference";
      content: string;
    } = {
      name: "prefers_typescript",
      description: "User prefers TypeScript over JavaScript",
      type: "user",
      content:
        "The user consistently asks for TypeScript implementations and avoids any `any` types.",
    };

    const entry2: {
      name: string;
      description: string;
      type: "user" | "feedback" | "project" | "reference";
      content: string;
    } = {
      name: "use_bun_runtime",
      description: "Project uses Bun as the runtime",
      type: "project",
      content:
        "All packages in the monorepo use Bun. Do not suggest npm or pnpm.",
    };

    store.save(entry1);
    store.save(entry2);

    const loaded1 = store.load("prefers_typescript");
    expect(loaded1).toEqual(entry1);

    const list = store.list();
    expect(list.length).toBe(2);
    expect(list.map((e) => e.name).sort()).toEqual([
      "prefers_typescript",
      "use_bun_runtime",
    ]);

    const index = store.buildIndex();
    expect(index).toContain("# Memory Index");
    expect(index).toContain("prefers_typescript");
    expect(index).toContain("use_bun_runtime");
    expect(index).toContain("user");
    expect(index).toContain("project");

    // Verify files on disk
    expect(existsSync(path.join(memDir, "prefers_typescript.md"))).toBe(true);
    expect(existsSync(path.join(memDir, "MEMORY.md"))).toBe(true);
  });

  test("AutoMemoryStore: delete removes entry", () => {
    const store = new AutoMemoryStore({ workspaceRoot, memoryDir: memDir });
    const entry = {
      name: "temp_entry",
      description: "Temporary",
      type: "reference" as const,
      content: "Will be deleted",
    };
    store.save(entry);
    expect(store.load("temp_entry")).not.toBeNull();

    store.delete("temp_entry");
    expect(store.load("temp_entry")).toBeNull();
    expect(store.list().length).toBe(0);
  });

  test("extractMemories: extracts structured entries via model completion", async () => {
    const mockModel = {
      label: "mock-mem",
      async complete() {
        return {
          text: `## Entry 1
- **Name**: user_prefers_dark_mode
- **Type**: user
- **Description**: User prefers dark mode UI
- **Content**: All interfaces should use dark themes.

## Entry 2
- **Name**: avoid_console_log
- **Type**: feedback
- **Description**: Do not use console.log in production
- **Content**: The user corrected previous code. Use structured logging instead.
`,
        };
      },
      async *completeStream() {
        throw new Error("Not implemented");
      },
    };

    const result = await extractMemories(
      mockModel,
      "User said they prefer dark mode.",
    );
    expect(result.entries.length).toBe(2);
    expect(result.entries[0]).toMatchObject({
      name: "user_prefers_dark_mode",
      type: "user",
      description: "User prefers dark mode UI",
    });
    expect(result.entries[0]?.content).toContain("dark themes");
    expect(result.entries[1]).toMatchObject({
      name: "avoid_console_log",
      type: "feedback",
      description: "Do not use console.log in production",
    });
  });

  test("extractMemories: returns empty for no-memories marker", async () => {
    const mockModel = {
      label: "mock-mem",
      async complete() {
        return { text: "No memories to extract." };
      },
      async *completeStream() {
        throw new Error("Not implemented");
      },
    };

    const result = await extractMemories(mockModel, "Generic conversation.");
    expect(result.entries.length).toBe(0);
  });

  test("runCompressionAgent: converts summary to structured session memory", async () => {
    const mockModel = {
      label: "mock-compress",
      async complete() {
        return {
          text: `## Active Task
Refactor auth to OAuth2.

## Goal
Migrate to OAuth2 with PKCE.

## Progress
- Extracted JWT utilities
- Created OAuth provider abstraction

## Key Decisions
- Use RS256 for token signing
- Store refresh tokens in httpOnly cookies

## Relevant Files
- src/auth.ts
- src/oauth/provider.ts

## Errors & Fixes
- Fixed circular dependency by creating shared types package

## Next Steps
1. Implement token refresh endpoint

## Pending Questions
- Should we support SAML?`,
        };
      },
      async *completeStream() {
        throw new Error("Not implemented");
      },
    };

    const result = await runCompressionAgent(
      mockModel,
      "Compress this conversation.",
      "run-003",
    );
    expect(result.summary).toContain("Active Task");
    expect(result.sessionMemory.session).toBe("run-003");
    expect(result.sessionMemory.task).toContain("OAuth2");
    expect(result.sessionMemory.keyDecisions).toContain(
      "Use RS256 for token signing",
    );
    expect(result.sessionMemory.errorsAndFixes).toContain(
      "Fixed circular dependency by creating shared types package",
    );
    expect(result.sessionMemory.filesAndFunctions).toContain("- src/auth.ts");
    expect(result.sessionMemory.currentState).toContain(
      "Extracted JWT utilities",
    );
    expect(result.sessionMemory.relevantContext).toContain("Next Steps:");
    expect(result.sessionMemory.relevantContext).toContain(
      "Pending Questions:",
    );
  });
});

// ═════════════════════════════════════════════════════════════
// Suite 3: Context Compression
// ═════════════════════════════════════════════════════════════

describe("Context Compression", () => {
  test("ContextCompactor: triggers at 70% threshold", () => {
    const compactor = new ContextCompactor();
    const contextWindow = 128_000;
    const threshold = Math.floor(contextWindow * 0.7 - 10_000); // ~79,600

    // Just under threshold
    const smallMessages: ChatMessage[] = [
      { role: "system", content: "You are an agent.".repeat(100) },
      { role: "user", content: "Hello.".repeat(100) },
    ];
    const check1 = compactor.check(smallMessages, contextWindow);
    expect(check1.shouldCompact).toBe(false);

    // Over threshold: create messages with ~80K tokens (320K chars)
    const hugeContent = "x".repeat(320_000);
    const bigMessages: ChatMessage[] = [
      { role: "system", content: hugeContent },
      { role: "user", content: hugeContent },
    ];
    const check2 = compactor.check(bigMessages, contextWindow);
    expect(check2.shouldCompact).toBe(true);
    expect(check2.currentTokens).toBeGreaterThan(threshold);
  });

  test("ContextCompactor: protects head and tail boundaries", () => {
    const compactor = new ContextCompactor();

    const messages: ChatMessage[] = [
      { role: "system", content: "System prompt." },
      { role: "user", content: "Initial goal." },
      { role: "assistant", content: "A1".repeat(1000) },
      { role: "user", content: "U1".repeat(1000) },
      { role: "assistant", content: "A2".repeat(1000) },
      { role: "user", content: "U2".repeat(1000) },
      { role: "assistant", content: "A3".repeat(1000) },
      { role: "user", content: "U3".repeat(1000) },
      { role: "assistant", content: "A4".repeat(1000) },
      { role: "user", content: "Recent tool result." },
    ];

    const boundaries = compactor.determineBoundaries(messages);
    // Head protects first 2 messages
    expect(boundaries.headEnd).toBe(1);
    // Tail should include some of the recent messages
    expect(boundaries.tailStart).toBeGreaterThan(boundaries.headEnd);
    expect(boundaries.tailStart).toBeLessThan(messages.length);
  });

  test("ContextCompactor: builds anchored summary prompt", () => {
    const compactor = new ContextCompactor();
    const headMessages: ChatMessage[] = [
      { role: "system", content: "System prompt." },
      { role: "user", content: "Do something." },
    ];

    // Without existing summary
    const prompt1 = compactor.buildSummaryPrompt(headMessages, null);
    expect(prompt1).toContain("Summarize the following conversation");
    expect(prompt1).toContain("Active Task");
    expect(prompt1).toContain("Key Decisions");
    expect(prompt1).toContain("[System]");
    expect(prompt1).toContain("[User]");

    // With existing summary (anchored)
    const prompt2 = compactor.buildSummaryPrompt(
      headMessages,
      "Previous summary text.",
    );
    expect(prompt2).toContain("Previous Summary");
    expect(prompt2).toContain(
      "Update the summary with the new conversation below",
    );
    expect(prompt2).toContain("Preserve information from the previous summary");
  });

  test("ContextCompactor: anti-thrashing skips low-savings compaction", () => {
    const compactor = new ContextCompactor();

    // Simulate one compaction that saved only 5% (< 15% threshold)
    compactor.recordResult(100_000, 95_000, true);
    // Single low-savings run should NOT trigger thrashing skip (needs 2 consecutive)
    expect(compactor.shouldSkipDueToThrashing()).toBe(false);

    // Second consecutive low-savings compaction
    compactor.recordResult(100_000, 95_000, true);
    expect(compactor.shouldSkipDueToThrashing()).toBe(true);

    // Another compactor with high savings — streak resets
    const compactor2 = new ContextCompactor();
    compactor2.recordResult(100_000, 80_000, true);
    expect(compactor2.shouldSkipDueToThrashing()).toBe(false);
  });

  test("ContextCompactor: circuit breaker disables after 3 failures", () => {
    const compactor = new ContextCompactor();
    expect(compactor.isDisabled).toBe(false);

    compactor.recordResult(100_000, 90_000, false);
    expect(compactor.isDisabled).toBe(false);
    compactor.recordResult(100_000, 90_000, false);
    expect(compactor.isDisabled).toBe(false);
    compactor.recordResult(100_000, 90_000, false);
    expect(compactor.isDisabled).toBe(true);

    // Reset should clear
    compactor.reset();
    expect(compactor.isDisabled).toBe(false);
  });

  test("pruneToolResults: persists oversized tool outputs", () => {
    const toolDir = tmpDir("paw-prune-");
    const hugeDetail = "x".repeat(60_000);
    const messages: ChatMessage[] = [
      { role: "assistant", content: "Tool call." },
      {
        role: "user",
        content: `[Tool workspace.list_dir completed]\nFound files:\n${hugeDetail}`,
      },
    ];

    const result = pruneToolResults(messages, { toolResultsDir: toolDir });
    expect(result.pruned).toBe(true);
    expect(result.freedTokens).toBeGreaterThan(0);
    expect(result.messages[1]?.content).toContain("<persisted-output>");
    expect(result.messages[1]?.content).not.toContain("x".repeat(55_000));
    cleanup(toolDir);
  });

  test("pruneToolResults: persists old tool results beyond keepRecentTools", () => {
    const toolDir = tmpDir("paw-prune-");
    const messages: ChatMessage[] = [];
    for (let i = 0; i < 12; i++) {
      messages.push({ role: "assistant", content: `Call ${i}` });
      messages.push({
        role: "user",
        content: `[Tool workspace.read_file completed]\nFile ${i} content:\n${"x".repeat(10_000)}`,
      });
    }

    const result = pruneToolResults(messages, {
      toolResultsDir: toolDir,
      keepRecentTools: 5,
    });
    expect(result.pruned).toBe(true);

    const persistedCount = result.messages.filter(
      (m) => m.role === "user" && m.content.includes("<persisted-output>"),
    ).length;
    expect(persistedCount).toBe(7);

    const recentFull = result.messages
      .slice(-10)
      .filter(
        (m) =>
          m.role === "user" &&
          !m.content.includes("<persisted-output>") &&
          m.content.length > 100,
      ).length;
    expect(recentFull).toBeGreaterThan(0);
    cleanup(toolDir);
  });

  test("pruneToolResults: protects skill/web_fetch/web_search/todo_write tools", () => {
    const toolDir = tmpDir("paw-prune-");
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: `[Tool skill completed]\nSkill result:\n${"y".repeat(60_000)}`,
      },
      {
        role: "user",
        content: `[Tool web_fetch completed]\nFetched:\n${"z".repeat(60_000)}`,
      },
      {
        role: "user",
        content: `[Tool workspace.list_dir completed]\nFiles:\n${"a".repeat(60_000)}`,
      },
    ];

    const result = pruneToolResults(messages, { toolResultsDir: toolDir });
    const skillMsg = result.messages.find((m) =>
      m.content.includes("[Tool skill completed]"),
    );
    const webMsg = result.messages.find((m) =>
      m.content.includes("[Tool web_fetch completed]"),
    );
    const listMsg = result.messages.find((m) =>
      m.content.includes("[Tool workspace.list_dir completed]"),
    );

    expect(skillMsg?.content).not.toContain("<persisted-output>");
    expect(webMsg?.content).not.toContain("<persisted-output>");
    expect(listMsg?.content).toContain("<persisted-output>");
    cleanup(toolDir);
  });

  test("full compression pipeline: compactor + pruner integration", () => {
    const toolDir = tmpDir("paw-prune-");
    const compactor = new ContextCompactor();
    const contextWindow = 128_000;

    const messages: ChatMessage[] = [
      { role: "system", content: "System prompt." },
      { role: "user", content: "Do a complex task." },
    ];
    const bigOutput = "data-line-content-here\n".repeat(500);
    for (let i = 0; i < 50; i++) {
      messages.push({ role: "assistant", content: `Analysis ${i}` });
      messages.push({
        role: "user",
        content: `[Tool workspace.run_shell completed]\nOutput ${i}:\n${bigOutput}`,
      });
    }
    messages.push({ role: "assistant", content: "Latest analysis." });
    messages.push({ role: "user", content: "What next?" });

    const pruneResult = pruneToolResults(messages, { toolResultsDir: toolDir });
    expect(pruneResult.pruned).toBe(true);

    // Step 2: History pool compact trigger (orchestrator uses history budget, not full context)
    const historyOnly: ChatMessage[] = [];
    const chunk = "word ".repeat(2000);
    for (let i = 0; i < 40; i++) {
      historyOnly.push({ role: "assistant", content: `Step ${i}: ${chunk}` });
      historyOnly.push({ role: "user", content: `Continue ${i}` });
    }
    const historyTokens = estimateMessagesTokens(historyOnly);
    const budgetSnapshot = measureContextBudget({
      contextWindow,
      systemTokens: 500,
      toolsTokens: 8_000,
      historyTokens,
    });
    expect(budgetSnapshot.compactThreshold).toBe(
      Math.floor(budgetSnapshot.allocation.historyBudget * 0.7 - 10_000),
    );
    expect(shouldCompactHistory(budgetSnapshot)).toBe(true);

    const compactMessages: ChatMessage[] = [
      { role: "system", content: "System prompt." },
      ...historyOnly,
    ];
    const boundaries = compactor.determineBoundaries(compactMessages);
    const head = compactMessages.slice(0, boundaries.headEnd + 1);
    const tail = compactMessages.slice(boundaries.tailStart);
    const prompt = compactor.buildSummaryPrompt(head, null);

    expect(head.length).toBeGreaterThanOrEqual(1);
    expect(tail.length).toBeGreaterThanOrEqual(1);
    expect(prompt).toContain("context compression assistant");
    cleanup(toolDir);
  });
});
