/**
 * EvalDataCollector unit tests — verify hook integration produces valid records.
 */

import { describe, expect, test } from "bun:test";
import { EvalDataCollector } from "../src/data-collector.js";

// Minimal ContextManager stub
class StubContextManager {
  estimatedTokens = 500;
  historyEstimatedTokens = 300;
  systemEstimatedTokens = 200;
  length = 5;
  buildMessages() {
    return [
      { role: "system", content: "You are a test agent." },
      { role: "user", content: "test goal" },
    ];
  }
}

describe("EvalDataCollector", () => {
  test("builds a complete EvalRunRecord from hooks", () => {
    const collector = new EvalDataCollector(
      "tc-001",
      0,
      "run-1",
      "test goal",
      "test-model",
    );
    const cm = new StubContextManager();

    // Simulate one turn
    collector.beforeModelCall({
      messages: cm.buildMessages() as Parameters<typeof collector.beforeModelCall>[0]["messages"],
      contextManager: cm as Parameters<typeof collector.beforeModelCall>[0]["contextManager"],
    });

    collector.afterModelCall({
      turnIndex: 0,
      responseText: 'I will read the file.\n{"tool":"workspace.read_file","args":{"path":"test.ts"}}',
      toolCalls: [{ tool: "workspace.read_file", args: { path: "test.ts" } }],
      latencyMs: 100,
    });

    collector.afterToolCall({
      tool: "workspace.read_file",
      args: { path: "test.ts" },
      result: "file contents here",
      ok: true,
      durationMs: 50,
    });

    const record = collector.finalize("completed", "I have read the file.");

    expect(record.testCaseId).toBe("tc-001");
    expect(record.repetitionIndex).toBe(0);
    expect(record.status).toBe("completed");
    expect(record.finalAnswer).toBe("I have read the file.");
    expect(record.turns).toHaveLength(1);

    const turn = record.turns[0]!;
    expect(turn.turnIndex).toBe(0);
    expect(turn.modelInput.messageCount).toBe(2);
    expect(turn.modelOutput.rawText).toContain("read_file");
    expect(turn.toolExecutions).toHaveLength(1);
    expect(turn.toolExecutions[0]!.tool).toBe("workspace.read_file");
    expect(turn.toolExecutions[0]!.ok).toBe(true);
    expect(turn.contextSnapshot.totalTokens).toBe(500);
  });

  test("handles multiple turns", () => {
    const collector = new EvalDataCollector(
      "tc-002",
      1,
      "run-2",
      "multi-turn",
      "test-model",
    );
    const cm = new StubContextManager();

    // Turn 1
    collector.beforeModelCall({
      messages: [{ role: "system", content: "sys" }] as Parameters<typeof collector.beforeModelCall>[0]["messages"],
      contextManager: cm as Parameters<typeof collector.beforeModelCall>[0]["contextManager"],
    });
    collector.afterModelCall({
      turnIndex: 0,
      responseText: "turn 1",
      latencyMs: 50,
    });

    // Turn 2
    collector.beforeModelCall({
      messages: [{ role: "system", content: "sys" }] as Parameters<typeof collector.beforeModelCall>[0]["messages"],
      contextManager: cm as Parameters<typeof collector.beforeModelCall>[0]["contextManager"],
    });
    collector.afterModelCall({
      turnIndex: 1,
      responseText: "turn 2",
      latencyMs: 60,
    });
    collector.afterToolCall({
      tool: "workspace.glob",
      args: { pattern: "*.ts" },
      result: "found 3 files",
      ok: true,
      durationMs: 30,
    });

    const record = collector.finalize("completed", "Done after 2 turns.");
    expect(record.turns).toHaveLength(2);
    expect(record.turns[0]!.turnIndex).toBe(0);
    expect(record.turns[1]!.turnIndex).toBe(1);
    expect(record.turns[1]!.toolExecutions).toHaveLength(1);
  });

  test("handles error status", () => {
    const collector = new EvalDataCollector(
      "tc-003",
      0,
      "run-3",
      "error case",
      "test-model",
    );
    const cm = new StubContextManager();

    collector.beforeModelCall({
      messages: [{ role: "system", content: "sys" }] as Parameters<typeof collector.beforeModelCall>[0]["messages"],
      contextManager: cm as Parameters<typeof collector.beforeModelCall>[0]["contextManager"],
    });
    collector.afterModelCall({
      turnIndex: 0,
      responseText: "trying...",
      latencyMs: 100,
    });

    const record = collector.finalize(
      "error",
      undefined,
      "Model API call failed",
    );
    expect(record.status).toBe("error");
    expect(record.error).toBe("Model API call failed");
    expect(record.finalAnswer).toBeUndefined();
    expect(record.turns).toHaveLength(1);
  });
});
