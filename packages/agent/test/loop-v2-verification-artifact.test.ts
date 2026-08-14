import { describe, expect, test } from "bun:test";
import { applyPatch, formatPatch, parsePatch, structuredPatch } from "diff";
import {
  type ArtifactContentBlobV2,
  LOOP_V2_SCHEMA_VERSION,
  type LoopV2Event,
  type MutationJournalEntryV2,
  type SemanticReviewV2,
  type WorkingDecisionStateV2,
  artifactEvidenceV2,
  buildCandidateReviewPayloadV2,
  candidateSnapshotHashV2,
  createArtifactContentBlobV2,
  createWorkingDecisionStateV2,
  deriveRunOutcomeV2,
  evaluateCandidateReadinessV2,
  materializeCandidateArtifactV2,
  projectLoopV2Event,
  renderMutationStepPatchV2,
} from "../src/loop-v2/index.js";

const RUN_ID = "loop-v2-artifact";
const FILE = "src/value.ts";

function append(
  state: WorkingDecisionStateV2,
  event: LoopV2Event,
): WorkingDecisionStateV2 {
  return projectLoopV2Event(state, {
    schemaVersion: LOOP_V2_SCHEMA_VERSION,
    runId: RUN_ID,
    seq: state.lastSeq + 1,
    ts: 30_000 + state.lastSeq + 1,
    event,
  }).state;
}

function stepPatch(before: string, after: string): string {
  return formatPatch(
    structuredPatch(
      `a/${FILE}`,
      `b/${FILE}`,
      before,
      after,
      undefined,
      undefined,
      { context: 3 },
    ),
  );
}

function mutation(
  revision: number,
  seq: number,
  before: ArtifactContentBlobV2,
  after: ArtifactContentBlobV2,
): MutationJournalEntryV2 {
  return {
    seq,
    callId: `edit-r${revision}`,
    mutationRevision: revision,
    paths: [FILE],
    beforeHashes: { [FILE]: before.contentHash },
    afterHashes: { [FILE]: after.contentHash },
    beforeContentRefs: { [FILE]: before.ref },
    afterContentRefs: { [FILE]: after.ref },
    patch: stepPatch(before.content, after.content),
    workspaceEffect: "product",
  };
}

function startedState(): WorkingDecisionStateV2 {
  return append(createWorkingDecisionStateV2(RUN_ID), {
    type: "task.started",
    goal: "Update the product value and preserve its contract.",
    sourceHash: "artifact-goal-hash",
  });
}

function stateWithMutations(
  mutations: readonly MutationJournalEntryV2[],
): WorkingDecisionStateV2 {
  let state = startedState();
  for (const entry of mutations) {
    state = append(state, { type: "mutation.recorded", mutation: entry });
  }
  return state;
}

function externalCriterion(
  state: WorkingDecisionStateV2,
): WorkingDecisionStateV2 {
  return append(state, {
    type: "criterion.upserted",
    criterion: {
      id: "criterion-external",
      text: "Pass the external task verifier.",
      observable: "The external suite resolves the task.",
      source: "external_test_id",
      authority: "external",
      status: "pending",
      evidenceRefs: [],
      mutationRevision: state.currentMutationRevision,
    },
  });
}

function passReview(
  state: WorkingDecisionStateV2,
  terminalContent: string,
): SemanticReviewV2 {
  const payload = buildCandidateReviewPayloadV2(state, [
    {
      path: FILE,
      contentHash: candidateSnapshotHashV2(terminalContent),
      content: terminalContent,
    },
  ]);
  return {
    candidateInputHash: payload.candidateInputHash,
    mutationRevision: state.currentMutationRevision,
    verdict: "pass",
    findings: [],
  };
}

describe("Loop Kernel v2 verification and artifact", () => {
  test("R14 materializes one baseline-to-terminal patch after two edits when Git is unavailable", () => {
    const before = createArtifactContentBlobV2("export const value = 1;\n");
    const middle = createArtifactContentBlobV2("export const value = 2;\n");
    const after = createArtifactContentBlobV2(
      "export const value = 3;\nexport const ready = true;\n",
    );
    const mutations = [
      mutation(1, 2, before, middle),
      mutation(2, 3, middle, after),
    ];
    const artifact = materializeCandidateArtifactV2(
      mutations,
      [before, middle, after],
      { status: "unavailable", detail: "git diff timed out" },
    );

    expect(artifact.status).toBe("valid");
    expect(artifact.source).toBe("mutation_journal");
    expect(artifact.crossCheck.status).toBe("unavailable");
    expect(artifact.changedPaths).toEqual([FILE]);
    const finalPatches = parsePatch(artifact.patch);
    expect(finalPatches).toHaveLength(1);
    const finalPatch = finalPatches[0];
    if (!finalPatch) throw new Error("missing final materialized patch");
    expect(applyPatch(before.content, finalPatch)).toBe(after.content);
    expect(artifact.patch).not.toContain("export const value = 2;");
  });

  test("materializes CRLF snapshots into a parseable canonical patch", () => {
    const beforeText = [
      "def _cstack(left, right):",
      "    if left.ndim == 2:",
      "        cleft = left",
      "    else:",
      "        cleft = np.zeros((left, left))",
      "",
      "    if isinstance(data, Variable):",
      "        return data.data",
      "",
      "    if isinstance(data, SUPPORTED_ARRAY_TYPES):",
      "        return wrap(data)",
      "",
      "def next_function():",
      "    return None",
      "",
    ].join("\r\n");
    const afterText = beforeText.replace(
      "    if isinstance(data, SUPPORTED_ARRAY_TYPES):",
      "    if isinstance(data, DataArray):\r\n        return data.variable._data\r\n\r\n    if isinstance(data, SUPPORTED_ARRAY_TYPES):",
    );
    const before = createArtifactContentBlobV2(beforeText);
    const after = createArtifactContentBlobV2(afterText);
    const patch = renderMutationStepPatchV2([
      {
        path: FILE,
        beforeContent: beforeText,
        afterContent: afterText,
      },
    ]);
    const entry: MutationJournalEntryV2 = {
      seq: 2,
      callId: "edit-crlf",
      mutationRevision: 1,
      paths: [FILE],
      beforeHashes: { [FILE]: before.contentHash },
      afterHashes: { [FILE]: after.contentHash },
      beforeContentRefs: { [FILE]: before.ref },
      afterContentRefs: { [FILE]: after.ref },
      patch,
      workspaceEffect: "product",
    };

    expect(() => parsePatch(patch)).not.toThrow();
    const artifact = materializeCandidateArtifactV2([entry], [before, after], {
      status: "unavailable",
    });

    expect(artifact.status).toBe("valid");
    expect(artifact.patch).toContain("+        return data.variable._data");
    expect(artifact.errors).toEqual([]);
  });

  test("truncated step patches, broken continuity, and Git mismatches fail closed", () => {
    const before = createArtifactContentBlobV2("export const value = 1;\n");
    const middle = createArtifactContentBlobV2("export const value = 2;\n");
    const unrelated = createArtifactContentBlobV2("export const value = 20;\n");
    const after = createArtifactContentBlobV2("export const value = 3;\n");
    const first = mutation(1, 2, before, middle);
    const second = mutation(2, 3, middle, after);

    const truncated = materializeCandidateArtifactV2(
      [{ ...first, patch: first.patch.slice(0, 40) }],
      [before, middle],
      { status: "matched" },
    );
    expect(truncated.status).toBe("invalid");
    expect(truncated.errors.join("\n")).toContain("patch omits");

    const discontinuous = materializeCandidateArtifactV2(
      [first, mutation(2, 3, unrelated, after)],
      [before, middle, unrelated, after],
      { status: "matched" },
    );
    expect(discontinuous.status).toBe("invalid");
    expect(discontinuous.errors.join("\n")).toContain("continuity mismatch");

    const mismatch = materializeCandidateArtifactV2(
      [first, second],
      [before, middle, after],
      { status: "mismatch", detail: "untracked write detected" },
    );
    expect(mismatch.status).toBe("invalid");
    expect(mismatch.patch).toBe("");
    expect(mismatch.errors.join("\n")).toContain("untracked write detected");
  });

  test("R07 keeps a current substantive pass when a later harness check fails", () => {
    const before = createArtifactContentBlobV2("export const value = 1;\n");
    const after = createArtifactContentBlobV2("export const value = 2;\n");
    const entry = mutation(1, 2, before, after);
    let state = externalCriterion(stateWithMutations([entry]));
    state = append(state, {
      type: "verification.recorded",
      verification: {
        id: "unit-r1",
        runner: "bun_test",
        argv: ["bun", "test", "test/value.test.ts"],
        cwd: ".",
        scope: ["unit"],
        mutationRevision: 1,
        outcome: "passed",
        outputArtifactRef: "artifact://verification/unit-r1",
        authoritative: true,
      },
    });
    state = append(state, {
      type: "verification.recorded",
      verification: {
        id: "container-r1",
        runner: "custom",
        argv: ["external-container"],
        cwd: ".",
        scope: ["external"],
        mutationRevision: 1,
        outcome: "harness_failed",
        failureClass: "container_unavailable",
        outputArtifactRef: "artifact://verification/container-r1",
        authoritative: true,
      },
    });
    const artifact = materializeCandidateArtifactV2([entry], [before, after], {
      status: "matched",
    });
    const evidence = artifactEvidenceV2(artifact);
    const readiness = evaluateCandidateReadinessV2(state, evidence, {
      verificationAuthority: "local",
      requiredVerificationScopes: ["unit"],
    });
    const outcome = deriveRunOutcomeV2({
      candidateProposed: true,
      readiness,
      review: passReview(state, after.content),
      artifact: evidence,
      externalVerification: "resolved",
    });

    expect(readiness.readyForSemanticReview).toBeTrue();
    expect(readiness.localVerification).toBe("passed");
    expect(outcome.executionStatus).toBe("completed");
    expect(outcome.localVerification).toBe("passed");
    expect(outcome.externalVerification).toBe("resolved");
  });

  test("R16 records local harness failure as external_pending, never as a pass", () => {
    const before = createArtifactContentBlobV2("export const value = 1;\n");
    const after = createArtifactContentBlobV2("export const value = 2;\n");
    const entry = mutation(1, 2, before, after);
    let state = externalCriterion(stateWithMutations([entry]));
    state = append(state, {
      type: "verification.recorded",
      verification: {
        id: "external-harness-r1",
        runner: "custom",
        argv: ["external-container"],
        cwd: ".",
        scope: ["external"],
        mutationRevision: 1,
        outcome: "harness_failed",
        failureClass: "docker_unavailable",
        outputArtifactRef: "artifact://verification/external-harness-r1",
        authoritative: true,
      },
    });
    const artifact = materializeCandidateArtifactV2([entry], [before, after], {
      status: "unavailable",
      detail: "git unavailable",
    });
    const evidence = artifactEvidenceV2(artifact);
    const readiness = evaluateCandidateReadinessV2(state, evidence, {
      verificationAuthority: "external",
      requiredVerificationScopes: ["external"],
    });
    const outcome = deriveRunOutcomeV2({
      candidateProposed: true,
      readiness,
      review: passReview(state, after.content),
      artifact: evidence,
      externalVerification: "pending",
    });

    expect(readiness.gaps).toEqual([]);
    expect(readiness.readyForSemanticReview).toBeTrue();
    expect(readiness.localVerification).toBe("harness_failed");
    expect(outcome.executionStatus).toBe("external_pending");
    expect(outcome.candidateStatus).toBe("certified");
    expect(outcome.localVerification).toBe("harness_failed");
    expect(outcome.externalVerification).toBe("pending");
    expect(outcome.reasonCode).toBe("external_verification_pending");
  });
});
