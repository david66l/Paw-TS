/**
 * SWE-Exp pairing tests — 纯函数 + fake 协议 +（可选）deterministic DB
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { closeSql } from "@paw/memory/db";

import {
  SWE_EXP_BUILTIN_PAIRS,
  type SweExpPairResult,
  type SweInstance,
  armOutcome,
  assertNoGoldLeak,
  buildSameRepoPairs,
  buildSweAcceptanceCriteria,
  buildSweAgentGoal,
  distillHistoryLesson,
  harnessPythonArgs,
  lessonGoalOverlap,
  mergeExternalResolveResults,
  officialHarnessArgs,
  parseResolvedFromHarnessOutput,
  runSweExpAgent,
  runSweExpBuiltin,
  statementSimilarity,
  summarizeLifecycleGates,
  summarizeSweExp,
  sweExpPassed,
  writeJsonAtomic,
} from "../src/swe-exp/index.js";

describe("statementSimilarity / buildSameRepoPairs", () => {
  test("Jaccard 同文=1，无关≈0", () => {
    expect(
      statementSimilarity("fix add overflow bug", "fix add overflow bug"),
    ).toBe(1);
    expect(statementSimilarity("alpha beta gamma", "zzzz yyyy xxxx")).toBe(0);
  });

  test("同 repo 产出不重复 probe/history 对", () => {
    const instances: SweInstance[] = [
      {
        instance_id: "demo__a-1",
        repo: "demo/a",
        problem_statement:
          "Fix the cache invalidation when tokens rotate after deploy",
      },
      {
        instance_id: "demo__a-2",
        repo: "demo/a",
        problem_statement:
          "Fix cache invalidation tokens rotate during deploy window",
      },
      {
        instance_id: "demo__a-3",
        repo: "demo/a",
        problem_statement: "Unrelated documentation typo in README only",
      },
      {
        instance_id: "other__1",
        repo: "other/b",
        problem_statement:
          "Fix the cache invalidation when tokens rotate after deploy",
      },
    ];
    const pairs = buildSameRepoPairs(instances, {
      minSimilarity: 0.15,
      maxPairs: 10,
    });
    expect(pairs.length).toBeGreaterThanOrEqual(1);
    expect(pairs.every((p) => p.repo === "demo/a")).toBe(true);
    const probes = new Set(pairs.map((p) => p.probe.instance_id));
    const hist = new Set(pairs.map((p) => p.history.instance_id));
    expect(probes.size).toBe(pairs.length);
    expect(hist.size).toBe(pairs.length);
  });
});

describe("summarizeSweExp / resolve Δ", () => {
  const mk = (id: string, off: boolean, on: boolean): SweExpPairResult => {
    const offArm = { memoryOn: false as const, resolved: off };
    const onArm = { memoryOn: true as const, resolved: on };
    return {
      pairId: id,
      repo: "r",
      historyId: `${id}-h`,
      probeId: `${id}-p`,
      off: offArm,
      on: onArm,
      outcome: armOutcome(offArm, onArm),
    };
  };

  test("win/loss/tie 与 Δ", () => {
    const details = [
      mk("a", false, true), // win
      mk("b", false, true), // win
      mk("c", true, true), // tie
      mk("d", true, false), // loss
    ];
    const s = summarizeSweExp(details);
    expect(s.wins).toBe(2);
    expect(s.losses).toBe(1);
    expect(s.ties).toBe(1);
    expect(s.resolveRateOn).toBe(0.75);
    expect(s.resolveRateOff).toBe(0.5);
    expect(s.delta).toBeCloseTo(0.25);
    expect(sweExpPassed(s)).toBe(true);
  });

  test("Δ≤0 或不赢 → 不达标", () => {
    expect(sweExpPassed(summarizeSweExp([mk("a", true, true)]))).toBe(false);
    expect(sweExpPassed(summarizeSweExp([]))).toBe(null);
  });

  test("mergeExternalResolveResults", () => {
    const report = mergeExternalResolveResults([
      {
        pairId: "p1",
        repo: "django/django",
        historyId: "h",
        probeId: "p",
        offResolved: false,
        onResolved: true,
      },
    ]);
    expect(report.mode).toBe("external");
    expect(report.passed).toBe(true);
    expect(report.paired.wins).toBe(1);
  });
});

describe("builtin fixtures guards", () => {
  test("lesson/goal overlap ≥2；fake 预设 on 优于 off", () => {
    for (const p of SWE_EXP_BUILTIN_PAIRS) {
      expect(
        lessonGoalOverlap(p.goal, p.lesson.summary),
      ).toBeGreaterThanOrEqual(2);
      expect(p.fakeOnResolved).toBe(true);
      expect(p.fakeOffResolved).toBe(false);
    }
  });
});

describe("runSweExpBuiltin fake", () => {
  test("fake 模式协议通过且不碰 DB", async () => {
    const report = await runSweExpBuiltin({ mode: "fake" });
    expect(report.suite).toBe("swe-exp");
    expect(report.passed).toBe(true);
    expect(report.paired.nPairs).toBe(SWE_EXP_BUILTIN_PAIRS.length);
    expect(report.paired.wins).toBe(SWE_EXP_BUILTIN_PAIRS.length);
    expect(report.paired.delta).toBe(1);
  });
});

describe("lifecycle observability", () => {
  test("rolls up coding phase errors", () => {
    const arm = {
      memoryOn: false,
      resolved: false,
      warnings: ["coding_phase_errors:2"],
    };
    const summary = summarizeLifecycleGates([
      {
        pairId: "p",
        repo: "r",
        historyId: "h",
        probeId: "q",
        off: arm,
        on: { ...arm, memoryOn: true, warnings: ["coding_phase_errors:1"] },
        outcome: "tie",
      },
    ]);
    expect(summary.codingPhaseErrors).toBe(3);
  });
});

describe("agent control-plane preflight/checkpoint", () => {
  test("Windows harness uses the LF-normalizing launcher", () => {
    const args = harnessPythonArgs("C:\\repo", ["--run_id", "x"], "win32");
    expect(args[0]?.replaceAll("\\", "/")).toEndWith(
      "benchmarks/swe-exp/run_harness_lf.py",
    );
    expect(args.slice(1)).toEqual(["--run_id", "x"]);
  });

  test("official harness can retain an instance image for agent verification", () => {
    expect(
      officialHarnessArgs({
        dataset: "princeton-nlp/SWE-bench_Lite",
        predictionsPath: "predictions.jsonl",
        runId: "preflight",
        maxWorkers: 1,
        instanceIds: ["demo__repo-1"],
        cacheLevel: "instance",
        cleanImages: false,
      }),
    ).toEqual([
      "--dataset_name",
      "princeton-nlp/SWE-bench_Lite",
      "--predictions_path",
      "predictions.jsonl",
      "--run_id",
      "preflight",
      "--max_workers",
      "1",
      "--instance_ids",
      "demo__repo-1",
      "--cache_level",
      "instance",
      "--clean",
      "false",
    ]);
  });

  test("official schema-v2 root report resolves the exact run id", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-swe-exp-report-"));
    try {
      writeFileSync(
        path.join(root, "paw-ts-memory-on.run-123.json"),
        JSON.stringify({ resolved_ids: ["demo__repo-1"], schema_version: 2 }),
      );
      const parsed = parseResolvedFromHarnessOutput(
        "",
        "run-123",
        "demo__repo-1",
        root,
      );
      expect(parsed.resolved).toBe(true);
      expect(parsed.source).toBe("swebench_harness");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("official schema-v2 error ids are infrastructure errors, not unresolved code", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-swe-exp-error-report-"));
    try {
      writeFileSync(
        path.join(root, "swe-compare-paw.run-error.json"),
        JSON.stringify({
          resolved_ids: [],
          error_ids: ["demo__repo-1"],
          schema_version: 2,
        }),
      );
      const parsed = parseResolvedFromHarnessOutput(
        "",
        "run-error",
        "demo__repo-1",
        root,
      );
      expect(parsed.resolved).toBe(false);
      expect(parsed.source).toBe("error");
      expect(parsed.error).toContain("did not produce a valid adjudication");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("agent goal exposes acceptance ids but never gold patches", () => {
    const goal = buildSweAgentGoal({
      instance_id: "demo__repo-1",
      repo: "demo/repo",
      base_commit: "deadbeef",
      problem_statement: "cache invalidation is incorrect",
      FAIL_TO_PASS: ["tests/test_cache.py::test_rotation"],
      PASS_TO_PASS: ["tests/test_cache.py::test_baseline"],
      patch: "GOLD_PATCH_MUST_NOT_LEAK",
      test_patch: "GOLD_TEST_PATCH_MUST_NOT_LEAK",
    });
    expect(goal).toContain("tests/test_cache.py::test_rotation");
    expect(goal).toContain("tests/test_cache.py::test_baseline");
    expect(goal).toContain("Do not modify unrelated files or any test files");
    expect(goal).not.toContain("[coding_phase_budget]");
    expect(goal).not.toContain("GOLD_PATCH_MUST_NOT_LEAK");
    expect(goal).not.toContain("GOLD_TEST_PATCH_MUST_NOT_LEAK");
  });

  test("trusted SWE metadata compiles into external acceptance state", () => {
    const criteria = buildSweAcceptanceCriteria({
      instance_id: "demo__repo-1",
      repo: "demo/repo",
      base_commit: "deadbeef",
      problem_statement: "fix it",
      FAIL_TO_PASS: ["tests/test_cache.py::test_rotation"],
      PASS_TO_PASS: ["tests/test_cache.py::test_baseline"],
    });
    expect(criteria).toHaveLength(2);
    expect(criteria.map((item) => item.ref)).toEqual([
      "tests/test_cache.py::test_baseline",
      "tests/test_cache.py::test_rotation",
    ]);
    expect(
      criteria.every((item) => item.verificationAuthority === "external"),
    ).toBe(true);
  });

  test("DB unavailable fails before either model arm runs", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-swe-exp-preflight-"));
    try {
      const common = {
        repo: "demo/repo",
        problem_statement: "fix a similar cache bug",
        base_commit: "deadbeef",
      };
      const report = await runSweExpAgent({
        repoRoot: root,
        suiteRunId: "preflight-test",
        memoryPreflight: async () => false,
        pairs: [
          {
            id: "pair-1",
            repo: "demo/repo",
            similarity: 0.5,
            history: { ...common, instance_id: "history-1" },
            probe: { ...common, instance_id: "probe-1" },
          },
        ],
      });
      expect(report.details).toEqual([]);
      expect(report.warnings).toContain(
        "preflight_failed: memory database unavailable; no model arms were run",
      );
      expect(
        JSON.parse(
          readFileSync(
            path.join(
              root,
              "benchmarks",
              "swe-exp",
              "runs",
              "preflight-test",
              "manifest.json",
            ),
            "utf8",
          ),
        ).pairs,
      ).toHaveLength(1);
      expect(
        JSON.parse(
          readFileSync(
            path.join(
              root,
              "benchmarks",
              "swe-exp",
              "runs",
              "preflight-test",
              "report.json",
            ),
            "utf8",
          ),
        ).suiteRunId,
      ).toBe("preflight-test");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("eval-only does not require the memory DB preflight", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-swe-exp-eval-only-"));
    let preflightCalls = 0;
    try {
      const common = {
        repo: "demo/repo",
        problem_statement: "fix a similar cache bug",
        base_commit: "deadbeef",
      };
      const report = await runSweExpAgent({
        repoRoot: root,
        suiteRunId: "eval-only-test",
        evalOnly: true,
        skipHarness: true,
        memoryPreflight: async () => {
          preflightCalls += 1;
          return false;
        },
        pairs: [
          {
            id: "pair-1",
            repo: "demo/repo",
            similarity: 0.5,
            history: { ...common, instance_id: "history-1" },
            probe: { ...common, instance_id: "probe-1" },
          },
        ],
      });
      expect(preflightCalls).toBe(0);
      expect(report.warnings).toContain(
        "pair-1/off: eval_only_missing_checkpoint",
      );
      expect(report.warnings).toContain(
        "pair-1/on: eval_only_missing_checkpoint",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("checkpoint JSON uses a complete atomic replacement", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-swe-exp-checkpoint-"));
    try {
      const target = path.join(root, "nested", "checkpoint.json");
      writeJsonAtomic(target, { status: "running", value: 1 });
      writeJsonAtomic(target, { status: "completed", value: 2 });
      expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({
        status: "completed",
        value: 2,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

const DB_URL = process.env.DATABASE_URL ?? "postgresql:///paw_memory_test";
const runDb = process.env.SWE_EXP_DB_TEST === "1";

describe.skipIf(!runDb)("runSweExpBuiltin deterministic (DB)", () => {
  process.env.DATABASE_URL = DB_URL;

  test("memory on 召回后打补丁 → 测试通过；off 失败", async () => {
    const report = await runSweExpBuiltin({ mode: "deterministic" });
    expect(report.details.length).toBeGreaterThan(0);
    for (const d of report.details) {
      expect(d.off.resolved).toBe(false);
      expect(d.on.resolved).toBe(true);
      expect(d.on.recalled).toBe(true);
      expect(d.outcome).toBe("win");
    }
    expect(report.passed).toBe(true);
  }, 120_000);
});

afterAll(async () => {
  if (runDb) {
    try {
      await closeSql();
    } catch {
      /* ignore */
    }
  }
});

describe("history-seed no gold", () => {
  test("distill 只用题面；含 diff 标记则拒绝", () => {
    const lesson = distillHistoryLesson({
      historyId: "django__django-1",
      repo: "django/django",
      problemStatement:
        "QuerySet.update() fails when annotating with F() on related fields in models.py",
    });
    expect(lesson.modification.length).toBeGreaterThan(0);
    assertNoGoldLeak(
      lesson,
      "diff --git a/foo.py b/foo.py\n@@ -1 +1 @@\n-a\n+b\n",
    );

    expect(() =>
      distillHistoryLesson({
        historyId: "x",
        repo: "r/r",
        problemStatement: "broken\ndiff --git a/a.py b/a.py\n@@ -1 +1 @@\n",
      }),
    ).toThrow(/gold|patch/i);
  });
});
