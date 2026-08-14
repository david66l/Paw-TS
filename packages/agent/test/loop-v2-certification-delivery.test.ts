import { describe, expect, test } from "bun:test";
import {
  LOOP_V2_SCHEMA_VERSION,
  type LoopV2Event,
  type SemanticReviewModelV2,
  type SemanticReviewV2,
  type WorkingDecisionStateV2,
  buildCandidateReviewPayloadV2,
  buildSemanticReviewMessagesV2,
  candidateSnapshotHashV2,
  createModelSemanticReviewerV2,
  createSemanticReviewLedgerV2,
  createWorkingDecisionStateV2,
  deriveRunOutcomeV2,
  evaluateCandidateReadinessV2,
  projectLoopV2Event,
  renderHostReportV2,
  reviewCandidateOnceV2,
} from "../src/loop-v2/index.js";

const RUN_ID = "loop-v2-django-14155";

function append(
  state: WorkingDecisionStateV2,
  event: LoopV2Event,
): WorkingDecisionStateV2 {
  return projectLoopV2Event(state, {
    schemaVersion: LOOP_V2_SCHEMA_VERSION,
    runId: RUN_ID,
    seq: state.lastSeq + 1,
    ts: 20_000 + state.lastSeq + 1,
    event,
  }).state;
}

function djangoCandidateState(): WorkingDecisionStateV2 {
  let state = createWorkingDecisionStateV2(RUN_ID);
  state = append(state, {
    type: "task.started",
    goal: "Fix ResolverMatch repr for functools.partial without changing its public state.",
    sourceHash: "django-14155-goal-hash",
  });
  state = append(state, {
    type: "mutation.recorded",
    mutation: {
      seq: 2,
      callId: "edit-resolver-init",
      mutationRevision: 1,
      paths: ["django/urls/resolvers.py"],
      beforeHashes: { "django/urls/resolvers.py": "before" },
      afterHashes: { "django/urls/resolvers.py": "after" },
      patch:
        "diff --git a/django/urls/resolvers.py b/django/urls/resolvers.py\n@@ ResolverMatch.__init__\n- self.func = func\n+ self.func = func.func\n+ self.args = func.args + args\n+ self.kwargs = {**func.keywords, **kwargs}",
      workspaceEffect: "product",
    },
  });
  state = append(state, {
    type: "verification.recorded",
    verification: {
      id: "django-existing-tests-r1",
      runner: "pytest",
      argv: ["pytest", "tests/urlpatterns_reverse"],
      cwd: ".",
      scope: ["tests/urlpatterns_reverse"],
      mutationRevision: 1,
      outcome: "passed",
      assertions: { passed: 102, failed: 0, total: 102 },
      outputArtifactRef: "artifact://django-tests-r1",
      authoritative: true,
    },
  });
  state = append(state, {
    type: "criterion.upserted",
    criterion: {
      id: "criterion-partial-repr",
      text: "Represent functools.partial accurately.",
      observable: "repr(ResolverMatch) displays the partial callable.",
      source: "user_explicit",
      authority: "agent",
      status: "satisfied",
      evidenceRefs: ["django-existing-tests-r1"],
      mutationRevision: 1,
    },
  });
  state = append(state, {
    type: "invariant.upserted",
    invariant: {
      id: "invariant-resolver-public-state",
      text: "ResolverMatch.func, args, and kwargs retain their existing public values.",
      source: "repository_contract",
      authority: "agent",
      status: "active",
      evidenceRefs: ["django-existing-tests-r1"],
      mutationRevision: 1,
    },
  });
  state = append(state, {
    type: "change_surface.upserted",
    changeSurface: {
      id: "surface-resolver-init",
      path: "django/urls/resolvers.py",
      symbol: "ResolverMatch.__init__",
      visibility: "public",
      observables: ["func", "args", "kwargs"],
      criterionIds: ["criterion-partial-repr"],
      mutationRevision: 1,
    },
  });
  return state;
}

function djangoPayload() {
  const content = [
    "class ResolverMatch:",
    "    def __init__(self, func, args, kwargs):",
    "        self.func = func.func",
    "        self.args = func.args + args",
    "        self.kwargs = {**func.keywords, **kwargs}",
    "    def __repr__(self): ...",
  ].join("\n");
  return buildCandidateReviewPayloadV2(djangoCandidateState(), [
    {
      path: "django/urls/resolvers.py",
      contentHash: candidateSnapshotHashV2(content),
      content,
    },
  ]);
}

const artifact = {
  reconstructible: true,
  crossCheck: "matched" as const,
  artifactRef: "artifact://django-candidate",
};

function passingReview(): SemanticReviewV2 {
  const payload = djangoPayload();
  return {
    candidateInputHash: payload.candidateInputHash,
    mutationRevision: 1,
    verdict: "pass",
    findings: [],
  };
}

describe("Loop Kernel v2 semantic certification and delivery", () => {
  test("review payload binds actual diff and source content to its stable identity", () => {
    const payload = djangoPayload();
    expect(payload.mutationPatches[0]?.patch).toContain(
      "self.func = func.func",
    );
    expect(payload.snapshots[0]?.content).toContain("ResolverMatch");

    const snapshot = payload.snapshots[0];
    if (!snapshot) throw new Error("missing Django snapshot fixture");
    const tampered = {
      ...payload,
      snapshots: [{ ...snapshot, content: "tampered" }],
    };
    expect(
      reviewCandidateOnceV2(
        createSemanticReviewLedgerV2(),
        tampered,
        async () => ({}),
      ),
    ).rejects.toThrow("snapshot mismatch");
  });

  test("model reviewer is a one-call, tool-free, de-anchored adapter", async () => {
    const payload = djangoPayload();
    let calls = 0;
    let captured = "";
    const model: SemanticReviewModelV2 = {
      label: "fake-reviewer",
      async complete(messages) {
        calls += 1;
        captured = messages.map((message) => message.content).join("\n");
        return {
          text: JSON.stringify({
            candidateInputHash: payload.candidateInputHash,
            mutationRevision: 1,
            verdict: "pass",
            findings: [],
          }),
        };
      },
    };
    const reviewer = createModelSemanticReviewerV2({ model });
    const result = await reviewer(payload);

    expect(calls).toBe(1);
    expect(result).toEqual(
      expect.objectContaining({ verdict: "pass", mutationRevision: 1 }),
    );
    expect(captured).toContain("self.func = func.func");
    expect(captured).toContain("ResolverMatch.func, args, and kwargs");
    expect(captured).not.toContain("proposedSummary");
    expect(captured).not.toContain("deliberation");
    expect(captured).not.toContain("final_answer");
  });

  test("R04 binds the widened public state and requires a smaller alternative", async () => {
    const payload = djangoPayload();
    let calls = 0;
    const result = await reviewCandidateOnceV2(
      createSemanticReviewLedgerV2(),
      payload,
      async () => {
        calls += 1;
        return {
          candidateInputHash: payload.candidateInputHash,
          mutationRevision: 1,
          verdict: "fail",
          findings: [
            {
              severity: "blocking",
              invariantId: "invariant-resolver-public-state",
              file: "django/urls/resolvers.py",
              line: 3,
              observedChange:
                "ResolverMatch.__init__ rewrites func, args, and kwargs.",
              risk: "A repr-only request now changes observable public state.",
              minimalAlternative:
                "Keep __init__ state unchanged and branch only inside __repr__ for functools.partial.",
              evidenceRefs: [
                "mutation:edit-resolver-init",
                "surface:surface-resolver-init",
                "snapshot:django/urls/resolvers.py",
              ],
            },
          ],
        };
      },
    );

    expect(calls).toBe(1);
    expect(result.review.verdict).toBe("fail");
    expect(result.review.findings[0]?.minimalAlternative).toContain(
      "only inside __repr__",
    );

    const invalid = await reviewCandidateOnceV2(
      createSemanticReviewLedgerV2(),
      payload,
      async () => ({
        candidateInputHash: payload.candidateInputHash,
        mutationRevision: 1,
        verdict: "fail",
        findings: [
          {
            severity: "blocking",
            invariantId: "invariant-resolver-public-state",
            observedChange: "Public state changed.",
            risk: "Contract regression.",
            evidenceRefs: ["surface:surface-resolver-init"],
          },
        ],
      }),
    );
    expect(invalid.review.verdict).toBe("partial");
  });

  test("R06 host report omits an unsupported manual-check claim without reviewing again", () => {
    const payload = djangoPayload();
    const readiness = evaluateCandidateReadinessV2(
      djangoCandidateState(),
      artifact,
    );
    const review = passingReview();
    const outcome = deriveRunOutcomeV2({
      candidateProposed: true,
      readiness,
      review,
      artifact,
    });
    const report = renderHostReportV2({
      candidate: payload.input,
      outcome,
      review,
      candidateNote: {
        overview: "Updated ResolverMatch behavior.",
        verificationClaims: [
          {
            verificationId: "unrecorded-manual-check",
            outcome: "passed",
            statement: "A manual partial-function check passed.",
          },
        ],
      },
    });

    expect(report.markdown).toContain("django-existing-tests-r1");
    expect(report.markdown).not.toContain(
      "A manual partial-function check passed.",
    );
    expect(report.markdown).toContain("unsupported candidate verification");
    expect(report.omittedClaims).toEqual([
      expect.objectContaining({
        verificationId: "unrecorded-manual-check",
        reason: "unknown_verification",
      }),
    ]);
  });

  test("R08 keeps internal certification and external rejection orthogonal", () => {
    const readiness = evaluateCandidateReadinessV2(
      djangoCandidateState(),
      artifact,
    );
    const outcome = deriveRunOutcomeV2({
      candidateProposed: true,
      readiness,
      review: passingReview(),
      artifact,
      externalVerification: "rejected",
    });

    expect(outcome.executionStatus).toBe("completed");
    expect(outcome.candidateStatus).toBe("certified");
    expect(outcome.localVerification).toBe("passed");
    expect(outcome.externalVerification).toBe("rejected");
    expect(outcome.artifactStatus).toBe("valid");
    expect(outcome.reasonCode).toBe("external_verification_rejected");
  });

  test("external resolution cannot disguise an internally uncertified candidate", () => {
    const readiness = {
      ...evaluateCandidateReadinessV2(djangoCandidateState(), artifact),
      disposition: "needs_work" as const,
      readyForSemanticReview: false,
      gaps: [
        {
          code: "criterion_pending" as const,
          message: "Local contract is still pending.",
        },
      ],
    };
    const outcome = deriveRunOutcomeV2({
      candidateProposed: true,
      readiness,
      review: passingReview(),
      artifact,
      externalVerification: "resolved",
    });

    expect(outcome.executionStatus).toBe("incomplete");
    expect(outcome.candidateStatus).toBe("proposed");
    expect(outcome.externalVerification).toBe("resolved");
    expect(outcome.reasonCode).toBe("criterion_pending");
  });

  test("semantic prompt size fails explicitly instead of silently truncating evidence", () => {
    expect(() => buildSemanticReviewMessagesV2(djangoPayload(), 1_000)).toThrow(
      "exceeds 1000 characters",
    );
  });
});
