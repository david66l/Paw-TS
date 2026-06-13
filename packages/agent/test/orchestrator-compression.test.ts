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
        turn: 1,
        messages: buildHugeHistory(),
      },
    });
    expect(r.status).toBe("completed");
    expect(
      events.some(
        (e) =>
          e.event.type === "compression.auto_compact.started",
      ),
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
        turn: 1,
        messages: buildHugeHistory(),
      },
    });
    expect(r.status).toBe("completed");
    const skipped = events.find((e) => e.event.type === "compression.skipped");
    expect(skipped?.event.type).toBe("compression.skipped");
    if (skipped?.event.type === "compression.skipped") {
      expect(skipped.event.reason).toContain("insufficient compression savings");
    }
    expect(
      events.some((e) => e.event.type === "compression.auto_compact.done"),
    ).toBe(false);
  });
});
