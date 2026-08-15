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
});
