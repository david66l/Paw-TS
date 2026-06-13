import { describe, expect, test } from "bun:test";
import {
  evaluateRunFromEnvelopes,
  evaluateRunFromJsonl,
} from "../src/run-evaluator.js";
import type { RunEventEnvelope } from "../src/run-events.js";

function env(ts: number, event: RunEventEnvelope["event"]): RunEventEnvelope {
  return { runId: "r1", seq: 0, ts, event };
}

describe("evaluateRunFromEnvelopes", () => {
  test("empty stream yields zero metrics", () => {
    const m = evaluateRunFromEnvelopes([]);
    expect(m.durationMs).toBe(0);
    expect(m.modelLatencyMs).toBe(0);
    expect(m.modelCalls).toBe(0);
    expect(m.toolCalls).toBe(0);
    expect(m.toolSuccesses).toBe(0);
    expect(m.totalTokens).toBe(0);
    expect(m.estimatedCost).toBe(0);
    expect(m.costCurrency).toBe("USD");
    expect(m.steps).toBe(0);
    expect(m.truncationCount).toBe(0);
  });

  test("computes duration from first to last envelope", () => {
    const m = evaluateRunFromEnvelopes([
      env(1_000, { type: "run.started", goal: "g" }),
      env(5_000, { type: "run.completed", status: "completed", message: "done" }),
    ]);
    expect(m.durationMs).toBe(4_000);
  });

  test("counts model calls, latency and tokens", () => {
    const m = evaluateRunFromEnvelopes([
      env(1_000, { type: "model.request", label: "l", messageCount: 2 }),
      env(2_500, {
        type: "model.done",
        text: "hi",
        usage: { promptTokens: 10, completionTokens: 5 },
      }),
      env(3_000, { type: "model.request", label: "l2", messageCount: 3 }),
      env(4_500, {
        type: "model.done",
        text: "ok",
        usage: { promptTokens: 8, completionTokens: 4 },
      }),
    ]);
    expect(m.modelCalls).toBe(2);
    expect(m.modelLatencyMs).toBe(3_000); // 1_500 + 1_500
    expect(m.totalTokens).toBe(27); // 15 + 12
  });

  test("model.done without usage does not affect totalTokens", () => {
    const m = evaluateRunFromEnvelopes([
      env(1_000, { type: "model.request", label: "l", messageCount: 1 }),
      env(2_000, { type: "model.done", text: "hi" }),
    ]);
    expect(m.modelCalls).toBe(1);
    expect(m.modelLatencyMs).toBe(1_000);
    expect(m.totalTokens).toBe(0);
  });

  test("handles unpaired model.request (no matching model.done)", () => {
    const m = evaluateRunFromEnvelopes([
      env(1_000, { type: "model.request", label: "l", messageCount: 1 }),
    ]);
    expect(m.modelCalls).toBe(1);
    expect(m.modelLatencyMs).toBe(0);
  });

  test("handles tool results", () => {
    const m = evaluateRunFromEnvelopes([
      env(1_000, { type: "tool.result", tool: "t1", ok: true, summary: "ok" }),
      env(2_000, { type: "tool.result", tool: "t2", ok: false, summary: "err" }),
      env(3_000, { type: "tool.result", tool: "t3", ok: true, summary: "ok2" }),
    ]);
    expect(m.toolCalls).toBe(3);
    expect(m.toolSuccesses).toBe(2);
  });

  test("tracks steps from loop.tick max turn", () => {
    const m = evaluateRunFromEnvelopes([
      env(1_000, { type: "loop.tick", turn: 1, maxSteps: 10, estimatedTokens: 100 }),
      env(2_000, { type: "loop.tick", turn: 3, maxSteps: 10, estimatedTokens: 200 }),
      env(3_000, { type: "loop.tick", turn: 2, maxSteps: 10, estimatedTokens: 150 }),
    ]);
    expect(m.steps).toBe(3);
  });

  test("tracks truncation count", () => {
    const m = evaluateRunFromEnvelopes([
      env(1_000, { type: "model.truncated", finishReason: "length" }),
      env(2_000, { type: "model.truncated", finishReason: "max_tokens" }),
    ]);
    expect(m.truncationCount).toBe(2);
  });

  test("reads cost and currency from last cost.update", () => {
    const m = evaluateRunFromEnvelopes([
      env(1_000, {
        type: "cost.update",
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        estimatedCostUsd: 0.01,
      }),
      env(2_000, {
        type: "cost.update",
        promptTokens: 20,
        completionTokens: 10,
        totalTokens: 30,
        estimatedCostUsd: 0.03,
        costCurrency: "CNY",
      }),
    ]);
    expect(m.estimatedCost).toBe(0.03);
    expect(m.costCurrency).toBe("CNY");
  });

  test("full synthetic run snapshot", () => {
    const m = evaluateRunFromEnvelopes([
      env(0, { type: "run.started", goal: "test" }),
      env(100, { type: "loop.tick", turn: 1, maxSteps: 10, estimatedTokens: 50 }),
      env(200, { type: "model.request", label: "plan", messageCount: 3 }),
      env(1_200, {
        type: "model.done",
        text: "plan",
        usage: { promptTokens: 20, completionTokens: 10 },
      }),
      env(1_300, {
        type: "cost.update",
        promptTokens: 20,
        completionTokens: 10,
        totalTokens: 30,
        estimatedCostUsd: 0.005,
      }),
      env(1_400, { type: "tool.result", tool: "read", ok: true, summary: "file" }),
      env(1_500, { type: "loop.tick", turn: 2, maxSteps: 10, estimatedTokens: 100 }),
      env(1_600, { type: "model.request", label: "act", messageCount: 5 }),
      env(3_100, {
        type: "model.done",
        text: "done",
        usage: { promptTokens: 30, completionTokens: 20 },
      }),
      env(3_200, {
        type: "cost.update",
        promptTokens: 30,
        completionTokens: 20,
        totalTokens: 50,
        estimatedCostUsd: 0.01,
      }),
      env(3_300, { type: "run.completed", status: "completed", message: "done" }),
    ]);

    expect(m.durationMs).toBe(3_300);
    expect(m.modelCalls).toBe(2);
    expect(m.modelLatencyMs).toBe(2_500); // 1_000 + 1_500
    expect(m.toolCalls).toBe(1);
    expect(m.toolSuccesses).toBe(1);
    expect(m.totalTokens).toBe(80); // 30 + 50
    expect(m.estimatedCost).toBe(0.01);
    expect(m.costCurrency).toBe("USD");
    expect(m.steps).toBe(2);
    expect(m.truncationCount).toBe(0);
  });
});

describe("evaluateRunFromJsonl", () => {
  test("reads JSONL and computes metrics", async () => {
    const tmp = await Bun.file("/tmp/paw-eval-test.jsonl").writer();
    const lines = [
      JSON.stringify({ runId: "r1", seq: 1, ts: 1000, event: { type: "run.started", goal: "g" } }),
      JSON.stringify({ runId: "r1", seq: 2, ts: 2000, event: { type: "model.request", label: "l", messageCount: 1 } }),
      JSON.stringify({ runId: "r1", seq: 3, ts: 3500, event: { type: "model.done", text: "ok", usage: { promptTokens: 5, completionTokens: 3 } } }),
      JSON.stringify({ runId: "r1", seq: 4, ts: 5000, event: { type: "run.completed", status: "completed", message: "done" } }),
    ];
    for (const line of lines) {
      tmp.write(line + "\n");
    }
    await tmp.end();

    const m = await evaluateRunFromJsonl("/tmp/paw-eval-test.jsonl");
    expect(m.durationMs).toBe(4_000);
    expect(m.modelCalls).toBe(1);
    expect(m.modelLatencyMs).toBe(1_500);
    expect(m.totalTokens).toBe(8);
  });
});
