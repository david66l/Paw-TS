import { describe, expect, test } from "bun:test";

import {
  type VerificationRecordV2,
  isStableCandidateCheckpointEligibleV1,
} from "../src/loop-v2/index.js";

function verification(
  mutationRevision: number,
  authoritative = true,
): VerificationRecordV2 {
  return {
    id: `verification-${mutationRevision}`,
    runner: "custom",
    argv: ["test"],
    cwd: ".",
    scope: ["source"],
    mutationRevision,
    outcome: "code_failed",
    exitCode: 1,
    outputArtifactRef: `artifact-${mutationRevision}`,
    authoritative,
  };
}

describe("stable candidate checkpoint eligibility", () => {
  test("requires current authoritative verification, inspected diff, and settled jobs", () => {
    const eligible = {
      mutationRevision: 2,
      diffInspectedRevision: 2,
      managedJobsBlockCompletion: false,
      reviewAlreadyAttempted: false,
      verification: [verification(2)],
    } as const;
    expect(isStableCandidateCheckpointEligibleV1(eligible)).toBe(true);
    expect(
      isStableCandidateCheckpointEligibleV1({
        ...eligible,
        mutationRevision: 0,
        diffInspectedRevision: 0,
      }),
    ).toBe(false);
    expect(
      isStableCandidateCheckpointEligibleV1({
        ...eligible,
        verification: [],
      }),
    ).toBe(false);
    expect(
      isStableCandidateCheckpointEligibleV1({
        ...eligible,
        verification: [verification(1)],
      }),
    ).toBe(false);
    expect(
      isStableCandidateCheckpointEligibleV1({
        ...eligible,
        verification: [verification(2, false)],
      }),
    ).toBe(false);
    expect(
      isStableCandidateCheckpointEligibleV1({
        ...eligible,
        diffInspectedRevision: 1,
      }),
    ).toBe(false);
    expect(
      isStableCandidateCheckpointEligibleV1({
        ...eligible,
        managedJobsBlockCompletion: true,
      }),
    ).toBe(false);
    expect(
      isStableCandidateCheckpointEligibleV1({
        ...eligible,
        reviewAlreadyAttempted: true,
      }),
    ).toBe(false);
  });
});
