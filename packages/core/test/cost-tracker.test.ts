import { describe, expect, it } from "bun:test";
import {
  CostTracker,
  estimateUsageCost,
  resolveModelPricing,
} from "../src/cost-tracker.js";

describe("CostTracker", () => {
  it("starts at zero", () => {
    const tracker = new CostTracker();
    const snap = tracker.snapshot();
    expect(snap.promptTokens).toBe(0);
    expect(snap.completionTokens).toBe(0);
    expect(snap.totalTokens).toBe(0);
    expect(snap.estimatedCost).toBe(0);
  });

  it("accumulates usage across multiple records", () => {
    const tracker = new CostTracker();
    tracker.record("claude-sonnet-4-6", {
      promptTokens: 100,
      completionTokens: 50,
    });
    tracker.record("claude-sonnet-4-6", {
      promptTokens: 200,
      completionTokens: 100,
    });
    const snap = tracker.snapshot();
    expect(snap.promptTokens).toBe(300);
    expect(snap.completionTokens).toBe(150);
    expect(snap.totalTokens).toBe(450);
    expect(snap.estimatedCost).toBeGreaterThan(0);
    expect(snap.costCurrency).toBe("USD");
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

  it("uses claude pricing for prefixed model labels", () => {
    const tracker = new CostTracker();
    tracker.record("anthropic:claude-sonnet-4-6", {
      promptTokens: 100,
      completionTokens: 50,
    });
    const snap = tracker.snapshot();
    expect(snap.totalTokens).toBe(150);
    expect(snap.estimatedCost).toBeGreaterThan(0);
    expect(snap.costCurrency).toBe("USD");
  });

  it("uses average pricing for unknown models", () => {
    const tracker = new CostTracker();
    tracker.record("some-unknown-model", {
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
    });
    const snap = tracker.snapshot();
    expect(snap.estimatedCost).toBeGreaterThan(0);
  });

  it("resets counters to zero", () => {
    const tracker = new CostTracker();
    tracker.record("claude-sonnet-4-6", {
      promptTokens: 100,
      completionTokens: 50,
    });
    tracker.reset();
    const snap = tracker.snapshot();
    expect(snap.promptTokens).toBe(0);
    expect(snap.completionTokens).toBe(0);
    expect(snap.totalTokens).toBe(0);
  });

  it("summary returns human-readable string", () => {
    const tracker = new CostTracker();
    tracker.record("claude-sonnet-4-6", {
      promptTokens: 1234,
      completionTokens: 567,
    });
    const summary = tracker.summary();
    expect(summary).toContain("1,801");
    expect(summary).toMatch(/[$¥]/);
  });

  it("uses custom pricing when provided", () => {
    const tracker = new CostTracker({
      pricing: {
        "custom-model": {
          currency: "USD",
          promptPer1M: 1.0,
          completionPer1M: 2.0,
        },
      },
    });
    tracker.record("custom-model", {
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
    });
    const snap = tracker.snapshot();
    expect(snap.estimatedCost).toBe(3.0);
  });

  it("returns zero cost when no pricing available", () => {
    const tracker = new CostTracker({ pricing: {} });
    tracker.record("any-model", { promptTokens: 1000, completionTokens: 500 });
    const snap = tracker.snapshot();
    expect(snap.estimatedCost).toBe(0);
  });

  it("deepseek v4 flash uses cheaper flash tier (CNY)", () => {
    const { cost, currency } = estimateUsageCost("deepseek:deepseek-v4-flash", {
      promptTokens: 8313,
      completionTokens: 47,
      cachedPromptTokens: 8192,
    });
    expect(currency).toBe("CNY");
    // Flash: 8192×0.02 + 121×1 + 47×2 per 1M
    expect(cost).toBeCloseTo(0.00038, 4);
  });

  it("deepseek v4 pro uses pro tier (CNY)", () => {
    const { cost } = estimateUsageCost("deepseek:deepseek-v4-pro", {
      promptTokens: 8313,
      completionTokens: 47,
      cachedPromptTokens: 8192,
    });
    // Pro: 8192×0.025 + 121×3 + 47×6 per 1M
    expect(cost).toBeCloseTo(0.00085, 4);
  });

  it("accumulates deepseek flash session cost in CNY", () => {
    const tracker = new CostTracker();
    tracker.record("deepseek-v4-flash", {
      promptTokens: 8313,
      completionTokens: 47,
      cachedPromptTokens: 8192,
    });
    const snap = tracker.snapshot();
    expect(snap.costCurrency).toBe("CNY");
    expect(snap.estimatedCost).toBeCloseTo(0.00038, 4);
  });

  it("resolveModelPricing maps deepseek variants", () => {
    expect(resolveModelPricing("deepseek:deepseek-v4-flash").currency).toBe(
      "CNY",
    );
    expect(
      resolveModelPricing("deepseek:deepseek-v4-flash").promptCacheHitPer1M,
    ).toBe(0.02);
    expect(
      resolveModelPricing("deepseek:deepseek-v4-pro").promptCacheMissPer1M,
    ).toBe(3);
    expect(resolveModelPricing("deepseek-chat").promptCacheMissPer1M).toBe(1);
  });
});
