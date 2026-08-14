import { describe, expect, test } from "bun:test";

import { PAW_FRESH_QUALIFICATION_RULE } from "../src/swe-compare/manifest.js";
import {
  PAW_QUALIFICATION_GATE,
  summarizePawQualification,
} from "../src/swe-compare/qualification.js";
import type { SweCompareRunResult } from "../src/swe-compare/runner.js";
import type { SweCompareManifest } from "../src/swe-compare/types.js";

const ids = Array.from(
  { length: PAW_QUALIFICATION_GATE.expectedSamples },
  (_, index) => `repo-${index}__issue-${index}`,
);
const manifest = {
  selection: { ruleVersion: PAW_FRESH_QUALIFICATION_RULE.version, ids },
  sourceTree: { gitCommit: "frozen-commit", gitDirty: false },
} as unknown as SweCompareManifest;

function result(index: number, resolved: boolean): SweCompareRunResult {
  return {
    schemaVersion: 1,
    runId: `run-${index}`,
    runner: "paw",
    instanceId: ids[index] ?? `missing-${index}`,
    sourceCommit: "frozen-commit",
    startedAt: "2026-08-14T00:00:00.000Z",
    finishedAt: "2026-08-14T00:01:00.000Z",
    durationMs: 60_000,
    status: "completed",
    patch: "diff --git a/a b/a\n",
    patchChars: 24,
    patchSource: "workspace",
    artifactStatus: "valid",
    integrity: { valid: true, violations: [] },
    resolved,
    resolvedSource: "swebench_harness",
    tracePath: `runs/run-${index}/trace.json`,
  };
}

describe("Paw qualification batch gate", () => {
  test("stays in progress until all ten unique samples exist", () => {
    const summary = summarizePawQualification(
      manifest,
      Array.from({ length: 9 }, (_, index) => result(index, true)),
    );
    expect(summary.state).toBe("in_progress");
    expect(summary.pendingInstanceIds).toEqual([ids[9]]);
  });

  test("passes at seven official resolutions with auditable artifacts", () => {
    const summary = summarizePawQualification(
      manifest,
      Array.from({ length: 10 }, (_, index) => result(index, index < 7)),
    );
    expect(summary.state).toBe("passed");
    expect(summary.officialResolved).toBe(7);
  });

  test("fails below seven or when integrity is invalid", () => {
    const lowScore = Array.from({ length: 10 }, (_, index) =>
      result(index, index < 6),
    );
    expect(summarizePawQualification(manifest, lowScore).state).toBe("failed");
    const invalid = [...lowScore];
    invalid[0] = {
      ...result(0, true),
      integrity: { valid: false, violations: ["network"] },
    };
    expect(summarizePawQualification(manifest, invalid).passed).toBe(false);
  });

  test("rejects duplicate samples instead of resampling", () => {
    expect(() =>
      summarizePawQualification(manifest, [result(0, true), result(0, false)]),
    ).toThrow("duplicate qualification sample");
  });
});
