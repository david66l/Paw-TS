import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  claudeCodeArgs,
  validateCompareRun,
} from "../src/swe-compare/runner.js";
import type { SweCompareManifest } from "../src/swe-compare/types.js";

describe("SWE compare runner", () => {
  test("Claude Code command freezes clean 1M max-effort mode", () => {
    const goal = "neutral task";
    const args = claudeCodeArgs(goal);
    expect(args).toContain("--bare");
    expect(args).toContain("deepseek-v4-flash[1m]");
    expect(args).toContain("max");
    expect(args).toContain("1m");
    expect(args).toContain("--no-session-persistence");
    expect(args).toContain("--disable-slash-commands");
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args.at(-1)).toBe(goal);
  });

  test("refuses to run when the current source tree is dirty", () => {
    const repoRoot = path.resolve(import.meta.dir, "../../..");
    const manifest = JSON.parse(
      readFileSync(
        path.join(
          repoRoot,
          "benchmarks",
          "swe-compare",
          "manifests",
          "smoke-v1.json",
        ),
        "utf8",
      ),
    ) as SweCompareManifest;
    const instanceId = manifest.instances[0]?.instanceId;
    if (!instanceId) throw new Error("test manifest has no instances");
    expect(() => validateCompareRun(repoRoot, manifest, instanceId)).toThrow(
      "current source tree is dirty",
    );
  });
});
