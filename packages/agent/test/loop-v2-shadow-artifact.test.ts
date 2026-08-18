import { describe, expect, test } from "bun:test";

import {
  assessLoopV2AuthorityEligibilityV1,
  buildLoopV2LiveCandidateArtifactV1,
  buildLoopV2LiveReviewArtifactV1,
  buildLoopV2LiveReviewPayloadV1,
  buildLoopV2LiveTerminalArtifactV1,
  buildLoopV2RunResultShadowArtifactV1,
  buildLoopV2ShadowArtifactV1,
  createLoopV2ShadowObserver,
  createSemanticReviewLedgerV2,
  observeLoopV2DurableEnvelopeV1,
  parseLoopV2LiveTerminalArtifactV1,
  parseLoopV2RunResultShadowArtifactV1,
  parseLoopV2ShadowArtifactV1,
  replayLegacyTraceToLoopV2ShadowV1,
  restoreLoopV2ProjectionObserver,
  reviewCandidateOnceV2,
  serializeLoopV2LiveTerminalArtifactV1,
  serializeLoopV2RunResultShadowArtifactV1,
  serializeLoopV2ShadowArtifactV1,
} from "../src/loop-v2/index.js";

function envelope(
  seq: number,
  event: Readonly<{ type: string } & Record<string, unknown>>,
) {
  return { runId: "shadow-artifact", seq, ts: 20_000 + seq, event };
}

function completeCandidateReport() {
  const observer = createLoopV2ShadowObserver("shadow-artifact");
  observer.observe(envelope(1, { type: "run.started", goal: "Fix value" }));
  observer.observe(
    envelope(2, {
      type: "tool.result",
      tool: "workspace.edit_file",
      ok: true,
      summary: "edited",
      workspaceEffect: { changed: true, paths: ["src/value.ts"] },
    }),
  );
  observer.observeToolCommit({
    sourceSeq: 2,
    callId: "edit-r1",
    tool: "workspace.edit_file",
    args: { path: "src/value.ts" },
    result: { ok: true, summary: "edited", payload: {} },
    repositoryRevision: "run:shadow-artifact:mutation:0",
    concurrentMutation: true,
    mutationCapture: {
      status: "complete",
      paths: ["src/value.ts"],
      beforeContents: { "src/value.ts": "export const value = 1;\n" },
      afterContents: { "src/value.ts": "export const value = 2;\n" },
    },
  });
  observer.observe(
    envelope(3, {
      type: "tool.result",
      tool: "workspace.run_shell",
      ok: true,
      summary: "1 passed",
      workspaceEffect: { changed: false, paths: [] },
    }),
  );
  observer.observeToolCommit({
    sourceSeq: 3,
    callId: "verify-r1",
    tool: "workspace.run_shell",
    args: { command: "bun test test/value.test.ts" },
    result: {
      ok: true,
      summary: "1 passed",
      payload: { stdout: "1 passed", exit_code: 0 },
    },
    repositoryRevision: "run:shadow-artifact:mutation:1",
    concurrentMutation: true,
    mutationCapture: {
      status: "complete",
      paths: [],
      beforeContents: {},
      afterContents: {},
    },
    verificationCapture: {
      runner: "bun_test",
      argv: ["bun", "test", "test/value.test.ts"],
      cwd: "C:/workspace",
      scope: ["test/value.test.ts"],
      mutationRevision: 1,
      outcome: "passed",
      exitCode: 0,
      output: "1 passed",
      authoritative: true,
    },
  });
  observer.observe(
    envelope(4, {
      type: "agent.action",
      action: { type: "final_answer", summary: "done" },
    }),
  );
  observer.observe(
    envelope(5, {
      type: "run.completed",
      status: "completed",
      message: "done",
    }),
  );
  return observer.snapshot();
}

async function reviewedCandidate(
  verificationAuthority: "local" | "external" | "not_required" = "local",
) {
  const candidate = buildLoopV2LiveCandidateArtifactV1(
    completeCandidateReport(),
    {
      requireProductMutation: true,
      verificationAuthority,
    },
  );
  const payload = buildLoopV2LiveReviewPayloadV1(candidate.report);
  const reviewed = await reviewCandidateOnceV2(
    createSemanticReviewLedgerV2(),
    payload,
    async () => ({
      candidateInputHash: payload.candidateInputHash,
      mutationRevision: payload.input.mutationRevision,
      verdict: "pass",
      findings: [],
    }),
  );
  const record = reviewed.ledger.records[reviewed.reviewKey];
  if (!record) throw new Error("review fixture did not settle");
  return {
    candidate,
    review: buildLoopV2LiveReviewArtifactV1(candidate, record),
  };
}

describe("Loop Kernel v2 shadow artifacts", () => {
  test("live terminal dual-calculation is strict and preserves external pending", async () => {
    const local = await reviewedCandidate("local");
    const localTerminal = buildLoopV2LiveTerminalArtifactV1({
      runId: local.candidate.report.runId,
      candidate: local.candidate,
      review: local.review,
      legacyTerminal: {
        status: "completed",
        outcome: "verified",
        reasonCode: "tests_passed",
      },
    });
    expect(localTerminal.v2Outcome).toMatchObject({
      executionStatus: "completed",
      candidateStatus: "certified",
      localVerification: "passed",
      externalVerification: "not_configured",
      artifactStatus: "valid",
    });
    expect(localTerminal.comparison).toBe("equal");
    const legacyResult = {
      runId: localTerminal.runId,
      status: "completed" as const,
      message: "Legacy implementing-model summary.",
      outcome: "verified" as const,
      completionReason: "tests_passed",
      evidence: {
        filesChanged: ["src/value.ts"],
        commandsRun: [
          {
            command: "bun test test/value.test.ts",
            ok: true,
            summary: "1 passed",
          },
        ],
        testResults: [
          {
            command: "bun test test/value.test.ts",
            passed: true,
            outcome: "passed" as const,
            summary: "1 passed",
          },
        ],
      },
    };
    const resultShadow = buildLoopV2RunResultShadowArtifactV1(
      legacyResult,
      localTerminal,
      local.candidate,
      local.review,
    );
    expect(resultShadow).toMatchObject({
      eligibility: { eligible: true, reasons: [] },
      mappedResult: {
        status: "completed",
        outcome: "verified",
        completionReason: "candidate_certified",
        evidence: legacyResult.evidence,
      },
      comparison: {
        authorityFieldsEqual: true,
        evidencePreserved: true,
        cutoverReady: true,
      },
    });
    expect(resultShadow.mappedResult?.message).toContain("# Paw Run Report");
    expect(resultShadow.mappedResult?.message).not.toContain(
      "Legacy implementing-model summary.",
    );
    expect(
      parseLoopV2RunResultShadowArtifactV1(
        serializeLoopV2RunResultShadowArtifactV1(
          resultShadow,
          localTerminal,
          local.candidate,
          local.review,
        ),
        localTerminal,
        local.candidate,
        local.review,
      ),
    ).toEqual(resultShadow);
    const tamperedShadow = structuredClone(resultShadow) as unknown as {
      mappedResult: { evidence: { filesChanged: string[] } };
    };
    tamperedShadow.mappedResult.evidence.filesChanged.push("src/ghost.ts");
    expect(() =>
      parseLoopV2RunResultShadowArtifactV1(
        JSON.stringify(tamperedShadow),
        localTerminal,
        local.candidate,
        local.review,
      ),
    ).toThrow("does not match evidence");
    expect(
      parseLoopV2LiveTerminalArtifactV1(
        serializeLoopV2LiveTerminalArtifactV1(
          localTerminal,
          local.candidate,
          local.review,
        ),
        local.candidate,
        local.review,
      ),
    ).toEqual(localTerminal);

    const external = await reviewedCandidate("external");
    const externalTerminal = buildLoopV2LiveTerminalArtifactV1({
      runId: external.candidate.report.runId,
      candidate: external.candidate,
      review: external.review,
      legacyTerminal: { status: "completed", outcome: "model_declared" },
    });
    expect(externalTerminal.v2Outcome).toMatchObject({
      executionStatus: "external_pending",
      candidateStatus: "certified",
      externalVerification: "pending",
    });
    expect(externalTerminal.comparison).toBe(
      "legacy_completed_v2_external_pending",
    );
    expect(
      assessLoopV2AuthorityEligibilityV1(
        externalTerminal,
        external.candidate,
        external.review,
      ),
    ).toMatchObject({
      eligible: false,
      reasons: expect.arrayContaining([
        "v2_not_completed",
        "external_verification_not_closed",
        "terminal_comparison_not_equal",
      ]),
    });
  });

  test("authority eligibility rejects trusted verification bypasses", async () => {
    const fixture = await reviewedCandidate("not_required");
    const terminal = buildLoopV2LiveTerminalArtifactV1({
      runId: fixture.candidate.report.runId,
      candidate: fixture.candidate,
      review: fixture.review,
      legacyTerminal: {
        status: "completed",
        outcome: "verified",
        reasonCode: "skip_verify",
      },
    });
    expect(terminal.comparison).toBe("equal");
    expect(
      assessLoopV2AuthorityEligibilityV1(
        terminal,
        fixture.candidate,
        fixture.review,
      ),
    ).toMatchObject({
      eligible: false,
      reasons: [
        "verification_authority_not_local",
        "local_verification_not_passed",
      ],
    });

    const local = await reviewedCandidate("local");
    const modelDeclaredTerminal = buildLoopV2LiveTerminalArtifactV1({
      runId: local.candidate.report.runId,
      candidate: local.candidate,
      review: local.review,
      legacyTerminal: {
        status: "completed",
        outcome: "model_declared",
        reasonCode: "skip_verify",
      },
    });
    expect(
      assessLoopV2AuthorityEligibilityV1(
        modelDeclaredTerminal,
        local.candidate,
        local.review,
      ).reasons,
    ).toContain("legacy_outcome_not_verified");
  });

  test("host incomplete is monotonic and terminal tampering fails closed", async () => {
    const fixture = await reviewedCandidate();
    const terminal = buildLoopV2LiveTerminalArtifactV1({
      runId: fixture.candidate.report.runId,
      candidate: fixture.candidate,
      review: fixture.review,
      legacyTerminal: {
        status: "incomplete",
        outcome: "budget_exhausted",
        reasonCode: "max_steps_exhausted_without_final",
      },
    });
    expect(terminal.v2Outcome).toMatchObject({
      executionStatus: "incomplete",
      candidateStatus: "certified",
      reasonCode: "max_steps_exhausted_without_final",
    });
    expect(terminal.comparison).toBe("equal");

    const tampered = structuredClone(terminal) as {
      v2Outcome: { executionStatus: string };
    };
    tampered.v2Outcome.executionStatus = "completed";
    expect(() =>
      parseLoopV2LiveTerminalArtifactV1(
        JSON.stringify(tampered),
        fixture.candidate,
        fixture.review,
      ),
    ).toThrow("does not match evidence");
  });

  test("persists a complete candidate as a deterministic, review-pending artifact", () => {
    const first = buildLoopV2ShadowArtifactV1(completeCandidateReport());
    const second = buildLoopV2ShadowArtifactV1(completeCandidateReport());
    const serialized = serializeLoopV2ShadowArtifactV1(first);
    const restored = parseLoopV2ShadowArtifactV1(serialized);

    expect(second).toEqual(first);
    expect(restored).toEqual(first);
    expect(serialized.endsWith("\n")).toBeTrue();
    expect(first.assessment).toMatchObject({
      facts: {
        evidence: 0,
        mutations: 1,
        verification: 1,
        candidateProposed: true,
      },
      artifact: { status: "valid", changedPaths: ["src/value.ts"] },
      readiness: {
        disposition: "ready_for_review",
        readyForSemanticReview: true,
        localVerification: "passed",
        gaps: [],
      },
      v2Outcome: {
        executionStatus: "incomplete",
        candidateStatus: "proposed",
        reasonCode: "semantic_review_missing",
      },
      comparison: "legacy_completed_v2_ready_for_review",
    });
    expect(first.assessment.coverage.projectedRatio).toBe(0.8);
  });

  test("rejects content, assessment, and top-level hash tampering", () => {
    const original = buildLoopV2ShadowArtifactV1(completeCandidateReport());
    const contentTampered = structuredClone(original) as unknown as {
      report: { artifactBlobs: Array<{ content: string }> };
    };
    const firstBlob = contentTampered.report.artifactBlobs[0];
    if (!firstBlob) throw new Error("Missing fixture blob");
    firstBlob.content = "tampered";
    expect(() =>
      parseLoopV2ShadowArtifactV1(JSON.stringify(contentTampered)),
    ).toThrow(/blob integrity/);

    const assessmentTampered = structuredClone(original) as {
      assessment: { comparison: string };
    };
    assessmentTampered.assessment.comparison = "aligned_noncompleted";
    expect(() =>
      parseLoopV2ShadowArtifactV1(JSON.stringify(assessmentTampered)),
    ).toThrow(/assessment does not match/);

    const hashTampered = { ...original, artifactHash: "bad" };
    expect(() =>
      parseLoopV2ShadowArtifactV1(JSON.stringify(hashTampered)),
    ).toThrow(/artifact hash mismatch/);
  });

  test("keeps legacy-only evidence gaps visible instead of upgrading completion", () => {
    const observer = createLoopV2ShadowObserver("shadow-artifact");
    observer.observe(
      envelope(1, { type: "run.started", goal: "Fix the old trace" }),
    );
    observer.observe(
      envelope(2, {
        type: "tool.result",
        tool: "workspace.edit_file",
        ok: true,
        summary: "edited",
        workspaceEffect: { changed: true, paths: ["src/old.ts"] },
      }),
    );
    observer.observe(
      envelope(3, {
        type: "agent.action",
        action: { type: "final_answer", summary: "done" },
      }),
    );
    observer.observe(
      envelope(4, {
        type: "run.completed",
        status: "completed",
        message: "done",
      }),
    );

    const artifact = buildLoopV2ShadowArtifactV1(observer.snapshot());
    expect(artifact.assessment.artifact.status).toBe("invalid");
    expect(artifact.assessment.readiness?.gaps.map((gap) => gap.code)).toEqual(
      expect.arrayContaining([
        "product_mutation_missing",
        "artifact_unreconstructible",
        "verification_missing",
      ]),
    );
    expect(artifact.assessment.coverage.gapsByReason).toEqual({
      legacy_mutation_missing_content_refs: 1,
    });
    expect(artifact.assessment.comparison).toBe(
      "legacy_completed_v2_not_ready",
    );
  });

  test("offline legacy replay is model-free and keeps sparse source sequences", () => {
    const trace = [
      envelope(1, { type: "run.started", goal: "Inspect old run" }),
      envelope(20, {
        type: "tool.result",
        tool: "workspace.read_file",
        ok: true,
        summary: "legacy summary",
      }),
      envelope(30, {
        type: "tool.result",
        tool: "workspace.run_shell",
        ok: true,
        summary: "legacy test output",
      }),
      envelope(40, {
        type: "run.completed",
        status: "incomplete",
        message: "budget exhausted",
      }),
    ];
    const report = replayLegacyTraceToLoopV2ShadowV1("shadow-artifact", trace);
    const artifact = buildLoopV2ShadowArtifactV1(report);

    expect(report.sourceThroughSeq).toBe(40);
    expect(artifact.assessment.legacyTerminal?.status).toBe("incomplete");
    expect(artifact.assessment.coverage.gapsByReason).toEqual({
      legacy_evidence_missing_content_identity: 1,
      legacy_verification_missing_authority_scope: 1,
    });
    expect(() =>
      replayLegacyTraceToLoopV2ShadowV1("shadow-artifact", [
        trace[1],
        trace[0],
      ]),
    ).toThrow(/sequence must increase/);
  });

  test("durable rich tool commits replay to the exact live projection", () => {
    const trace = [
      envelope(1, { type: "run.started", goal: "Change value" }),
      envelope(2, { type: "model.thinking", text: "live only snapshot" }),
      envelope(8, {
        type: "tool.result",
        tool: "workspace.edit_file",
        ok: true,
        summary: "edited src/value.ts",
        decisionCommit: {
          schemaVersion: "paw.tool-decision-commit.v1",
          callId: "legacy:shadow-artifact:turn:1:call:0",
          tool: "workspace.edit_file",
          args: { path: "src/value.ts", old_string: "a", new_string: "b" },
          result: {
            ok: true,
            payload: { path: "src/value.ts", linesAdded: 1, linesRemoved: 1 },
            summary: "edited src/value.ts",
          },
          repositoryRevision: "run:shadow-artifact:mutation:0",
          concurrentMutation: false,
          mutationCapture: {
            status: "complete",
            paths: ["src/value.ts"],
            beforeContents: { "src/value.ts": "a\n" },
            afterContents: { "src/value.ts": "b\n" },
          },
        },
      }),
      envelope(12, {
        type: "tool.result",
        tool: "workspace.grep",
        ok: true,
        summary: "found value",
        decisionCommit: {
          schemaVersion: "paw.tool-decision-commit.v1",
          callId: "legacy:shadow-artifact:turn:2:call:0",
          tool: "workspace.grep",
          args: { path: "src", pattern: "value" },
          result: {
            ok: true,
            payload: { matches: ["src/value.ts:1:b"] },
            summary: "found value",
          },
          repositoryRevision: "run:shadow-artifact:mutation:1",
          concurrentMutation: false,
          mutationCapture: {
            status: "complete",
            paths: [],
            beforeContents: {},
            afterContents: {},
          },
        },
      }),
    ];
    const live = createLoopV2ShadowObserver("shadow-artifact");
    for (const item of trace) observeLoopV2DurableEnvelopeV1(live, item);

    const prefix = createLoopV2ShadowObserver("shadow-artifact");
    for (const item of trace.slice(0, 3)) {
      observeLoopV2DurableEnvelopeV1(prefix, item);
    }
    const checkpointPlusTail = restoreLoopV2ProjectionObserver(
      prefix.snapshot(),
    );
    for (const item of trace.slice(3)) {
      observeLoopV2DurableEnvelopeV1(checkpointPlusTail, item);
    }

    const liveReport = live.snapshot();
    const replayed = replayLegacyTraceToLoopV2ShadowV1(
      "shadow-artifact",
      trace,
    );
    expect(replayed).toEqual(liveReport);
    expect(checkpointPlusTail.snapshot()).toEqual(liveReport);
    expect(replayed.sourceThroughSeq).toBe(12);
    expect(replayed.projectedEvents).toHaveLength(3);
    expect(replayed.state.currentMutationRevision).toBe(1);
    expect(Object.keys(replayed.state.evidence)).toHaveLength(1);
    expect(replayed.artifactBlobs).toHaveLength(3);
    expect(replayed.diagnostics).toHaveLength(3);
    expect(replayed.diagnostics.some((item) => item.sourceSeq === 2)).toBeFalse();
  });

  test("rejects a malformed versioned rich tool commit before partial replay", () => {
    expect(() =>
      replayLegacyTraceToLoopV2ShadowV1("shadow-artifact", [
        envelope(1, { type: "run.started", goal: "Inspect" }),
        envelope(2, {
          type: "tool.result",
          tool: "workspace.read_file",
          ok: true,
          summary: "read",
          decisionCommit: {
            schemaVersion: "paw.tool-decision-commit.v1",
            callId: " ",
          },
        }),
      ]),
    ).toThrow(/callId must not be empty/);

    expect(() =>
      replayLegacyTraceToLoopV2ShadowV1("shadow-artifact", [
        envelope(1, { type: "run.started", goal: "Inspect" }),
        envelope(2, {
          type: "tool.result",
          tool: "workspace.read_file",
          ok: true,
          summary: "outer summary",
          decisionCommit: {
            schemaVersion: "paw.tool-decision-commit.v1",
            callId: "legacy:shadow-artifact:turn:1:call:0",
            tool: "workspace.read_file",
            args: { path: "note.txt" },
            result: {
              ok: true,
              payload: { content: "hello", line_count: 1 },
              summary: "different inner summary",
            },
            repositoryRevision: "run:shadow-artifact:mutation:0",
            concurrentMutation: false,
          },
        }),
      ]),
    ).toThrow(/does not match its durable tool\.result/);
  });

  test("replays a versioned pre-execution native rejection without inventing a commit", () => {
    const trace = [
      envelope(1, { type: "run.started", goal: "Retry a native call" }),
      envelope(4, {
        type: "tool.result",
        tool: "workspace.write_file",
        ok: false,
        summary: "[Tool call not executed] arguments failed to parse.",
        decisionDisposition: {
          schemaVersion: "paw.tool-decision-disposition.v1",
          status: "not_executed",
          reason: "native_tool_rejected",
        },
      }),
    ];
    const live = createLoopV2ShadowObserver("shadow-artifact");
    for (const item of trace) observeLoopV2DurableEnvelopeV1(live, item);
    const replayed = replayLegacyTraceToLoopV2ShadowV1(
      "shadow-artifact",
      trace,
    );
    expect(replayed).toEqual(live.snapshot());
    expect(replayed.state.currentMutationRevision).toBe(0);
    expect(replayed.diagnostics.at(-1)).toMatchObject({
      disposition: "ignored",
      reason: "non_decision_event",
    });

    expect(() =>
      replayLegacyTraceToLoopV2ShadowV1("shadow-artifact", [
        envelope(1, { type: "run.started", goal: "Retry" }),
        envelope(2, {
          type: "tool.result",
          tool: "workspace.write_file",
          ok: false,
          summary: "rejected",
          decisionDisposition: {
            schemaVersion: "paw.tool-decision-disposition.v1",
            status: "not_executed",
            reason: "invented_reason",
          },
        }),
      ]),
    ).toThrow(/decision disposition is invalid/);
    expect(() =>
      replayLegacyTraceToLoopV2ShadowV1("shadow-artifact", [
        envelope(1, { type: "run.started", goal: "Retry" }),
        envelope(2, {
          type: "tool.result",
          tool: "workspace.write_file",
          ok: false,
          summary: "rejected",
          decisionCommit: {},
          decisionDisposition: {
            schemaVersion: "paw.tool-decision-disposition.v1",
            status: "not_executed",
            reason: "native_tool_rejected",
          },
        }),
      ]),
    ).toThrow(/cannot contain both/);
  });

  test("preserves a legacy runtime failure as an interrupted v2 outcome", () => {
    const observer = createLoopV2ShadowObserver("shadow-artifact");
    observer.observe(
      envelope(1, { type: "run.started", goal: "Inspect failure" }),
    );
    observer.observe(
      envelope(2, { type: "run.failed", message: "provider timeout" }),
    );
    const artifact = buildLoopV2ShadowArtifactV1(observer.snapshot(), {
      requireProductMutation: false,
      verificationAuthority: "not_required",
    });

    expect(artifact.policy).toEqual({
      requireProductMutation: false,
      verificationAuthority: "not_required",
      requiredVerificationScopes: [],
    });
    expect(artifact.assessment.v2Outcome).toMatchObject({
      executionStatus: "failed",
      candidateStatus: "none",
      reasonCode: "legacy_failed",
    });
    expect(
      parseLoopV2ShadowArtifactV1(serializeLoopV2ShadowArtifactV1(artifact)),
    ).toEqual(artifact);
  });
});
