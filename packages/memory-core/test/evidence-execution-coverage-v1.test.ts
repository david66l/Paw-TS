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
      },
    ],
    inputHitCount: 1,
    budgetOmittedHitCount: 0,
    selectedHitCount: 1,
    chars: 64,
  };
}

describe("execution coverage certificate v1", () => {
  test("closes only when selector, notebook, and closure audit all agree", () => {
    const certificate = compileMemoryEvidenceExecutionCoverageCertificateV1({
      requirements,
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
      requirements,
      selectorSnapshot,
      notebook: notebook(["ref-unresolved"]),
      closureAuditStatus: "fallback",
      closureVerdict: "insufficient",
    });
    expect(certificate.status).toBe("open");
    expect(certificate.requirements[0]?.reasonCodes).toEqual([
      "notebook_unresolved_peer",
      "closure_audit_not_passed",
    ]);
  });

  test("rejects a forged closed certificate revision", () => {
    const certificate = compileMemoryEvidenceExecutionCoverageCertificateV1({
      requirements,
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
      requirements,
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
});
