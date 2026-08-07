/**
 * 红队第二层：扰动评测 harness 单测（spec v2 §11.4）
 *
 * 全 mock 无 DB：judge/backbone 全部 mock，只测纯函数与配置解析。
 * 覆盖：判定解析 / 保守合成 / 预算护栏 / 三套件统计与达标判定 /
 * 报告渲染 / LLM 配置解析 / settings 文件查找 / fixture 合法性（validateCandidate）。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseVerdict,
  conservativeMerge,
  LlmBudget,
  renderRedteamReport,
  summarizeCounterfactual,
  summarizeJudgeRates,
  noisePassed,
  summarizeNegation,
  COUNTERFACTUAL_FIXTURES,
  NOISE_FIXTURES,
  NOISE_POLLUTANTS,
  NEGATION_FIXTURES,
  type CfItemResult,
  type NegationItemResult,
  type RedteamReport,
} from "../src/longterm/eval/perturbation.js";
import { resolveLlmConfig, findSettingsFile } from "../src/longterm/eval/llm-client.js";
import { validateCandidate } from "../src/longterm/write/distiller.js";

// ═══════════════════════════════════════════════════════════════
// 判定解析 + 保守合成（§11.6）
// ═══════════════════════════════════════════════════════════════

describe("parseVerdict", () => {
  test("合法 JSON / 容忍前后废话 / 非法返回 null", () => {
    expect(parseVerdict('{"verdict":"corrected","reason":"ok"}', ["corrected", "uncorrected"] as const))
      .toEqual({ verdict: "corrected", reason: "ok" });
    expect(parseVerdict('前面废话 {"verdict":"uncorrected","reason":"r"} 后面', ["corrected", "uncorrected"] as const)?.verdict)
      .toBe("uncorrected");
    expect(parseVerdict('{"verdict":"maybe"}', ["corrected", "uncorrected"] as const)).toBeNull();
    expect(parseVerdict("不是 JSON", ["corrected", "uncorrected"] as const)).toBeNull();
    expect(parseVerdict('{"verdict":"kept","reason":"r"}', ["kept", "reversed"] as const)?.verdict).toBe("kept");
  });
});

describe("conservativeMerge", () => {
  test("保守档优先：任一坏档即该档；单边 unjudged 用另一边；都不判定", () => {
    const bad = ["uncorrected"] as const;
    expect(conservativeMerge("corrected", "corrected", bad))
      .toEqual({ v1: "corrected", v2: "corrected", final: "corrected", inconsistent: false });
    // 任一坏档 → final 取坏档，且标记不一致
    expect(conservativeMerge("uncorrected", "corrected", bad).final).toBe("uncorrected");
    expect(conservativeMerge("corrected", "uncorrected", bad).final).toBe("uncorrected");
    expect(conservativeMerge("corrected", "uncorrected", bad).inconsistent).toBe(true);
    // 单边 unjudged 用另一边
    expect(conservativeMerge("corrected", "unjudged", bad).final).toBe("corrected");
    expect(conservativeMerge("unjudged", "uncorrected", bad).final).toBe("uncorrected");
    // 都 unjudged
    expect(conservativeMerge("unjudged", "unjudged", bad).final).toBe("unjudged");
  });
});

describe("LlmBudget", () => {
  test("超预算抛错并计数", async () => {
    const b = new LlmBudget(2);
    const llm = b.wrap({ complete: async () => "x" });
    expect(await llm.complete("a")).toBe("x");
    expect(await llm.complete("b")).toBe("x");
    expect(b.used).toBe(2);
    await expect(llm.complete("c")).rejects.toThrow("llm_budget_exceeded");
    expect(b.used).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════
// 三套件统计与达标判定
// ═══════════════════════════════════════════════════════════════

describe("summarizeCounterfactual", () => {
  const mk = (id: string, recalled: boolean, final: string, inconsistent = false): CfItemResult =>
    ({ id, recalled, v1: final, v2: final, final, inconsistent, answerSnippet: "" });

  test("纠正率 ≥80% 达标；未召回计入召回率不计入纠正率分母", () => {
    const all = [mk("a", true, "corrected"), mk("b", true, "corrected"), mk("c", true, "uncorrected"), mk("d", true, "corrected")];
    const s = summarizeCounterfactual(all);
    expect(s.recallRate).toBe(1);
    expect(s.correctionRate).toBe(0.75);
    expect(s.passed).toBe(false);

    const ok = summarizeCounterfactual([mk("a", true, "corrected"), mk("b", true, "corrected"), mk("c", true, "corrected"), mk("d", true, "corrected")]);
    expect(ok.correctionRate).toBe(1);
    expect(ok.passed).toBe(true);

    // 未召回不计入纠正率分母，但计入召回率
    const mixed = summarizeCounterfactual([mk("a", true, "corrected"), mk("b", false, "unjudged")]);
    expect(mixed.recallRate).toBe(0.5);
    expect(mixed.correctionRate).toBe(1);
    expect(mixed.passed).toBe(true);

    // 无已判定样本 → passed null
    expect(summarizeCounterfactual([mk("a", false, "unjudged")]).passed).toBeNull();
    expect(summarizeCounterfactual([]).correctionRate).toBeNull();
  });
});

describe("summarizeJudgeRates / noisePassed", () => {
  test("helpful/harmful 比率与 Δ 阈值（<5 个百分点）", () => {
    const r = summarizeJudgeRates([
      { final: "helpful" }, { final: "helpful" }, { final: "harmful" },
      { final: "neutral" }, { final: "unjudged" },
    ]);
    expect(r.judged).toBe(4);
    expect(r.helpfulRate).toBe(0.5);
    expect(r.harmfulRate).toBe(0.25);
    expect(summarizeJudgeRates([{ final: "unjudged" }]).helpfulRate).toBeNull();

    expect(noisePassed(0.9, 0.87)).toBe(true);  // 降幅 0.03 < 0.05
    expect(noisePassed(0.9, 0.84)).toBe(false); // 降幅 0.06 ≥ 0.05
    expect(noisePassed(null, 0.8)).toBeNull();
    expect(noisePassed(0.8, null)).toBeNull();
  });
});

describe("summarizeNegation", () => {
  const mk = (id: string, recalled: boolean, verbatim: boolean, final: string): NegationItemResult =>
    ({ id, recalled, verbatim, v1: final, v2: final, final, inconsistent: false, answerSnippet: "" });

  test("保持率 / 注入保真率 / 100% 达标", () => {
    const all = [mk("a", true, true, "kept"), mk("b", true, false, "kept"), mk("c", true, true, "reversed")];
    const s = summarizeNegation(all);
    expect(s.keptRate).toBeCloseTo(2 / 3);
    expect(s.verbatimRate).toBeCloseTo(2 / 3);
    expect(s.passed).toBe(false); // 有一条 reversed

    const perfect = summarizeNegation([mk("a", true, true, "kept"), mk("b", true, true, "kept")]);
    expect(perfect.keptRate).toBe(1);
    expect(perfect.passed).toBe(true);

    expect(summarizeNegation([mk("a", false, false, "unjudged")]).passed).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// 报告渲染（§11.6 效率指标）
// ═══════════════════════════════════════════════════════════════

describe("renderRedteamReport", () => {
  const base: RedteamReport = {
    suite: "counterfactual",
    generatedAt: "2026-01-01T00:00:00.000Z",
    passed: true,
    metrics: { 条目数: 5, 召回率: 0.8, 纠正率: 1, 判定不一致: 0 },
    details: [{ id: "cf-1", 召回: true, v1: "corrected", v2: "corrected", 最终: "corrected", 回答: "bun run build" }],
    efficiency: { llmCalls: 12, retries: 1, failures: 0, totalMs: 3000, estimatedTokens: 4000, truncated: false },
    warnings: [],
  };

  test("含达标判定 / 效率指标 / 明细", () => {
    const text = renderRedteamReport(base);
    expect(text).toContain("✅ 达标");
    expect(text).toContain("LLM 调用 12 次");
    expect(text).toContain("cf-1");
  });

  test("样本不足与预算截断提示", () => {
    const t = renderRedteamReport({ ...base, passed: null, efficiency: { ...base.efficiency, truncated: true } });
    expect(t).toContain("样本不足");
    expect(t).toContain("预算截断");
  });
});

// ═══════════════════════════════════════════════════════════════
// LLM 配置解析（llm-client.ts）
// ═══════════════════════════════════════════════════════════════

describe("resolveLlmConfig", () => {
  // resolveLlmConfig 会真实 findSettingsFile(cwd)，故用真实临时目录做配置解析
  let dir: string;
  const writeSettings = (content: string) => {
    mkdirSync(join(dir, ".paw"), { recursive: true });
    writeFileSync(join(dir, ".paw", "settings.local.json"), content);
  };
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "paw-llmcfg-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("优先级：CLI provider > settings 默认 > 环境变量", () => {
    writeSettings(JSON.stringify({
      provider: "default-p",
      models: {
        "default-p": { baseUrl: "https://a", model: "m1" },
        flash: { baseUrl: "https://b", model: "m2", apiKey: "k" },
      },
    }));
    // CLI 显式 provider
    const r1 = resolveLlmConfig({ provider: "flash", cwd: dir });
    if ("error" in r1) throw new Error(r1.error);
    expect(r1.providerName).toBe("flash");
    expect(r1.apiKey).toBe("k");
    expect(r1.baseUrl).toBe("https://b");
    // settings 默认 provider
    const r2 = resolveLlmConfig({ cwd: dir });
    if ("error" in r2) throw new Error(r2.error);
    expect(r2.providerName).toBe("default-p");
    // 无 settings 时回退环境变量（先删掉 settings 文件）
    rmSync(join(dir, ".paw"), { recursive: true, force: true });
    const r3 = resolveLlmConfig({ cwd: dir, env: { OPENAI_BASE_URL: "https://e", OPENAI_API_KEY: "ek", OPENAI_MODEL: "em" } });
    if ("error" in r3) throw new Error(r3.error);
    expect(r3.baseUrl).toBe("https://e");
    expect(r3.model).toBe("em");
  });

  test("未知 provider / 完全无配置 → 报错（不抛异常）", () => {
    writeSettings(JSON.stringify({ provider: "default-p", models: { flash: { baseUrl: "https://b", model: "m2" } } }));
    const r4 = resolveLlmConfig({ provider: "nope", cwd: dir, env: {} });
    expect("error" in r4 && r4.error).toContain("nope");
    const r5 = resolveLlmConfig({ cwd: dir, env: {} });
    expect("error" in r5).toBe(true);
  });

  test("settings 解析失败报错（不抛异常）", () => {
    writeSettings("{bad json");
    const r = resolveLlmConfig({ provider: "flash", cwd: dir, env: {} });
    expect("error" in r && r.error).toContain("解析失败");
  });
});

describe("findSettingsFile", () => {
  test("从 startDir 向上找 ≤4 层；超过返回 null", () => {
    const dir = mkdtempSync(join(tmpdir(), "paw-redteam-"));
    try {
      mkdirSync(join(dir, "a", "b", ".paw"), { recursive: true });
      writeFileSync(join(dir, "a", "b", ".paw", "settings.local.json"), "{}");

      // b/.paw 在 startDir=c 的第 1 层 → 找到
      expect(findSettingsFile(join(dir, "a", "b", "c"), 4)).toBe(join(dir, "a", "b", ".paw", "settings.local.json"));
      // b/.paw 距 startDir 第 5 层（超出 maxUp=4）→ null
      expect(findSettingsFile(join(dir, "a", "b", "c", "d", "e", "f", "g"), 4)).toBeNull();
      // startDir 无 .paw 且无父级 → null
      expect(findSettingsFile(dir, 4)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// fixture 合法性：全部须过 validateCandidate（否则种子被写入管线拦截）
// ═══════════════════════════════════════════════════════════════

describe("fixture 合法性", () => {
  test("全部夹具过 validateCandidate（防止去具体化/体量校验误伤）", () => {
    for (const f of COUNTERFACTUAL_FIXTURES) {
      const v = validateCandidate({ kind: "semantic", fact: f.falseMemory, keywords: f.keywords, evidence: ["runs/redteam#s0"] });
      expect(v.ok, `cf ${f.id}: ${v.ok ? "" : v.errors.join(";")}`).toBe(true);
    }
    for (const f of NEGATION_FIXTURES) {
      const v = validateCandidate({ kind: "semantic", fact: f.memory, keywords: f.keywords, evidence: ["runs/redteam#s0"] });
      expect(v.ok, `ng ${f.id}: ${v.ok ? "" : v.errors.join(";")}`).toBe(true);
    }
    for (const f of NOISE_FIXTURES) {
      const v = validateCandidate({ kind: "episodic", whenToUse: f.whenToUse, perspective: f.perspective, modification: f.modification, evidence: ["runs/redteam#s0"] });
      expect(v.ok, `nz ${f.taskId}: ${v.ok ? "" : v.errors.join(";")}`).toBe(true);
    }
    for (const p of NOISE_POLLUTANTS) {
      const v = validateCandidate({ kind: "episodic", whenToUse: p.whenToUse, perspective: p.perspective, modification: p.modification, evidence: ["runs/redteam#s0"] });
      expect(v.ok, `pollutant: ${v.ok ? "" : v.errors.join(";")}`).toBe(true);
    }
  });

  test("episodic 夹具 whenToUse 均以 When 开头（T1 episodic 检索主键纪律）", () => {
    for (const f of NOISE_FIXTURES) expect(f.whenToUse.startsWith("When"), f.taskId).toBe(true);
    for (const p of NOISE_POLLUTANTS) expect(p.whenToUse.startsWith("When")).toBe(true);
  });
});
