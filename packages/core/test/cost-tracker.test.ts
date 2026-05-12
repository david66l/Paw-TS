import { describe, expect, it } from "bun:test";
import { CostTracker } from "../src/cost-tracker.js";

describe("CostTracker", () => {
  it("starts at zero", () => {
    const tracker = new CostTracker();
    const snap = tracker.snapshot();
    expect(snap.promptTokens).toBe(0);
    expect(snap.completionTokens).toBe(0);
    expect(snap.totalTokens).toBe(0);
    expect(snap.estimatedCostUsd).toBe(0);
  });

  it("accumulates usage across multiple records", () => {
    const tracker = new CostTracker();
    tracker.record("claude-sonnet-4-6", { promptTokens: 100, completionTokens: 50 });
    tracker.record("claude-sonnet-4-6", { promptTokens: 200, completionTokens: 100 });
    const snap = tracker.snapshot();
    expect(snap.promptTokens).toBe(300);
    expect(snap.completionTokens).toBe(150);
    expect(snap.totalTokens).toBe(450);
    expect(snap.estimatedCostUsd).toBeGreaterThan(0);
  });

  it("handles partial usage (only promptTokens)", () => {
    const tracker = new CostTracker();
    tracker.record("gpt-4o", { promptTokens: 1000 });
    const snap = tracker.snapshot();
    expect(snap.promptTokens).toBe(1000);
    expect(snap.completionTokens).toBe(0);
    expect(snap.totalTokens).toBe(1000);
  });

  it("handles partial usage (only completionTokens)", () => {
    const tracker = new CostTracker();
    tracker.record("gpt-4o", { completionTokens: 500 });
    const snap = tracker.snapshot();
    expect(snap.promptTokens).toBe(0);
    expect(snap.completionTokens).toBe(500);
    expect(snap.totalTokens).toBe(500);
  });

  it("ignores undefined usage fields", () => {
    const tracker = new CostTracker();
    tracker.record("claude-sonnet-4-6", {});
    const snap = tracker.snapshot();
    expect(snap.totalTokens).toBe(0);
  });

  it("normalizes prefixed model labels", () => {
    const tracker = new CostTracker();
    tracker.record("anthropic:claude-sonnet-4-6", { promptTokens: 100, completionTokens: 50 });
    const snap = tracker.snapshot();
    expect(snap.totalTokens).toBe(150);
    expect(snap.estimatedCostUsd).toBeGreaterThan(0);
  });

  it("uses average pricing for unknown models", () => {
    const tracker = new CostTracker();
    tracker.record("some-unknown-model", { promptTokens: 1_000_000, completionTokens: 1_000_000 });
    const snap = tracker.snapshot();
    expect(snap.estimatedCostUsd).toBeGreaterThan(0);
  });

  it("resets counters to zero", () => {
    const tracker = new CostTracker();
    tracker.record("claude-sonnet-4-6", { promptTokens: 100, completionTokens: 50 });
    tracker.reset();
    const snap = tracker.snapshot();
    expect(snap.promptTokens).toBe(0);
    expect(snap.completionTokens).toBe(0);
    expect(snap.totalTokens).toBe(0);
  });

  it("summary returns human-readable string", () => {
    const tracker = new CostTracker();
    tracker.record("claude-sonnet-4-6", { promptTokens: 1234, completionTokens: 567 });
    const summary = tracker.summary();
    expect(summary).toContain("1,801");
    expect(summary).toContain("~$");
  });

  it("uses custom pricing when provided", () => {
    const tracker = new CostTracker({
      pricing: {
        "custom-model": { promptPer1M: 1.0, completionPer1M: 2.0 },
      },
    });
    tracker.record("custom-model", { promptTokens: 1_000_000, completionTokens: 1_000_000 });
    const snap = tracker.snapshot();
    expect(snap.estimatedCostUsd).toBe(3.0);
  });

  it("returns zero cost when no pricing available", () => {
    const tracker = new CostTracker({ pricing: {} });
    tracker.record("any-model", { promptTokens: 1000, completionTokens: 500 });
    const snap = tracker.snapshot();
    expect(snap.estimatedCostUsd).toBe(0);
  });
});
