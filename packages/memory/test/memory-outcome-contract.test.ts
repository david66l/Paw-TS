import { describe, expect, test } from "bun:test";

import {
  type MemoryOutcomeContractV1,
  classifyMemoryCompletion,
} from "../src/index.js";

function contract(
  patch: Partial<MemoryOutcomeContractV1> = {},
): MemoryOutcomeContractV1 {
  return {
    schemaVersion: 1,
    runStatus: "completed",
    completionOutcome: "verified",
    completionReason: "tests_passed",
    verificationAuthority: "local",
    mutationRevision: 2,
    evidence: {
      filesChanged: ["src/a.ts"],
      commandsRun: [],
      mutationRevision: 2,
      testResults: [
        {
          command: "bun test",
          passed: true,
          outcome: "passed",
          summary: "4 pass",
          mutationRevision: 2,
        },
      ],
    },
    ...patch,
  };
}

describe("MemoryOutcomeContract", () => {
  test("accepts only a local pass for the exact final mutation revision", () => {
    expect(
      classifyMemoryCompletion({
        status: "completed",
        outcome: contract(),
      }),
    ).toBe("verified_success");
  });

  test("a repaired early failure does not poison the later authoritative pass", () => {
    const base = contract();
    expect(
      classifyMemoryCompletion({
        status: "completed",
        outcome: {
          ...base,
          evidence: {
            ...base.evidence,
            testResults: [
              {
                command: "bun test",
                passed: false,
                outcome: "code_failed",
                summary: "1 fail",
                mutationRevision: 1,
              },
              ...base.evidence.testResults,
            ],
          },
        },
      }),
    ).toBe("verified_success");
  });

  test("rejects stale, external-pending, and model-declared evidence", () => {
    const base = contract();
    const stale: MemoryOutcomeContractV1 = {
      ...base,
      evidence: {
        ...base.evidence,
        testResults: base.evidence.testResults.map((result) => ({
          ...result,
          mutationRevision: 1,
        })),
      },
    };
    expect(
      classifyMemoryCompletion({ status: "completed", outcome: stale }),
    ).toBe("unverified_completion");
    expect(
      classifyMemoryCompletion({
        status: "completed",
        outcome: contract({
          completionOutcome: "model_declared",
          completionReason: "external_verification_pending",
          verificationAuthority: "external",
        }),
      }),
    ).toBe("unverified_completion");
  });

  test("budget exhaustion and runtime failure enter the failure channel", () => {
    expect(
      classifyMemoryCompletion({
        status: "failed",
        outcome: contract({
          runStatus: "incomplete",
          completionOutcome: "budget_exhausted",
          completionReason: "max_steps_exhausted_without_final",
        }),
      }),
    ).toBe("failed");
  });
});
