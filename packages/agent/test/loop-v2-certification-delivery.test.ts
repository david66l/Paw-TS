import { describe, expect, test } from "bun:test";
import {
  HOST_TASK_GOAL_REVIEW_CRITERION_ID,
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
  sha256Canonical,
} from "../src/loop-v2/index.js";

const RUN_ID = "loop-v2-django-14155";

function djangoTerminalPatch(newStart = 1) {
  const patch = [
    "diff --git a/django/urls/resolvers.py b/django/urls/resolvers.py",
    "--- a/django/urls/resolvers.py",
    "+++ b/django/urls/resolvers.py",
    `@@ -${newStart},2 +${newStart},4 @@`,
    " class ResolverMatch:",
    "-    self.func = func",
    "+    def __init__(self, func, args, kwargs):",
    "+        self.func = func.func",
    "+        self.args = func.args + args",
  ].join("\n");
  return {
    patch,
    patchHash: sha256Canonical(patch),
    changedPaths: ["django/urls/resolvers.py"],
  };
}

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
      beforeContentRefs: {
        "django/urls/resolvers.py": "artifact://content/resolver-before",
      },
      afterContentRefs: {
        "django/urls/resolvers.py": "artifact://content/resolver-after",
      },
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
  return buildCandidateReviewPayloadV2(
    djangoCandidateState(),
    [
      {
        path: "django/urls/resolvers.py",
        contentHash: candidateSnapshotHashV2(content),
        content,
      },
    ],
    djangoTerminalPatch(),
  );
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

    expect(
      reviewCandidateOnceV2(
        createSemanticReviewLedgerV2(),
        {
          ...payload,
          terminalPatch: {
            ...payload.terminalPatch,
            patch: `${payload.terminalPatch.patch}\n+tampered`,
          },
        },
        async () => ({}),
      ),
    ).rejects.toThrow("terminal patch mismatch");
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

  test("an empty repository contract can still block a visible task-goal omission", async () => {
    const base = djangoPayload();
    const payload = buildCandidateReviewPayloadV2(
      { ...djangoCandidateState(), criteria: {}, invariants: {} },
      base.snapshots,
      base.terminalPatch,
    );
    const messages = buildSemanticReviewMessagesV2(payload);
    const material = JSON.parse(
      messages[1]?.content.split("\n\n").at(-1) ?? "{}",
    ) as {
      criteria: Array<{
        id: string;
        sourceHash: string;
        goalRef: string;
      }>;
    };
    expect(material.criteria).toEqual([
      expect.objectContaining({
        id: HOST_TASK_GOAL_REVIEW_CRITERION_ID,
        sourceHash: payload.input.goalSourceHash,
        goalRef: "goal",
      }),
    ]);
    const rendered = messages.map((message) => message.content).join("\n");
    expect(rendered.split(payload.goal)).toHaveLength(2);

    const reviewed = await reviewCandidateOnceV2(
      createSemanticReviewLedgerV2(),
      payload,
      async () => ({
        candidateInputHash: payload.candidateInputHash,
        mutationRevision: payload.input.mutationRevision,
        verdict: "fail",
        findings: [
          {
            severity: "blocking",
            criterionId: HOST_TASK_GOAL_REVIEW_CRITERION_ID,
            file: "django/urls/resolvers.py",
            observedChange:
              "The terminal patch changes public state instead of limiting the requested behavior to repr.",
            risk: "The complete task goal remains observably unsatisfied.",
            evidenceRefs: ["snapshot:django/urls/resolvers.py"],
          },
        ],
      }),
    );
    expect(reviewed.review).toMatchObject({
      verdict: "fail",
      findings: [{ criterionId: HOST_TASK_GOAL_REVIEW_CRITERION_ID }],
    });

    const unknownBinding = await reviewCandidateOnceV2(
      createSemanticReviewLedgerV2(),
      payload,
      async () => ({
        candidateInputHash: payload.candidateInputHash,
        mutationRevision: payload.input.mutationRevision,
        verdict: "fail",
        findings: [
          {
            severity: "blocking",
            criterionId: "host:invented-contract",
            observedChange: "Invented binding.",
            risk: "This must not be admitted.",
            evidenceRefs: ["snapshot:django/urls/resolvers.py"],
          },
        ],
      }),
    );
    expect(unknownBinding.review.verdict).toBe("partial");

    const stateWithCollision = djangoCandidateState();
    const existingCriterion = Object.values(stateWithCollision.criteria)[0];
    if (!existingCriterion) throw new Error("missing criterion fixture");
    expect(() =>
      buildCandidateReviewPayloadV2(
        {
          ...stateWithCollision,
          criteria: {
            [HOST_TASK_GOAL_REVIEW_CRITERION_ID]: {
              ...existingCriterion,
              id: HOST_TASK_GOAL_REVIEW_CRITERION_ID,
            },
          },
        },
        base.snapshots,
        base.terminalPatch,
      ),
    ).toThrow("reserved task-goal review id");
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

  test("mandatory evidence that cannot fit fails closed instead of certifying a partial prompt", async () => {
    const payload = djangoPayload();
    let modelCalls = 0;
    const result = await reviewCandidateOnceV2(
      createSemanticReviewLedgerV2(),
      payload,
      createModelSemanticReviewerV2({
        maxInputChars: 1_000,
        model: {
          label: "must-not-run",
          async complete() {
            modelCalls += 1;
            return {
              text: JSON.stringify({
                candidateInputHash: payload.candidateInputHash,
                mutationRevision: payload.input.mutationRevision,
                verdict: "pass",
                findings: [],
              }),
            };
          },
        },
      }),
    );

    expect(modelCalls).toBe(0);
    expect(result.review.verdict).toBe("partial");
    expect(result.ledger.records[result.reviewKey]?.reasonCode).toBe(
      "reviewer_error",
    );
  });

  test("review material excludes historical patch bodies that are absent from the terminal candidate", () => {
    const payload = djangoPayload();
    const stale = "STALE_INTERMEDIATE_IMPLEMENTATION_MUST_NOT_BE_REVIEWED";
    const messages = buildSemanticReviewMessagesV2({
      ...payload,
      mutationPatches: payload.mutationPatches.map((mutation) => ({
        ...mutation,
        patch: `${mutation.patch}\n+${stale}`,
      })),
    });
    const captured = messages.map((message) => message.content).join("\n");
    const material = JSON.parse(
      messages[1]?.content.split("\n\n").at(-1) ?? "{}",
    ) as { terminalPatch: { patch: string } };

    expect(material.terminalPatch.patch).toBe(payload.terminalPatch.patch);
    expect(captured).not.toContain(stale);
    expect(captured).toContain("historicalPatchBodies");
  });

  test("large source snapshots are projected to bounded excerpts and still make one model call", async () => {
    const resolverLines = Array.from(
      { length: 5_500 },
      (_, index) => `resolver_filler_${index}`,
    );
    resolverLines[2_700] = "class ResolverMatch:";
    resolverLines[2_701] = "    def __init__(self, func, args, kwargs):";
    resolverLines[2_702] = "        self.func = func.func";
    resolverLines[4_000] = "FAR_RESOLVER_SENTINEL_MUST_BE_OMITTED";
    const helperLines = Array.from(
      { length: 4_000 },
      (_, index) => `helper_filler_${index}`,
    );
    helperLines[2_000] = "FAR_HELPER_SENTINEL_MUST_BE_OMITTED";
    const resolver = resolverLines.join("\n");
    const helper = helperLines.join("\n");
    const payload = buildCandidateReviewPayloadV2(
      djangoCandidateState(),
      [
        {
          path: "django/urls/resolvers.py",
          contentHash: candidateSnapshotHashV2(resolver),
          content: resolver,
        },
        {
          path: "django/urls/helper.py",
          contentHash: candidateSnapshotHashV2(helper),
          content: helper,
        },
      ],
      djangoTerminalPatch(2_701),
    );
    expect(
      payload.snapshots.reduce(
        (sum, snapshot) => sum + snapshot.content.length,
        0,
      ),
    ).toBeGreaterThan(120_000);
    let calls = 0;
    let captured = "";
    const reviewer = createModelSemanticReviewerV2({
      maxInputChars: 120_000,
      model: {
        label: "large-review-fixture",
        async complete(messages) {
          calls += 1;
          captured = messages.map((message) => message.content).join("\n");
          return {
            text: JSON.stringify({
              candidateInputHash: payload.candidateInputHash,
              mutationRevision: payload.input.mutationRevision,
              verdict: "pass",
              findings: [],
            }),
          };
        },
      },
    });

    await reviewer(payload);

    expect(calls).toBe(1);
    expect(captured.length).toBeLessThan(122_000);
    expect(captured).toContain("self.func = func.func");
    expect(captured).toContain("def __init__");
    expect(captured).toContain("paw.semantic-review-projection.v2");
    expect(captured).not.toContain("FAR_RESOLVER_SENTINEL_MUST_BE_OMITTED");
    expect(captured).not.toContain("FAR_HELPER_SENTINEL_MUST_BE_OMITTED");
  });

  test("multi-file hunk windows are whole units and every omitted window is explicit", () => {
    const base = djangoPayload();
    const resolver = Array.from(
      { length: 100 },
      (_, index) => `resolver_line_${index + 1}`,
    ).join("\n");
    const helper = Array.from(
      { length: 100 },
      (_, index) => `helper_line_${index + 1}`,
    ).join("\n");
    const patch = [
      "diff --git a/django/urls/resolvers.py b/django/urls/resolvers.py",
      "--- a/django/urls/resolvers.py",
      "+++ b/django/urls/resolvers.py",
      "@@ -2,1 +2,1 @@",
      "-old resolver 2",
      "+resolver_line_2",
      "@@ -70,1 +70,1 @@",
      "-old resolver 70",
      "+resolver_line_70",
      "diff --git a/django/urls/helper.py b/django/urls/helper.py",
      "--- a/django/urls/helper.py",
      "+++ b/django/urls/helper.py",
      "@@ -40,1 +40,1 @@",
      "-old helper 40",
      "+helper_line_40",
    ].join("\n");
    const payload = {
      ...base,
      terminalPatch: {
        patch,
        patchHash: sha256Canonical(patch),
        changedPaths: ["django/urls/helper.py", "django/urls/resolvers.py"],
      },
      snapshots: [
        {
          path: "django/urls/helper.py",
          contentHash: candidateSnapshotHashV2(helper),
          content: helper,
        },
        {
          path: "django/urls/resolvers.py",
          contentHash: candidateSnapshotHashV2(resolver),
          content: resolver,
        },
      ],
    };
    type ProjectedMaterial = {
      sourceContext: {
        windows: Array<{
          path: string;
          hunkStartLine: number;
          hunkEndLine: number;
          excerpt: string;
        }>;
        omissions: Array<{
          path: string;
          contentHash: string;
          hunkStartLine: number;
          hunkEndLine: number;
          reason: string;
        }>;
      };
    };
    let material: ProjectedMaterial | undefined;
    for (let budget = 2_800; budget <= 3_600; budget += 10) {
      try {
        const messages = buildSemanticReviewMessagesV2(payload, budget);
        const candidate = JSON.parse(
          messages[1]?.content.split("\n\n").at(-1) ?? "{}",
        ) as ProjectedMaterial;
        if (candidate.sourceContext.omissions.length > 0) {
          material = candidate;
          break;
        }
      } catch {
        // The mandatory section or omission manifest does not fit yet.
      }
    }
    if (!material)
      throw new Error("fixture did not exercise bounded omissions");
    const accounted = [
      ...material.sourceContext.windows,
      ...material.sourceContext.omissions,
    ].map(
      (entry) => `${entry.path}:${entry.hunkStartLine}-${entry.hunkEndLine}`,
    );

    expect(accounted.sort()).toEqual([
      "django/urls/helper.py:40-40",
      "django/urls/resolvers.py:2-2",
      "django/urls/resolvers.py:70-70",
    ]);
    expect(material.sourceContext.omissions.length).toBeGreaterThan(0);
    for (const omission of material.sourceContext.omissions) {
      expect(omission.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(omission.reason).toBe("source_window_budget");
    }
    for (const window of material.sourceContext.windows) {
      expect(window.excerpt).not.toContain("omitted by semantic-review budget");
      expect(
        window.excerpt.split("\n").every((line) => /^\d+: /.test(line)),
      ).toBeTrue();
    }
  });
});
