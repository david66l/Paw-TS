import { describe, expect, test } from "bun:test";

import {
  ContextMonitor,
  DEFAULT_MONITOR_OPTIONS,
  evaluateTrigger,
  type ChatMessage,
} from "../src/index.js";

const msg = (role: "user" | "assistant", content: string): ChatMessage => ({
  role,
  content,
});

describe("P5.1 evaluateTrigger 规则引擎", () => {
  test("subtask_end：最近回合完成证据 + 错误已解决 → 触发", () => {
    const messages = [
      msg("user", "fix the bug"),
      msg("assistant", "patching now"),
      msg("user", "[Tool workspace.run_shell failed]\nexit code 1: error"),
      msg("assistant", "retrying with fix"),
      msg("user", "run tests again"),
      msg("assistant", "all tests pass — done with the bug fix"),
    ];
    const d = evaluateTrigger(messages);
    expect(d.triggered).toBe(true);
    expect(d.reason).toBe("subtask_end");
  });

  test("low_density：最近 3+ 条连续低密度 → 触发", () => {
    const messages = [
      msg("user", "task start"),
      msg("assistant", "ok"),
      msg("user", "yes"),
      msg("assistant", "done"),
      msg("user", "next"),
      msg("assistant", "sure"),
    ];
    const d = evaluateTrigger(messages);
    expect(d.triggered).toBe(true);
    expect(d.reason).toBe("low_density");
  });

  test("critical_issue：错误证据跨多轮未解 → 触发", () => {
    const messages = [
      msg("user", "start"),
      msg("user", "[Tool workspace.run_shell failed]\nerror: build failed"),
      msg("assistant", "looking into it"),
      msg("user", "try again"),
      msg("user", "[Tool workspace.run_shell failed]\nexception: still failing"),
      msg("assistant", "still investigating"),
    ];
    const d = evaluateTrigger(messages);
    expect(d.triggered).toBe(true);
    expect(d.reason).toBe("critical_issue");
  });

  test("正常对话不触发", () => {
    const messages = [
      msg(
        "user",
        "read the config file at src/config/auth.ts and summarize the full authentication flow for me in detail including all middleware",
      ),
      msg(
        "assistant",
        "here is the detailed summary of the file contents with the key details about the jwt verification chain",
      ),
      msg(
        "user",
        "thanks, now write a comprehensive test for the new function we discussed earlier in this conversation",
      ),
      msg(
        "assistant",
        "added tests in src/__tests__/foo.test.ts covering the new behavior with edge cases and mocks",
      ),
      msg(
        "user",
        "run the test suite to verify everything still passes cleanly before we move on to the next task",
      ),
      msg("assistant", "ran them — all passing"),
    ];
    expect(evaluateTrigger(messages).triggered).toBe(false);
  });

  test("消息太少不触发", () => {
    expect(evaluateTrigger([msg("user", "hi")]).triggered).toBe(false);
  });
});

describe("P5.1 ContextMonitor 调度", () => {
  test("采样率 1.0 时每轮评估；触发后进入冷却", () => {
    const monitor = new ContextMonitor({ sampleProbability: 1.0 });
    expect(monitor.shouldEvaluate(1, 1)).toBe(true);
    monitor.noteEvaluated(true);
    // 冷却期内不评估
    for (let i = 0; i < DEFAULT_MONITOR_OPTIONS.cooldownTurns; i++) {
      expect(monitor.shouldEvaluate(2 + i, 1)).toBe(false);
    }
    // 冷却结束恢复
    expect(monitor.shouldEvaluate(10, 1)).toBe(true);
  });

  test("剩余预算 <5% 必触发（硬线）", () => {
    const monitor = new ContextMonitor({ sampleProbability: 0 });
    expect(monitor.shouldEvaluate(1, 0.03)).toBe(true);
  });

  test("剩余预算 <20% 采样率提高 3 倍", () => {
    const monitor = new ContextMonitor({ sampleProbability: 0.1 });
    // 软启动区间：p = 0.3 —— 统计上 20 次至少命中几次（用边界断言：非零概率即可能）
    let hits = 0;
    for (let i = 0; i < 200; i++) {
      if (monitor.shouldEvaluate(i, 0.1)) hits++;
    }
    // 0.3 概率下 200 次采样几乎必 >5（远高于 0.1 的期望 20）
    expect(hits).toBeGreaterThan(5);
  });

  test("同轮不重复评估", () => {
    const monitor = new ContextMonitor({ sampleProbability: 1.0 });
    monitor.shouldEvaluate(5, 1);
    expect(monitor.shouldEvaluate(5, 1)).toBe(false);
  });

  test("统计：采样/触发计数", () => {
    const monitor = new ContextMonitor({ sampleProbability: 1.0 });
    monitor.shouldEvaluate(1, 1);
    monitor.noteEvaluated(true);
    monitor.shouldEvaluate(10, 1);
    monitor.noteEvaluated(false);
    expect(monitor.stats).toEqual({ samples: 2, triggers: 1 });
  });
});
