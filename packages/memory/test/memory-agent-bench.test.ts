/**
 * MemoryAgentBench adapter 单测（§11.3.1 P0）
 *
 * 全 mock 无 DB：打分 / 切 chunk / 汇总 / 加载 / 报告。
 */

import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  normalizeAnswer,
  scorePrediction,
  chunkText,
  extractKeywords,
  normalizeMabRecord,
  loadMabSamplesFromFile,
  filterMabSamples,
  summarizeMab,
  sfSuppressionRate,
  renderMabReport,
  BUILTIN_CODING_FIXTURES,
  type MabQaResult,
  type MabReport,
} from "../src/longterm/eval/memory-agent-bench.js";

describe("normalizeAnswer / scorePrediction", () => {
  test("去冠词标点后 substring / exact", () => {
    expect(normalizeAnswer("The Bun Run Build!")).toBe("bun run build");
    expect(scorePrediction("用 bun run build 即可", ["bun run build"], "substring_exact_match")).toBe(true);
    expect(scorePrediction("label: 43", ["43"], "exact_match")).toBe(false);
    expect(scorePrediction("43", ["43"], "exact_match")).toBe(true);
    expect(scorePrediction("不知道", ["bun test"], "substring_exact_match")).toBe(false);
  });
});

describe("chunkText", () => {
  test("短文不切；长文按预算切开且非空", () => {
    expect(chunkText("hello", 100)).toEqual(["hello"]);
    const long = "第一句。".repeat(80) + "\n" + "第二段内容。".repeat(80);
    const chunks = chunkText(long, 100);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length > 0)).toBe(true);
    expect(chunks.join("").replace(/\s/g, "").length).toBeGreaterThan(100);
  });
});

describe("extractKeywords", () => {
  test("抽出拉丁词与中文二字以上", () => {
    const ks = extractKeywords("bun run build 构建命令 vitest");
    expect(ks.some((k) => k.includes("bun") || k === "bun")).toBe(true);
    expect(ks.length).toBeGreaterThan(0);
    expect(ks.length).toBeLessThanOrEqual(16);
  });
});

describe("BUILTIN_CODING_FIXTURES", () => {
  test("覆盖五维且 context 足够长、含 SF current+historical", () => {
    const dims = new Set(BUILTIN_CODING_FIXTURES.map((s) => s.dimension));
    expect([...dims].sort()).toEqual(["AR", "CR", "LRU", "SF", "TTL"]);
    for (const s of BUILTIN_CODING_FIXTURES) {
      expect(s.context.length).toBeGreaterThan(2000);
      expect(s.qa.length).toBeGreaterThan(0);
    }
    const sf = BUILTIN_CODING_FIXTURES.find((s) => s.dimension === "SF")!;
    expect(sf.qa.some((q) => q.sfMode === "current" && q.oldFactNeedle)).toBe(true);
    expect(sf.qa.some((q) => q.sfMode === "historical")).toBe(true);
  });
});

describe("normalizeMabRecord / loadMabSamplesFromFile", () => {
  test("扁平 MabSample 与 HF 形状", () => {
    const flat = normalizeMabRecord({
      id: "x",
      dimension: "AR",
      source: "event_qa",
      context: "x".repeat(50),
      qa: [{ id: "q0", question: "Q?", answers: ["A"] }],
      metric: "substring_exact_match",
    });
    expect(flat?.id).toBe("x");
    expect(flat?.qa[0]?.answers).toEqual(["A"]);

    const hf = normalizeMabRecord(
      {
        dimension: "Accurate_Retrieval",
        context: "y".repeat(50),
        questions: ["What?"],
        answers: [["yes"]],
        metadata: { source: "event_qa", qa_pair_ids: ["p1"] },
      },
      0,
    );
    expect(hf?.dimension).toBe("AR");
    expect(hf?.qa[0]?.id).toBe("p1");
    expect(hf?.source).toBe("event_qa");
  });

  test("JSON / JSONL / data 包装 + filter", () => {
    const dir = mkdtempSync(join(tmpdir(), "paw-mab-"));
    try {
      const arr = join(dir, "a.json");
      writeFileSync(
        arr,
        JSON.stringify([
          {
            id: "a1",
            dimension: "AR",
            source: "t",
            context: "c".repeat(40),
            qa: [{ id: "q", question: "Q", answers: ["A"] }],
          },
          {
            id: "t1",
            dimension: "TTL",
            source: "t",
            context: "c".repeat(40),
            qa: [{ id: "q", question: "Q", answers: ["B"] }],
          },
        ]),
      );
      expect(loadMabSamplesFromFile(arr)).toHaveLength(2);
      expect(filterMabSamples(loadMabSamplesFromFile(arr), { dimensions: ["AR"] })).toHaveLength(1);

      const wrapped = join(dir, "w.json");
      writeFileSync(wrapped, JSON.stringify({ data: [{ dimension: "CR", context: "z".repeat(40), questions: ["q"], answers: ["a"], metadata: { source: "fact_mh" } }] }));
      expect(loadMabSamplesFromFile(wrapped)[0]?.dimension).toBe("CR");

      const jsonl = join(dir, "x.jsonl");
      writeFileSync(
        jsonl,
        JSON.stringify({
          dimension: "SF",
          context: "w".repeat(40),
          questions: ["now?"],
          answers: ["vitest"],
          source: "coding_sf",
          sfMode: "current",
          oldFactNeedle: "jest",
        }) + "\n",
      );
      const sf = loadMabSamplesFromFile(jsonl)[0]!;
      expect(sf.dimension).toBe("SF");
      expect(sf.qa[0]?.sfMode).toBe("current");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("summarizeMab / sfSuppressionRate / render", () => {
  test("Δ 与 SF 抑制达标判定（正增益 + 配对 wins>losses）", () => {
    const items: MabQaResult[] = [
      { sampleId: "a", qaId: "1", dimension: "AR", memoryOn: true, correct: true, answerSnippet: "x", recalled: true, warnings: [] },
      { sampleId: "a", qaId: "1", dimension: "AR", memoryOn: false, correct: false, answerSnippet: "?", recalled: false, warnings: [] },
      {
        sampleId: "s",
        qaId: "c",
        dimension: "SF",
        memoryOn: true,
        correct: true,
        answerSnippet: "vitest",
        recalled: true,
        oldFactSuppressed: true,
        warnings: [],
      },
      {
        sampleId: "s",
        qaId: "c",
        dimension: "SF",
        memoryOn: false,
        correct: false,
        answerSnippet: "?",
        recalled: false,
        warnings: [],
      },
    ];
    const s = summarizeMab(items);
    expect(s.byDim.AR.delta).toBe(1);
    expect(s.sfSuppression).toBe(1);
    expect(s.paired.wins).toBe(2);
    expect(s.paired.losses).toBe(0);
    expect(s.meanDelta).toBeGreaterThan(0);
    expect(s.passed).toBe(true);
    expect(sfSuppressionRate(items)).toBe(1);

    const bad = summarizeMab([
      ...items,
      {
        sampleId: "s2",
        qaId: "c",
        dimension: "SF",
        memoryOn: true,
        correct: true,
        answerSnippet: "jest",
        recalled: true,
        oldFactSuppressed: false,
        warnings: [],
      },
      {
        sampleId: "s2",
        qaId: "c",
        dimension: "SF",
        memoryOn: false,
        correct: false,
        answerSnippet: "?",
        recalled: false,
        warnings: [],
      },
    ]);
    expect(bad.sfSuppression).toBe(0.5);
    expect(bad.passed).toBe(false);
  });

  test("零增益（meanΔ=0）或配对不占优 → 不达标", () => {
    const zero: MabQaResult[] = [
      { sampleId: "a", qaId: "1", dimension: "AR", memoryOn: true, correct: true, answerSnippet: "x", recalled: true, warnings: [] },
      { sampleId: "a", qaId: "1", dimension: "AR", memoryOn: false, correct: true, answerSnippet: "x", recalled: false, warnings: [] },
    ];
    const z = summarizeMab(zero);
    expect(z.meanDelta).toBe(0);
    expect(z.paired.wins).toBe(0);
    expect(z.paired.ties).toBe(1);
    expect(z.passed).toBe(false);

    const loss: MabQaResult[] = [
      { sampleId: "a", qaId: "1", dimension: "AR", memoryOn: true, correct: false, answerSnippet: "?", recalled: true, warnings: [] },
      { sampleId: "a", qaId: "1", dimension: "AR", memoryOn: false, correct: true, answerSnippet: "x", recalled: false, warnings: [] },
    ];
    expect(summarizeMab(loss).passed).toBe(false);
  });

  test("renderMabReport 含分项 Δ 与配对行", () => {
    const r: MabReport = {
      suite: "memory-agent-bench",
      generatedAt: "2026-08-10T00:00:00.000Z",
      passed: true,
      metrics: { 平均Δ: 0.5, SF旧事实抑制率: 1 },
      deltas: { AR: 0.5, SF: 0.25 },
      paired: {
        nPairs: 4,
        wins: 3,
        losses: 0,
        ties: 1,
        pairedAdvantage: 0.75,
        winRateAmongDecisive: 1,
        signTestP: 0.125,
      },
      details: [],
      efficiency: { llmCalls: 2, retries: 0, failures: 0, totalMs: 10, estimatedTokens: 100, truncated: false },
      warnings: [],
    };
    const text = renderMabReport(r);
    expect(text).toContain("✅");
    expect(text).toContain("AR: 0.500");
    expect(text).toContain("wins=3");
  });
});

describe("computePairedStats / binomialSignTestP / HF cache", () => {
  test("配对与符号检验", async () => {
    const { computePairedStats, binomialSignTestP, loadOrFetchMabHf, loadMabSamplesFromHfCache } =
      await import("../src/longterm/eval/memory-agent-bench.js");
    expect(binomialSignTestP(3, 0)).toBeCloseTo(0.125, 5);
    expect(binomialSignTestP(0, 0)).toBeNull();

    const paired = computePairedStats([
      { sampleId: "a", qaId: "1", dimension: "AR", memoryOn: true, correct: true, answerSnippet: "", recalled: true, warnings: [] },
      { sampleId: "a", qaId: "1", dimension: "AR", memoryOn: false, correct: false, answerSnippet: "", recalled: false, warnings: [] },
      { sampleId: "b", qaId: "1", dimension: "AR", memoryOn: true, correct: false, answerSnippet: "", recalled: true, warnings: [] },
      { sampleId: "b", qaId: "1", dimension: "AR", memoryOn: false, correct: true, answerSnippet: "", recalled: false, warnings: [] },
    ]);
    expect(paired).toMatchObject({ wins: 1, losses: 1, ties: 0, nPairs: 2 });
    expect(paired.winRateAmongDecisive).toBe(0.5);

    const {
      loadMabSamplesFromParquetDir,
      subsampleChunks,
      subsampleChunksForQuery,
    } = await import("../src/longterm/eval/memory-agent-bench.js");
    expect(subsampleChunks(["a", "b", "c", "d", "e"], 3)).toEqual(["a", "c", "e"]);

    const corpus = [
      "noise about weather and traffic reports forever",
      "the secret password is orchid-42 for vault access",
      "more noise padding with unrelated cooking recipes",
      "orchid-42 appears again near the vault door latch",
      "random filler about sports scores and movies",
    ];
    const picked = subsampleChunksForQuery(corpus, 3, ["What is the vault password orchid?"]);
    expect(picked.some((c) => c.includes("orchid-42"))).toBe(true);
    expect(picked.length).toBeLessThanOrEqual(3);

    const parquetDir = join(
      import.meta.dir,
      "../../../benchmarks/memory-agent-bench/hf-dataset/data",
    );
    if (existsSync(parquetDir)) {
      const fromPq = await loadMabSamplesFromParquetDir(parquetDir, {
        splits: ["Conflict_Resolution"],
      });
      expect(fromPq.length).toBe(8);
      expect(fromPq[0]?.dimension).toBe("CR");
      expect(fromPq[0]?.qa.length).toBeGreaterThan(0);
    }

    const dir = mkdtempSync(join(tmpdir(), "paw-mab-hf-"));
    try {
      writeFileSync(
        join(dir, "Accurate_Retrieval.json"),
        JSON.stringify([
          {
            context: "c".repeat(40),
            questions: ["Q?"],
            answers: [["A"]],
            metadata: { source: "event_qa", qa_pair_ids: ["p0"] },
          },
        ]),
      );
      const cached = loadMabSamplesFromHfCache(dir, { splits: ["Accurate_Retrieval"] });
      expect(cached).toHaveLength(1);
      expect(cached[0]?.dimension).toBe("AR");

      const fakeFetch: typeof fetch = async () =>
        new Response(JSON.stringify({ error: "offline" }), { status: 503 });
      const loaded = await loadOrFetchMabHf({
        cacheDir: dir,
        splits: ["Accurate_Retrieval", "Conflict_Resolution"],
        fetchImpl: fakeFetch,
      });
      expect(loaded.samples.length).toBeGreaterThanOrEqual(1);
      expect(loaded.bySplit.Accurate_Retrieval).toBe(1);
      expect(loaded.warnings.some((w) => w.includes("Conflict_Resolution"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("shouldInvalidateForSf / injectionForSfMode", () => {
  test("纯旧失效；含新答案保留；current 只用活跃文本", async () => {
    const {
      shouldInvalidateForSf,
      injectionForSfMode,
    } = await import("../src/longterm/eval/memory-agent-bench.js");
    expect(shouldInvalidateForSf("2023 用 jest", "jest", ["vitest"])).toBe(true);
    expect(shouldInvalidateForSf("迁移到 vitest，jest 已移除", "jest", ["vitest"])).toBe(false);
    expect(shouldInvalidateForSf("只用 bun", "jest", ["vitest"])).toBe(false);

    const shaped = injectionForSfMode(
      "full",
      [
        { text: "vitest now" },
        { text: "old jest", tInvalid: "2025-01-01" },
      ],
      "current",
    );
    expect(shaped.activeTexts).toEqual(["vitest now"]);
    expect(shaped.text).toContain("vitest");
    expect(shaped.text).not.toContain("jest");
  });
});

describe("parseMemoryArgs mab", () => {
  test("解析 --builtin / --hf / --data / --dimension / --chunk-size", async () => {
    const { parseMemoryArgs } = await import("../src/longterm/cli.js");
    const r = parseMemoryArgs([
      "mab",
      "--builtin",
      "--hf",
      "--hf-cache",
      "./hf-cache",
      "--hf-force",
      "--data",
      "x.json",
      "--dimension",
      "AR,SF",
      "--chunk-size",
      "256",
      "--provider",
      "flash",
      "--json",
      "--max-samples",
      "2",
    ]);
    expect(r).toEqual({
      subcommand: "mab",
      builtin: true,
      hf: true,
      hfCache: "./hf-cache",
      hfForce: true,
      data: "x.json",
      dimensions: "AR,SF",
      chunkSize: 256,
      provider: "flash",
      json: true,
      maxSamples: 2,
    });
    expect("error" in parseMemoryArgs(["mab", "--chunk-size", "0"])).toBe(true);
    expect("error" in parseMemoryArgs(["enable", "on"])).toBe(false);
  });
});
