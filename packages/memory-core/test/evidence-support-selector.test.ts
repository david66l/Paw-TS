import { describe, expect, test } from "bun:test";

import {
  type MemoryEvidenceNotebookHitV1,
  type MemoryEvidenceRequirementV3,
  buildMemoryEvidenceSupportSelectionRequestV1,
  createJsonMemoryEvidenceSupportSelectorV1,
  memoryEvidenceSupportFailureCodeV1,
  parseMemoryEvidenceSupportSelectionV1,
} from "../src/index.js";

const requirements: readonly MemoryEvidenceRequirementV3[] = [
  {
    requirementId: "requirement-1",
    label: "Japan trip duration",
    searchText: "Japan trip duration",
    temporalMode: "any",
    roleConstraint: "user",
  },
  {
    requirementId: "requirement-2",
    label: "Chicago trip duration",
    searchText: "Chicago trip duration",
    temporalMode: "any",
    roleConstraint: "user",
  },
];

const candidates: readonly MemoryEvidenceNotebookHitV1[] = [
  {
    sourceId: "japan",
    evidenceRef: "japan#turn-1",
    content: "I stayed in Japan for seven days.",
    authority: "user_asserted",
  },
  {
    sourceId: "chicago",
    evidenceRef: "chicago#turn-1",
    content: "My Chicago trip lasted four days.",
    authority: "user_asserted",
  },
  {
    sourceId: "noise",
    evidenceRef: "noise#turn-1",
    content: "I like reading travel magazines.",
    authority: "user_asserted",
  },
];

describe("requirement-bound evidence support selector v1", () => {
  test("exposes only content-free selector failure codes", () => {
    const known = new Error("invalid output");
    known.name = "MemoryEvidenceSupportRequirementInvalid";
    expect(memoryEvidenceSupportFailureCodeV1(known)).toBe(
      "MemoryEvidenceSupportRequirementInvalid",
    );
    expect(
      memoryEvidenceSupportFailureCodeV1(new Error("private detail")),
    ).toBe("MemoryEvidenceSupportSelectorFailed");
    const untrusted = new Error("private detail");
    untrusted.name = "MemoryEvidenceSupportPrivateDetail";
    expect(memoryEvidenceSupportFailureCodeV1(untrusted)).toBe(
      "MemoryEvidenceSupportSelectorFailed",
    );
  });

  test("projects ordinal evidence and exposes turn order for revised outputs", () => {
    const request = buildMemoryEvidenceSupportSelectionRequestV1({
      query: "What was the 27th item in the second output?",
      requirements: [requirements[0]!],
      candidates: [
        {
          sourceId: "session",
          evidenceRef: "session#assistant-3",
          authority: "context_only",
          episodeOrder: 4,
          turnOrder: 3,
          content: [
            "A long numbered response follows.",
            ...Array.from({ length: 40 }, (_, index) =>
              index === 26
                ? "27. Sound effects"
                : `${index + 1}. ${"filler ".repeat(20)}`,
            ),
          ].join("\n"),
        },
      ],
    });

    const payload = JSON.parse(request.user) as {
      candidates: Array<{
        content: string;
        evidenceRef: string;
        sourceId?: string;
        turnOrder: number;
        certifiedAssistantDialogue?: boolean;
      }>;
      requirements: Array<{
        certifiedAssistantDialogueCandidate?: boolean;
      }>;
    };
    expect(payload.candidates[0]?.content).toContain("27. Sound effects");
    expect(payload.candidates[0]?.evidenceRef).toBe("e1");
    expect(payload.candidates[0]?.sourceId).toBeUndefined();
    expect(payload.candidates[0]?.turnOrder).toBe(3);
    expect(payload.candidates[0]).not.toHaveProperty(
      "certifiedAssistantDialogue",
    );
    expect(payload.requirements[0]).not.toHaveProperty(
      "certifiedAssistantDialogueCandidate",
    );
    expect(request.system).not.toContain(
      "roleConstraint=user with certifiedAssistantDialogueCandidate=true",
    );
    expect(request.system).toContain(
      "later assistant response after user feedback",
    );
  });

  test("passes typed inference closure to the bounded selector", () => {
    const input = {
      query: "What kind of exercise do I seem to prefer?",
      requirements: [
        {
          ...requirements[0]!,
          relation: "inferred",
          coverageMode: "convergent",
          minimumEvidence: 2,
        },
      ],
      candidates,
    } as const;
    const request = buildMemoryEvidenceSupportSelectionRequestV1(input);
    const payload = JSON.parse(request.user) as {
      requirements: Array<{
        relation: string;
        coverageMode: string;
        minimumEvidence: number;
        evidenceUse?: string;
      }>;
    };

    expect(payload.requirements[0]).toMatchObject({
      relation: "inferred",
      coverageMode: "convergent",
      minimumEvidence: 2,
    });
    expect(payload.requirements[0]).not.toHaveProperty("evidenceUse");
    expect(
      buildMemoryEvidenceSupportSelectionRequestV1({
        ...input,
        requirements: [{ ...input.requirements[0], evidenceUse: "fact" }],
      }),
    ).toEqual(request);
    expect(request.system).toContain("relation=inferred");
    expect(request.system).toContain("distinct observations");
  });

  test("exposes only structurally certified assistant dialogue candidates", () => {
    const assistant = {
      sourceId: "session",
      evidenceRef: "session#assistant-2",
      content: "The proposed label was Northstar.",
      authority: "context_only" as const,
      sourceKind: "assistant_output" as const,
      contextEvidenceRefs: ["session#user-1", "session#assistant-2"],
      turnOrder: 2,
    };
    const request = buildMemoryEvidenceSupportSelectionRequestV1({
      query: "What was the label from our previous conversation?",
      requirements: [requirements[0]!],
      candidates: [assistant],
      certifiedAssistantDialogueEvidenceRefs: [assistant.evidenceRef],
      sourceLocalAssistantEvidenceRefs: [assistant.evidenceRef],
    });
    const payload = JSON.parse(request.user) as {
      requirements: Array<{
        certifiedAssistantDialogueCandidate: boolean;
      }>;
      candidates: Array<{
        certifiedAssistantDialogue: boolean;
        sourceLocalAssistantOriginCertified: boolean;
      }>;
    };
    expect(payload.requirements[0]?.certifiedAssistantDialogueCandidate).toBe(
      true,
    );
    expect(payload.candidates[0]?.certifiedAssistantDialogue).toBe(true);
    expect(payload.candidates[0]?.sourceLocalAssistantOriginCertified).toBe(
      true,
    );
    expect(request.system).toContain(
      "roleConstraint=user with certifiedAssistantDialogueCandidate=true",
    );

    const unresolved = buildMemoryEvidenceSupportSelectionRequestV1({
      query: "What was proposed in the earlier chat?",
      requirements: [
        {
          ...requirements[0]!,
          roleConstraint: "any",
        },
      ],
      candidates: [assistant],
      sourceLocalAssistantEvidenceRefs: [assistant.evidenceRef],
    });
    const unresolvedPayload = JSON.parse(unresolved.user) as {
      candidates: Array<{ sourceLocalAssistantOriginCertified: boolean }>;
    };
    expect(
      unresolvedPayload.candidates[0]?.sourceLocalAssistantOriginCertified,
    ).toBe(true);

    expect(() =>
      buildMemoryEvidenceSupportSelectionRequestV1({
        query: "What is my address?",
        requirements,
        candidates,
        certifiedAssistantDialogueEvidenceRefs: ["japan#turn-1"],
      }),
    ).toThrow("MemoryEvidenceSupportCertificateInvalid");
  });

  test("binds reported assistant assertions to their dedicated requirement", () => {
    const assistant = {
      sourceId: "session",
      evidenceRef: "session#assistant-1",
      content: "The cover was blue.",
      authority: "context_only" as const,
      sourceKind: "assistant_output" as const,
      contextEvidenceRefs: ["session#assistant-1"],
      turnOrder: 1,
    };
    const reportedRequirement = {
      ...requirements[0]!,
      evidenceUse: "reported_assistant_assertion" as const,
    };
    const request = buildMemoryEvidenceSupportSelectionRequestV1({
      query: "Do you remember what was the color of the cover?",
      requirements: [reportedRequirement],
      candidates: [assistant],
      reportedAssistantAssertionEvidenceRefs: [assistant.evidenceRef],
      sourceLocalAssistantEvidenceRefs: [assistant.evidenceRef],
    });
    const payload = JSON.parse(request.user) as {
      requirements: Array<{ evidenceUse: string }>;
      candidates: Array<{ reportedAssistantAssertion: boolean }>;
    };
    expect(payload.requirements[0]?.evidenceUse).toBe(
      "reported_assistant_assertion",
    );
    expect(payload.candidates[0]?.reportedAssistantAssertion).toBe(true);
    expect(request.system).toContain(
      "not the truth of the underlying user, shared, third-party, or world fact",
    );

    expect(() =>
      buildMemoryEvidenceSupportSelectionRequestV1({
        query: "What is my address?",
        requirements: [requirements[0]!],
        candidates: [assistant],
        reportedAssistantAssertionEvidenceRefs: [assistant.evidenceRef],
        sourceLocalAssistantEvidenceRefs: [assistant.evidenceRef],
      }),
    ).toThrow("MemoryEvidenceSupportCertificateInvalid");
  });

  test("accepts only supplied evidence addresses for every requirement", () => {
    expect(
      parseMemoryEvidenceSupportSelectionV1(
        JSON.stringify({
          assessments: [
            {
              requirementId: "requirement-1",
              supportingEvidenceRefs: ["japan#turn-1"],
              contradictingEvidenceRefs: [],
              unknownEvidenceRefs: [],
            },
            {
              requirementId: "requirement-2",
              supportingEvidenceRefs: ["chicago#turn-1"],
              contradictingEvidenceRefs: [],
              unknownEvidenceRefs: [],
            },
          ],
        }),
        { query: "Compare both trips", requirements, candidates },
      ),
    ).toEqual([
      {
        requirementId: "requirement-1",
        supportingEvidenceRefs: ["japan#turn-1"],
        contradictingEvidenceRefs: [],
        unknownEvidenceRefs: [],
      },
      {
        requirementId: "requirement-2",
        supportingEvidenceRefs: ["chicago#turn-1"],
        contradictingEvidenceRefs: [],
        unknownEvidenceRefs: [],
      },
    ]);
  });

  test("rejects invented addresses and incomplete requirement sets", () => {
    expect(() =>
      parseMemoryEvidenceSupportSelectionV1(
        JSON.stringify({
          assessments: [
            {
              requirementId: "requirement-1",
              supportingEvidenceRefs: ["invented#turn-9"],
              contradictingEvidenceRefs: [],
              unknownEvidenceRefs: [],
            },
            {
              requirementId: "requirement-2",
              supportingEvidenceRefs: [],
              contradictingEvidenceRefs: [],
              unknownEvidenceRefs: [],
            },
          ],
        }),
        { query: "Compare both trips", requirements, candidates },
      ),
    ).toThrow("MemoryEvidenceSupportAddressInvalid");
    expect(() =>
      parseMemoryEvidenceSupportSelectionV1(
        JSON.stringify({
          assessments: [
            {
              requirementId: "requirement-1",
              supportingEvidenceRefs: ["japan#turn-1"],
              contradictingEvidenceRefs: ["japan#turn-1"],
              unknownEvidenceRefs: [],
            },
            {
              requirementId: "requirement-2",
              supportingEvidenceRefs: ["chicago#turn-1"],
              contradictingEvidenceRefs: [],
              unknownEvidenceRefs: [],
            },
          ],
        }),
        { query: "Compare both trips", requirements, candidates },
      ),
    ).toThrow("MemoryEvidenceSupportAddressInvalid");
  });

  test("keeps the model inside the validated address-selection boundary", async () => {
    const selector = createJsonMemoryEvidenceSupportSelectorV1({
      model: {
        async complete() {
          return {
            status: "completed",
            text: JSON.stringify({
              assessments: [
                {
                  requirementId: "requirement-1",
                  supportingEvidenceRefs: ["e1"],
                  contradictingEvidenceRefs: [],
                  unknownEvidenceRefs: [],
                },
                {
                  requirementId: "requirement-2",
                  supportingEvidenceRefs: ["e2"],
                  contradictingEvidenceRefs: [],
                  unknownEvidenceRefs: [],
                },
              ],
            }),
          } as const;
        },
      },
    });
    const selected = await selector.select(
      { query: "Compare both trips", requirements, candidates },
      new AbortController().signal,
    );
    expect(selected.assessments[0]?.supportingEvidenceRefs).toEqual([
      "japan#turn-1",
    ]);
    expect(selected.selectionRevision).toHaveLength(64);
  });
});
