import { describe, expect, it } from "bun:test";
import {
  allocateContextBudget,
  DEFAULT_BUDGET_RATIOS,
  LARGE_WINDOW_BUDGET_RATIOS,
  measureContextBudget,
  resolveBudgetRatios,
  shouldCompactHistory,
  truncateTextToTokenBudget,
} from "../src/context/budget.js";

describe("context-budget", () => {
  it("uses default ratios for 128k window", () => {
    expect(resolveBudgetRatios(128_000)).toEqual(DEFAULT_BUDGET_RATIOS);
    const alloc = allocateContextBudget(128_000);
    expect(alloc.systemBudget).toBe(Math.floor(128_000 * 0.12));
    expect(alloc.historyBudget).toBe(Math.floor(128_000 * 0.75));
  });

  it("uses large-window ratios for 500k+", () => {
    expect(resolveBudgetRatios(500_000)).toEqual(LARGE_WINDOW_BUDGET_RATIOS);
    const alloc = allocateContextBudget(1_000_000);
    expect(alloc.historyBudget).toBe(Math.floor(1_000_000 * 0.85));
  });

  it("detects history over budget and compact threshold", () => {
    const snapshot = measureContextBudget({
      contextWindow: 100_000,
      systemTokens: 5_000,
      toolsTokens: 3_000,
      historyTokens: 80_000,
    });
    expect(snapshot.historyOverBudget).toBe(true);
    expect(snapshot.systemOverBudget).toBe(false);
    expect(snapshot.compactThreshold).toBe(
      Math.floor(snapshot.allocation.historyBudget * 0.7 - 10_000),
    );
    expect(shouldCompactHistory(snapshot)).toBe(true);
  });

  it("detects system over budget", () => {
    const snapshot = measureContextBudget({
      contextWindow: 100_000,
      systemTokens: 20_000,
      toolsTokens: 3_000,
      historyTokens: 10_000,
    });
    expect(snapshot.systemOverBudget).toBe(true);
    expect(snapshot.historyOverBudget).toBe(false);
  });

  it("shouldCompactHistory is false below threshold", () => {
    const snapshot = measureContextBudget({
      contextWindow: 128_000,
      systemTokens: 1_000,
      toolsTokens: 1_000,
      historyTokens: 10_000,
    });
    expect(shouldCompactHistory(snapshot)).toBe(false);
  });

  it("truncateTextToTokenBudget shortens long text", () => {
    const long = "x".repeat(2000);
    const out = truncateTextToTokenBudget(long, 100);
    expect(out.length).toBeLessThan(long.length);
    expect(out).toContain("truncated");
  });
});
