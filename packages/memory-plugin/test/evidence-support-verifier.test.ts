import { describe, expect, test } from "bun:test";

import { hashTextV1 } from "../src/canonical.js";
import {
  type MemoryEvidenceSupportVerificationInputV1,
  buildMemoryEvidenceSupportRequestV1,
  createJsonMemoryEvidenceSupportVerifierV1,
  parseMemoryEvidenceSupportProposalV1,
} from "../src/index.js";

describe("memory evidence support verifier", () => {
  test("accepts a complete ID-only partition grounded in an exact raw span", () => {
    const input = verificationInput();
    const assessments = parseMemoryEvidenceSupportProposalV1(
      JSON.stringify({
        assessments: [
          {
            requirementId: "requirement-1",
            supportingMemoryIds: ["memory-1"],
            contradictingMemoryIds: [],
            unknownMemoryIds: ["memory-2"],
            supportingSpanHashes: [input.spans[0]?.contentHash],
            contradictingSpanHashes: [],
          },
        ],
      }),
      input,
    );
    expect(assessments[0]?.supportingMemoryIds).toEqual(["memory-1"]);
    expect(assessments[0]?.unknownMemoryIds).toEqual(["memory-2"]);
  });

  test("downgrades relevant support that lacks raw-span grounding", () => {
    const input = verificationInput();
    const assessments = parseMemoryEvidenceSupportProposalV1(
      JSON.stringify({
        assessments: [
          {
            requirementId: "requirement-1",
            supportingMemoryIds: ["memory-2"],
            contradictingMemoryIds: [],
            unknownMemoryIds: ["memory-1"],
            supportingSpanHashes: [input.spans[0]?.contentHash],
            contradictingSpanHashes: [],
          },
        ],
      }),
      input,
    );
    expect(assessments[0]?.supportingMemoryIds).toEqual([]);
    expect(assessments[0]?.unknownMemoryIds).toEqual(["memory-1", "memory-2"]);
  });

  test("normalizes omitted empty sets without weakening ID validation", () => {
    const input = verificationInput();
    const assessments = parseMemoryEvidenceSupportProposalV1(
      JSON.stringify({
        assessments: [
          {
            requirementId: "requirement-1",
            supportingMemoryIds: ["memory-1"],
            unknownMemoryIds: ["memory-2"],
            supportingSpanHashes: [input.spans[0]?.contentHash],
          },
        ],
      }),
      input,
    );
    expect(assessments[0]?.contradictingMemoryIds).toEqual([]);
    expect(assessments[0]?.contradictingSpanHashes).toEqual([]);
    expect(() =>
      parseMemoryEvidenceSupportProposalV1(
        JSON.stringify({
          assessments: [
            {
              requirementId: "requirement-1",
              supportingMemoryIds: ["memory-1"],
              unknownMemoryIds: ["memory-2"],
              supportingSpanHashes: [input.spans[0]?.contentHash],
              unexpected: [],
            },
          ],
        }),
        input,
      ),
    ).toThrow();
  });

  test("repairs one invalid model proposal without relaxing ID constraints", async () => {
    const input = verificationInput();
    let calls = 0;
    const verifier = createJsonMemoryEvidenceSupportVerifierV1({
      model: {
        async complete(request) {
          calls += 1;
          if (calls === 1) {
            return {
              status: "completed",
              text: '{"assessments":[{"requirementId":"unknown"}]}',
            };
          }
          expect(request.user).toContain(
            "paw.memory-evidence-support-repair-input.v1",
          );
          return {
            status: "completed",
            text: JSON.stringify({
              assessments: [
                {
                  requirementId: "requirement-1",
                  supportingMemoryIds: ["memory-1"],
                  contradictingMemoryIds: [],
                  unknownMemoryIds: ["memory-2"],
                  supportingSpanHashes: [input.spans[0]?.contentHash],
                  contradictingSpanHashes: [],
                },
              ],
            }),
          };
        },
      },
    });
    const result = await verifier.verify(input, new AbortController().signal);
    expect(calls).toBe(2);
    expect(result.assessments[0]?.supportingMemoryIds).toEqual(["memory-1"]);
    expect(result.verificationRevision).toHaveLength(64);
  });

  test("keeps the reusable system prefix separate from volatile evidence", () => {
    const request = buildMemoryEvidenceSupportRequestV1(verificationInput());
    expect(request.system).toContain("Relevance is not support");
    expect(request.system).not.toContain("Compose");
    expect(request.user).toContain("Compose");
  });
});

function verificationInput(): MemoryEvidenceSupportVerificationInputV1 {
  const content = "The user chose Compose because cloud cost was high.";
  return Object.freeze({
    query: "Why did the user choose Compose?",
    requirements: Object.freeze([
      Object.freeze({
        requirementId: "requirement-1",
        description: "The reason for choosing Compose",
        priority: "required" as const,
        minimumEvidence: 1,
        candidateMemoryIds: Object.freeze(["memory-1", "memory-2"]),
      }),
    ]),
    evidence: Object.freeze([
      Object.freeze({
        memoryId: "memory-1",
        layer: "L1" as const,
        statement: "High cloud cost caused the Compose choice.",
      }),
      Object.freeze({
        memoryId: "memory-2",
        layer: "L1" as const,
        statement: "The user has deployed containers before.",
      }),
    ]),
    spans: Object.freeze([
      Object.freeze({
        evidenceRef: "journal:run-1#input-fact-2",
        memoryIds: Object.freeze(["memory-1"]),
        content,
        contentHash: hashTextV1(content),
      }),
    ]),
  });
}
