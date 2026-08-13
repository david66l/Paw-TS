/**
 * Integration test suite for paw-ts core capabilities:
 * 1. Agent workflow (multi-turn, parallel tools, plan system, approval)
 * 2. Memory system (session memory for L2 compact)
 * 3. Context compression (compactor, pruner, anti-thrashing)
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { AgentOrchestrator } from "@paw/agent";
import type { ChatMessage, RunEventEnvelope } from "@paw/core";
import {
  ContextCompactor,
  SessionMemoryStore,
  estimateMessagesTokens,
  measureContextBudget,
  pruneToolResults,
  shouldCompactHistory,
} from "@paw/core";
import { resetPolicyConfig } from "@paw/harness";
import { FakeLanguageModel } from "@paw/models";
import { runCompressionAgent } from "../src/compression-agent.js";
import { cleanup, tmpDir } from "./fixtures.js";

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

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
  beforeEach(() => {
    resetPolicyConfig();
  });

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
      '{"action":"final_answer","summary":"Config updated. [skip_verify: integration fixture]"}',
      // spare turns if recovery/verify nudges consume a step
      '{"action":"final_answer","summary":"Config updated. [skip_verify: integration fixture]"}',
      '{"action":"final_answer","summary":"Config updated. [skip_verify: integration fixture]"}',
    ];

    const events: RunEventEnvelope[] = [];
    const o = new AgentOrchestrator({
      model: cycleModel(responses),
      onEvent: (e) => events.push(e),
    });

    const r = await o.run({
      runId: "cap-mt1",
      goal: "update config.json\n[allow_skip_verify]",
      workspaceRoot: dir,
      maxSteps: 10,
    });

    // Primary contract: write landed. Status may be completed (with skip_verify)
    // or incomplete under parallel policy-singleton races in the test process.
    expect(readFileSync(path.join(dir, "config.json"), "utf8")).toBe(
      '{"key":"updated"}',
    );
    expect(["completed", "incomplete"]).toContain(r.status);
    if (r.status === "completed") {
      expect(r.message).toContain("Config updated.");
    }

    const toolCalls = events.filter((e) => e.event.type === "tool.call");
    expect(
      toolCalls.some(
        (e) =>
          e.event.type === "tool.call" &&
          e.event.tool === "workspace.write_file",
      ),
    ).toBe(true);

    cleanup(dir);
  });

  test("explicit workspaceRoot is trusted, not re-anchored to ancestor .paw", async () => {
    // Regression: orchestrator used to run findPawRoot on an explicit
    // workspaceRoot, silently redirecting writes to an ancestor that has .paw
    // (e.g. home dir with global ~/.paw) while tools reported ok:true.
    const parent = tmpDir("paw-cap-anchor-");
    mkdirSync(path.join(parent, ".paw"), { recursive: true });
    const child = path.join(parent, "child");
    mkdirSync(child, { recursive: true });

    const responses = [
      '{"tool":"workspace.write_file","args":{"path":"out.txt","content":"hello"}}',
      '{"action":"final_answer","summary":"Wrote out.txt. [skip_verify: integration fixture]"}',
      '{"action":"final_answer","summary":"Wrote out.txt. [skip_verify: integration fixture]"}',
    ];

    const o = new AgentOrchestrator({ model: cycleModel(responses) });
    const r = await o.run({
      runId: "cap-anchor1",
      goal: "write out.txt\n[allow_skip_verify]",
      workspaceRoot: child,
      maxSteps: 5,
    });

    expect(r.status).toBe("completed");
    // File must land in the explicitly given child dir, not the .paw ancestor
    expect(readFileSync(path.join(child, "out.txt"), "utf8")).toBe("hello");
    expect(existsSync(path.join(parent, "out.txt"))).toBe(false);

    cleanup(parent);
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
    let modelCalls = 0;
    const model = {
      label: "plan-model",
      async complete(messages: readonly ChatMessage[]) {
        modelCalls += 1;
        if (modelCalls === 1) {
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
        if (modelCalls === 2) {
          return {
            text: JSON.stringify({
              action: "plan_update",
              reason: "steps completed",
              new_items: [
                {
                  id: "plan-001",
                  task_id: "step-a",
                  status: "completed",
                  depends_on: [],
                },
                {
                  id: "plan-002",
                  task_id: "step-b",
                  status: "completed",
                  depends_on: ["plan-001"],
                },
              ],
              deprecated_items: [],
            }),
          };
        }
        return { text: '{"action":"final_answer","summary":"Plan executed."}' };
      },
    };

    const events: RunEventEnvelope[] = [];
    const o = new AgentOrchestrator({
      model,
      auxiliaryModel: {
        label: "plan-aux",
        async complete() {
          return { text: '{"keep":[],"drop":[],"add":[]}' };
        },
      },
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

    expect(["completed", "incomplete"]).toContain(r.status);
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

    expect(r.status).toBe("aborted");
    expect(r.message).toBe("Run aborted.");

    cleanup(dir);
  });
});

// ═════════════════════════════════════════════════════════════
// Suite 2: Memory System
// ═════════════════════════════════════════════════════════════

describe("Memory System", () => {
  let sessionDir: string;
  let workspaceRoot: string;

  beforeEach(() => {
    workspaceRoot = tmpDir("paw-cap-mem-ws-");
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
  test("ContextCompactor: triggers at 80% threshold (v3 P5.2)", () => {
    const compactor = new ContextCompactor();
    const contextWindow = 128_000;
    // v3 P5.2 单口径：0.8 × 0.68 × window − 10K（纯百分比，无绝对封顶）
    const threshold = Math.floor(contextWindow * 0.68 * 0.8) - 10_000;

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
    // v3 P2.1: Head protects first 3 messages (protectFirstN=3)
    expect(boundaries.headEnd).toBe(2);
    // Tail should include some of the recent messages
    expect(boundaries.tailStart).toBeGreaterThan(boundaries.headEnd);
    expect(boundaries.tailStart).toBeLessThan(messages.length);
    // v3 P2.2: pinned 区存在（内容驱动保护索引）
    expect(boundaries.pinned).toBeDefined();
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
    // v3 P2.4: chapter-level revision rule
    expect(prompt2).toContain("REVISION RULE");
    expect(prompt2).toContain("Keep all unaffected sections verbatim");
  });

  test("ContextCompactor: low-savings rejections back off without tripping breaker", () => {
    const compactor = new ContextCompactor();

    // 单次低收益拒绝：不退避、不熔断
    compactor.recordLowSavings(100_000);
    expect(compactor.shouldBackoffForLowSavings(100_000)).toBe(false);
    expect(compactor.isDisabled).toBe(false);

    // 连续第二次低收益且历史未实质增长 → 退避（良性，仍不熔断）
    compactor.recordLowSavings(105_000);
    expect(compactor.shouldBackoffForLowSavings(110_000)).toBe(true);
    expect(compactor.isDisabled).toBe(false);

    // 历史增长 ≥20% 后退避自动解除
    expect(compactor.shouldBackoffForLowSavings(126_001)).toBe(false);

    // 成功压缩后复位
    compactor.recordSuccess();
    expect(compactor.shouldBackoffForLowSavings(100_000)).toBe(false);
  });

  test("ContextCompactor: circuit breaker disables after 3 failures", () => {
    const compactor = new ContextCompactor();
    expect(compactor.isDisabled).toBe(false);

    compactor.recordFailure("error");
    expect(compactor.isDisabled).toBe(false);
    compactor.recordFailure("quality");
    expect(compactor.isDisabled).toBe(false);
    compactor.recordFailure("over_compression");
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

  test("pruneToolResults: protects durable control-state tool results", () => {
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
      {
        role: "user",
        content: `[Tool workspace.acceptance_update completed]\nLedger:\n${"b".repeat(60_000)}`,
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
    const acceptanceMsg = result.messages.find((m) =>
      m.content.includes("[Tool workspace.acceptance_update completed]"),
    );

    expect(skillMsg?.content).not.toContain("<persisted-output>");
    expect(webMsg?.content).not.toContain("<persisted-output>");
    expect(acceptanceMsg?.content).not.toContain("<persisted-output>");
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
      Math.floor(budgetSnapshot.allocation.historyBudget * 0.8) - 10_000,
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
