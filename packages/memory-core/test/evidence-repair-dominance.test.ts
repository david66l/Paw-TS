import { describe, expect, test } from "bun:test";
import type { MemoryEvidenceNotebookHitV1 } from "../src/evidence-contracts.js";
import { evaluateMemoryEvidenceRepairDominanceV1 } from "../src/evidence-repair-dominance.js";
import type { MemoryEvidenceResolutionPassV1 } from "../src/evidence-resolution-pass.js";

describe("closure repair commit-on-dominance", () => {
  test("commits a strict tail append", () => {
    const baseline = pass();
    const repaired = pass({ appended: true });

    expect(report(baseline, repaired)).toMatchObject({
      status: "committed",
      reason: "dominant",
      packetEvidenceCountDelta: 1,
      protectedProofOrderPreserved: true,
      protectedReaderOrderPreserved: true,
    });
  });

  test.each([
    [
      "proof replacement",
      { replaceProof: true },
      "protected_proof_lost_or_reordered",
    ],
    [
      "support downgrade",
      { downgradeSupport: true },
      "protected_support_downgraded",
    ],
    [
      "content mutation",
      { mutateHit: true },
      "protected_evidence_identity_changed",
    ],
    [
      "reader source loss",
      { dropFallbackSource: true },
      "protected_reader_source_lost_or_reordered",
    ],
    [
      "answer role downgrade",
      { downgradeAnswerRole: true },
      "protected_answer_role_changed",
    ],
  ] as const)("rolls back %s", (_label, options, reason) => {
    const baseline = pass({
      fallbackSource:
        "dropFallbackSource" in options && options.dropFallbackSource,
    });
    const repaired = pass(options);

    expect(report(baseline, repaired)).toMatchObject({
      status: "rolled_back",
      reason,
    });
  });

  test("rejects any repaired packet that leaks an audited ref", () => {
    const baseline = pass();
    const repaired = pass();

    expect(
      evaluateMemoryEvidenceRepairDominanceV1({
        baseline,
        repaired,
        rejectedEvidenceRefs: new Set(["e1"]),
      }),
    ).toMatchObject({
      status: "rolled_back",
      reason: "rejected_evidence_leaked",
      rejectedEvidenceLeakCount: 1,
    });
  });

  test("rejects an audited ref outside the rendered packet", () => {
    const baseline = pass();
    const visible = pass();
    const repaired = {
      ...visible,
      requirementHits: [[]],
      supportAssessments: [
        {
          requirementId: "r1",
          supportingEvidenceRefs: [],
          contradictingEvidenceRefs: [],
          unknownEvidenceRefs: [],
        },
      ],
      notebook: {
        ...visible.notebook,
        sources: [],
        coverage: [
          {
            ...visible.notebook.coverage[0],
            selectedEvidenceRefs: [],
            historicalEvidenceRefs: ["e1"],
          },
        ],
      },
      requirementEvidence: [
        {
          requirementId: "r1",
          supportingEvidenceRefs: [],
          candidateEvidenceRefs: [],
          contradictingEvidenceRefs: [],
        },
      ],
      packetSources: [],
    } as unknown as MemoryEvidenceResolutionPassV1;

    expect(
      evaluateMemoryEvidenceRepairDominanceV1({
        baseline,
        repaired,
        rejectedEvidenceRefs: new Set(["e1"]),
      }),
    ).toMatchObject({
      status: "rolled_back",
      reason: "rejected_evidence_leaked",
      rejectedEvidenceLeakCount: 1,
    });
  });
});

function report(
  baseline: MemoryEvidenceResolutionPassV1,
  repaired: MemoryEvidenceResolutionPassV1,
) {
  return evaluateMemoryEvidenceRepairDominanceV1({
    baseline,
    repaired,
    rejectedEvidenceRefs: new Set(),
  });
}

function pass(
  options: {
    readonly appended?: boolean;
    readonly replaceProof?: boolean;
    readonly downgradeSupport?: boolean;
    readonly mutateHit?: boolean;
    readonly fallbackSource?: boolean;
    readonly dropFallbackSource?: boolean;
    readonly downgradeAnswerRole?: boolean;
  } = {},
): MemoryEvidenceResolutionPassV1 {
  const e1 = hit("e1", options.mutateHit ? "mutated" : "fact one");
  const e2 = hit("e2", "fact two");
  const selectedRefs = options.replaceProof
    ? ["e2"]
    : options.appended
      ? ["e1", "e2"]
      : ["e1"];
  const hits = options.replaceProof || options.appended ? [e1, e2] : [e1];
  const packetRefs = options.appended ? ["e1", "e2"] : ["e1"];
  const packetSources = [
    {
      sourceId: "s1",
      text: options.appended
        ? "header\nfact one\nfact two"
        : "header\nfact one",
      evidenceRefs: packetRefs,
      evidenceBindings: packetRefs.map((evidenceRef) => ({
        evidenceRef,
        evidenceUse: "user_fact" as const,
      })),
      evidenceUses: ["user_fact" as const],
      answerRole: options.downgradeAnswerRole
        ? ("candidate" as const)
        : ("supporting" as const),
    },
    ...(options.fallbackSource && !options.dropFallbackSource
      ? [
          {
            sourceId: "s2",
            text: "fallback",
            evidenceRefs: ["fallback"],
            evidenceBindings: [
              { evidenceRef: "fallback", evidenceUse: "user_fact" as const },
            ],
            evidenceUses: ["user_fact" as const],
            answerRole: "candidate" as const,
          },
        ]
      : []),
  ];
  const result = {
    requirements: [
      {
        requirementId: "r1",
        label: "fact",
        searchText: "fact",
        temporalMode: "any" as const,
        roleConstraint: "user" as const,
      },
    ],
    fusion: {
      policyVersion: "test-fusion",
      sources: [{ sourceId: "s1" }, { sourceId: "s2" }],
    },
    sourceAcquisition: { policyVersion: "test-acquisition" },
    degradedChannels: [],
    requirementHits: [hits],
    supportAssessments: [
      {
        requirementId: "r1",
        supportingEvidenceRefs: options.downgradeSupport ? [] : ["e1"],
        contradictingEvidenceRefs: [],
        unknownEvidenceRefs: [],
      },
    ],
    lockedSourceIds: ["s1", "s2"],
    notebook: {
      coverage: [
        {
          requirementId: "r1",
          status: "covered" as const,
          selectedEvidenceRefs: selectedRefs,
          historicalEvidenceRefs: [],
          unresolvedEvidenceRefs: [],
          closureEvidenceCount: selectedRefs.length,
        },
      ],
    },
    requirementEvidence: [
      {
        requirementId: "r1",
        supportingEvidenceRefs: options.downgradeSupport ? [] : ["e1"],
        candidateEvidenceRefs: [],
        contradictingEvidenceRefs: [],
      },
    ],
    packetSources,
    dialogueCertificateRegistry: { certificates: [] },
  };
  return result as unknown as MemoryEvidenceResolutionPassV1;
}

function hit(
  evidenceRef: string,
  content: string,
): MemoryEvidenceNotebookHitV1 {
  return {
    sourceId: "s1",
    evidenceRef,
    content,
    authority: "user_asserted",
    sourceKind: "user_input",
    observedAt: "2025-01-01T00:00:00.000Z",
    episodeOrder: 1,
    turnOrder: evidenceRef === "e1" ? 1 : 2,
  };
}
