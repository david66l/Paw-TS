import { describe, expect, test } from "bun:test";
import {
  LOOP_V2_SCHEMA_VERSION,
  type LoopV2Event,
  type SemanticReviewLedgerV2,
  type WorkingDecisionStateV2,
  buildCandidateInputV2,
  buildCandidateReviewPayloadV2,
  candidateInputHashV2,
  candidateSnapshotHashV2,
  createSemanticReviewLedgerV2,
  createWorkingDecisionStateV2,
  evaluateCandidateReadinessV2,
  projectLoopV2Event,
  reviewCandidateOnceV2,
  semanticReviewKeyV2,
} from "../src/loop-v2/index.js";

const RUN_ID = "loop-v2-certification";

function append(
  state: WorkingDecisionStateV2,
  event: LoopV2Event,
): WorkingDecisionStateV2 {
  return projectLoopV2Event(state, {
    schemaVersion: LOOP_V2_SCHEMA_VERSION,
    runId: RUN_ID,
    seq: state.lastSeq + 1,
    ts: 10_000 + state.lastSeq + 1,
    event,
  }).state;
}

function baseState(): WorkingDecisionStateV2 {
  let state = createWorkingDecisionStateV2(RUN_ID);
  state = append(state, {
    type: "task.started",
    goal: "Change the named behavior and preserve the public contract.",
    sourceHash: "goal-source-hash",
  });
  state = append(state, {
    type: "mutation.recorded",
    mutation: {
      seq: 2,
      callId: "edit-r1",
      mutationRevision: 1,
      paths: ["src/public.ts"],
      beforeHashes: { "src/public.ts": "before-r1" },
      afterHashes: { "src/public.ts": "after-r1" },
      beforeContentRefs: {
        "src/public.ts": "artifact://content/public-before-r1",
      },
      afterContentRefs: {
        "src/public.ts": "artifact://content/public-after-r1",
      },
      patch: "diff --git a/src/public.ts b/src/public.ts\n+fixed",
      workspaceEffect: "product",
    },
  });
  state = append(state, {
    type: "verification.recorded",
    verification: {
      id: "verify-r1",
      runner: "bun_test",
      argv: ["bun", "test", "test/public.test.ts"],
      cwd: ".",
      scope: ["test/public.test.ts"],
      mutationRevision: 1,
      outcome: "passed",
      assertions: { passed: 3, failed: 0, total: 3 },
      outputArtifactRef: "artifact://verify-r1",
      authoritative: true,
    },
  });
  state = append(state, {
    type: "criterion.upserted",
    criterion: {
      id: "criterion-public",
      text: "Preserve the public return shape.",
      observable: "Return keys and values remain unchanged.",
      source: "user_explicit",
      authority: "agent",
      status: "satisfied",
      evidenceRefs: ["verify-r1"],
      mutationRevision: 1,
    },
  });
  state = append(state, {
    type: "criterion.upserted",
    criterion: {
      id: "criterion-external",
      text: "Pass the external evaluator.",
      observable: "External test suite resolves the task.",
      source: "external_test_id",
      authority: "external",
      status: "satisfied",
      evidenceRefs: [],
      mutationRevision: 1,
    },
  });
  state = append(state, {
    type: "invariant.upserted",
    invariant: {
      id: "invariant-api",
      text: "Do not widen the public API change surface.",
      source: "repository_contract",
      authority: "agent",
      status: "active",
      evidenceRefs: ["verify-r1"],
      mutationRevision: 1,
    },
  });
  state = append(state, {
    type: "change_surface.upserted",
    changeSurface: {
      id: "surface-public",
      path: "src/public.ts",
      symbol: "renderPublic",
      visibility: "public",
      observables: ["return shape", "string output"],
      criterionIds: ["criterion-public"],
      mutationRevision: 1,
    },
  });
  return state;
}

const artifact = {
  reconstructible: true,
  crossCheck: "matched" as const,
  artifactRef: "artifact://candidate-r1",
};

describe("Loop Kernel v2 candidate certification", () => {
  test("builds a deterministic candidate identity without final prose or deliberation", () => {
    const input = buildCandidateInputV2(baseState(), [
      { path: "src/z.ts", contentHash: "z-hash" },
      { path: "src/a.ts", contentHash: "a-hash" },
    ]);
    const hash = candidateInputHashV2(input);

    expect(input.snapshotHashes.map((snapshot) => snapshot.path)).toEqual([
      "src/a.ts",
      "src/z.ts",
    ]);
    expect(JSON.stringify(input)).not.toContain("proposedSummary");
    expect(JSON.stringify(input)).not.toContain("deliberation");
    expect(candidateInputHashV2(input)).toBe(hash);
    expect(semanticReviewKeyV2(1, hash)).toBe(
      semanticReviewKeyV2(input.mutationRevision, hash),
    );
  });

  test("is ready on current host evidence while keeping external authority pending", () => {
    const readiness = evaluateCandidateReadinessV2(baseState(), artifact);

    expect(readiness.disposition).toBe("ready_for_review");
    expect(readiness.readyForSemanticReview).toBeTrue();
    expect(readiness.gaps).toEqual([]);
    expect(readiness.pendingExternalCriterionIds).toEqual([
      "criterion-external",
    ]);
    expect(readiness.currentAuthoritativeVerificationIds).toEqual([
      "verify-r1",
    ]);
  });

  test("a genuinely read-only candidate does not require a synthetic empty patch", () => {
    let state = createWorkingDecisionStateV2(RUN_ID);
    state = append(state, {
      type: "task.started",
      goal: "Inspect the named file and report what it contains.",
      sourceHash: "read-only-goal",
    });
    const readiness = evaluateCandidateReadinessV2(
      state,
      {
        reconstructible: false,
        crossCheck: "unavailable",
        artifactRef: "artifact://empty-candidate",
      },
      {
        requireProductMutation: false,
        verificationAuthority: "not_required",
      },
    );

    expect(readiness).toMatchObject({
      disposition: "ready_for_review",
      readyForSemanticReview: true,
      localVerification: "not_required",
      gaps: [],
    });
  });

  test("R17 makes r1 criterion evidence stale after an r2 mutation", () => {
    let state = baseState();
    state = append(state, {
      type: "mutation.recorded",
      mutation: {
        seq: state.lastSeq + 1,
        callId: "edit-r2",
        mutationRevision: 2,
        paths: ["src/public.ts"],
        beforeHashes: { "src/public.ts": "after-r1" },
        afterHashes: { "src/public.ts": "after-r2" },
        beforeContentRefs: {
          "src/public.ts": "artifact://content/public-after-r1",
        },
        afterContentRefs: {
          "src/public.ts": "artifact://content/public-after-r2",
        },
        patch: "diff --git a/src/public.ts b/src/public.ts\n+repair",
        workspaceEffect: "product",
      },
    });

    const stale = evaluateCandidateReadinessV2(state, artifact);
    expect(stale.readyForSemanticReview).toBeFalse();
    expect(stale.gaps).toContainEqual(
      expect.objectContaining({
        code: "criterion_stale",
        criterionId: "criterion-public",
      }),
    );
    expect(stale.gaps).toContainEqual(
      expect.objectContaining({ code: "verification_missing" }),
    );

    state = append(state, {
      type: "verification.recorded",
      verification: {
        id: "verify-r2",
        runner: "bun_test",
        argv: ["bun", "test", "test/public.test.ts"],
        cwd: ".",
        scope: ["test/public.test.ts"],
        mutationRevision: 2,
        outcome: "passed",
        outputArtifactRef: "artifact://verify-r2",
        authoritative: true,
      },
    });
    const criterion = state.criteria["criterion-public"];
    if (!criterion) throw new Error("missing criterion-public fixture");
    state = append(state, {
      type: "criterion.upserted",
      criterion: {
        ...criterion,
        status: "satisfied",
        evidenceRefs: ["verify-r2"],
        mutationRevision: 2,
      },
    });

    const refreshed = evaluateCandidateReadinessV2(state, artifact);
    expect(refreshed.gaps).toEqual([]);
    expect(refreshed.readyForSemanticReview).toBeTrue();
  });

  test("Git unavailability does not erase a journal artifact, but mismatch fails closed", () => {
    const unavailable = evaluateCandidateReadinessV2(baseState(), {
      reconstructible: true,
      crossCheck: "unavailable",
    });
    expect(unavailable.readyForSemanticReview).toBeTrue();

    const mismatch = evaluateCandidateReadinessV2(baseState(), {
      reconstructible: true,
      crossCheck: "mismatch",
    });
    expect(mismatch.readyForSemanticReview).toBeFalse();
    expect(mismatch.gaps.map((gap) => gap.code)).toContain(
      "artifact_cross_check_mismatch",
    );
  });

  test("a current substantive pass survives an additional harness failure", () => {
    let state = baseState();
    state = append(state, {
      type: "verification.recorded",
      verification: {
        id: "verify-environment-r1",
        runner: "custom",
        argv: ["external-harness"],
        cwd: ".",
        scope: ["external"],
        mutationRevision: 1,
        outcome: "harness_failed",
        failureClass: "container_unavailable",
        outputArtifactRef: "artifact://harness-failure",
        authoritative: true,
      },
    });

    const readiness = evaluateCandidateReadinessV2(state, artifact);
    expect(readiness.readyForSemanticReview).toBeTrue();
    expect(readiness.currentAuthoritativeVerificationIds).toEqual([
      "verify-r1",
    ]);
  });

  test("R05 reviews one semantic candidate once across six different summaries", async () => {
    const content = "export function renderPublic() { return 'fixed'; }";
    const payload = buildCandidateReviewPayloadV2(baseState(), [
      {
        path: "src/public.ts",
        contentHash: candidateSnapshotHashV2(content),
        content,
      },
    ]);
    let ledger: SemanticReviewLedgerV2 = createSemanticReviewLedgerV2();
    let calls = 0;
    const summaries = Array.from(
      { length: 6 },
      (_, index) => `Final summary wording ${index + 1}`,
    );

    for (const _summary of summaries) {
      const result = await reviewCandidateOnceV2(
        ledger,
        payload,
        async (value) => {
          calls += 1;
          return {
            candidateInputHash: value.candidateInputHash,
            mutationRevision: value.input.mutationRevision,
            verdict: "pass",
            findings: [],
          };
        },
      );
      ledger = result.ledger;
    }

    expect(calls).toBe(1);
    expect(Object.keys(ledger.records)).toHaveLength(1);
  });

  test("R18 records malformed reviewer output once as partial and never retries", async () => {
    const payload = buildCandidateReviewPayloadV2(baseState(), []);
    let calls = 0;
    const first = await reviewCandidateOnceV2(
      createSemanticReviewLedgerV2(),
      payload,
      async () => {
        calls += 1;
        return { verdict: "looks-good" };
      },
    );
    const second = await reviewCandidateOnceV2(
      first.ledger,
      payload,
      async () => {
        calls += 1;
        throw new Error("must not run");
      },
    );

    expect(first.review.verdict).toBe("partial");
    expect(first.reused).toBeFalse();
    expect(second.reused).toBeTrue();
    expect(second.review).toEqual(first.review);
    expect(calls).toBe(1);
  });
});
