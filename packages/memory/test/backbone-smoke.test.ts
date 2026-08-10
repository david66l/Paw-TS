/**
 * Backbone 冒烟评测 harness 单测（spec v2 §11.5）
 *
 * 全 mock 无 DB：只测纯函数与配置解析。
 * 覆盖：summarizeSmoke 统计 / smokePassed 边界 / isUnverified / smokeProbe /
 * 报告渲染 / CLI 解析（smoke 子命令）/ fixture 合法性（密钥拦截 + trigram 三向重叠）。
 */

import { describe, test, expect } from "bun:test";
import {
  summarizeSmoke,
  smokePassed,
  smokeProbe,
  renderBackboneSmokeReport,
  SMOKE_FIXTURES,
  SMOKE_SCHEMA_RATE_MIN,
  SMOKE_RECALL_RATE_MIN,
  SMOKE_UNVERIFIED_MAX,
  type SmokeItemResult,
  type BackboneSmokeReport,
} from "../src/longterm/eval/backbone-smoke.js";
import { parseMemoryArgs } from "../src/longterm/cli.js";
import { scanForSecrets } from "../src/longterm/write/secrets.js";

// ═══════════════════════════════════════════════════════════════
// 测试助手
// ═══════════════════════════════════════════════════════════════

/** 构造 SmokeItemResult（默认 written 未召回） */
function item(partial: Partial<SmokeItemResult> & { fixtureId: string }): SmokeItemResult {
  return {
    status: "written",
    memoryIds: [],
    recalledByKeyword: false,
    recalledByQuery: false,
    detail: "",
    ...partial,
  };
}

/** 计算字符串的 3-gram 集合（对齐 NGramEmbeddingService 真实口径：lowercase + 非字母数字→空格保留进 gram） */
function trigrams(s: string): Set<string> {
  const normalized = s.toLowerCase().replace(/[^a-z0-9一-鿿]/g, " ");
  const out = new Set<string>();
  for (let i = 0; i <= normalized.length - 3; i++) out.add(normalized.slice(i, i + 3));
  return out;
}

function sharesTrigram(a: string, b: string): boolean {
  const ta = trigrams(a);
  for (const t of trigrams(b)) if (ta.has(t)) return true;
  return false;
}

// ═══════════════════════════════════════════════════════════════
// summarizeSmoke 统计与达标判定（§11.5）
// ═══════════════════════════════════════════════════════════════

describe("summarizeSmoke", () => {
  test("全 written 全 recalled → schema=1 keywordRecall=1 unverified=0 passed=true", () => {
    const items = ["a", "b", "c"].map((id) => item({ fixtureId: id, status: "written", memoryIds: [`m-${id}`], recalledByKeyword: true }));
    const s = summarizeSmoke(items);
    expect(s.schemaRate).toBe(1);
    expect(s.keywordRecall).toBe(1);
    expect(s.queryRecall).toBe(0); // 未设 query 命中
    expect(s.writtenOnlyRecall).toBe(1);
    expect(s.unverifiedRatio).toBe(0);
    expect(s.degradedPathOk).toBe(true);
    expect(s.passed).toBe(true);
  });

  test("4 条 degraded → unverified=0.4 超红线 → passed=false", () => {
    const items = [
      ...["a", "b", "c", "d", "e", "f"].map((id) => item({ fixtureId: id, status: "written", memoryIds: [`m-${id}`], recalledByKeyword: true })),
      ...["g", "h", "i", "j"].map((id) => item({ fixtureId: id, status: "degraded", memoryIds: [`d-${id}`] })),
    ];
    const s = summarizeSmoke(items);
    expect(s.schemaRate).toBeCloseTo(6 / 10);
    expect(s.unverifiedRatio).toBeCloseTo(4 / 10);
    expect(s.degradedPathOk).toBe(true);
    expect(s.passed).toBe(false);
  });

  test("schema 合格率不足（7 written 3 noop）→ passed=false", () => {
    const items = [
      ...["a", "b", "c", "d", "e", "f", "g"].map((id) => item({ fixtureId: id, status: "written", memoryIds: [`m-${id}`], recalledByKeyword: true })),
      ...["h", "i", "j"].map((id) => item({ fixtureId: id, status: "noop" })),
    ];
    const s = summarizeSmoke(items);
    expect(s.schemaRate).toBeCloseTo(0.7);
    expect(s.keywordRecall).toBeCloseTo(0.7); // 分母 10：noop 天然 miss
    expect(s.passed).toBe(false);
  });

  test("检索命中率不足（keyword 6/10）→ passed=false", () => {
    const items = [
      ...["a", "b", "c", "d", "e", "f"].map((id) => item({ fixtureId: id, status: "written", memoryIds: [`m-${id}`], recalledByKeyword: true })),
      ...["g", "h", "i", "j"].map((id) => item({ fixtureId: id, status: "written", memoryIds: [`m-${id}`], recalledByKeyword: false })),
    ];
    const s = summarizeSmoke(items);
    expect(s.keywordRecall).toBeCloseTo(0.6);
    expect(s.passed).toBe(false);
  });

  test("全 rejected/noop（无写入）→ unverified=null → passed=null", () => {
    const s = summarizeSmoke([item({ fixtureId: "a", status: "rejected" }), item({ fixtureId: "b", status: "noop" })]);
    expect(s.schemaRate).toBe(0);
    expect(s.unverifiedRatio).toBeNull();
    expect(s.passed).toBeNull();
  });

  test("空数组 → passed=null", () => {
    const s = summarizeSmoke([]);
    expect(s.schemaRate).toBe(0);
    expect(s.keywordRecall).toBe(0);
    expect(s.unverifiedRatio).toBeNull();
    expect(s.passed).toBeNull();
  });

  test("degraded 带/不带 memoryId → degradedPathOk 真/假", () => {
    const withId = summarizeSmoke([item({ fixtureId: "a", status: "degraded", memoryIds: ["d-a"] })]);
    expect(withId.degradedPathOk).toBe(true);
    const withoutId = summarizeSmoke([item({ fixtureId: "b", status: "degraded", memoryIds: [] })]);
    expect(withoutId.degradedPathOk).toBe(false);
    // 无 degraded → 真空成立
    expect(summarizeSmoke([item({ fixtureId: "c", status: "written", memoryIds: ["m"] })]).degradedPathOk).toBe(true);
  });

  test("writtenOnlyRecall 拆因：degraded 不挤占 written 分母", () => {
    const items = [
      item({ fixtureId: "a", status: "written", memoryIds: ["m-a"], recalledByKeyword: true }),
      item({ fixtureId: "b", status: "degraded", memoryIds: ["d-b"] }), // 天然 miss
    ];
    const s = summarizeSmoke(items);
    expect(s.keywordRecall).toBeCloseTo(0.5); // 分母 10 双惩罚
    expect(s.writtenOnlyRecall).toBe(1);      // 拆因：written 全命中
  });
});

describe("smokePassed 边界", () => {
  test("阈值恰好命中与跨越", () => {
    expect(smokePassed(SMOKE_SCHEMA_RATE_MIN, SMOKE_RECALL_RATE_MIN, SMOKE_UNVERIFIED_MAX - 0.01)).toBe(true);
    expect(smokePassed(0.79, 1, 0)).toBe(false);                       // schema 不足
    expect(smokePassed(1, 0.69, 0)).toBe(false);                       // recall 不足
    expect(smokePassed(1, 1, SMOKE_UNVERIFIED_MAX)).toBe(false);       // unverified 恰好红线（>= 判定）
    expect(smokePassed(1, 1, 0.29)).toBe(true);
    expect(smokePassed(1, 1, null)).toBeNull();                        // 无写入 → 无法判定
  });
});

// ═══════════════════════════════════════════════════════════════
// smokeProbe
// ═══════════════════════════════════════════════════════════════

describe("smokeProbe", () => {
  const f = SMOKE_FIXTURES[0]!;
  test("keyword 模式 join 关键词；query 模式返回自然语言查询", () => {
    expect(smokeProbe(f, "keyword")).toBe(f.keywords.join(" "));
    expect(smokeProbe(f, "query")).toBe(f.query);
  });
});

// ═══════════════════════════════════════════════════════════════
// 报告渲染（§11.5）
// ═══════════════════════════════════════════════════════════════

describe("renderBackboneSmokeReport", () => {
  const base: BackboneSmokeReport = {
    suite: "backbone-smoke",
    generatedAt: "2026-01-01T00:00:00.000Z",
    provider: "flash",
    passed: true,
    metrics: { 条目数: 10, "schema合格率": 1, "检索命中率(keyword)": 0.9, "unverified占比": 0 },
    details: [item({ fixtureId: "smoke-01", status: "written", memoryIds: ["m"], recalledByKeyword: true })],
    efficiency: { llmCalls: 22, retries: 1, failures: 0, totalMs: 5000, estimatedTokens: 8000, truncated: false },
    warnings: [],
  };

  test("达标 → ✅ 达标 + 效率指标 + 明细", () => {
    const text = renderBackboneSmokeReport(base);
    expect(text).toContain("✅ 达标");
    expect(text).toContain("LLM 调用 22 次");
    expect(text).toContain("smoke-01");
  });

  test("未达标 → ❌ 未达标 + readonly 提示（防静默腐蚀）", () => {
    const text = renderBackboneSmokeReport({ ...base, passed: false });
    expect(text).toContain("❌ 未达标");
    expect(text).toContain("memory readonly on");
  });

  test("无写入 → 无法判定 + 只读提示（passed!==true 一律 fail-closed）", () => {
    const text = renderBackboneSmokeReport({ ...base, passed: null, metrics: { 条目数: 0 } });
    expect(text).toContain("无法判定");
    expect(text).toContain("memory readonly on");
  });
});

// ═══════════════════════════════════════════════════════════════
// CLI 解析：memory smoke
// ═══════════════════════════════════════════════════════════════

describe("parseMemoryArgs smoke", () => {
  test("smoke --provider flash --json --keep --no-governed --auto-readonly", () => {
    const r = parseMemoryArgs(["smoke", "--provider", "flash", "--json", "--keep", "--no-governed", "--auto-readonly"]);
    if ("error" in r) throw new Error(r.error);
    expect(r.subcommand).toBe("smoke");
    expect(r.provider).toBe("flash");
    expect(r.json).toBe(true);
    expect(r.keep).toBe(true);
    expect(r.noGoverned).toBe(true);
    expect(r.autoReadonly).toBe(true);
  });

  test("smoke 进入允许列表（非未知子命令）；缺 provider 值报错；未知参数报错", () => {
    const ok = parseMemoryArgs(["smoke"]);
    expect("error" in ok).toBe(false);
    const badProvider = parseMemoryArgs(["smoke", "--provider"]);
    expect("error" in badProvider && badProvider.error).toContain("缺名称");
    const bogus = parseMemoryArgs(["smoke", "--bogus"]);
    expect("error" in bogus && bogus.error).toContain("未知参数");
  });
});

// ═══════════════════════════════════════════════════════════════
// fixture 合法性（防止写入管线拦截 / NGram 召回失效）
// ═══════════════════════════════════════════════════════════════

describe("SMOKE_FIXTURES 合法性", () => {
  test("id 唯一 / 字段非空 / keywords 非空", () => {
    expect(SMOKE_FIXTURES.length).toBe(10);
    const ids = SMOKE_FIXTURES.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const f of SMOKE_FIXTURES) {
      expect(f.id, f.id).toBeTruthy();
      expect(f.description, f.id).toBeTruthy();
      expect(f.goal.trim(), f.id).toBeTruthy();
      expect(f.trajectory.trim(), f.id).toBeTruthy();
      expect(f.query.trim(), f.id).toBeTruthy();
      expect(f.keywords.length, f.id).toBeGreaterThan(0);
    }
  });

  test("不触发密钥拦截（scanForSecrets 不 reject，否则整条被写入管线拦截）", () => {
    for (const f of SMOKE_FIXTURES) {
      const scan = scanForSecrets(`${f.goal}\n${f.trajectory}\n${f.query}\n${f.keywords.join(" ")}`);
      expect(scan.action, `${f.id} 触发密钥拦截: ${scan.action === "reject" ? scan.pattern : ""}`).not.toBe("reject");
    }
  });

  test("trigram 启发式：keyword 探针（joined）与 query 各自与 trajectory 共享 ≥1 个 3-gram（真实 embedding 口径）", () => {
    // 对齐真实机制（NGramEmbeddingService：lowercase + 非字母数字→空格保留进 gram）：
    // stored entry 的 embeddingKey 由 distiller 从 trajectory 蒸馏生成（fixture keywords 是
    // 探针而非入库内容）——所以约束是"探针 ↔ trajectory"在真实 gram 口径下词面重叠。
    // 这是启发式而非召回保证（蒸馏产物由 LLM 生成、可改写），但保证探针的独特技术名词
    // 逐字出现在轨迹里，蒸馏才可能保留并命中；smoke-03/09 的 keywords 为此用轨迹逐字
    // 出现的复合词（bun / 日志轮转）。
    for (const f of SMOKE_FIXTURES) {
      const kwProbe = f.keywords.join(" ");
      expect(sharesTrigram(kwProbe, f.trajectory), `${f.id} keyword 探针与 trajectory 无共享 trigram`).toBe(true);
      expect(sharesTrigram(f.query, f.trajectory), `${f.id} query 与 trajectory 无共享 trigram`).toBe(true);
    }
  });

  test("≥2 条轨迹含失败→成功转折（触发 failureFixPair 纪律，弱模型敏感性探针）", () => {
    const turned = SMOKE_FIXTURES.filter((f) => /失败|报错/.test(f.trajectory));
    expect(turned.length).toBeGreaterThanOrEqual(2);
  });
});
