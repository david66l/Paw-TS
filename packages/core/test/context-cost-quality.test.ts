import { describe, expect, test } from "bun:test";

import {
  costAdjustedCompactThreshold,
  detectDuplicateAccess,
  estimateContextCost,
} from "../src/index.js";

describe("P5.2 预算按成本记账", () => {
  test("estimateContextCost：output 60×、miss 10×、hit 1×", () => {
    const cost = estimateContextCost({
      promptTokens: 10_000,
      cachedPromptTokens: 7_000,
      completionTokens: 1_000,
    });
    // input = 7000×1 + 3000×10 = 37_000；output = 1000×60 = 60_000
    expect(cost.inputCost).toBe(37_000);
    expect(cost.outputCost).toBe(60_000);
    expect(cost.totalCost).toBe(97_000);
  });

  test("命中率高时成本主要来自生成（output 60×）", () => {
    const a = estimateContextCost({
      promptTokens: 100_000,
      cachedPromptTokens: 90_000,
      completionTokens: 5_000,
    });
    // input = 90K×1 + 10K×10 = 190K；output = 5K×60 = 300K
    expect(a.outputCost).toBe(300_000);
    expect(a.inputCost).toBe(190_000);
    expect(a.outputCost).toBeGreaterThan(a.inputCost);
  });

  test("costAdjustedCompactThreshold：高命中放宽阈值，低命中不变", () => {
    const base = 50_000;
    expect(costAdjustedCompactThreshold(base, 0)).toBe(base);
    expect(costAdjustedCompactThreshold(base, 0.8)).toBe(
      Math.floor(base * 1.2),
    );
    expect(costAdjustedCompactThreshold(base, 1)).toBe(
      Math.floor(base * 1.25),
    );
    // 上限 1.25
    expect(costAdjustedCompactThreshold(base, 5)).toBe(
      Math.floor(base * 1.25),
    );
  });
});

describe("P2.7 行为闭环：压缩后重复获取检测", () => {
  test("压缩后重读同一文件 → low quality", () => {
    const r = detectDuplicateAccess({
      filesReadAtCompact: ["src/a.ts", "src/b.ts"],
      commandsAtCompact: ["bun test src/a.test.ts"],
      newFilesRead: ["src/a.ts"],
      newCommands: [],
    });
    expect(r.quality).toBe("low");
    expect(r.duplicates).toEqual([{ kind: "file", value: "src/a.ts" }]);
  });

  test("压缩后重复跑同一测试命令 → low quality", () => {
    const r = detectDuplicateAccess({
      filesReadAtCompact: ["src/a.ts"],
      commandsAtCompact: ["bun test", "git status"],
      newFilesRead: [],
      newCommands: ["bun test"],
    });
    expect(r.quality).toBe("low");
    expect(r.duplicates).toEqual([{ kind: "command", value: "bun test" }]);
  });

  test("新文件/新命令不误报（ok）", () => {
    const r = detectDuplicateAccess({
      filesReadAtCompact: ["src/a.ts"],
      commandsAtCompact: ["bun test"],
      newFilesRead: ["src/c.ts", "src/d.ts"],
      newCommands: ["bun run build"],
    });
    expect(r.quality).toBe("ok");
    expect(r.duplicates).toEqual([]);
  });

  test("重复项去重（同一文件多次读只报一次）", () => {
    const r = detectDuplicateAccess({
      filesReadAtCompact: ["src/a.ts"],
      commandsAtCompact: [],
      newFilesRead: ["src/a.ts", "src/a.ts"],
      newCommands: [],
    });
    expect(r.duplicates).toHaveLength(1);
  });
});
