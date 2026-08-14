import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildSweCompareGoal } from "../src/swe-compare/goal.js";
import {
  PAW_FRESH_DEVELOPMENT_RULE,
  PAW_FRESH_QUALIFICATION_RULE,
  PAW_FRESH_QUALIFICATION_V3_RULE,
  PAW_FRESH_QUALIFICATION_V4_RULE,
  PAW_FRESH_QUALIFICATION_V5_RULE,
  PAW_FRESH_QUALIFICATION_V5_RUN_IDS,
  PAW_FRESH_QUALIFICATION_V6_RULE,
  PAW_FRESH_QUALIFICATION_V6_RUN_IDS,
  PAW_FRESH_QUALIFICATION_V7_RULE,
  PAW_FRESH_QUALIFICATION_V7_RUN_IDS,
  PAW_FRESH_V2_IDS,
  PAW_KNOWN_EXPOSED_IDS,
  PAW_SEEN_DEVELOPMENT_IDS,
  createSweCompareManifest,
  findLocalTrajectoryHits,
  selectPawFreshDevelopmentIds,
  selectPawFreshQualificationIds,
} from "../src/swe-compare/manifest.js";
import {
  PREFLIGHT_SENTINEL_PATCH,
  interpretPreflightSummary,
} from "../src/swe-compare/preflight.js";

const instance = {
  instance_id: "demo__repo-1",
  repo: "demo/repo",
  base_commit: "deadbeef",
  problem_statement: "Fix the cache without changing tests.",
  FAIL_TO_PASS: JSON.stringify(["tests/test_cache.py::test_fix"]),
  PASS_TO_PASS: JSON.stringify([
    "tests/test_cache.py::test_1",
    "tests/test_cache.py::test_2",
    "tests/test_cache.py::test_3",
    "tests/test_cache.py::test_4",
    "tests/test_cache.py::test_5",
  ]),
};

describe("SWE compare manifest", () => {
  test("freezes eight seen tasks from distinct repositories", () => {
    expect(PAW_SEEN_DEVELOPMENT_IDS).toHaveLength(8);
    expect(new Set(PAW_SEEN_DEVELOPMENT_IDS).size).toBe(8);
    expect(
      new Set(PAW_SEEN_DEVELOPMENT_IDS.map((id) => id.split("__")[0])).size,
    ).toBe(8);
    expect(PAW_SEEN_DEVELOPMENT_IDS).toContain("pylint-dev__pylint-7228");
    expect(PAW_SEEN_DEVELOPMENT_IDS).toContain("pydata__xarray-4493");
    expect(PAW_SEEN_DEVELOPMENT_IDS).toContain("matplotlib__matplotlib-25332");
  });

  test("selects five fresh repositories deterministically without task text", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-swe-fresh-selection-"));
    const datasetPath = path.join(
      root,
      "benchmarks",
      "swe-bench",
      "swe-bench-lite.jsonl",
    );
    mkdirSync(path.dirname(datasetPath), { recursive: true });
    const candidates = Array.from({ length: 7 }, (_, index) => ({
      ...instance,
      instance_id: `fresh-${index}__repo-${index}`,
      repo: `fresh-${index}/repo`,
      base_commit: `base-${index}`,
      problem_statement:
        index % 2 === 0 ? "apparently easy" : "apparently difficult",
    }));
    candidates.push({ ...instance, instance_id: PAW_SEEN_DEVELOPMENT_IDS[0] });
    writeFileSync(
      datasetPath,
      `${candidates.map((item) => JSON.stringify(item)).join("\n")}\n`,
      "utf8",
    );
    const selected = selectPawFreshDevelopmentIds({
      repoRoot: root,
      datasetPath,
    });
    expect(selected).toHaveLength(PAW_FRESH_DEVELOPMENT_RULE.count);
    expect(
      new Set(
        selected.map(
          (id) => candidates.find((item) => item.instance_id === id)?.repo,
        ),
      ).size,
    ).toBe(PAW_FRESH_DEVELOPMENT_RULE.count);
    expect(selected).not.toContain(PAW_SEEN_DEVELOPMENT_IDS[0]);
    expect(PAW_KNOWN_EXPOSED_IDS).toContain(PAW_SEEN_DEVELOPMENT_IDS[0]);

    writeFileSync(
      datasetPath,
      `${[...candidates]
        .reverse()
        .map((item) =>
          JSON.stringify({ ...item, problem_statement: "changed after sort" }),
        )
        .join("\n")}\n`,
      "utf8",
    );
    expect(
      selectPawFreshDevelopmentIds({ repoRoot: root, datasetPath }),
    ).toEqual(selected);
  });

  test("freezes v2 results as permanently exposed while preserving v2 selection", () => {
    expect(PAW_FRESH_V2_IDS).toHaveLength(5);
    expect(new Set(PAW_FRESH_V2_IDS).size).toBe(5);
    for (const id of PAW_FRESH_V2_IDS) {
      expect(PAW_KNOWN_EXPOSED_IDS).toContain(id);
    }
  });

  test("selects ten v8 repositories after excluding model runs and Requests", () => {
    expect(PAW_FRESH_QUALIFICATION_V3_RULE.count).toBe(5);
    expect(PAW_FRESH_QUALIFICATION_V4_RULE.count).toBe(10);
    expect(PAW_FRESH_QUALIFICATION_V5_RULE.count).toBe(10);
    expect(PAW_FRESH_QUALIFICATION_V6_RULE.count).toBe(10);
    expect(PAW_FRESH_QUALIFICATION_V7_RULE.count).toBe(10);
    expect(PAW_FRESH_QUALIFICATION_RULE.count).toBe(10);
    expect(PAW_FRESH_QUALIFICATION_RULE.version).toBe(
      "paw-fresh-qualification-v8",
    );
    expect(PAW_FRESH_QUALIFICATION_V5_RUN_IDS).toEqual(["sympy__sympy-14024"]);
    expect(PAW_FRESH_QUALIFICATION_V6_RUN_IDS).toEqual(["psf__requests-2317"]);
    expect(PAW_FRESH_QUALIFICATION_V7_RUN_IDS).toEqual([
      "django__django-11001",
      "scikit-learn__scikit-learn-15535",
      "sympy__sympy-20154",
    ]);
    expect(PAW_FRESH_QUALIFICATION_RULE.excludedRepos).toEqual([
      "psf/requests",
    ]);
    expect(PAW_FRESH_QUALIFICATION_RULE.fallbackMinFailToPass).toBe(1);
    expect(PAW_FRESH_QUALIFICATION_RULE.seed).toBe(
      PAW_FRESH_QUALIFICATION_V3_RULE.seed,
    );
    const root = mkdtempSync(path.join(tmpdir(), "paw-swe-v3-selection-"));
    const datasetPath = path.join(root, "swe-bench-lite.jsonl");
    const failToPass = JSON.stringify([
      "tests/test_fix.py::test_a",
      "tests/test_fix.py::test_b",
    ]);
    const passToPass = JSON.stringify(
      Array.from(
        { length: 20 },
        (_, index) => `tests/test_regression.py::test_${index}`,
      ),
    );
    const candidates = Array.from({ length: 9 }, (_, index) => ({
      ...instance,
      instance_id: `qualification-${index}__repo-${index}`,
      repo: `qualification-${index}/repo`,
      base_commit: `qualification-base-${index}`,
      problem_statement: index % 2 === 0 ? "short" : "longer task prose",
      FAIL_TO_PASS: failToPass,
      PASS_TO_PASS: passToPass,
    }));
    const fallbackCandidates = Array.from({ length: 3 }, (_, index) => ({
      ...instance,
      instance_id: `fallback-${index}__repo-${index}`,
      repo: `fallback-${index}/repo`,
      base_commit: `fallback-base-${index}`,
      problem_statement: "fallback task prose",
      FAIL_TO_PASS: JSON.stringify(["tests/test_fix.py::test_a"]),
      PASS_TO_PASS: passToPass,
    }));
    candidates.push(...fallbackCandidates);
    const qualifying = candidates[0];
    if (!qualifying) throw new Error("v3 fixture has no qualifying candidate");
    candidates.push({
      ...qualifying,
      instance_id: PAW_FRESH_QUALIFICATION_V5_RUN_IDS[0],
      repo: "v5-model-run/repo",
    });
    candidates.push({
      ...qualifying,
      instance_id: PAW_FRESH_QUALIFICATION_V6_RUN_IDS[0],
      repo: "v6-model-run/repo",
    });
    for (const [
      index,
      instanceId,
    ] of PAW_FRESH_QUALIFICATION_V7_RUN_IDS.entries()) {
      candidates.push({
        ...qualifying,
        instance_id: instanceId,
        repo: `v7-model-run-${index}/repo`,
      });
    }
    candidates.push({
      ...qualifying,
      instance_id: "requests__networked-test",
      repo: "psf/requests",
    });
    candidates.push({
      ...qualifying,
      instance_id: PAW_FRESH_V2_IDS[0],
      repo: "already-exposed/repo",
    });
    candidates.push({
      ...qualifying,
      instance_id: "zero-f2p__repo",
      repo: "zero-f2p/repo",
      FAIL_TO_PASS: JSON.stringify([]),
    });
    candidates.push({
      ...qualifying,
      instance_id: "too-small-p2p__repo",
      repo: "too-small-p2p/repo",
      PASS_TO_PASS: JSON.stringify(
        Array.from(
          { length: 19 },
          (_, index) => `tests/test_regression.py::test_${index}`,
        ),
      ),
    });
    writeFileSync(
      datasetPath,
      `${candidates.map((item) => JSON.stringify(item)).join("\n")}\n`,
      "utf8",
    );

    const selected = selectPawFreshQualificationIds({
      repoRoot: root,
      datasetPath,
    });
    expect(selected).toHaveLength(PAW_FRESH_QUALIFICATION_RULE.count);
    expect(new Set(selected.map((id) => id.split("__")[0])).size).toBe(
      PAW_FRESH_QUALIFICATION_RULE.count,
    );
    expect(selected).not.toContain(PAW_FRESH_V2_IDS[0]);
    expect(selected).not.toContain(PAW_FRESH_QUALIFICATION_V5_RUN_IDS[0]);
    expect(selected).not.toContain(PAW_FRESH_QUALIFICATION_V6_RUN_IDS[0]);
    for (const instanceId of PAW_FRESH_QUALIFICATION_V7_RUN_IDS) {
      expect(selected).not.toContain(instanceId);
    }
    expect(selected).not.toContain("requests__networked-test");
    expect(selected).not.toContain("zero-f2p__repo");
    expect(selected).not.toContain("too-small-p2p__repo");
    expect(selected.filter((id) => id.startsWith("fallback-")).length).toBe(1);
    expect(
      selected.slice(0, 9).every((id) => id.startsWith("qualification-")),
    ).toBe(true);

    writeFileSync(
      datasetPath,
      `${[...candidates]
        .reverse()
        .map((item) =>
          JSON.stringify({ ...item, problem_statement: "rewritten task text" }),
        )
        .join("\n")}\n`,
      "utf8",
    );
    expect(
      selectPawFreshQualificationIds({ repoRoot: root, datasetPath }),
    ).toEqual(selected);
  });
  test("uses one provider-neutral goal without leaking gold", () => {
    const goal = buildSweCompareGoal({
      ...instance,
      FAIL_TO_PASS: ["tests/test_cache.py::test_fix"],
      PASS_TO_PASS: ["tests/test_cache.py::test_1"],
      patch: "GOLD_PATCH",
      test_patch: "GOLD_TEST_PATCH",
    });
    expect(goal).toContain("checked-out repository");
    expect(goal).toContain("tests/test_cache.py::test_fix");
    expect(goal).not.toContain("workspace.edit_file");
    expect(goal).not.toContain("Claude");
    expect(goal).not.toContain("Paw");
    expect(goal).not.toContain("GOLD_PATCH");
    expect(goal).not.toContain("GOLD_TEST_PATCH");
  });

  test("refuses to prepare without a fair Paw runtime profile", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-swe-compare-"));
    mkdirSync(path.join(root, "benchmarks", "swe-bench"), { recursive: true });
    writeFileSync(
      path.join(root, "benchmarks", "swe-bench", "swe-bench-lite.jsonl"),
      `${JSON.stringify(instance)}\n`,
      "utf8",
    );
    expect(() =>
      createSweCompareManifest({
        repoRoot: root,
        instanceIds: [instance.instance_id],
      }),
    ).toThrow();
  });

  test("preflight artifacts are not treated as prior agent trajectories", () => {
    const root = mkdtempSync(
      path.join(tmpdir(), "paw-swe-preflight-artifact-"),
    );
    mkdirSync(path.join(root, "benchmarks", "swe-bench"), { recursive: true });
    mkdirSync(path.join(root, "benchmarks", "swe-compare", "preflight"), {
      recursive: true,
    });
    writeFileSync(
      path.join(root, "benchmarks", "swe-bench", "swe-bench-lite.jsonl"),
      `${JSON.stringify(instance)}\n`,
      "utf8",
    );
    writeFileSync(
      path.join(root, "benchmarks", "swe-compare", "preflight", "probe.jsonl"),
      instance.instance_id,
      "utf8",
    );
    writeFileSync(
      path.join(root, "benchmarks", "swe-compare", "README.md"),
      `Frozen protocol example: ${instance.instance_id}`,
      "utf8",
    );
    mkdirSync(path.join(root, ".paw", "code-index"), { recursive: true });
    writeFileSync(
      path.join(root, ".paw", "code-index", "repo-map.json"),
      JSON.stringify({
        path: `benchmarks/swe-compare/preflight/${instance.instance_id}.jsonl`,
      }),
      "utf8",
    );
    expect(findLocalTrajectoryHits(root, instance.instance_id)).toEqual([]);
  });

  test("preflight sentinel is validly terminated and requires completed", () => {
    expect(PREFLIGHT_SENTINEL_PATCH.endsWith("\n")).toBe(true);
    const root = mkdtempSync(path.join(tmpdir(), "paw-swe-summary-"));
    const report = path.join(root, "report.json");
    writeFileSync(
      report,
      JSON.stringify({
        completed_ids: [instance.instance_id],
        resolved_ids: [],
        empty_patch_ids: [],
        error_ids: [],
      }),
      "utf8",
    );
    expect(interpretPreflightSummary(instance.instance_id, report)).toEqual({
      eligible: true,
      completed: true,
      baselineResolved: false,
      emptyPatch: false,
      harnessError: false,
    });
  });
});
