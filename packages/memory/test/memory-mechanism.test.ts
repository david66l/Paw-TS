/**
 * 记忆机制验收套件 DB 集成测试（Trial → Gate → Profile → Cap）
 *
 *   DATABASE_URL="postgresql://postgres@127.0.0.1:54329/paw_memory_test" bun test test/memory-mechanism.test.ts
 */

import { describe, test, expect, afterAll } from "bun:test";
import { closeSql, ping } from "../src/db/connection.js";
import { resetMemoryV2Core } from "../src/runtime/index.js";
import {
  renderMechReport,
  runMechanismSuite,
  type MechReport,
} from "../src/longterm/eval/memory-mechanism-fixtures.js";

process.env.DATABASE_URL ??= "postgresql://postgres@127.0.0.1:54329/paw_memory_test";

const dbOk = await ping();
const it = dbOk ? test : test.skip;

afterAll(async () => {
  resetMemoryV2Core();
  await closeSql().catch(() => undefined);
});

describe("memory-mechanism fixtures（DB）", () => {
  it("四组全部通过、无 warning、无残留", async () => {
    resetMemoryV2Core();
    const report = await runMechanismSuite({ keep: false });
    if (!report.passed) {
      console.error(renderMechReport(report));
    }
    expect(report.passed).toBe(true);
    expect(report.warnings.filter((w) => w.startsWith("残留")).length).toBe(0);
    expect(report.metrics["trial通过"]).toBe(1);
    expect(report.metrics["gate通过"]).toBe(1);
    expect(report.metrics["profile通过"]).toBe(1);
    expect(report.metrics["cap通过"]).toBe(1);
    expect(report.details.every((d) => d.passed)).toBe(true);
  }, 120_000);

  it("可按套件过滤（仅 profile）", async () => {
    const report = await runMechanismSuite({ suites: ["profile"], keep: false });
    expect(report.details.length).toBeGreaterThan(0);
    expect(report.details.every((d) => d.suite === "profile")).toBe(true);
    expect(report.passed).toBe(true);
  }, 60_000);
});

describe("renderMechReport", () => {
  test("渲染含判定行", () => {
    const r: MechReport = {
      suite: "memory-mechanism",
      generatedAt: "2026-08-10T00:00:00.000Z",
      passed: true,
      mode: "fake",
      metrics: { 用例数: 1 },
      details: [
        {
          id: "x",
          suite: "trial",
          passed: true,
          assertions: [{ name: "a", ok: true }],
          writes: [],
          injectStatuses: [],
          graduatedIds: [],
          invalidatedIds: [],
          warnings: [],
          ms: 1,
        },
      ],
      efficiency: { llmCalls: 0, totalMs: 1, wallMs: 1 },
      residual: { memoryItems: 0, trials: 0, opLogs: 0 },
      warnings: [],
    };
    expect(renderMechReport(r)).toContain("✅");
  });
});
