import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildSweCompareGoal } from "../src/swe-compare/goal.js";
import {
  createSweCompareManifest,
  findLocalTrajectoryHits,
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
