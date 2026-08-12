import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  claudeCodeArgs,
  parseClaudeStream,
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
    expect(args).toContain("stream-json");
    expect(args).toContain("--verbose");
    const toolsIndex = args.indexOf("--tools");
    expect(args[toolsIndex + 2]?.startsWith("--")).toBe(true);
    expect(args.at(-1)).toBe(goal);
  });

  test("Claude stream keeps tool events but never persists thinking", () => {
    const stdout = [
      JSON.stringify({ type: "system", subtype: "init", model: "deepseek" }),
      JSON.stringify({
        type: "system",
        subtype: "thinking_tokens",
        estimated_tokens: 10,
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "thinking", thinking: "private chain" },
            { type: "tool_use", name: "Read", input: { file_path: "x" } },
          ],
        },
      }),
      JSON.stringify({
        type: "result",
        is_error: false,
        num_turns: 1,
        terminal_reason: "completed",
      }),
    ].join("\n");
    const parsed = parseClaudeStream(stdout);
    expect(parsed.result.terminal_reason).toBe("completed");
    expect(JSON.stringify(parsed.trace)).toContain("tool_use");
    expect(JSON.stringify(parsed.trace)).not.toContain("private chain");
    expect(JSON.stringify(parsed.trace)).not.toContain("thinking_tokens");
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
          // An existing ignored runtime artifact is sufficient here; this test
          // fails on dirty-tree validation before selection metadata is read.
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
