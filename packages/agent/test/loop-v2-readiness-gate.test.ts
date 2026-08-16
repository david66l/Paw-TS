import { describe, expect, test } from "bun:test";
import {
  type LoopV2LiveCandidateAssessmentV1,
  evaluateLoopV2ReadinessGateV1,
} from "../src/loop-v2/index.js";

function blockedAssessment(
  facts: LoopV2LiveCandidateAssessmentV1["facts"],
): LoopV2LiveCandidateAssessmentV1 {
  return {
    schemaVersion: 1,
    kind: "paw.loop-v2-live-candidate",
    candidateId: "candidate-1",
    candidateInputHash: "candidate-input",
    mutationRevision: 0,
    proposedAtSeq: 10,
    reportHash: "report",
    stateHash: "state",
    policy: {
      requireProductMutation: true,
      verificationAuthority: "local",
      requiredVerificationScopes: [],
    },
    facts,
    artifact: {
      status: "invalid",
      changedPaths: [],
      errors: ["No product mutation is present."],
    },
    readiness: {
      disposition: "blocked",
      readyForSemanticReview: false,
      gaps: [
        {
          code: "product_mutation_missing",
          message: "No product mutation is present.",
        },
        {
          code: "verification_missing",
          message: "No current authoritative verification pass is recorded.",
        },
      ],
      pendingExternalCriterionIds: [],
      currentAuthoritativeVerificationIds: [],
      localVerification: "missing",
    },
    assessmentHash: "assessment",
  };
}

describe("Loop Kernel v2 readiness repair identity", () => {
  test("unchanged facts exhaust the one-shot feedback budget", () => {
    const assessment = blockedAssessment({
      evidence: 2,
      mutations: 0,
      verification: 0,
    });
    const first = evaluateLoopV2ReadinessGateV1({
      assessment,
      progressKey: "evidence-2",
      noRoomForAnotherTurn: false,
    });
    expect(first.type).toBe("feedback");
    if (first.type !== "feedback") throw new Error("expected feedback");
    expect(first.message).toContain("Issue the necessary tool call(s)");
    expect(first.message).toContain("does not count as repair progress");
    expect(first.requirement).toEqual({
      kind: "material_change",
      afterRevision: 0,
    });

    expect(
      evaluateLoopV2ReadinessGateV1({
        assessment: { ...assessment, proposedAtSeq: 20, stateHash: "reworded" },
        progressKey: "evidence-2",
        priorKey: first.key,
        priorNudges: 1,
        noRoomForAnotherTurn: false,
      }),
    ).toMatchObject({ type: "incomplete", reason: "feedback_exhausted" });
  });

  test("novel investigation evidence opens a new bounded repair cycle", () => {
    const first = evaluateLoopV2ReadinessGateV1({
      assessment: blockedAssessment({
        evidence: 2,
        mutations: 0,
        verification: 0,
      }),
      progressKey: "evidence-2",
      noRoomForAnotherTurn: false,
    });
    expect(first.type).toBe("feedback");
    if (first.type !== "feedback") throw new Error("expected feedback");

    const progressed = evaluateLoopV2ReadinessGateV1({
      assessment: blockedAssessment({
        evidence: 3,
        mutations: 0,
        verification: 0,
      }),
      progressKey: "evidence-3",
      priorKey: first.key,
      priorNudges: 1,
      noRoomForAnotherTurn: false,
    });
    expect(progressed.type).toBe("feedback");
    if (progressed.type !== "feedback") throw new Error("expected feedback");
    expect(progressed.key).not.toBe(first.key);

    expect(
      evaluateLoopV2ReadinessGateV1({
        assessment: blockedAssessment({
          evidence: 3,
          mutations: 0,
          verification: 0,
        }),
        progressKey: "evidence-3",
        priorKey: progressed.key,
        priorNudges: 1,
        noRoomForAnotherTurn: false,
      }),
    ).toMatchObject({ type: "incomplete", reason: "feedback_exhausted" });
  });

  test("fresh verification records make masked and code failures actionable", () => {
    const maskedAssessment = {
      ...blockedAssessment({
        evidence: 1,
        mutations: 1,
        verification: 1,
      }),
      mutationRevision: 1,
    };
    const masked = evaluateLoopV2ReadinessGateV1({
      assessment: {
        ...maskedAssessment,
        readiness: {
          ...maskedAssessment.readiness,
          gaps: [
            {
              code: "verification_unavailable",
              message:
                "Current authoritative verification is unavailable because the harness failed.",
            },
          ],
          localVerification: "harness_failed",
        },
      },
      progressKey: "masked-progress",
      verificationRecords: [
        {
          id: "verify-masked",
          runner: "custom",
          argv: ["python", "tests/runtests.py", "target.case"],
          cwd: ".",
          scope: ["target.case"],
          mutationRevision: 1,
          outcome: "harness_failed",
          failureClass: "untrusted_exit_status",
          outputArtifactRef: "artifact://verify-masked",
          authoritative: true,
        },
      ],
      noRoomForAnotherTurn: false,
    });
    expect(masked.type).toBe("feedback");
    if (masked.type !== "feedback") throw new Error("expected feedback");
    expect(masked.message).toContain("failure=untrusted_exit_status");
    expect(masked.message).toContain("python tests/runtests.py target.case");
    expect(masked.message).toContain("without pipes");
    expect(masked.message).toContain("masked exit code");
    expect(masked.requirement).toEqual({
      kind: "direct_verification",
      revision: 1,
      runnerFamily: "custom",
      scope: ["target.case"],
    });

    const codeFailed = evaluateLoopV2ReadinessGateV1({
      assessment: {
        ...maskedAssessment,
        readiness: {
          ...maskedAssessment.readiness,
          gaps: [
            {
              code: "verification_code_failed",
              message:
                "Current authoritative verification reports a code failure.",
            },
          ],
          localVerification: "code_failed",
        },
      },
      progressKey: "code-failed-progress",
      verificationRecords: [
        {
          id: "verify-failed",
          runner: "custom",
          argv: ["python", "tests/runtests.py", "target.case"],
          cwd: ".",
          scope: ["target.case"],
          mutationRevision: 1,
          outcome: "code_failed",
          failureClass: "test_failure",
          outputArtifactRef: "artifact://verify-failed",
          authoritative: true,
        },
      ],
      noRoomForAnotherTurn: false,
    });
    expect(codeFailed.type).toBe("feedback");
    if (codeFailed.type !== "feedback") throw new Error("expected feedback");
    expect(codeFailed.message).toContain("failure=test_failure");
    expect(codeFailed.message).toContain("current-revision failures");
    expect(codeFailed.message).toContain(
      "do not assume external or hidden tests",
    );
    expect(codeFailed.requirement).toEqual({
      kind: "material_change",
      afterRevision: 1,
    });
  });
});
