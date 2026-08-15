import { describe, expect, test } from "bun:test";

import { summarizeLoopV2CutoverV1 } from "../src/loop-v2/index.js";

describe("Loop Kernel v2 cutover summary", () => {
  test("requires strict, non-permissive, cutover-ready eligible evidence", () => {
    const summary = summarizeLoopV2CutoverV1([
      {
        runId: "eligible",
        terminalComparison: "equal",
        eligibility: { eligible: true, reasons: [] },
        cutoverReady: true,
      },
      {
        runId: "read-only",
        terminalComparison: "legacy_more_permissive",
        eligibility: {
          eligible: false,
          reasons: [
            "product_mutation_not_required",
            "local_verification_not_passed",
          ],
        },
        cutoverReady: false,
      },
    ]);

    expect(summary).toMatchObject({
      scannedRuns: 2,
      strictRuns: 2,
      corruptRuns: 0,
      eligibleRuns: 1,
      cutoverReadyRuns: 1,
      eligibleNotReadyRuns: 0,
      v2MorePermissiveRuns: 0,
      eligibleRunIds: ["eligible"],
      ineligibilityReasons: {
        product_mutation_not_required: 1,
        local_verification_not_passed: 1,
      },
      controlledCutoverEvidenceReady: true,
    });
  });

  test("fails the evidence gate on corruption, permissiveness, or mapping drift", () => {
    const summary = summarizeLoopV2CutoverV1(
      [
        {
          runId: "mapping-drift",
          terminalComparison: "equal",
          eligibility: { eligible: true, reasons: [] },
          cutoverReady: false,
        },
        {
          runId: "too-permissive",
          terminalComparison: "v2_more_permissive",
          eligibility: {
            eligible: false,
            reasons: ["legacy_not_completed"],
          },
          cutoverReady: false,
        },
      ],
      [{ runDirectory: "runs/corrupt", error: "bad hash" }],
    );
    expect(summary).toMatchObject({
      scannedRuns: 3,
      strictRuns: 2,
      corruptRuns: 1,
      eligibleRuns: 1,
      cutoverReadyRuns: 0,
      eligibleNotReadyRuns: 1,
      v2MorePermissiveRuns: 1,
      eligibleNotReadyRunIds: ["mapping-drift"],
      v2MorePermissiveRunIds: ["too-permissive"],
      controlledCutoverEvidenceReady: false,
    });
  });

  test("rejects duplicate ids and impossible ineligible-ready records", () => {
    expect(() =>
      summarizeLoopV2CutoverV1([
        {
          runId: "same",
          terminalComparison: "equal",
          eligibility: { eligible: true, reasons: [] },
          cutoverReady: true,
        },
        {
          runId: "same",
          terminalComparison: "equal",
          eligibility: { eligible: true, reasons: [] },
          cutoverReady: true,
        },
      ]),
    ).toThrow("invalid runId");
    expect(() =>
      summarizeLoopV2CutoverV1([
        {
          runId: "impossible",
          terminalComparison: "equal",
          eligibility: { eligible: false, reasons: ["candidate_missing"] },
          cutoverReady: true,
        },
      ]),
    ).toThrow("cannot be cutover-ready");
  });
});
