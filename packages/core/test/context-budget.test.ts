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
    expect(alloc.historyBudget).toBe(Math.floor(128_000 * 0.68));
    expect(alloc.reserveBudget).toBe(Math.floor(128_000 * 0.12));
  });

  it("uses large-window ratios for 500k+", () => {
    expect(resolveBudgetRatios(500_000)).toEqual(LARGE_WINDOW_BUDGET_RATIOS);
    const alloc = allocateContextBudget(1_000_000);
    expect(alloc.historyBudget).toBe(Math.floor(1_000_000 * 0.73));
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
    // v3 P5.2 单口径：0.8 × historyBudget − 10K（纯百分比，无绝对封顶）
    expect(snapshot.compactThreshold).toBe(
      Math.floor(snapshot.allocation.historyBudget * 0.8) - 10_000,
    );
    expect(shouldCompactHistory(snapshot)).toBe(true);
  });

  it("1M 窗口：纯百分比阈值（0.8 × 730K ≈ 584K），需要大量内容才触发", () => {
    const snapshot = measureContextBudget({
      contextWindow: 1_000_000,
      systemTokens: 5_000,
      toolsTokens: 3_000,
      historyTokens: 300_000,
    });
    // 无 200K 封顶：1M 模型的阈值按 80% historyBudget 走（≈584K−10K）
    expect(snapshot.compactThreshold).toBe(
      Math.floor(1_000_000 * 0.73 * 0.8) - 10_000,
    );
    // 300K 未到阈值（大窗口不频繁压缩是特性，由侧信道 monitor 兜底）
    expect(shouldCompactHistory(snapshot)).toBe(false);
    // 构造足够内容（>80% 预算）仍能触发——百分比与窗口无关
    const full = measureContextBudget({
      contextWindow: 1_000_000,
      systemTokens: 5_000,
      toolsTokens: 3_000,
      historyTokens: 600_000,
    });
    expect(shouldCompactHistory(full)).toBe(true);
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
