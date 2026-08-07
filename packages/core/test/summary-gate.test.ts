import { describe, expect, test } from "bun:test";

import {
  MAX_COMPRESSION_SAVINGS_RATIO,
  MIN_COMPRESSION_SAVINGS_RATIO,
  extractEntityAnchors,
  meetsCompressionSavingsThreshold,
  validateCompressionSummary,
} from "../src/context/summary.js";

const GOOD_SUMMARY = `## Active Task
修复登录 bug
## Goal
修复 login 模块的认证问题
## Progress
- 已定位根因
- 已修复
## Key Decisions
- 使用 JWT
## Relevant Files
- src/auth/login.ts
## Errors & Fixes
- E108 error fixed
## Constraints
- 不要修改 src/index.ts
## Next Steps
- 写测试
## Pending Questions
- 无`;

describe("validateCompressionSummary — 规则层", () => {
  test("accepts well-formed summary", () => {
    expect(validateCompressionSummary(GOOD_SUMMARY).ok).toBe(true);
  });

  test("rejects empty summary", () => {
    const r = validateCompressionSummary("   ");
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("empty");
  });

  test("rejects summary missing required section", () => {
    const r = validateCompressionSummary(
      "## Active Task\nx\n## Goal\ny", // 缺 ## Progress
    );
    expect(r.ok).toBe(false);
  });

  test("rejects summary missing Constraints when constraints required", () => {
    const summary = GOOD_SUMMARY.replace(
      "## Constraints\n- 不要修改 src/index.ts\n",
      "",
    );
    const r = validateCompressionSummary(summary, {
      requiredConstraints: ["约束：不要修改 src/index.ts"],
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("Constraints");
  });
});

describe("validateCompressionSummary — 实体层（约束整块逐字）", () => {
  test("constraint preserved verbatim passes", () => {
    const r = validateCompressionSummary(GOOD_SUMMARY, {
      requiredConstraints: ["不要修改 src/index.ts"],
    });
    expect(r.ok).toBe(true);
  });

  test("constraint paraphrased (semantics kept, wording changed) is REJECTED", () => {
    // 实测失败模式：摘要改写约束（"不要修改"→"不得修改"）→ 必须拒绝
    const paraphrased = GOOD_SUMMARY.replace(
      "不要修改 src/index.ts",
      "不得修改 src/index.ts",
    );
    const r = validateCompressionSummary(paraphrased, {
      requiredConstraints: ["不要修改 src/index.ts"],
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("constraint not preserved verbatim");
  });

  test("semantic flip (forbidden→allowed) is REJECTED", () => {
    // 关键词全在但语义翻转：块匹配必须抓住
    const flipped = GOOD_SUMMARY.replace(
      "不要修改 src/index.ts",
      "允许修改 src/index.ts",
    );
    const r = validateCompressionSummary(flipped, {
      requiredConstraints: ["不要修改 src/index.ts"],
    });
    expect(r.ok).toBe(false);
  });

  test("constraint buried mid-conversation still required", () => {
    // 约束来自第 5+ 条消息 → 摘要必须包含原文
    const r = validateCompressionSummary(GOOD_SUMMARY, {
      requiredConstraints: ["只能修改 src/auth/ 下的文件"],
    });
    expect(r.ok).toBe(false); // 摘要没有这条 → 拒绝
  });
});

describe("validateCompressionSummary — 实体层（锚点）", () => {
  test("file path anchor lost is REJECTED", () => {
    const summary = GOOD_SUMMARY.replace("src/auth/login.ts", "login file");
    const r = validateCompressionSummary(summary, {
      originalMessages: [
        { role: "user", content: "检查 src/auth/login.ts 的认证逻辑" },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("entity anchor lost");
  });

  test("error line anchor preserved passes", () => {
    const r = validateCompressionSummary(GOOD_SUMMARY, {
      originalMessages: [
        {
          role: "user",
          content: "看到错误：E108: list_display_item failed",
        },
      ],
    });
    expect(r.ok).toBe(true);
  });

  test("no originalMessages → anchor check skipped", () => {
    const r = validateCompressionSummary(GOOD_SUMMARY);
    expect(r.ok).toBe(true);
  });
});

describe("extractEntityAnchors", () => {
  test("extracts file paths, error lines, commands", () => {
    const anchors = extractEntityAnchors([
      {
        role: "user",
        content: [
          "检查 packages/core/src/context/summary.ts",
          "bun test packages/core",
          "遇到错误: exit code 1, Traceback:",
        ].join("\n"),
      },
    ]);
    expect(anchors).toContain("packages/core/src/context/summary.ts");
    expect(anchors.some((a) => a.includes("bun test"))).toBe(true);
    expect(anchors.some((a) => a.includes("exit code 1"))).toBe(true);
  });
});

describe("meetsCompressionSavingsThreshold — 20-80% 区间", () => {
  test("savings below 20% rejected", () => {
    expect(meetsCompressionSavingsThreshold(1000, 850)).toBe(false);
  });

  test("savings 20-80% accepted", () => {
    expect(meetsCompressionSavingsThreshold(1000, 700)).toBe(true);
    expect(meetsCompressionSavingsThreshold(1000, 300)).toBe(true);
  });

  test("savings above 80% rejected (over-compression)", () => {
    expect(meetsCompressionSavingsThreshold(1000, 100)).toBe(false);
  });

  test("constants aligned with plan", () => {
    expect(MIN_COMPRESSION_SAVINGS_RATIO).toBe(0.2);
    expect(MAX_COMPRESSION_SAVINGS_RATIO).toBe(0.8);
  });
});
