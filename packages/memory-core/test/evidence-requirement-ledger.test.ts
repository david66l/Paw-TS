import { describe, expect, test } from "bun:test";

import { PAW_MEMORY_EVIDENCE_NOTEBOOK_POLICY_VERSION_V1 } from "../src/evidence-first.js";
import { buildMemoryEvidenceRequirementLedgerV1 } from "../src/evidence-requirement-ledger.js";

const requirement = Object.freeze({
  requirementId: "operand-a",
  label: "operand A",
  searchText: "operand A value",
  temporalMode: "any" as const,
  roleConstraint: "user" as const,
  relation: "comparative" as const,
  coverageMode: "any" as const,
  minimumEvidence: 1,
});

describe("requirement evidence ledger v1", () => {
  test("keeps visible support, candidate, and contradiction disjoint", () => {
    const ledger = buildMemoryEvidenceRequirementLedgerV1({
      requirements: [requirement],
      notebook: {
        policyVersion: PAW_MEMORY_EVIDENCE_NOTEBOOK_POLICY_VERSION_V1,
        sources: [],
        inputHitCount: 1,
        budgetOmittedHitCount: 0,
        coverage: [
          {
            requirementId: requirement.requirementId,
            status: "covered",
            selectedHitCount: 1,
            independentEvidenceCount: 1,
            closureEvidenceCount: 1,
            selectedEvidenceRefs: ["support", "shared"],
            historicalEvidenceRefs: [],
            unresolvedEvidenceRefs: ["candidate", "shared"],
          },
        ],
        selectedHitCount: 1,
        chars: 0,
      },
      assessments: [
        {
          requirementId: requirement.requirementId,
          supportingEvidenceRefs: ["support"],
          unknownEvidenceRefs: ["candidate", "not-visible"],
          contradictingEvidenceRefs: ["conflict", "shared"],
        },
      ],
      packetSources: [
        {
          sourceId: "source-1",
          text: "visible packet",
          evidenceRefs: ["support", "shared", "candidate", "conflict"],
          evidenceBindings: [],
          evidenceUses: [],
          answerRole: "mixed",
        },
      ],
    });

    expect(ledger).toEqual([
      {
        requirementId: requirement.requirementId,
        supportingEvidenceRefs: ["support", "shared"],
        candidateEvidenceRefs: ["candidate"],
        contradictingEvidenceRefs: ["conflict"],
      },
    ]);
    expect(JSON.stringify(ledger)).not.toContain("not-visible");
  });

  test("rejects a requirement that has no notebook coverage row", () => {
    expect(() =>
      buildMemoryEvidenceRequirementLedgerV1({
        requirements: [requirement],
        notebook: {
          policyVersion: PAW_MEMORY_EVIDENCE_NOTEBOOK_POLICY_VERSION_V1,
          sources: [],
          inputHitCount: 0,
          budgetOmittedHitCount: 0,
          coverage: [],
          selectedHitCount: 0,
          chars: 0,
        },
        assessments: [],
        packetSources: [],
      }),
    ).toThrow("MemoryEvidenceRequirementLedgerShapeInvalid");
  });
});
