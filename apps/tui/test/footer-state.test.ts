import { describe, expect, test } from "bun:test";

import {
  computeTurnCacheStats,
  formatBottomBar,
  formatContextBar,
  formatEventForScrollback,
  formatHudText,
  getFooterLayout,
  resolveApprovalKey,
} from "../src/footer-state.js";

describe("getFooterLayout", () => {
  test("等待用户回答时保持文本框可见", () => {
    expect(getFooterLayout({ askOpen: true, approvalOpen: false })).toEqual({
      showApprovalPicker: false,
      showAskPrompt: true,
      showTextarea: true,
      showBottomBar: true,
      showStreamPreview: false,
      streamPreviewHeight: 0,
      textareaHeight: 6,
    });
  });

  test("等待工具审批时显示审批选择器并隐藏输入框", () => {
    expect(getFooterLayout({ askOpen: false, approvalOpen: true })).toEqual({
      showApprovalPicker: true,
      showAskPrompt: false,
      showTextarea: false,
      showBottomBar: true,
      showStreamPreview: false,
      streamPreviewHeight: 0,
      textareaHeight: 0,
    });
  });
});

describe("formatHudText", () => {
  test("无数据时使用稳定的占位符渲染", () => {
    expect(
      formatHudText({
        modelLabel: null,
        turn: null,
        maxSteps: null,
        phase: null,
        costDetail: null,
        tokens: null,
        contextBudget: null,
        elapsedMs: null,
      }),
    ).toBe("paw │ - │ 轮 -/- │ 空闲");
  });
});

describe("formatContextBar", () => {
  test("tokens 未知时返回空字符串", () => {
    expect(formatContextBar(null, 128_000)).toBe("");
  });

  test("比例上限为 100%", () => {
    expect(formatContextBar(200_000, 128_000)).toBe(
      `${"█".repeat(20)} 100%`,
    );
  });

  test("按比例填充进度条", () => {
    const bar = formatContextBar(12_800, 128_000);
    expect(bar).toBe(`${"█".repeat(2)}${"░".repeat(18)} 10%`);
  });
});

describe("formatBottomBar", () => {
  test("格式化成本、上下文估计与会话 API tokens", () => {
    const line = formatBottomBar(
      {
        modelLabel: "deepseek:x",
        turn: 2,
        maxSteps: 40,
        phase: "idle",
        tokens: 6_500,
        contextBudget: {
          historyUsed: 42_000,
          historyBudget: 96_000,
          systemUsed: 8_000,
          systemBudget: 15_000,
          historyOverBudget: false,
          systemOverBudget: false,
        },
        elapsedMs: 9_000,
        costDetail: {
          promptTokens: 30_000,
          completionTokens: 4_800,
          totalTokens: 34_800,
          estimatedCostUsd: 0.4982,
          costCurrency: "USD" as const,
          turnPromptTokens: 8_600,
          turnCompletionTokens: 120,
          cachedPromptTokens: 8_200,
        },
      },
      128_000,
    );
    expect(line).toContain("$0.4982");
    expect(line).toContain("ctx 6.5K/128.0K");
    expect(line).toContain("上下文预算 42.0K/96.0K");
    expect(line).toContain("SP预算 8.0K/15.0K");
    expect(line).toContain("本轮 8.7K");
    expect(line).toContain("累计 34.8K");
    expect(line).toContain("缓存命中 95%");
    expect(line).toContain("⏱ 00:09");
  });

  test("超预算时显示警告标记", () => {
    const line = formatBottomBar(
      {
        modelLabel: null,
        turn: 1,
        maxSteps: 10,
        phase: "idle",
        tokens: 100_000,
        contextBudget: {
          historyUsed: 100_000,
          historyBudget: 96_000,
          systemUsed: 20_000,
          systemBudget: 15_000,
          historyOverBudget: true,
          systemOverBudget: true,
        },
        costDetail: null,
        elapsedMs: 0,
      },
      128_000,
    );
    expect(line).toContain("上下文预算 100.0K/96.0K!");
    expect(line).toContain("SP预算 20.0K/15.0K!");
  });
});

describe("computeTurnCacheStats", () => {
  test("分母使用本轮 prompt，而非累计 prompt", () => {
    const stats = computeTurnCacheStats({
      turnPromptTokens: 8_600,
      cachedPromptTokens: 8_200,
    });
    expect(stats?.hitPct).toBe(95);
    expect(stats?.hit).toBe(8_200);
    expect(stats?.miss).toBe(400);
  });

  test("缺少本轮 prompt tokens 时返回 null", () => {
    expect(
      computeTurnCacheStats({ cachedPromptTokens: 8_200 }),
    ).toBeNull();
  });
});

describe("formatEventForScrollback memory", () => {
  test("空记忆召回不显示", () => {
    expect(
      formatEventForScrollback({
        runId: "r",
        seq: 1,
        ts: 0,
        event: {
          type: "memory.retrieve.done",
          query: "x",
          totalCandidates: 0,
          selectedCount: 0,
          scores: [],
          injectedTokens: 0,
          selectedMemories: [],
        },
      }),
    ).toBeNull();
  });
});

describe("resolveApprovalKey", () => {
  test("正确映射审批选择器按键，且不拦截 ctrl-c", () => {
    expect(resolveApprovalKey({ name: "down" })).toBe("select-deny");
    expect(resolveApprovalKey({ name: "up" })).toBe("select-allow");
    expect(resolveApprovalKey({ name: "y" })).toBe("approve");
    expect(resolveApprovalKey({ name: "return" })).toBe("confirm");
    expect(resolveApprovalKey({ name: "n" })).toBe("deny");
    expect(resolveApprovalKey({ name: "escape" })).toBe("deny");
    expect(resolveApprovalKey({ name: "c", ctrl: true })).toBe(null);
  });
});

describe("formatEventForScrollback", () => {
  test("输出影响交互的审批结果与记忆事件", () => {
    expect(
      formatEventForScrollback({
        runId: "r",
        seq: 1,
        ts: 0,
        event: {
          type: "tool.approval.resolved",
          tool: "write_file",
          approved: false,
        },
      }),
    ).toBe("❌ 已拒绝 write_file");

    expect(
      formatEventForScrollback({
        runId: "r",
        seq: 2,
        ts: 0,
        event: {
          type: "tool.approval.resolved",
          tool: "write_file",
          approved: true,
        },
      }),
    ).toBeNull();

    expect(
      formatEventForScrollback({
        runId: "r",
        seq: 2,
        ts: 0,
        event: {
          type: "agent.action",
          action: { type: "tool_call", tool: "workspace.brief", args: {} },
        },
      }),
    ).toBeNull();

    expect(
      formatEventForScrollback({
        runId: "r",
        seq: 3,
        ts: 0,
        event: {
          type: "memory.retrieve.done",
          query: "parser bug",
          totalCandidates: 4,
          selectedCount: 2,
          scores: [120, 80],
          injectedTokens: 300,
          selectedMemories: [],
        },
      }),
    ).toBe("🧠 召回 2/4 条记忆 (300 tok)");

    expect(
      formatEventForScrollback({
        runId: "r",
        seq: 4,
        ts: 0,
        event: { type: "memory.extracted", entries: 2, rejected: 0, runId: "r" },
      }),
    ).toBe("🧠 记忆: 2 条已保存");

    expect(
      formatEventForScrollback({
        runId: "r",
        seq: 5,
        ts: 0,
        event: {
          type: "context.budget",
          contextWindow: 128_000,
          systemUsed: 8000,
          systemBudget: 15_360,
          toolsUsed: 2000,
          toolsBudget: 10_240,
          historyUsed: 42_000,
          historyBudget: 96_000,
          historyOverBudget: false,
          systemOverBudget: false,
          compactThreshold: 57_200,
        },
      }),
    ).toBe("📊 历史 42.0K/96.0K 系统 8.0K/15.4K");
  });
});
