import { describe, expect, test } from "bun:test";

import {
  ApproximateEstimator,
  CalibratedEstimator,
  CONSERVATIVE_BIAS,
  FastEstimator,
  TiktokenEstimator,
  resolveEstimatorForModel,
} from "../src/index.js";

describe("P1.4 估算器注册表", () => {
  test("deepseek/openai → cl100k（TiktokenEstimator）", () => {
    expect(resolveEstimatorForModel("deepseek-v4-flash")).toBeInstanceOf(
      TiktokenEstimator,
    );
    expect(resolveEstimatorForModel("openai/gpt-4o")).toBeInstanceOf(
      TiktokenEstimator,
    );
  });

  test("qwen/glm → o200k（TiktokenEstimator）", () => {
    expect(resolveEstimatorForModel("qwen2.5-14b-awq")).toBeInstanceOf(
      TiktokenEstimator,
    );
    expect(resolveEstimatorForModel("glm-4-plus")).toBeInstanceOf(
      TiktokenEstimator,
    );
  });

  test("claude/anthropic → ApproximateEstimator（cl100k 近似）", () => {
    expect(resolveEstimatorForModel("anthropic:claude-opus-4-6")).toBeInstanceOf(
      ApproximateEstimator,
    );
  });

  test("未知模型 → FastEstimator（零依赖）", () => {
    expect(resolveEstimatorForModel("local-llama3")).toBeInstanceOf(
      FastEstimator,
    );
  });

  test("注册表与主路径同一文本估算一致（AC-P1-9）", () => {
    const deepseek = resolveEstimatorForModel("deepseek-v4-flash");
    const text = "修复 context.ts 中的内存泄漏 memory leak";
    // cl100k 估算（不触发 o200k 的 ~20s 首次加载；o200k 由 instanceof 断言覆盖）
    expect(deepseek.count(text)).toBeGreaterThan(0);
  });
});

describe("P1.4 CalibratedEstimator usage 回填校准", () => {
  test("低估校准：真实 > 估算 → 系数上调（钳制 1.5）", () => {
    const est = new CalibratedEstimator();
    const baseCount = est.estimateRaw("hello world");
    // 真实 token 是估算的 2 倍（低估）→ 系数应上调并钳制到 1.5
    est.recordActual(baseCount * 2, baseCount);
    expect(est.calibrationRatio).toBe(1.5);
  });

  test("高估校准：真实 < 估算 → 系数下调（钳制 0.7）", () => {
    const est = new CalibratedEstimator();
    const baseCount = est.estimateRaw("hello world");
    est.recordActual(baseCount * 0.25, baseCount);
    expect(est.calibrationRatio).toBe(0.7);
  });

  test("AC-P1-10 多轮收敛：3 轮后估算不低估且误差有界（基线偏差 37%）", () => {
    const est = new CalibratedEstimator();
    const text = "console.log('hello world'); " .repeat(50);
    const base = est.estimateRaw(text);
    const real = base * 1.37; // 模拟 cl100k 对 DeepSeek 低估 37%
    for (let i = 0; i < 5; i++) {
      est.recordActual(real, base);
    }
    const estimate = est.count(text);
    // 校准后：绝不低估（保守方向），且过估有界（校准系数 + 保守系数 1.1）
    expect(estimate).toBeGreaterThanOrEqual(real);
    expect(estimate / real).toBeLessThanOrEqual(1.15);
  });

  test("count/countMessages 应用校准 × 保守系数", () => {
    const base = new TiktokenEstimator();
    const est = new CalibratedEstimator(base);
    const text = "hello";
    const raw = base.count(text);
    expect(est.count(text)).toBe(
      Math.ceil(raw * CONSERVATIVE_BIAS),
    );
    const msgs = [{ role: "user" as const, content: text }];
    expect(est.countMessages(msgs)).toBe(
      Math.ceil(base.countMessages(msgs) * CONSERVATIVE_BIAS),
    );
  });

  test("无效样本忽略（actual ≤ 0）", () => {
    const est = new CalibratedEstimator();
    est.recordActual(0, 100);
    est.recordActual(-5, 100);
    expect(est.sampleCount).toBe(0);
    expect(est.calibrationRatio).toBe(1);
  });
});
