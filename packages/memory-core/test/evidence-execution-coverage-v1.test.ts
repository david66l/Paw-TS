import { describe, expect, test } from "bun:test";
import { PAW_MEMORY_EVIDENCE_NOTEBOOK_POLICY_VERSION_V1 } from "../src/evidence-contracts.js";
import type { MemoryEvidenceNotebookV1 } from "../src/evidence-contracts.js";
import {
  compileMemoryEvidenceExecutionCoverageCertificateV1,
  validateMemoryEvidenceExecutionCoverageCertificateV1,
} from "../src/evidence-execution-coverage-v1.js";
import { compileMemoryEvidenceSelectorGroupsV1 } from "../src/evidence-selector-groups.js";
import type {
  MemoryEvidenceQueryIntentV3,
  MemoryEvidenceRequirementV3,
} from "../src/query-plan-contracts.js";
import { compileMemorySelectorExecutionSnapshotV1 } from "../src/selector-execution-snapshot-v1.js";
import { bindMemoryEvidenceTemporalConstraintV1 } from "../src/temporal-constraint.js";

const query = "Collect every supported item.";
const intent: MemoryEvidenceQueryIntentV3 = {
  answerShape: "aggregate",
  temporalMode: "any",
  roleConstraint: "user",
  needsPlanning: true,
};
const requirements: readonly MemoryEvidenceRequirementV3[] = [
  {
    requirementId: "items",
    label: "items",
    searchText: "items",
    temporalMode: "any",
    roleConstraint: "user",
    coverageMode: "all",
    minimumEvidence: 1,
    dependencyRelation: "independent",
    dependsOnRequirementIds: [],
  },
];
const temporalConstraints = requirements.map((requirement) =>
  bindMemoryEvidenceTemporalConstraintV1({
    query,
    queryEnvelopeMode: intent.temporalMode,
    leafMode: requirement.temporalMode,
  }),
);
const group = compileMemoryEvidenceSelectorGroupsV1({
  intent,
  requirements,
})[0];
if (!group) throw new Error("fixture invalid");
const selectorSnapshot = compileMemorySelectorExecutionSnapshotV1({
  query,
  intent,
  requirements,
  temporalConstraints,
  candidateScopes: [{ requirementId: "items", evidenceRefs: ["ref-1"] }],
  lockedSourceIds: ["source-1"],
  originRevision: "origin",
  selectorVersion: "selector",
  selectionRevision: "selection",
  committedAttempt: "baseline",
  attemptCount: 1,
  groups: [
    {
      groupId: group.groupId,
      requirementIds: group.requirementIds,
      status: "committed",
      assessments: [
        {
          requirementId: "items",
          supportingEvidenceRefs: ["ref-1"],
          contradictingEvidenceRefs: [],
          unknownEvidenceRefs: [],
          evidenceDispositions: [
            {
              requirementId: "items",
              evidenceRef: "ref-1",
              disposition: "supporting",
              resolvedRole: "user",
              evidenceUse: "user_fact",
              contextEvidenceRefs: [],
            },
          ],
        },
      ],
    },
  ],
});

function notebook(
  unresolvedEvidenceRefs: readonly string[] = [],
): MemoryEvidenceNotebookV1 {
  return {
    policyVersion: PAW_MEMORY_EVIDENCE_NOTEBOOK_POLICY_VERSION_V1,
    sources: [],
    coverage: [
      {
        requirementId: "items",
        status: "covered" as const,
        selectedHitCount: 1,
        independentEvidenceCount: 1,
        closureEvidenceCount: 1,
        selectedEvidenceRefs: ["ref-1"],
        historicalEvidenceRefs: [],
        unresolvedEvidenceRefs,
        inputEvidenceRefs: ["ref-1"],
        budgetOmittedEvidenceRefs: [],
        admission: [
          {
            evidenceRef: "ref-1",
            disposition: "selected",
            independenceIdentityRevision: "independent-ref-1",
          },
        ],
        budgetOmittedHitCount: 0,
      },
    ],
    inputHitCount: 1,
    budgetOmittedHitCount: 0,
    selectedHitCount: 1,
    chars: 64,
  };
}

function singleRequirementCoverageFixture(input: {
  query: string;
  intent: MemoryEvidenceQueryIntentV3;
  requirement: MemoryEvidenceRequirementV3;
  candidateEvidenceRefs?: readonly string[];
  additionalSupportingEvidenceRefs?: readonly string[];
  assessmentUnknownEvidenceRefs?: readonly string[];
  budgetOmittedHitCount?: number;
  selectedEvidenceRefs?: readonly string[];
  independentEvidenceCount?: number;
  closureEvidenceCount?: number;
}) {
  const temporal = [
    bindMemoryEvidenceTemporalConstraintV1({
      query: input.query,
      queryEnvelopeMode: input.intent.temporalMode,
      leafMode: input.requirement.temporalMode,
      evidenceTimeUpperBound: "2025-01-01T00:00:00.000Z",
    }),
  ];
  const group = compileMemoryEvidenceSelectorGroupsV1({
    intent: input.intent,
    requirements: [input.requirement],
  })[0];
  if (!group) throw new Error("single requirement fixture invalid");
  const evidenceRef = `ref-${input.requirement.requirementId}`;
  const supportingEvidenceRefs = [
    evidenceRef,
    ...(input.additionalSupportingEvidenceRefs ?? []),
  ];
  const candidateEvidenceRefs =
    input.candidateEvidenceRefs ?? supportingEvidenceRefs;
  const selectedEvidenceRefs = input.selectedEvidenceRefs ?? [evidenceRef];
  const snapshot = compileMemorySelectorExecutionSnapshotV1({
    query: input.query,
    intent: input.intent,
    requirements: [input.requirement],
    temporalConstraints: temporal,
    candidateScopes: [
      {
        requirementId: input.requirement.requirementId,
        evidenceRefs: candidateEvidenceRefs,
      },
    ],
    lockedSourceIds: [`source-${input.requirement.requirementId}`],
    originRevision: "origin-single",
    selectorVersion: "selector-single",
    selectionRevision: "selection-single",
    committedAttempt: "baseline",
    attemptCount: 1,
    groups: [
      {
        groupId: group.groupId,
        requirementIds: group.requirementIds,
        status: "committed",
        assessments: [
          {
            requirementId: input.requirement.requirementId,
            supportingEvidenceRefs,
            contradictingEvidenceRefs: [],
            unknownEvidenceRefs: input.assessmentUnknownEvidenceRefs ?? [],
            evidenceDispositions: supportingEvidenceRefs.map(
              (supportingEvidenceRef) => ({
                requirementId: input.requirement.requirementId,
                evidenceRef: supportingEvidenceRef,
                disposition: "supporting",
                resolvedRole: "user",
                evidenceUse: "user_fact",
                contextEvidenceRefs: [],
              }),
            ),
          },
        ],
      },
    ],
  });
  const notebook: MemoryEvidenceNotebookV1 = {
    policyVersion: PAW_MEMORY_EVIDENCE_NOTEBOOK_POLICY_VERSION_V1,
    sources: [],
    coverage: [
      {
        requirementId: input.requirement.requirementId,
        status: "covered",
        selectedHitCount: selectedEvidenceRefs.length,
        independentEvidenceCount: input.independentEvidenceCount ?? 1,
        closureEvidenceCount:
          input.closureEvidenceCount ?? selectedEvidenceRefs.length,
        selectedEvidenceRefs,
        historicalEvidenceRefs: [],
        unresolvedEvidenceRefs: [],
        inputEvidenceRefs: supportingEvidenceRefs,
        budgetOmittedEvidenceRefs:
          (input.budgetOmittedHitCount ?? 0) > 0
            ? (input.additionalSupportingEvidenceRefs ?? [])
            : [],
        admission: supportingEvidenceRefs.map((supportingEvidenceRef) => ({
          evidenceRef: supportingEvidenceRef,
          independenceIdentityRevision:
            input.independentEvidenceCount === 1
              ? `independent-${input.requirement.requirementId}`
              : `independent-${supportingEvidenceRef}`,
          disposition: selectedEvidenceRefs.includes(supportingEvidenceRef)
            ? ("selected" as const)
            : (input.budgetOmittedHitCount ?? 0) > 0
              ? ("budget_omitted" as const)
              : ("rejected" as const),
        })),
        budgetOmittedHitCount: input.budgetOmittedHitCount ?? 0,
      },
    ],
    inputHitCount: 1,
    budgetOmittedHitCount: 0,
    selectedHitCount: selectedEvidenceRefs.length,
    chars: 64,
  };
  return { temporal, snapshot, notebook };
}

describe("execution coverage certificate v1", () => {
  test("closes only when selector, notebook, and closure audit all agree", () => {
    const certificate = compileMemoryEvidenceExecutionCoverageCertificateV1({
      intent,
      requirements,
      temporalConstraints,
      selectorSnapshot,
      notebook: notebook(),
      closureAuditStatus: "completed",
      closureVerdict: "pass",
      closureAuditRevision: "closure-revision",
    });
    expect(certificate.status).toBe("closed");
    expect(certificate.requirements[0]).toMatchObject({
      status: "closed",
      reasonCodes: [],
    });
    expect(() =>
      validateMemoryEvidenceExecutionCoverageCertificateV1(certificate),
    ).not.toThrow();
  });

  test("keeps unresolved notebook peers and missing audit proof open", () => {
    const certificate = compileMemoryEvidenceExecutionCoverageCertificateV1({
      intent,
      requirements,
      temporalConstraints,
      selectorSnapshot,
      notebook: notebook(["ref-unresolved"]),
      closureAuditStatus: "fallback",
      closureVerdict: "insufficient",
    });
    expect(certificate.status).toBe("open");
    expect(certificate.requirements[0]?.reasonCodes).toEqual([
      "notebook_unresolved_peer",
      "notebook_admission_partition_incomplete",
      "closure_audit_not_passed",
    ]);
  });

  test("rejects a forged closed certificate revision", () => {
    const certificate = compileMemoryEvidenceExecutionCoverageCertificateV1({
      intent,
      requirements,
      temporalConstraints,
      selectorSnapshot,
      notebook: notebook(),
      closureAuditStatus: "completed",
      closureVerdict: "pass",
      closureAuditRevision: "closure-revision",
    });
    expect(() =>
      validateMemoryEvidenceExecutionCoverageCertificateV1({
        ...certificate,
        certificateRevision: "forged",
      }),
    ).toThrow("MemoryEvidenceExecutionCoverageCertificateInvalid");
  });

  test("binds the exact selected evidence set instead of counts alone", () => {
    const certificate = compileMemoryEvidenceExecutionCoverageCertificateV1({
      intent,
      requirements,
      temporalConstraints,
      selectorSnapshot,
      notebook: notebook(),
      closureAuditStatus: "completed",
      closureVerdict: "pass",
      closureAuditRevision: "closure-revision",
    });
    const coverage = certificate.requirements[0];
    if (!coverage) throw new Error("fixture invalid");
    expect(() =>
      validateMemoryEvidenceExecutionCoverageCertificateV1({
        ...certificate,
        requirements: [
          {
            ...coverage,
            selectedEvidenceSetRevision: "same-count-different-set",
          },
        ],
      }),
    ).toThrow("MemoryEvidenceExecutionCoverageCertificateInvalid");
  });

  test("rejects a requirement that no longer matches the selector snapshot", () => {
    const originalRequirement = requirements[0];
    if (!originalRequirement) throw new Error("fixture invalid");
    expect(() =>
      compileMemoryEvidenceExecutionCoverageCertificateV1({
        intent,
        requirements: [{ ...originalRequirement, minimumEvidence: 2 }],
        temporalConstraints,
        selectorSnapshot,
        notebook: notebook(),
        closureAuditStatus: "completed",
        closureVerdict: "pass",
        closureAuditRevision: "closure-revision",
      }),
    ).toThrow("MemoryEvidenceExecutionCoverageInputInvalid");
  });

  test("keeps forged notebook closure counts open", () => {
    const baseline = notebook();
    const row = baseline.coverage[0];
    if (!row) throw new Error("fixture invalid");
    const forgedNotebook: MemoryEvidenceNotebookV1 = {
      ...baseline,
      coverage: [{ ...row, closureEvidenceCount: 2 }],
    };
    const certificate = compileMemoryEvidenceExecutionCoverageCertificateV1({
      intent,
      requirements,
      temporalConstraints,
      selectorSnapshot,
      notebook: forgedNotebook,
      closureAuditStatus: "completed",
      closureVerdict: "pass",
      closureAuditRevision: "closure-revision",
    });

    expect(certificate.requirements[0]).toMatchObject({
      status: "open",
      reasonCodes: ["notebook_coverage_count_inconsistent"],
    });
  });

  test("closes a bounded point lookup without claiming global history closure", () => {
    const boundedQuery = "Who joined me last Saturday?";
    const boundedIntent: MemoryEvidenceQueryIntentV3 = {
      answerShape: "lookup",
      temporalMode: "range",
      roleConstraint: "user",
      needsPlanning: true,
    };
    const boundedRequirements: readonly MemoryEvidenceRequirementV3[] = [
      {
        requirementId: "companion",
        label: "companion",
        searchText: "joined companion",
        temporalMode: "range",
        roleConstraint: "user",
        coverageMode: "any",
        minimumEvidence: 1,
        dependencyRelation: "independent",
        dependsOnRequirementIds: [],
      },
    ];
    const boundedTemporal = boundedRequirements.map((requirement) =>
      bindMemoryEvidenceTemporalConstraintV1({
        query: boundedQuery,
        queryEnvelopeMode: boundedIntent.temporalMode,
        leafMode: requirement.temporalMode,
        evidenceTimeUpperBound: "2025-01-01T00:00:00.000Z",
      }),
    );
    const boundedGroup = compileMemoryEvidenceSelectorGroupsV1({
      intent: boundedIntent,
      requirements: boundedRequirements,
    })[0];
    if (!boundedGroup) throw new Error("bounded fixture invalid");
    const boundedSnapshot = compileMemorySelectorExecutionSnapshotV1({
      query: boundedQuery,
      intent: boundedIntent,
      requirements: boundedRequirements,
      temporalConstraints: boundedTemporal,
      candidateScopes: [
        { requirementId: "companion", evidenceRefs: ["ref-companion"] },
      ],
      lockedSourceIds: ["source-companion"],
      originRevision: "origin-bounded",
      selectorVersion: "selector-bounded",
      selectionRevision: "selection-bounded",
      committedAttempt: "baseline",
      attemptCount: 1,
      groups: [
        {
          groupId: boundedGroup.groupId,
          requirementIds: boundedGroup.requirementIds,
          status: "committed",
          assessments: [
            {
              requirementId: "companion",
              supportingEvidenceRefs: ["ref-companion"],
              contradictingEvidenceRefs: [],
              unknownEvidenceRefs: [],
              evidenceDispositions: [
                {
                  requirementId: "companion",
                  evidenceRef: "ref-companion",
                  disposition: "supporting",
                  resolvedRole: "user",
                  evidenceUse: "user_fact",
                  contextEvidenceRefs: [],
                },
              ],
            },
          ],
        },
      ],
    });
    const certificate = compileMemoryEvidenceExecutionCoverageCertificateV1({
      intent: boundedIntent,
      requirements: boundedRequirements,
      temporalConstraints: boundedTemporal,
      selectorSnapshot: boundedSnapshot,
      notebook: {
        policyVersion: PAW_MEMORY_EVIDENCE_NOTEBOOK_POLICY_VERSION_V1,
        sources: [],
        coverage: [
          {
            requirementId: "companion",
            status: "covered",
            selectedHitCount: 1,
            independentEvidenceCount: 1,
            closureEvidenceCount: 1,
            selectedEvidenceRefs: ["ref-companion"],
            historicalEvidenceRefs: [],
            unresolvedEvidenceRefs: [],
            inputEvidenceRefs: ["ref-companion"],
            budgetOmittedEvidenceRefs: [],
            admission: [
              {
                evidenceRef: "ref-companion",
                disposition: "selected",
                independenceIdentityRevision: "independent-ref-companion",
              },
            ],
            budgetOmittedHitCount: 0,
          },
        ],
        inputHitCount: 1,
        budgetOmittedHitCount: 0,
        selectedHitCount: 1,
        chars: 64,
      },
      closureAuditStatus: "fallback",
      closureVerdict: "insufficient",
    });

    expect(certificate.requirements[0]).toMatchObject({
      completionBasis: "bounded_window_lookup",
      status: "closed",
      reasonCodes: [],
    });
  });

  test("keeps latest and bounded history audit-backed", () => {
    const cases = [
      {
        query: "What is my latest status?",
        intent: {
          answerShape: "lookup" as const,
          temporalMode: "latest" as const,
          roleConstraint: "user" as const,
          needsPlanning: true,
        },
        requirement: {
          requirementId: "status",
          label: "status",
          searchText: "latest status",
          temporalMode: "latest" as const,
          roleConstraint: "user" as const,
          coverageMode: "latest" as const,
          minimumEvidence: 1,
          dependencyRelation: "independent" as const,
          dependsOnRequirementIds: [],
        },
        completionBasis: "frontier_complete",
      },
      {
        query: "List my visits in chronological order last month.",
        intent: {
          answerShape: "lookup" as const,
          temporalMode: "history" as const,
          roleConstraint: "user" as const,
          needsPlanning: true,
        },
        requirement: {
          requirementId: "visits",
          label: "visits",
          searchText: "visits",
          temporalMode: "history" as const,
          roleConstraint: "user" as const,
          coverageMode: "any" as const,
          minimumEvidence: 1,
          dependencyRelation: "independent" as const,
          dependsOnRequirementIds: [],
        },
        completionBasis: "closed_world_collection",
      },
    ];
    for (const item of cases) {
      const fixture = singleRequirementCoverageFixture(item);
      const certificate = compileMemoryEvidenceExecutionCoverageCertificateV1({
        intent: item.intent,
        requirements: [item.requirement],
        temporalConstraints: fixture.temporal,
        selectorSnapshot: fixture.snapshot,
        notebook: fixture.notebook,
        closureAuditStatus: "fallback",
        closureVerdict: "insufficient",
      });
      expect(certificate.requirements[0]).toMatchObject({
        completionBasis: item.completionBasis,
        status: "open",
        reasonCodes: ["closure_audit_not_passed"],
      });
    }
  });

  test("keeps a latest frontier open when the selector did not partition every candidate", () => {
    const latestIntent: MemoryEvidenceQueryIntentV3 = {
      answerShape: "lookup",
      temporalMode: "latest",
      roleConstraint: "user",
      needsPlanning: true,
    };
    const latestRequirement: MemoryEvidenceRequirementV3 = {
      requirementId: "status",
      label: "status",
      searchText: "latest status",
      temporalMode: "latest",
      roleConstraint: "user",
      coverageMode: "latest",
      minimumEvidence: 1,
      dependencyRelation: "independent",
      dependsOnRequirementIds: [],
    };
    const fixture = singleRequirementCoverageFixture({
      query: "What is my latest status?",
      intent: latestIntent,
      requirement: latestRequirement,
      candidateEvidenceRefs: ["ref-status", "ref-unassessed"],
    });
    const certificate = compileMemoryEvidenceExecutionCoverageCertificateV1({
      intent: latestIntent,
      requirements: [latestRequirement],
      temporalConstraints: fixture.temporal,
      selectorSnapshot: fixture.snapshot,
      notebook: fixture.notebook,
      closureAuditStatus: "completed",
      closureVerdict: "pass",
      closureAuditRevision: "closure-complete",
    });

    expect(certificate.requirements[0]).toMatchObject({
      completionBasis: "frontier_complete",
      status: "open",
      reasonCodes: ["selector_candidate_partition_incomplete"],
    });
  });

  test("keeps a latest frontier open when notebook budget omitted a valid hit", () => {
    const latestIntent: MemoryEvidenceQueryIntentV3 = {
      answerShape: "lookup",
      temporalMode: "latest",
      roleConstraint: "user",
      needsPlanning: true,
    };
    const latestRequirement: MemoryEvidenceRequirementV3 = {
      requirementId: "status",
      label: "status",
      searchText: "latest status",
      temporalMode: "latest",
      roleConstraint: "user",
      coverageMode: "latest",
      minimumEvidence: 1,
      dependencyRelation: "independent",
      dependsOnRequirementIds: [],
    };
    const fixture = singleRequirementCoverageFixture({
      query: "What is my latest status?",
      intent: latestIntent,
      requirement: latestRequirement,
      additionalSupportingEvidenceRefs: ["ref-omitted"],
      budgetOmittedHitCount: 1,
    });
    const certificate = compileMemoryEvidenceExecutionCoverageCertificateV1({
      intent: latestIntent,
      requirements: [latestRequirement],
      temporalConstraints: fixture.temporal,
      selectorSnapshot: fixture.snapshot,
      notebook: fixture.notebook,
      closureAuditStatus: "completed",
      closureVerdict: "pass",
      closureAuditRevision: "closure-complete",
    });

    expect(certificate.requirements[0]).toMatchObject({
      completionBasis: "frontier_complete",
      status: "open",
      reasonCodes: ["notebook_budget_omission"],
    });
  });

  test("requires zero omissions for finite endpoints and closed-world collections", () => {
    const cases = [
      {
        query: "How many days elapsed between the start and the end?",
        intent: {
          answerShape: "lookup" as const,
          temporalMode: "range" as const,
          roleConstraint: "user" as const,
          needsPlanning: true,
        },
        requirement: {
          requirementId: "events",
          label: "events",
          searchText: "start end events",
          temporalMode: "range" as const,
          roleConstraint: "user" as const,
          coverageMode: "all" as const,
          minimumEvidence: 1,
          dependencyRelation: "independent" as const,
          dependsOnRequirementIds: [],
        },
        completionBasis: "finite_endpoint_exact",
      },
      {
        query: "List every visit in chronological order last month.",
        intent: {
          answerShape: "lookup" as const,
          temporalMode: "history" as const,
          roleConstraint: "user" as const,
          needsPlanning: true,
        },
        requirement: {
          requirementId: "visits",
          label: "visits",
          searchText: "visit history",
          temporalMode: "history" as const,
          roleConstraint: "user" as const,
          coverageMode: "all" as const,
          minimumEvidence: 1,
          dependencyRelation: "independent" as const,
          dependsOnRequirementIds: [],
        },
        completionBasis: "closed_world_collection",
      },
    ];

    for (const item of cases) {
      const primaryRef = `ref-${item.requirement.requirementId}`;
      const omittedRef = `${primaryRef}-omitted`;
      const fixture = singleRequirementCoverageFixture({
        query: item.query,
        intent: item.intent,
        requirement: item.requirement,
        additionalSupportingEvidenceRefs: [omittedRef],
        budgetOmittedHitCount: 1,
      });
      const certificate = compileMemoryEvidenceExecutionCoverageCertificateV1({
        intent: item.intent,
        requirements: [item.requirement],
        temporalConstraints: fixture.temporal,
        selectorSnapshot: fixture.snapshot,
        notebook: fixture.notebook,
        closureAuditStatus: "completed",
        closureVerdict: "pass",
        closureAuditRevision: "closure-complete",
      });

      expect(certificate.requirements[0]).toMatchObject({
        completionBasis: item.completionBasis,
        status: "open",
        reasonCodes: ["notebook_budget_omission"],
      });
    }
  });

  test("uses retained fact count for all, history, and aggregate closure", () => {
    const cases = [
      {
        query: "Collect all supported facts.",
        intent: {
          answerShape: "lookup" as const,
          temporalMode: "any" as const,
          roleConstraint: "user" as const,
          needsPlanning: true,
        },
        requirement: {
          requirementId: "all-facts",
          label: "all facts",
          searchText: "all facts",
          temporalMode: "any" as const,
          roleConstraint: "user" as const,
          coverageMode: "all" as const,
          minimumEvidence: 2,
          dependencyRelation: "independent" as const,
          dependsOnRequirementIds: [],
        },
      },
      {
        query: "List the history in chronological order.",
        intent: {
          answerShape: "lookup" as const,
          temporalMode: "history" as const,
          roleConstraint: "user" as const,
          needsPlanning: true,
        },
        requirement: {
          requirementId: "history-facts",
          label: "history facts",
          searchText: "history facts",
          temporalMode: "history" as const,
          roleConstraint: "user" as const,
          coverageMode: "any" as const,
          minimumEvidence: 2,
          dependencyRelation: "independent" as const,
          dependsOnRequirementIds: [],
        },
      },
      {
        query: "Collect every supported item.",
        intent: {
          answerShape: "aggregate" as const,
          temporalMode: "any" as const,
          roleConstraint: "user" as const,
          needsPlanning: true,
        },
        requirement: {
          requirementId: "aggregate-facts",
          label: "aggregate facts",
          searchText: "aggregate facts",
          temporalMode: "any" as const,
          roleConstraint: "user" as const,
          coverageMode: "all" as const,
          minimumEvidence: 2,
          dependencyRelation: "independent" as const,
          dependsOnRequirementIds: [],
        },
      },
    ];

    for (const item of cases) {
      const firstRef = `ref-${item.requirement.requirementId}`;
      const secondRef = `${firstRef}-same-session`;
      const fixture = singleRequirementCoverageFixture({
        ...item,
        additionalSupportingEvidenceRefs: [secondRef],
        selectedEvidenceRefs: [firstRef, secondRef],
        independentEvidenceCount: 1,
        closureEvidenceCount: 2,
      });
      const certificate = compileMemoryEvidenceExecutionCoverageCertificateV1({
        intent: item.intent,
        requirements: [item.requirement],
        temporalConstraints: fixture.temporal,
        selectorSnapshot: fixture.snapshot,
        notebook: fixture.notebook,
        closureAuditStatus: "completed",
        closureVerdict: "pass",
        closureAuditRevision: "same-session-closure",
      });

      expect(certificate.requirements[0]).toMatchObject({
        status: "closed",
        independentEvidenceCount: 1,
        closureEvidenceCount: 2,
        minimumEvidence: 2,
        reasonCodes: [],
      });
    }
  });

  test("keeps convergent evidence open without two independent episodes", () => {
    const convergentIntent: MemoryEvidenceQueryIntentV3 = {
      answerShape: "lookup",
      temporalMode: "any",
      roleConstraint: "user",
      needsPlanning: true,
    };
    const convergentRequirement: MemoryEvidenceRequirementV3 = {
      requirementId: "preference",
      label: "repeated preference",
      searchText: "repeated preference",
      temporalMode: "any",
      roleConstraint: "user",
      coverageMode: "convergent",
      minimumEvidence: 2,
      dependencyRelation: "independent",
      dependsOnRequirementIds: [],
    };
    const firstRef = "ref-preference";
    const secondRef = "ref-preference-same-event";
    const fixture = singleRequirementCoverageFixture({
      query: "What activity do I appear to prefer?",
      intent: convergentIntent,
      requirement: convergentRequirement,
      additionalSupportingEvidenceRefs: [secondRef],
      selectedEvidenceRefs: [firstRef, secondRef],
      independentEvidenceCount: 1,
      closureEvidenceCount: 1,
    });
    const certificate = compileMemoryEvidenceExecutionCoverageCertificateV1({
      intent: convergentIntent,
      requirements: [convergentRequirement],
      temporalConstraints: fixture.temporal,
      selectorSnapshot: fixture.snapshot,
      notebook: fixture.notebook,
      closureAuditStatus: "completed",
      closureVerdict: "pass",
      closureAuditRevision: "convergent-closure",
    });

    expect(certificate.requirements[0]).toMatchObject({
      status: "open",
      independentEvidenceCount: 1,
      closureEvidenceCount: 1,
      minimumEvidence: 2,
      reasonCodes: ["minimum_evidence_unsatisfied"],
    });
  });

  test("recounts convergent independence from the admission ledger", () => {
    const convergentIntent: MemoryEvidenceQueryIntentV3 = {
      answerShape: "lookup",
      temporalMode: "any",
      roleConstraint: "user",
      needsPlanning: true,
    };
    const convergentRequirement: MemoryEvidenceRequirementV3 = {
      requirementId: "ledger-preference",
      label: "repeated preference",
      searchText: "repeated preference",
      temporalMode: "any",
      roleConstraint: "user",
      coverageMode: "convergent",
      minimumEvidence: 2,
      dependencyRelation: "independent",
      dependsOnRequirementIds: [],
    };
    const firstRef = "ref-ledger-preference";
    const secondRef = "ref-ledger-preference-restatement";
    const fixture = singleRequirementCoverageFixture({
      query: "What activity do I appear to prefer?",
      intent: convergentIntent,
      requirement: convergentRequirement,
      additionalSupportingEvidenceRefs: [secondRef],
      selectedEvidenceRefs: [firstRef, secondRef],
      independentEvidenceCount: 1,
      closureEvidenceCount: 1,
    });
    const baselineRow = fixture.notebook.coverage[0];
    if (!baselineRow) throw new Error("fixture invalid");
    const forgedNotebook: MemoryEvidenceNotebookV1 = {
      ...fixture.notebook,
      coverage: [
        {
          ...baselineRow,
          status: "covered",
          independentEvidenceCount: 2,
          closureEvidenceCount: 2,
        },
      ],
    };
    const certificate = compileMemoryEvidenceExecutionCoverageCertificateV1({
      intent: convergentIntent,
      requirements: [convergentRequirement],
      temporalConstraints: fixture.temporal,
      selectorSnapshot: fixture.snapshot,
      notebook: forgedNotebook,
      closureAuditStatus: "completed",
      closureVerdict: "pass",
      closureAuditRevision: "convergent-ledger",
    });

    expect(certificate.requirements[0]).toMatchObject({
      status: "open",
      reasonCodes: ["notebook_admission_partition_incomplete"],
    });
  });
});
