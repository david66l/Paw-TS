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
    expect(body.maxDeficiencies).toBe(4);
    expect(body).not.toHaveProperty("maxDescriptionChars");
    expect(request.system).toContain(
      "filled planner checklist is not sufficient",
    );
    expect(request.system).toContain("author retrieval requirements");
  });

  test("reports a reason-coded deficiency without authoring retrieval prose", () => {
    const parsed = parseMemoryEvidenceClosureAuditV1(
      JSON.stringify({
        decision: "incomplete",
        deficiencies: [
          {
            reason: "missing_operand",
            targetRequirementId: null,
          },
        ],
        rejectedEvidenceRefs: ["e1"],
      }),
      auditInput(),
    );

    expect(parsed.deficiencies).toEqual([
      {
        reason: "missing_operand",
        targetRequirementId: null,
      },
    ]);
    expect(parsed.rejectedEvidenceRefs).toEqual(["old-commute-ref"]);
    expect(parsed.deficiencies[0]).not.toHaveProperty("searchText");
  });

  test("rejects invented addresses and inconsistent decisions", () => {
    expect(() =>
      parseMemoryEvidenceClosureAuditV1(
        '{"decision":"incomplete","deficiencies":[{"reason":"missing_operand","targetRequirementId":null}],"rejectedEvidenceRefs":["invented"]}',
        auditInput(),
      ),
    ).toThrow("MemoryEvidenceClosureAuditAddressInvalid");
    expect(() =>
      parseMemoryEvidenceClosureAuditV1(
        '{"decision":"pass","deficiencies":[{"reason":"missing_operand","targetRequirementId":null}],"rejectedEvidenceRefs":[]}',
        auditInput(),
      ),
    ).toThrow("MemoryEvidenceClosureAuditVerdictInvalid");
  });

  test("rejects free-form deficiency prose and unknown requirement targets", () => {
    expect(() =>
      parseMemoryEvidenceClosureAuditV1(
        '{"decision":"incomplete","deficiencies":[{"description":"Current commute","reason":"missing_operand","targetRequirementId":null}],"rejectedEvidenceRefs":[]}',
        auditInput(),
      ),
    ).toThrow("MemoryEvidenceClosureAuditDeficiencyInvalid");
    expect(() =>
      parseMemoryEvidenceClosureAuditV1(
        '{"decision":"incomplete","deficiencies":[{"reason":"weak_support","targetRequirementId":"unknown"}],"rejectedEvidenceRefs":[]}',
        auditInput(),
      ),
    ).toThrow("MemoryEvidenceClosureAuditDeficiencyInvalid");
  });

  test("allows repeated query-level reason codes to represent omitted slots", () => {
    const parsed = parseMemoryEvidenceClosureAuditV1(
      '{"decision":"incomplete","deficiencies":[{"reason":"missing_operand","targetRequirementId":null},{"reason":"missing_operand","targetRequirementId":null}],"rejectedEvidenceRefs":[]}',
      auditInput(),
    );
    expect(parsed.deficiencies).toHaveLength(2);
    expect(
      parsed.deficiencies.every((item) => item.targetRequirementId === null),
    ).toBe(true);
  });

  test("keeps the model behind the parsed closure boundary", async () => {
    const auditor = createJsonMemoryEvidenceClosureAuditorV1({
      model: {
        async complete() {
          return {
            status: "completed" as const,
            text: '{"decision":"pass","deficiencies":[],"rejectedEvidenceRefs":[]}',
          };
        },
      },
    });
    const result = await auditor.audit(
      auditInput(),
      new AbortController().signal,
    );
    expect(result.decision).toBe("pass");
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
  };
}
