import { describe, expect, test } from "bun:test";

import {
  CONTROL_STATE_SCHEMA_VERSION,
  type ControlReducerInputV1,
  type ControlStateV1,
  controlInputFromLoopV2EnvelopeV1,
  controlStateHashV1,
  createControlStateV1,
  reduceControlStateV1,
  replayControlFactsV1,
  restoreControlStateV1,
} from "../src/loop-v2/index.js";

const RUN_ID = "control-reducer-v1";

function input(
  seq: number,
  fact: ControlReducerInputV1["fact"],
): ControlReducerInputV1 {
  return { runId: RUN_ID, seq, fact };
}

function started(): ControlStateV1 {
  return reduceControlStateV1(
    createControlStateV1(RUN_ID),
    input(1, { type: "run.started", goalHash: "goal-hash" }),
  ).state;
}

function candidateState(): ControlStateV1 {
  const mutated = reduceControlStateV1(
    started(),
    input(2, {
      type: "mutation.committed",
      revision: 1,
      paths: ["src/value.ts"],
    }),
  ).state;
  return reduceControlStateV1(
    mutated,
    input(3, {
      type: "candidate.submitted",
      candidate: {
        id: "candidate-1",
        mutationRevision: 1,
        candidateInputHash: "candidate-hash",
      },
    }),
  ).state;
}

function directRepairState(): ControlStateV1 {
  return reduceControlStateV1(
    candidateState(),
    input(4, {
      type: "readiness.evaluated",
      candidateId: "candidate-1",
      mutationRevision: 1,
      result: {
        kind: "repair_required",
        requirement: {
          kind: "direct_verification",
          revision: 1,
          runnerFamily: "bun_test",
          scope: ["src/value.ts"],
        },
      },
    }),
  ).state;
}

function readyCandidateState(
  externalVerification: "not_configured" | "pending" = "not_configured",
): ControlStateV1 {
  return reduceControlStateV1(
    candidateState(),
    input(4, {
      type: "readiness.evaluated",
      candidateId: "candidate-1",
      mutationRevision: 1,
      result: {
        kind: "ready",
        semanticReview: "required",
        verificationProbe: "required",
        externalVerification,
      },
    }),
  ).state;
}

describe("Loop v2 pure control reducer", () => {
  test("R11 natural stop is only a turn boundary", () => {
    const reduced = reduceControlStateV1(
      started(),
      input(2, {
        type: "provider.turn_stopped",
        turn: 1,
        empty: false,
      }),
    );

    expect(reduced.state).toMatchObject({
      schemaVersion: CONTROL_STATE_SCHEMA_VERSION,
      status: "running",
      turn: 1,
      consecutiveNoActionStops: 1,
    });
    expect(reduced.state.candidate).toBeUndefined();
    expect(reduced.effects).toEqual([
      { type: "call_model", reason: "turn_boundary" },
    ]);
  });

  test("only explicit candidate intent requests readiness", () => {
    const state = started();
    const reduced = reduceControlStateV1(
      state,
      input(2, {
        type: "candidate.submitted",
        candidate: {
          id: "candidate-0",
          mutationRevision: 0,
          candidateInputHash: "candidate-hash",
        },
      }),
    );

    expect(reduced.state.status).toBe("candidate");
    expect(reduced.effects).toEqual([
      { type: "request_readiness", candidateId: "candidate-0" },
    ]);
  });

  test("semantic pass requests a probe and only a clear probe finishes", () => {
    const ready = { state: readyCandidateState(), effects: [] } as const;
    const completed = reduceControlStateV1(
      ready.state,
      input(5, {
        type: "semantic_review.observed",
        candidateId: "candidate-1",
        mutationRevision: 1,
        reviewKey: "review-1",
        verdict: "pass",
        verificationProbe: "required",
        externalVerification: "not_configured",
      }),
    );

    expect(ready.state.status).toBe("candidate");
    expect(ready.effects).toEqual([]);
    expect(completed.state.status).toBe("candidate");
    expect(completed.effects).toEqual([
      { type: "request_probe", candidateId: "candidate-1" },
    ]);

    const probed = reduceControlStateV1(
      completed.state,
      input(6, {
        type: "verification_probe.observed",
        candidateId: "candidate-1",
        mutationRevision: 1,
        probeKey: "probe-1",
        outcome: "clear",
        semanticReviewKey: "review-1",
        externalVerification: "not_configured",
      }),
    );
    expect(probed.state.status).toBe("completed");
    expect(probed.effects).toEqual([
      {
        type: "commit_terminal",
        status: "completed",
        reason: "candidate_certified",
      },
    ]);
  });

  test("external verification stays pending even after semantic review passes", () => {
    const reviewed = reduceControlStateV1(
      readyCandidateState("pending"),
      input(5, {
        type: "semantic_review.observed",
        candidateId: "candidate-1",
        mutationRevision: 1,
        reviewKey: "review-external",
        verdict: "pass",
        verificationProbe: "required",
        externalVerification: "pending",
      }),
    );
    expect(reviewed.state.status).toBe("candidate");
    expect(reviewed.effects).toEqual([
      { type: "request_probe", candidateId: "candidate-1" },
    ]);

    const reduced = reduceControlStateV1(
      reviewed.state,
      input(6, {
        type: "verification_probe.observed",
        candidateId: "candidate-1",
        mutationRevision: 1,
        probeKey: "probe-external",
        outcome: "inconclusive",
        semanticReviewKey: "review-external",
        externalVerification: "pending",
      }),
    );

    expect(reduced.state.status).toBe("external_pending");
    expect(reduced.effects).toEqual([
      {
        type: "commit_terminal",
        status: "external_pending",
        reason: "external_verification_pending",
      },
    ]);
  });

  test("a candidate defect opens repair and an interrupted probe is incomplete", () => {
    const reviewed = reduceControlStateV1(
      readyCandidateState(),
      input(5, {
        type: "semantic_review.observed",
        candidateId: "candidate-1",
        mutationRevision: 1,
        reviewKey: "review-pass",
        verdict: "pass",
        verificationProbe: "required",
        externalVerification: "not_configured",
      }),
    );
    const defect = reduceControlStateV1(
      reviewed.state,
      input(6, {
        type: "verification_probe.observed",
        candidateId: "candidate-1",
        mutationRevision: 1,
        probeKey: "probe-defect",
        outcome: "candidate_defect",
        semanticReviewKey: "review-pass",
        externalVerification: "not_configured",
      }),
    );
    expect(defect.state.status).toBe("repair_required");
    expect(defect.state.openRepairObligation).toMatchObject({
      kind: "material_change",
      afterRevision: 1,
    });

    const interrupted = reduceControlStateV1(
      reviewed.state,
      input(7, {
        type: "verification_probe.observed",
        candidateId: "candidate-1",
        mutationRevision: 1,
        probeKey: "probe-interrupted",
        outcome: "interrupted",
        semanticReviewKey: "review-pass",
        externalVerification: "not_configured",
      }),
    );
    expect(interrupted.state.status).toBe("incomplete");
    expect(interrupted.effects).toEqual([
      {
        type: "commit_incomplete",
        reason: "verification_probe_interrupted",
      },
    ]);
  });

  test("readiness requirements cannot be weakened by later review or probe facts", () => {
    const externalReady = readyCandidateState("pending");
    expect(() =>
      reduceControlStateV1(
        externalReady,
        input(5, {
          type: "readiness.evaluated",
          candidateId: "candidate-1",
          mutationRevision: 1,
          result: {
            kind: "ready",
            semanticReview: "not_required",
            verificationProbe: "not_required",
            externalVerification: "not_configured",
          },
        }),
      ),
    ).toThrow("only once per submitted candidate");
    expect(() =>
      reduceControlStateV1(
        externalReady,
        input(5, {
          type: "semantic_review.observed",
          candidateId: "candidate-1",
          mutationRevision: 1,
          reviewKey: "forged-review",
          verdict: "pass",
          verificationProbe: "not_required",
          externalVerification: "not_configured",
        }),
      ),
    ).toThrow("requirements do not match readiness");

    const reviewed = reduceControlStateV1(
      externalReady,
      input(5, {
        type: "semantic_review.observed",
        candidateId: "candidate-1",
        mutationRevision: 1,
        reviewKey: "review-external",
        verdict: "pass",
        verificationProbe: "required",
        externalVerification: "pending",
      }),
    );
    expect(() =>
      reduceControlStateV1(
        reviewed.state,
        input(6, {
          type: "verification_probe.observed",
          candidateId: "candidate-1",
          mutationRevision: 1,
          probeKey: "forged-probe",
          outcome: "clear",
          semanticReviewNotRequired: true,
          externalVerification: "not_configured",
        }),
      ),
    ).toThrow("authority does not match readiness");
  });

  test("failed review or probe cannot be overwritten without a new candidate", () => {
    const failedReview = reduceControlStateV1(
      readyCandidateState(),
      input(5, {
        type: "semantic_review.observed",
        candidateId: "candidate-1",
        mutationRevision: 1,
        reviewKey: "review-fail",
        verdict: "fail",
        verificationProbe: "required",
        externalVerification: "not_configured",
      }),
    );
    expect(() =>
      reduceControlStateV1(
        failedReview.state,
        input(6, {
          type: "semantic_review.observed",
          candidateId: "candidate-1",
          mutationRevision: 1,
          reviewKey: "review-pass",
          verdict: "pass",
          verificationProbe: "required",
          externalVerification: "not_configured",
        }),
      ),
    ).toThrow("only once per ready candidate");

    const reviewed = reduceControlStateV1(
      readyCandidateState(),
      input(5, {
        type: "semantic_review.observed",
        candidateId: "candidate-1",
        mutationRevision: 1,
        reviewKey: "review-pass",
        verdict: "pass",
        verificationProbe: "required",
        externalVerification: "not_configured",
      }),
    );
    const failedProbe = reduceControlStateV1(
      reviewed.state,
      input(6, {
        type: "verification_probe.observed",
        candidateId: "candidate-1",
        mutationRevision: 1,
        probeKey: "probe-fail",
        outcome: "candidate_defect",
        semanticReviewKey: "review-pass",
        externalVerification: "not_configured",
      }),
    );
    expect(() =>
      reduceControlStateV1(
        failedProbe.state,
        input(7, {
          type: "verification_probe.observed",
          candidateId: "candidate-1",
          mutationRevision: 1,
          probeKey: "probe-clear",
          outcome: "clear",
          semanticReviewKey: "review-pass",
          externalVerification: "not_configured",
        }),
      ),
    ).toThrow("only once per ready candidate");
    expect(failedProbe.effects).not.toContainEqual(
      expect.objectContaining({ type: "commit_terminal" }),
    );
  });

  test("a probe can certify without semantic review only when readiness says not required", () => {
    const ready = reduceControlStateV1(
      candidateState(),
      input(4, {
        type: "readiness.evaluated",
        candidateId: "candidate-1",
        mutationRevision: 1,
        result: {
          kind: "ready",
          semanticReview: "not_required",
          verificationProbe: "required",
          externalVerification: "not_configured",
        },
      }),
    );
    expect(ready.effects).toEqual([
      { type: "request_probe", candidateId: "candidate-1" },
    ]);
    const completed = reduceControlStateV1(
      ready.state,
      input(5, {
        type: "verification_probe.observed",
        candidateId: "candidate-1",
        mutationRevision: 1,
        probeKey: "probe-no-review",
        outcome: "clear",
        semanticReviewNotRequired: true,
        externalVerification: "not_configured",
      }),
    );
    expect(completed.state.status).toBe("completed");
    expect(completed.effects).toEqual([
      {
        type: "commit_terminal",
        status: "completed",
        reason: "candidate_certified",
      },
    ]);
  });

  test("legacy missing probe requirements fail closed instead of certifying", () => {
    const legacyReady = reduceControlStateV1(
      candidateState(),
      input(4, {
        type: "readiness.evaluated",
        candidateId: "candidate-1",
        mutationRevision: 1,
        result: { kind: "ready" },
      }),
    );
    const legacyReview = reduceControlStateV1(
      legacyReady.state,
      input(5, {
        type: "semantic_review.observed",
        candidateId: "candidate-1",
        mutationRevision: 1,
        reviewKey: "legacy-review",
        verdict: "pass",
        externalVerification: "not_configured",
      }),
    );
    expect(legacyReview.state.status).toBe("candidate");
    expect(legacyReview.effects).toEqual([
      { type: "request_probe", candidateId: "candidate-1" },
    ]);
    expect(() =>
      restoreControlStateV1(RUN_ID, {
        ...legacyReview.state,
        schemaVersion: 1,
      } as unknown as ControlStateV1),
    ).toThrow("Unsupported control state schema: 1");
  });

  test("failed semantic review opens a repair that only a later mutation clears", () => {
    const failed = reduceControlStateV1(
      readyCandidateState(),
      input(5, {
        type: "semantic_review.observed",
        candidateId: "candidate-1",
        mutationRevision: 1,
        reviewKey: "review-failed",
        verdict: "fail",
        verificationProbe: "required",
        externalVerification: "not_configured",
      }),
    );
    const repeatedCandidate = reduceControlStateV1(
      failed.state,
      input(6, {
        type: "candidate.submitted",
        candidate: {
          id: "candidate-1",
          mutationRevision: 1,
          candidateInputHash: "candidate-hash",
        },
      }),
    );
    const changed = reduceControlStateV1(
      repeatedCandidate.state,
      input(7, {
        type: "mutation.committed",
        revision: 2,
        paths: ["src/value.ts"],
      }),
    );

    expect(failed.state.openRepairObligation).toMatchObject({
      kind: "material_change",
      afterRevision: 1,
    });
    expect(repeatedCandidate.state.status).toBe("repair_required");
    expect(repeatedCandidate.effects).toEqual([
      { type: "call_model", reason: "repair_required" },
    ]);
    expect(changed.state.status).toBe("running");
    expect(changed.state.openRepairObligation).toBeUndefined();
    expect(changed.state.semanticReview).toBeUndefined();
  });

  test("R21/R22 wrong or unrelated successful actions do not clear repair", () => {
    const repair = directRepairState();
    const obligation = repair.openRepairObligation;
    const read = reduceControlStateV1(
      repair,
      input(5, { type: "tool.settled", tool: "workspace.read_file", ok: true }),
    );
    const unrelatedVerification = reduceControlStateV1(
      read.state,
      input(6, {
        type: "verification.observed",
        verification: {
          revision: 1,
          runnerFamily: "bun_test",
          scope: ["test/unrelated.test.ts"],
          outcome: "passed",
        },
      }),
    );

    expect(read.state.openRepairObligation).toEqual(obligation);
    expect(unrelatedVerification.state.openRepairObligation).toEqual(
      obligation,
    );
    expect(unrelatedVerification.state.status).toBe("repair_required");
  });

  test("R23 code failure opens material repair and a later product change clears it", () => {
    const failed = reduceControlStateV1(
      directRepairState(),
      input(5, {
        type: "verification.observed",
        verification: {
          revision: 1,
          runnerFamily: "bun_test",
          scope: ["src/value.ts"],
          outcome: "code_failed",
        },
      }),
    );
    expect(failed.state.openRepairObligation).toMatchObject({
      kind: "material_change",
      afterRevision: 1,
    });
    expect(failed.state.status).toBe("repair_required");

    const unrelated = reduceControlStateV1(
      failed.state,
      input(6, {
        type: "mutation.committed",
        revision: 2,
        paths: ["README.md"],
      }),
    );
    expect(unrelated.state.openRepairObligation).toBeUndefined();
    expect(unrelated.state.status).toBe("running");
    expect(unrelated.state.candidate).toBeUndefined();
  });

  test("an unbound direct-verification runner accepts any authoritative family", () => {
    const repair = reduceControlStateV1(
      candidateState(),
      input(4, {
        type: "readiness.evaluated",
        candidateId: "candidate-1",
        mutationRevision: 1,
        result: {
          kind: "repair_required",
          requirement: {
            kind: "direct_verification",
            revision: 1,
            runnerFamily: "any",
            scope: [],
          },
        },
      }),
    );
    const verified = reduceControlStateV1(
      repair.state,
      input(5, {
        type: "verification.observed",
        verification: {
          revision: 1,
          runnerFamily: "pytest",
          scope: ["tests/test_value.py"],
          outcome: "passed",
        },
      }),
    );

    expect(verified.state.openRepairObligation).toBeUndefined();
    expect(verified.effects).toEqual([
      { type: "request_readiness", candidateId: "candidate-1" },
    ]);
  });

  test("R24 split replay preserves durable obligation identity", () => {
    const facts = [
      input(1, { type: "run.started", goalHash: "goal-hash" }),
      input(2, {
        type: "mutation.committed",
        revision: 1,
        paths: ["src/value.ts"],
      }),
      input(3, {
        type: "candidate.submitted",
        candidate: {
          id: "candidate-1",
          mutationRevision: 1,
          candidateInputHash: "candidate-hash",
        },
      }),
      input(4, {
        type: "readiness.evaluated",
        candidateId: "candidate-1",
        mutationRevision: 1,
        result: {
          kind: "repair_required",
          requirement: {
            kind: "direct_verification",
            revision: 1,
            runnerFamily: "bun_test",
            scope: ["src/value.ts"],
          },
        },
      }),
      input(5, {
        type: "tool.settled",
        tool: "workspace.read_file",
        ok: true,
      }),
    ] satisfies readonly ControlReducerInputV1[];

    const uninterrupted = replayControlFactsV1(RUN_ID, facts);
    const beforeResume = replayControlFactsV1(RUN_ID, facts.slice(0, 4));
    const resumed = replayControlFactsV1(
      RUN_ID,
      facts.slice(4),
      beforeResume.state,
    );

    expect(resumed.stateHash).toBe(uninterrupted.stateHash);
    expect(resumed.state.openRepairObligation).toEqual(
      uninterrupted.state.openRepairObligation,
    );
  });

  test("R25 an immediate duplicate is idempotent and a conflict is corruption", () => {
    const fact = input(2, {
      type: "provider.turn_stopped",
      turn: 1,
      empty: false,
    });
    const first = reduceControlStateV1(started(), fact);
    const duplicate = reduceControlStateV1(first.state, fact);

    expect(duplicate.state).toBe(first.state);
    expect(duplicate.effects).toEqual([]);
    expect(controlStateHashV1(duplicate.state)).toBe(
      controlStateHashV1(first.state),
    );
    expect(() =>
      reduceControlStateV1(
        first.state,
        input(2, {
          type: "provider.turn_stopped",
          turn: 1,
          empty: true,
        }),
      ),
    ).toThrow("Conflicting control fact");
  });

  test("adapts existing Loop v2 facts without another journal envelope", () => {
    const adapted = controlInputFromLoopV2EnvelopeV1({
      schemaVersion: 2,
      runId: RUN_ID,
      seq: 1,
      ts: 1,
      event: {
        type: "task.started",
        goal: "Fix the bug",
        sourceHash: "goal-hash",
      },
    });
    const advisorOnly = controlInputFromLoopV2EnvelopeV1({
      schemaVersion: 2,
      runId: RUN_ID,
      seq: 2,
      ts: 2,
      event: { type: "phase.changed", phase: "discover" },
    });
    const readiness = controlInputFromLoopV2EnvelopeV1({
      schemaVersion: 2,
      runId: RUN_ID,
      seq: 4,
      ts: 4,
      event: {
        type: "readiness.evaluated",
        candidateId: "candidate-1",
        mutationRevision: 1,
        result: {
          kind: "repair_required",
          requirement: {
            kind: "material_change",
            afterRevision: 1,
          },
        },
      },
    });
    const review = controlInputFromLoopV2EnvelopeV1({
      schemaVersion: 2,
      runId: RUN_ID,
      seq: 5,
      ts: 5,
      event: {
        type: "semantic_review.recorded",
        candidateId: "candidate-1",
        mutationRevision: 1,
        reviewKey: "review-1",
        verdict: "pass",
        verificationProbe: "required",
        externalVerification: "not_configured",
      },
    });
    const probe = controlInputFromLoopV2EnvelopeV1({
      schemaVersion: 2,
      runId: RUN_ID,
      seq: 6,
      ts: 6,
      event: {
        type: "verification_probe.recorded",
        candidateId: "candidate-1",
        mutationRevision: 1,
        probeKey: "probe-1",
        outcome: "clear",
        semanticReviewKey: "review-1",
        externalVerification: "not_configured",
      },
    });

    expect(adapted).toEqual(
      input(1, { type: "run.started", goalHash: "goal-hash" }),
    );
    expect(advisorOnly).toBeUndefined();
    expect(readiness).toEqual(
      input(4, {
        type: "readiness.evaluated",
        candidateId: "candidate-1",
        mutationRevision: 1,
        result: {
          kind: "repair_required",
          requirement: { kind: "material_change", afterRevision: 1 },
        },
      }),
    );
    expect(review).toEqual(
      input(5, {
        type: "semantic_review.observed",
        candidateId: "candidate-1",
        mutationRevision: 1,
        reviewKey: "review-1",
        verdict: "pass",
        verificationProbe: "required",
        externalVerification: "not_configured",
      }),
    );
    expect(probe).toEqual(
      input(6, {
        type: "verification_probe.observed",
        candidateId: "candidate-1",
        mutationRevision: 1,
        probeKey: "probe-1",
        outcome: "clear",
        semanticReviewKey: "review-1",
        externalVerification: "not_configured",
      }),
    );

    const mutation = controlInputFromLoopV2EnvelopeV1({
      schemaVersion: 2,
      runId: RUN_ID,
      seq: 3,
      ts: 3,
      event: {
        type: "mutation.recorded",
        mutation: {
          seq: 3,
          callId: "edit-1",
          mutationRevision: 1,
          paths: ["src/value.ts"],
          beforeHashes: { "src/value.ts": "before" },
          afterHashes: { "src/value.ts": "after" },
          beforeContentRefs: { "src/value.ts": "artifact:before" },
          afterContentRefs: { "src/value.ts": "artifact:after" },
          patch: "patch",
          workspaceEffect: "product",
        },
      },
    });
    if (!adapted || !mutation) throw new Error("Missing control projection");
    const withGap = replayControlFactsV1(RUN_ID, [adapted, mutation]);
    expect(withGap.state.lastSeq).toBe(3);
    expect(withGap.state.mutationRevision).toBe(1);
  });
});
