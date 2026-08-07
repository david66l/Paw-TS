import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ChatMessage, RunEventEnvelope } from "@paw/core";
import { ContextManager } from "@paw/core";
import type { LanguageModel } from "@paw/models";

import { AgentOrchestrator } from "../src/orchestrator.js";

function buildHugeHistory(): ChatMessage[] {
  const chunk = "word ".repeat(2000);
  const messages: ChatMessage[] = [{ role: "user", content: "Initial goal" }];
  for (let i = 0; i < 40; i++) {
    messages.push({ role: "assistant", content: `Step ${i}: ${chunk}` });
    messages.push({ role: "user", content: `Continue ${i}` });
  }
  return messages;
}

function largeHistoryContextManager(): ContextManager {
  return new ContextManager({ maxMessages: 200, maxChars: 10_000_000 });
}

const finalAnswerModel = {
  label: "final-only",
  capabilities: { contextWindow: 128_000 },
  async complete() {
    return { text: '{"action":"final_answer","summary":"Done."}' };
  },
  async *completeStream() {
    yield { type: "done" as const };
  },
};

function auxiliaryModel(responder: (user: string) => string): LanguageModel {
  return {
    label: "aux-compression",
    capabilities: { contextWindow: 128_000 },
    async complete(messages) {
      const user =
        messages.find((m) => m.role === "user")?.content?.toString() ?? "";
      return { text: responder(user) };
    },
    async *completeStream() {
      yield { type: "done" as const };
    },
  };
}

describe("AgentOrchestrator compression & budget", () => {
  test("emits context.budget on run start", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-orch-budget-"));
    const events: RunEventEnvelope[] = [];
    const o = new AgentOrchestrator({
      model: finalAnswerModel,
      onEvent: (e) => events.push(e),
    });
    const r = await o.run({
      runId: "budget1",
      goal: "say hello",
      workspaceRoot: dir,
      maxSteps: 1,
    });
    expect(r.status).toBe("completed");
    const budget = events.find((e) => e.event.type === "context.budget");
    expect(budget?.event.type).toBe("context.budget");
    if (budget?.event.type === "context.budget") {
      expect(budget.event.contextWindow).toBe(128_000);
      expect(budget.event.historyBudget).toBeGreaterThan(0);
      expect(budget.event.systemBudget).toBeGreaterThan(0);
      expect(budget.event.toolsBudget).toBeGreaterThan(0);
      expect(budget.event.systemOverBudget).toBe(false);
    }
  });

  test("skips compaction when summary fails quality gate", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-orch-quality-"));
    const events: RunEventEnvelope[] = [];
    const o = new AgentOrchestrator({
      model: finalAnswerModel,
      auxiliaryModel: auxiliaryModel((user) => {
        if (user.includes("Summarize the following conversation")) {
          return "not a valid structured summary";
        }
        return "";
      }),
      memoryExtraction: "off",
      contextManager: largeHistoryContextManager(),
      onEvent: (e) => events.push(e),
    });
    const r = await o.run({
      runId: "quality1",
      goal: "continue work",
      workspaceRoot: dir,
      maxSteps: 2,
      resumeFromState: {
        runId: "quality1",
        goal: "continue work",
        workspaceRoot: dir,
        turn: 1,
        maxSteps: 2,
        savedAt: Date.now(),
        messages: buildHugeHistory(),
      },
    });
    expect(r.status).toBe("completed");
    expect(
      events.some((e) => e.event.type === "compression.auto_compact.started"),
    ).toBe(true);
    const skipped = events.find((e) => e.event.type === "compression.skipped");
    expect(skipped?.event.type).toBe("compression.skipped");
    if (skipped?.event.type === "compression.skipped") {
      expect(skipped.event.reason).toContain("summary quality");
    }
    expect(
      events.some((e) => e.event.type === "compression.auto_compact.done"),
    ).toBe(false);
  });

  test("skips compaction when savings are below threshold", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-orch-savings-"));
    const events: RunEventEnvelope[] = [];
    const o = new AgentOrchestrator({
      model: finalAnswerModel,
      auxiliaryModel: auxiliaryModel((user) => {
        if (user.includes("Summarize the following conversation")) {
          const body = "compressed detail line with padding\n".repeat(30_000);
          return `## Active Task\nStill working\n## Goal\nFinish task\n## Progress\n${body}`;
        }
        return "";
      }),
      memoryExtraction: "off",
      contextManager: largeHistoryContextManager(),
      onEvent: (e) => events.push(e),
    });
    const r = await o.run({
      runId: "savings1",
      goal: "continue work",
      workspaceRoot: dir,
      maxSteps: 2,
      resumeFromState: {
        runId: "savings1",
        goal: "continue work",
        workspaceRoot: dir,
        turn: 1,
        maxSteps: 2,
        savedAt: Date.now(),
        messages: buildHugeHistory(),
      },
    });
    expect(r.status).toBe("completed");
    const skipped = events.find((e) => e.event.type === "compression.skipped");
    expect(skipped?.event.type).toBe("compression.skipped");
    if (skipped?.event.type === "compression.skipped") {
      expect(skipped.event.reason).toContain("savings too low");
    }
    expect(
      events.some((e) => e.event.type === "compression.auto_compact.done"),
    ).toBe(false);
  });

  test("P4.4 successful compaction emits compression.commit (snapshot 落盘)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-orch-commit-"));
    const events: RunEventEnvelope[] = [];
    const o = new AgentOrchestrator({
      model: finalAnswerModel,
      auxiliaryModel: auxiliaryModel((user) => {
        // 兼容全新摘要（"Summarize..."）与增量更新（"Update the summary"）两种 prompt
        if (
          user.includes("Summarize the following conversation") ||
          user.includes("Update the summary")
        ) {
          // 摘要体量需使节省比例落在 20-80%（超过 80% 危险线会被门控拒绝）
          const body = "compressed detail line with padding\n".repeat(2_500);
          return [
            "## Active Task",
            `Refactor module\n${body}`,
            "## Goal",
            "Finish the refactor",
            "## Progress",
            "- Extracted helpers",
            "## Key Decisions",
            "- Use ES modules",
            "## Relevant Files",
            "- src/main.ts",
            "## Errors & Fixes",
            "- Fixed import cycle",
            "## Next Steps",
            "1. Run tests",
            "## Pending Questions",
            "- None",
          ].join("\n");
        }
        return "";
      }),
      memoryExtraction: "off",
      contextManager: largeHistoryContextManager(),
      onEvent: (e) => events.push(e),
    });
    const r = await o.run({
      runId: "commit1",
      goal: "continue work",
      workspaceRoot: dir,
      maxSteps: 2,
      resumeFromState: {
        runId: "commit1",
        goal: "continue work",
        workspaceRoot: dir,
        turn: 1,
        maxSteps: 2,
        savedAt: Date.now(),
        messages: buildHugeHistory(),
      },
    });
    expect(r.status).toBe("completed");
    const done = events.find(
      (e) => e.event.type === "compression.auto_compact.done",
    );
    expect(done).toBeDefined();
    const commit = events.find((e) => e.event.type === "compression.commit");
    expect(commit?.event.type).toBe("compression.commit");
    if (commit?.event.type === "compression.commit") {
      expect(commit.event.commit).toBe(1);
      expect(commit.event.snapshotPath).toContain("compaction-commits");
      expect(commit.event.beforeTokens).toBeGreaterThan(
        commit.event.afterTokens,
      );
      // 快照确实落盘（回滚点可用）
      const { existsSync } = await import("node:fs");
      expect(existsSync(commit.event.snapshotPath)).toBe(true);
    }
  });

  test("P4.3 context.blocks 逐块账本：system/pinned/tool 块齐全", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-orch-blocks-"));
    const events: RunEventEnvelope[] = [];
    const o = new AgentOrchestrator({
      model: finalAnswerModel,
      onEvent: (e) => events.push(e),
    });
    const r = await o.run({
      runId: "blocks1",
      goal: "say hello",
      workspaceRoot: dir,
      maxSteps: 1,
    });
    expect(r.status).toBe("completed");
    const blocks = events.find((e) => e.event.type === "context.blocks");
    expect(blocks?.event.type).toBe("context.blocks");
    if (blocks?.event.type === "context.blocks") {
      expect(blocks.event.blocks.length).toBeGreaterThan(0);
      const types = new Set(blocks.event.blocks.map((b) => b.type));
      expect(types.has("system")).toBe(true);
      expect(types.has("pinned")).toBe(true); // [Context Package]
      for (const b of blocks.event.blocks) {
        expect(b.tokens).toBeGreaterThanOrEqual(0);
        expect(b.ageTurns).toBeGreaterThanOrEqual(0);
      }
    }
  });

  test("P5.1 侧信道触发：subtask_end 信号下强制压缩（低于预算阈值也可触发）", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "paw-orch-monitor-"));
    const events: RunEventEnvelope[] = [];
    // 历史远低于压缩阈值：靠 monitor 判定 subtask_end 强制压缩。
    // 体量 ~15K tokens（tail 8K 保底下 middle 仍可压缩 ≥20%）
    const chunk = "word ".repeat(800); // ~4K chars ≈ 1K tokens
    const smallHistory: ChatMessage[] = [
      { role: "user", content: "fix the login bug" },
    ];
    for (let i = 0; i < 15; i++) {
      smallHistory.push({ role: "assistant", content: `Step ${i}: ${chunk}` });
      smallHistory.push({ role: "user", content: `Continue ${i}` });
    }
    smallHistory.push({
      role: "user",
      // >120 字符：evaluateTrigger 中 low_density（连续 3 条短 user 消息）
      // 优先于 subtask_end 判定，尾部必须是长消息才不会抢占触发原因
      content:
        "run the full test suite to verify the login fix end to end, then summarize exactly what changed and list any follow-up work that still remains",
    });
    smallHistory.push({
      role: "assistant",
      content: "all tests pass — done with the login fix",
    });
    const o = new AgentOrchestrator({
      model: finalAnswerModel,
      auxiliaryModel: auxiliaryModel((user) => {
        if (
          user.includes("Summarize the following conversation") ||
          user.includes("Update the summary")
        ) {
          return [
            "## Active Task",
            "Fix login bug",
            "## Goal",
            "Finish the fix",
            "## Progress",
            "- Patched login flow",
            "## Key Decisions",
            "- ES modules",
            "## Relevant Files",
            "- src/auth.ts",
            "## Errors & Fixes",
            "- None",
            "## Next Steps",
            "1. Verify",
            "## Pending Questions",
            "- None",
          ].join("\n");
        }
        return "";
      }),
      memoryExtraction: "off",
      monitorOptions: { sampleProbability: 1.0, cooldownTurns: 0 },
      onEvent: (e) => events.push(e),
    });
    const r = await o.run({
      runId: "monitor1",
      goal: "fix the login bug",
      workspaceRoot: dir,
      maxSteps: 2,
      resumeFromState: {
        runId: "monitor1",
        goal: "fix the login bug",
        workspaceRoot: dir,
        turn: 1,
        maxSteps: 2,
        savedAt: Date.now(),
        messages: smallHistory,
      },
    });
    expect(r.status).toBe("completed");
    const trigger = events.find(
      (e) => e.event.type === "compression.monitor.trigger",
    );
    expect(trigger?.event.type).toBe("compression.monitor.trigger");
    if (trigger?.event.type === "compression.monitor.trigger") {
      expect(trigger.event.reason).toBe("subtask_end");
      expect(trigger.event.force).toBe(true);
    }
    // 强制压缩实际执行（auto_compact.done）
    const done = events.find(
      (e) => e.event.type === "compression.auto_compact.done",
    );
    expect(done).toBeDefined();
  });
});
