import { describe, expect, test } from "bun:test";

import {
  type MemoryEvidenceClosureAuditInputV1,
  buildMemoryEvidenceClosureAuditRequestV1,
  createJsonMemoryEvidenceClosureAuditorV1,
  parseMemoryEvidenceClosureAuditV1,
} from "../src/evidence-closure-auditor.js";

describe("independent evidence closure auditor v1", () => {
  test("compares the original query with compact selected evidence", () => {
    const request = buildMemoryEvidenceClosureAuditRequestV1(auditInput());
    const body = JSON.parse(request.user);

    expect(body.query).toBe("Compare my old and current commute.");
    expect(body.selectedEvidence[0].evidenceRef).toBe("e1");
    expect(request.system).toContain(
      "filled planner checklist is not sufficient",
    );
    expect(request.system).toContain("Do not answer the query");
  });

  test("accepts a bounded repair without letting the model set role or time", () => {
    const parsed = parseMemoryEvidenceClosureAuditV1(
      JSON.stringify({
        verdict: "repair",
        missingRequirements: [
          {
            label: "Current commute",
            searchText: "current commute route and duration",
            relation: "temporal",
            coverageMode: "latest",
            minimumEvidence: 1,
          },
        ],
        rejectedEvidenceRefs: ["e1"],
      }),
      auditInput(),
    );

    expect(parsed.missingRequirements).toEqual([
      expect.objectContaining({
        requirementId: "closure-repair-1",
        temporalMode: "history",
        roleConstraint: "user",
      }),
    ]);
    expect(parsed.rejectedEvidenceRefs).toEqual(["old-commute-ref"]);
  });

  test("rejects invented evidence addresses and a second repair request", () => {
    expect(() =>
      parseMemoryEvidenceClosureAuditV1(
        '{"verdict":"pass","missingRequirements":[],"rejectedEvidenceRefs":["invented"]}',
        auditInput(),
      ),
    ).toThrow("MemoryEvidenceClosureAuditAddressInvalid");
    expect(() =>
      parseMemoryEvidenceClosureAuditV1(
        '{"verdict":"repair","missingRequirements":[{"label":"x","searchText":"y","relation":"direct","coverageMode":"any","minimumEvidence":1}],"rejectedEvidenceRefs":[]}',
        { ...auditInput(), maxMissingRequirements: 0 },
      ),
    ).toThrow("MemoryEvidenceClosureAuditShapeInvalid");
  });

  test("keeps the model behind the parsed closure boundary", async () => {
    const auditor = createJsonMemoryEvidenceClosureAuditorV1({
      model: {
        async complete() {
          return {
            status: "completed" as const,
            text: '{"verdict":"pass","missingRequirements":[],"rejectedEvidenceRefs":[]}',
          };
        },
      },
    });
    const result = await auditor.audit(
      auditInput(),
      new AbortController().signal,
    );
    expect(result.verdict).toBe("pass");
    expect(result.auditRevision).toHaveLength(64);
  });
});

function auditInput(): MemoryEvidenceClosureAuditInputV1 {
  return {
    query: "Compare my old and current commute.",
    intent: {
      answerShape: "compare",
      temporalMode: "history",
      roleConstraint: "user",
      needsPlanning: true,
    },
    requirements: [
      {
        requirementId: "old-commute",
        label: "Old commute",
        searchText: "old commute route and duration",
        temporalMode: "history",
        roleConstraint: "user",
        relation: "comparative",
        coverageMode: "any",
        minimumEvidence: 1,
      },
    ],
    selectedEvidence: [
      {
        sourceId: "session-1",
        evidenceRef: "old-commute-ref",
        content: "I used to commute by bus for forty minutes.",
        authority: "user_asserted",
      },
    ],
    maxMissingRequirements: 2,
  };
}
