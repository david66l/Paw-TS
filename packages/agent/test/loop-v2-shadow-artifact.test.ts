import { describe, expect, test } from "bun:test";

import {
  buildLoopV2ShadowArtifactV1,
  createLoopV2ShadowObserver,
  parseLoopV2ShadowArtifactV1,
  replayLegacyTraceToLoopV2ShadowV1,
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

describe("Loop Kernel v2 shadow artifacts", () => {
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
    const contentTampered = structuredClone(original) as {
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
    });
    expect(() =>
      replayLegacyTraceToLoopV2ShadowV1("shadow-artifact", [
        trace[1],
        trace[0],
      ]),
    ).toThrow(/sequence must increase/);
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
