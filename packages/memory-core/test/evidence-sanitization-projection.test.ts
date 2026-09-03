import { describe, expect, test } from "bun:test";
import { hashTextV1 } from "../src/canonical.js";
import {
  compileMemoryDialogueCertificateRegistryV1,
  validateMemoryDialogueCertificateRegistryV1,
} from "../src/dialogue-certificate.js";
import type { MemoryEvidenceNotebookHitV1 } from "../src/evidence-contracts.js";
import { memoryEvidenceExecutableExposureRefsV1 } from "../src/evidence-repair-dominance.js";
import type { MemoryEvidenceResolutionPassV1 } from "../src/evidence-resolution-pass.js";
import {
  beginMemoryEvidenceSanitizationV1,
  completeMemoryEvidenceSanitizationV1,
  failMemoryEvidenceSanitizationV1,
  projectMemoryEvidenceSanitizedBaselineV1,
} from "../src/evidence-sanitization-projection.js";

describe("evidence sanitization projection", () => {
  test("removes a whole mixed source while preserving clean source identity and order", () => {
    const contaminated = source("s1", ["rejected", "same-source-clean"]);
    const cleanFirst = source("s2", ["clean-2"]);
    const cleanSecond = source("s3", ["clean-3"]);
    const initial = pass({ sources: [contaminated, cleanFirst, cleanSecond] });

    const result = projectMemoryEvidenceSanitizedBaselineV1({
      initial,
      rejectedEvidenceRefs: new Set(["rejected"]),
    });

    expect(result.pass.packetSources).toEqual([cleanFirst, cleanSecond]);
    expect(result.pass.packetSources[0]).toBe(cleanFirst);
    expect(result.pass.packetSources[1]).toBe(cleanSecond);
    expect(result.pass.notebook.sources).toEqual([cleanFirst, cleanSecond]);
    expect(
      result.pass.requirementHits.flat().map((hit) => hit.evidenceRef),
    ).toEqual(["clean-2", "clean-3"]);
    expect(result.report).toMatchObject({
      status: "projected",
      contaminatedSourceCount: 1,
      removedPacketSourceCount: 1,
      retainedPacketSourceCount: 2,
      rejectedEvidenceLeakCount: 0,
    });
  });

  test("treats a rejected context address as source contamination", () => {
    const contaminated = source("s1", ["anchor"]);
    const clean = source("s2", ["clean"]);
    const initial = pass({
      sources: [contaminated, clean],
      hits: [hit("s1", "anchor", ["rejected-neighbor"]), hit("s2", "clean")],
    });

    const result = projectMemoryEvidenceSanitizedBaselineV1({
      initial,
      rejectedEvidenceRefs: new Set(["rejected-neighbor"]),
    });

    expect(result.pass.packetSources).toEqual([clean]);
    expect(result.pass.requirementHits.flat()).toEqual([hit("s2", "clean")]);
    expect(result.report.contaminatedSourceCount).toBe(1);
  });

  test("removes every source carrying the same rejected evidence address", () => {
    const initial = pass({
      sources: [source("s1", ["shared"]), source("s2", ["shared"])],
      hits: [hit("s1", "shared"), hit("s2", "shared")],
    });

    const result = projectMemoryEvidenceSanitizedBaselineV1({
      initial,
      rejectedEvidenceRefs: new Set(["shared"]),
    });

    expect(result.pass.packetSources).toEqual([]);
    expect(result.report.contaminatedSourceCount).toBe(2);
  });

  test("closes contamination transitively across a shared evidence address", () => {
    const initial = pass({
      sources: [
        source("s1", ["rejected", "shared"]),
        source("s2", ["shared", "otherwise-clean"]),
      ],
    });

    const result = projectMemoryEvidenceSanitizedBaselineV1({
      initial,
      rejectedEvidenceRefs: new Set(["rejected"]),
    });

    expect(result.pass.packetSources).toEqual([]);
    expect(result.pass.requirementHits.flat()).toEqual([]);
    expect(result.report.contaminatedSourceCount).toBe(2);
    expect(result.report.retainedEvidenceCount).toBe(0);
  });

  test("removes a contaminated dialogue certificate and keeps its registry valid", () => {
    const precedingContent = "Please remember this.";
    const assistantContent = "I will remember this.";
    const registry = compileMemoryDialogueCertificateRegistryV1({
      lockedSourceIds: ["s1", "s2"],
      proofs: [
        {
          sourceId: "s1",
          precedingUser: {
            evidenceRef: "predecessor",
            sourceKind: "user_input",
            turnOrder: 1,
            content: precedingContent,
            contentHash: hashTextV1(precedingContent),
          },
          assistant: {
            evidenceRef: "assistant",
            sourceKind: "assistant_output",
            turnOrder: 2,
            content: assistantContent,
            contentHash: hashTextV1(assistantContent),
          },
        },
      ],
      verifierVersion: "test-verifier.v1",
      verificationRevision: "test-verification",
      originRevision: "test-origin",
    });
    const clean = source("s2", ["clean"]);
    const initial = pass({
      sources: [source("s1", ["assistant", "predecessor"]), clean],
      registry,
    });

    const result = projectMemoryEvidenceSanitizedBaselineV1({
      initial,
      rejectedEvidenceRefs: new Set(["predecessor"]),
    });

    expect(result.pass.packetSources).toEqual([clean]);
    expect(result.pass.dialogueCertificateRegistry.certificates).toEqual([]);
    expect(() =>
      validateMemoryDialogueCertificateRegistryV1(
        result.pass.dialogueCertificateRegistry,
      ),
    ).not.toThrow();
  });

  test("never increases any executable evidence exposure", () => {
    const initial = pass({
      sources: [source("s1", ["rejected"]), source("s2", ["clean"])],
    });

    const result = projectMemoryEvidenceSanitizedBaselineV1({
      initial,
      rejectedEvidenceRefs: new Set(["rejected"]),
    });
    const before = memoryEvidenceExecutableExposureRefsV1(initial);
    const after = memoryEvidenceExecutableExposureRefsV1(result.pass);

    expect([...after].every((evidenceRef) => before.has(evidenceRef))).toBe(
      true,
    );
    expect(after.has("rejected")).toBe(false);
  });

  test("counts one surviving evidence address only once across requirements", () => {
    const baseline = pass({
      sources: [source("s1", ["rejected"]), source("s2", ["shared"])],
    });
    const sharedHit = hit("s2", "shared");
    const sharedCoverage = baseline.notebook.coverage[0];
    const requirement = baseline.requirements[0];
    if (sharedCoverage === undefined || requirement === undefined) {
      throw new Error("missing test fixture");
    }
    const initial = {
      ...baseline,
      requirements: [
        { ...requirement, requirementId: "r1" },
        { ...requirement, requirementId: "r2" },
      ],
      requirementHits: [[sharedHit], [sharedHit]],
      supportAssessments: [
        {
          requirementId: "r1",
          supportingEvidenceRefs: ["shared"],
          contradictingEvidenceRefs: [],
          unknownEvidenceRefs: [],
        },
        {
          requirementId: "r2",
          supportingEvidenceRefs: ["shared"],
          contradictingEvidenceRefs: [],
          unknownEvidenceRefs: [],
        },
      ],
      notebook: {
        ...baseline.notebook,
        coverage: [
          {
            ...sharedCoverage,
            requirementId: "r1",
            selectedEvidenceRefs: ["shared"],
          },
          {
            ...sharedCoverage,
            requirementId: "r2",
            selectedEvidenceRefs: ["shared"],
          },
        ],
        selectedHitCount: 1,
      },
    } as unknown as MemoryEvidenceResolutionPassV1;

    const result = projectMemoryEvidenceSanitizedBaselineV1({
      initial,
      rejectedEvidenceRefs: new Set(["rejected"]),
    });

    expect(result.pass.notebook.coverage).toHaveLength(2);
    expect(result.pass.notebook.selectedHitCount).toBe(1);
  });

  test("records content-free attempted, projected, and failed transactions", () => {
    const rejectedEvidenceRefs = new Set(["rejected"]);
    const attempted = beginMemoryEvidenceSanitizationV1({
      attempt: 1,
      rejectedEvidenceRefs,
    });
    const projection = projectMemoryEvidenceSanitizedBaselineV1({
      initial: pass({ sources: [source("s1", ["rejected"])] }),
      rejectedEvidenceRefs,
    }).report;
    const projected = completeMemoryEvidenceSanitizationV1({
      attempt: 1,
      projection,
    });
    const failed = failMemoryEvidenceSanitizationV1({
      attempt: 2,
      rejectedEvidenceRefs: new Set(["rejected", "second-reject"]),
      error: Object.assign(new Error("private detail"), {
        name: "MemoryEvidenceSanitizationProjectionInvalid",
      }),
    });

    expect(attempted).toMatchObject({
      status: "attempted",
      attempt: 1,
      rejectedEvidenceCount: 1,
    });
    expect(projected).toMatchObject({
      status: "projected",
      attempt: 1,
      rejectedEvidenceCount: 1,
      rejectedEvidenceLeakCount: 0,
    });
    expect(failed).toMatchObject({
      status: "failed",
      attempt: 2,
      rejectedEvidenceCount: 2,
      failureCode: "MemoryEvidenceSanitizationProjectionInvalid",
    });
    expect(failed.rejectedEvidenceRevision).not.toBe(
      attempted.rejectedEvidenceRevision,
    );
    expect(failed).not.toHaveProperty("message");
  });
});

type NotebookSource =
  MemoryEvidenceResolutionPassV1["notebook"]["sources"][number];

function source(
  sourceId: string,
  evidenceRefs: readonly string[],
): NotebookSource {
  return Object.freeze({
    sourceId,
    text: `${sourceId}:${evidenceRefs.join(",")}`,
    evidenceRefs: Object.freeze([...evidenceRefs]),
    evidenceBindings: Object.freeze(
      evidenceRefs.map((evidenceRef) => ({
        evidenceRef,
        evidenceUse: "user_fact" as const,
      })),
    ),
    evidenceUses: Object.freeze(["user_fact" as const]),
    answerRole: "supporting" as const,
  });
}

function hit(
  sourceId: string,
  evidenceRef: string,
  contextEvidenceRefs: readonly string[] = [],
): MemoryEvidenceNotebookHitV1 {
  return Object.freeze({
    sourceId,
    evidenceRef,
    content: `${sourceId}:${evidenceRef}`,
    authority: "user_asserted" as const,
    sourceKind: "user_input" as const,
    episodeOrder: Number(sourceId.slice(1)),
    turnOrder: 1,
    contextEvidenceRefs: Object.freeze([...contextEvidenceRefs]),
  });
}

function pass(input: {
  sources: readonly NotebookSource[];
  hits?: readonly MemoryEvidenceNotebookHitV1[];
  registry?: MemoryEvidenceResolutionPassV1["dialogueCertificateRegistry"];
}): MemoryEvidenceResolutionPassV1 {
  const hits =
    input.hits ??
    input.sources.flatMap((item) =>
      item.evidenceRefs.map((evidenceRef) => hit(item.sourceId, evidenceRef)),
    );
  const evidenceRefs = hits.map((item) => item.evidenceRef);
  const lockedSourceIds = input.sources.map((item) => item.sourceId);
  return {
    requirements: [
      {
        requirementId: "r1",
        label: "fact",
        searchText: "fact",
        temporalMode: "any",
        roleConstraint: "user",
        relation: "direct",
        coverageMode: "any",
      },
    ],
    fusion: {
      policyVersion: "test-fusion",
      sources: lockedSourceIds.map((sourceId) => ({ sourceId })),
    },
    sourceAcquisition: { policyVersion: "test-acquisition" },
    degradedChannels: [],
    requirementHits: [Object.freeze([...hits])],
    supportSelectorStatus: "completed",
    supportSelectionRevision: "test-selection",
    supportAssessments: [
      {
        requirementId: "r1",
        supportingEvidenceRefs: Object.freeze([...evidenceRefs]),
        contradictingEvidenceRefs: [],
        unknownEvidenceRefs: [],
      },
    ],
    selectorExecutionSnapshot: {} as never,
    sourceLocalization: {
      status: "completed",
      reasonCode: "test",
      addedCandidateCount: 0,
      retainedContextCandidateCount: 0,
      selectedCandidateCount: 0,
    },
    lockedSourceIds,
    notebook: {
      policyVersion: "paw.memory-evidence-notebook.v5:bounded-per-requirement",
      sources: input.sources,
      coverage: [
        {
          requirementId: "r1",
          status: evidenceRefs.length === 0 ? "missing" : "covered",
          selectedHitCount: evidenceRefs.length,
          independentEvidenceCount: evidenceRefs.length,
          closureEvidenceCount: evidenceRefs.length,
          selectedEvidenceRefs: Object.freeze([...evidenceRefs]),
          historicalEvidenceRefs: [],
          unresolvedEvidenceRefs: [],
          inputEvidenceRefs: Object.freeze([...evidenceRefs]),
          budgetOmittedEvidenceRefs: [],
          admission: Object.freeze(
            evidenceRefs.map((evidenceRef) => ({
              evidenceRef,
              disposition: "selected" as const,
              independenceIdentityRevision: `identity:${evidenceRef}`,
            })),
          ),
          budgetOmittedHitCount: 0,
        },
      ],
      inputHitCount: evidenceRefs.length,
      budgetOmittedHitCount: 0,
      selectedHitCount: evidenceRefs.length,
      chars: input.sources.reduce((count, item) => count + item.text.length, 0),
    },
    requirementEvidence: [
      {
        requirementId: "r1",
        supportingEvidenceRefs: Object.freeze([...evidenceRefs]),
        candidateEvidenceRefs: [],
        contradictingEvidenceRefs: [],
      },
    ],
    packetSources: input.sources,
    dialogueCertificateRegistry:
      input.registry ??
      compileMemoryDialogueCertificateRegistryV1({
        lockedSourceIds,
        proofs: [],
        verifierVersion: null,
        verificationRevision: null,
        originRevision: "test-origin",
      }),
  } as unknown as MemoryEvidenceResolutionPassV1;
}
