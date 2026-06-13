/**
 * Smoke test with REAL model — verifies the full pipeline end-to-end.
 *
 * Uses the first 3 simple core-tools test cases with 1 repetition each.
 * Run: bun test packages/eval/test/smoke-real-model.test.ts
 */

import { describe, expect, test } from "bun:test";
import { createDefaultLanguageModel } from "@paw/models";
import { EvalRunner } from "../src/runner.js";
import { CORE_TOOLS_SUITE } from "../src/test-suite/builtin/core-tools.js";

describe("Smoke: real model end-to-end", () => {
  test("simple core-tools cases pass with real model", async () => {
    // Pick 5 simple cases
    const cases = CORE_TOOLS_SUITE.filter((tc) =>
      ["core-tools-001", "core-tools-004", "core-tools-008", "core-tools-012", "core-tools-013"].includes(tc.id),
    );

    expect(cases).toHaveLength(5);

    const model = createDefaultLanguageModel(process.cwd());
    console.log(`[smoke] Using model: ${model.label}`);

    const runner = new EvalRunner({
      model,
      workspaceRoot: process.cwd(),
      sandbox: false, // set true to test isolation
      settings: { default_repetitions: 1 },
      reportFormat: "console",
    });

    const result = await runner.runSuite("smoke-real", cases);

    console.log(result.formattedReport);

    // Basic sanity checks — not all may pass with real model, but pipeline should work
    expect(result.allRecords.length).toBe(5);
    for (const record of result.allRecords) {
      console.log(
        `[smoke] ${record.testCaseId}: status=${record.status}, turns=${record.turns.length}, duration=${(record.durationMs / 1000).toFixed(1)}s`,
      );
      expect(record.turns.length).toBeGreaterThan(0);
    }
  }, 120_000); // 2 min timeout for real API calls
});
