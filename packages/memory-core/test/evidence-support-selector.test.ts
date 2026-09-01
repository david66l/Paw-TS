import { describe, expect, test } from "bun:test";

import {
  type MemoryEvidenceNotebookHitV1,
  type MemoryEvidenceRequirementV3,
  buildMemoryEvidenceSupportSelectionRequestV1,
  createJsonMemoryEvidenceSupportSelectorV1,
  parseMemoryEvidenceSupportGroupedSelectionV1,
  parseMemoryEvidenceSupportSelectionV1,
  projectMemoryEvidenceSupportSelectionInputV1,
} from "../src/legacy.js";

const firstRequirement: MemoryEvidenceRequirementV3 = {
  requirementId: "requirement-1",
  label: "Japan trip duration",
  searchText: "Japan trip duration",
  temporalMode: "any",
  roleConstraint: "user",
};

const requirements: readonly MemoryEvidenceRequirementV3[] = [
  firstRequirement,
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
const japanCandidate = candidates[0];
if (!japanCandidate) throw new Error("support selector fixture is incomplete");

describe("requirement-bound evidence support selector v1", () => {
  test("projects ordinal evidence and exposes turn order for revised outputs", () => {
    const request = buildMemoryEvidenceSupportSelectionRequestV1({
      query: "What was the 27th item in the second output?",
      requirements: [firstRequirement],
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
    const request = buildMemoryEvidenceSupportSelectionRequestV1({
      query: "What kind of exercise do I seem to prefer?",
      requirements: [
        {
          ...firstRequirement,
          relation: "inferred",
          coverageMode: "convergent",
          minimumEvidence: 2,
        },
      ],
      candidates,
    });
    const payload = JSON.parse(request.user) as {
      requirements: Array<{
        relation: string;
        coverageMode: string;
        minimumEvidence: number;
      }>;
    };

    expect(payload.requirements[0]).toMatchObject({
      relation: "inferred",
      coverageMode: "convergent",
      minimumEvidence: 2,
    });
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
      requirements: [firstRequirement],
      candidates: [assistant],
      certifiedAssistantDialogueEvidenceRefs: [assistant.evidenceRef],
    });
    const payload = JSON.parse(request.user) as {
      requirements: Array<{
        certifiedAssistantDialogueCandidate: boolean;
      }>;
      candidates: Array<{ certifiedAssistantDialogue: boolean }>;
    };
    expect(payload.requirements[0]?.certifiedAssistantDialogueCandidate).toBe(
      true,
    );
    expect(payload.candidates[0]?.certifiedAssistantDialogue).toBe(true);
    expect(request.system).toContain(
      "roleConstraint=user with certifiedAssistantDialogueCandidate=true",
    );

    expect(() =>
      buildMemoryEvidenceSupportSelectionRequestV1({
        query: "What is my address?",
        requirements,
        candidates,
        certifiedAssistantDialogueEvidenceRefs: ["japan#turn-1"],
      }),
    ).toThrow("MemoryEvidenceSupportCertificateInvalid");
  });

  test("exposes typed dialogue provenance to assistant and any without opening the user exception", () => {
    const assistant = {
      sourceId: "session",
      evidenceRef: "session#assistant-2",
      content: "The proposed label was Northstar.",
      authority: "context_only" as const,
      sourceKind: "assistant_output" as const,
      contextEvidenceRefs: ["session#user-1", "session#assistant-2"],
      turnOrder: 2,
    };
    for (const roleConstraint of ["assistant", "any"] as const) {
      const requirement = { ...firstRequirement, roleConstraint };
      const request = buildMemoryEvidenceSupportSelectionRequestV1({
        query: "What label did the assistant propose?",
        requirements: [requirement],
        candidates: [assistant],
        candidateScopes: [
          {
            requirementId: requirement.requirementId,
            evidenceRefs: [assistant.evidenceRef],
          },
        ],
        certifiedAssistantDialogueEvidenceRefs: [assistant.evidenceRef],
      });
      const payload = JSON.parse(request.user) as {
        requirements: Array<{
          certifiedAssistantDialogueCandidate?: boolean;
        }>;
        candidates: Array<{ certifiedAssistantDialogue: boolean }>;
      };

      expect(payload.candidates[0]?.certifiedAssistantDialogue).toBe(true);
      expect(payload.requirements[0]).not.toHaveProperty(
        "certifiedAssistantDialogueCandidate",
      );
      expect(request.system).toContain(
        "only deterministic dialogue provenance",
      );
      expect(request.system).not.toContain(
        "roleConstraint=user with certifiedAssistantDialogueCandidate=true",
      );
    }
  });

  test("rejects forged or out-of-scope dialogue certificates", () => {
    const requirement = {
      ...firstRequirement,
      roleConstraint: "any" as const,
    };
    const assistant = {
      sourceId: "session",
      evidenceRef: "session#assistant-2",
      content: "The proposed label was Northstar.",
      authority: "context_only" as const,
      sourceKind: "assistant_output" as const,
      contextEvidenceRefs: ["session#user-1", "session#assistant-2"],
      turnOrder: 2,
    };
    const base = {
      query: "What label did the assistant propose?",
      requirements: [requirement],
      candidates: [assistant],
      candidateScopes: [
        {
          requirementId: requirement.requirementId,
          evidenceRefs: [assistant.evidenceRef],
        },
      ],
      certifiedAssistantDialogueEvidenceRefs: [assistant.evidenceRef],
    } as const;

    expect(() =>
      buildMemoryEvidenceSupportSelectionRequestV1({
        ...base,
        certifiedAssistantDialogueEvidenceRefs: ["session#assistant-9"],
      }),
    ).toThrow("MemoryEvidenceSupportCertificateInvalid");
    expect(() =>
      buildMemoryEvidenceSupportSelectionRequestV1({
        ...base,
        candidateScopes: [
          {
            requirementId: requirement.requirementId,
            evidenceRefs: [],
          },
        ],
      }),
    ).toThrow("MemoryEvidenceSupportCertificateInvalid");
    expect(() =>
      buildMemoryEvidenceSupportSelectionRequestV1({
        ...base,
        candidates: [{ ...assistant, sourceKind: "user_input" as const }],
      }),
    ).toThrow("MemoryEvidenceSupportCertificateInvalid");
    expect(() =>
      buildMemoryEvidenceSupportSelectionRequestV1({
        ...base,
        candidates: [{ ...assistant, authority: "user_asserted" as const }],
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

  test("keeps each candidate inside its requirement slot", () => {
    const input = {
      query: "Compare both trips",
      requirements,
      candidates,
      candidateScopes: [
        {
          requirementId: "requirement-1",
          evidenceRefs: ["japan#turn-1"],
        },
        {
          requirementId: "requirement-2",
          evidenceRefs: ["chicago#turn-1"],
        },
      ],
    } as const;
    const payload = JSON.parse(
      buildMemoryEvidenceSupportSelectionRequestV1(input).user,
    ) as {
      candidates: Array<{
        evidenceRef: string;
        eligibleRequirementIds: string[];
      }>;
    };
    expect(payload.candidates[0]?.eligibleRequirementIds).toEqual([
      "requirement-1",
    ]);
    expect(payload.candidates[1]?.eligibleRequirementIds).toEqual([
      "requirement-2",
    ]);
    expect(payload.candidates[2]?.eligibleRequirementIds).toEqual([]);

    expect(() =>
      parseMemoryEvidenceSupportSelectionV1(
        JSON.stringify({
          assessments: [
            {
              requirementId: "requirement-1",
              supportingEvidenceRefs: ["chicago#turn-1"],
              contradictingEvidenceRefs: [],
              unknownEvidenceRefs: [],
            },
            {
              requirementId: "requirement-2",
              supportingEvidenceRefs: ["japan#turn-1"],
              contradictingEvidenceRefs: [],
              unknownEvidenceRefs: [],
            },
          ],
        }),
        input,
      ),
    ).toThrow("MemoryEvidenceSupportAddressInvalid");
  });

  test("commits valid selector groups from one response and closes only the invalid group", () => {
    const input = {
      query: "Compare both trips",
      requirements,
      candidates,
      candidateScopes: [
        {
          requirementId: "requirement-1",
          evidenceRefs: ["japan#turn-1"],
        },
        {
          requirementId: "requirement-2",
          evidenceRefs: ["chicago#turn-1"],
        },
      ],
    } as const;
    const text = JSON.stringify({
      assessments: [
        {
          requirementId: "requirement-1",
          supportingEvidenceRefs: ["chicago#turn-1"],
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
    });
    expect(
      parseMemoryEvidenceSupportGroupedSelectionV1(text, input, [
        { groupId: "group-1", requirementIds: ["requirement-1"] },
        { groupId: "group-2", requirementIds: ["requirement-2"] },
      ]),
    ).toEqual([
      {
        groupId: "group-1",
        status: "fallback",
        assessments: [],
        failureCodes: ["MemoryEvidenceSupportAddressInvalid"],
      },
      {
        groupId: "group-2",
        status: "completed",
        assessments: [
          {
            requirementId: "requirement-2",
            supportingEvidenceRefs: ["chicago#turn-1"],
            contradictingEvidenceRefs: [],
            unknownEvidenceRefs: [],
          },
        ],
        failureCodes: [],
      },
    ]);
    expect(
      parseMemoryEvidenceSupportGroupedSelectionV1(text, input, [
        {
          groupId: "dependent-group",
          requirementIds: ["requirement-1", "requirement-2"],
        },
      ]),
    ).toEqual([
      {
        groupId: "dependent-group",
        status: "fallback",
        assessments: [],
        failureCodes: ["MemoryEvidenceSupportAddressInvalid"],
      },
    ]);
  });

  test("keeps unknown and duplicate requirement keys query-fatal in grouped mode", () => {
    const groups = [
      { groupId: "group-1", requirementIds: ["requirement-1"] },
      { groupId: "group-2", requirementIds: ["requirement-2"] },
    ];
    const input = {
      query: "Compare both trips",
      requirements,
      candidates,
    };
    const assessment = (requirementId: string) => ({
      requirementId,
      supportingEvidenceRefs: [],
      contradictingEvidenceRefs: [],
      unknownEvidenceRefs: [],
    });
    expect(() =>
      parseMemoryEvidenceSupportGroupedSelectionV1(
        JSON.stringify({
          assessments: [assessment("unknown"), assessment("requirement-2")],
        }),
        input,
        groups,
      ),
    ).toThrow("MemoryEvidenceSupportRequirementInvalid");
    expect(() =>
      parseMemoryEvidenceSupportGroupedSelectionV1(
        JSON.stringify({
          assessments: [
            assessment("requirement-1"),
            assessment("requirement-1"),
          ],
        }),
        input,
        groups,
      ),
    ).toThrow("MemoryEvidenceSupportRequirementInvalid");
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

  test("admits every scoped canonical address when the aperture exceeds sixteen", async () => {
    const wideCandidates = Object.freeze(
      Array.from({ length: 32 }, (_, index) => ({
        sourceId: `source-${index}`,
        evidenceRef: `source-${index}#turn-1`,
        content: `Direct observation ${index}.`,
        authority: "user_asserted" as const,
      })),
    );
    const selector = createJsonMemoryEvidenceSupportSelectorV1({
      model: {
        async complete() {
          return {
            status: "completed",
            text: JSON.stringify({
              assessments: [
                {
                  requirementId: firstRequirement.requirementId,
                  supportingEvidenceRefs: wideCandidates.map(
                    (_, index) => `e${index + 1}`,
                  ),
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
      {
        query: "Summarize every direct observation.",
        requirements: [firstRequirement],
        candidates: wideCandidates,
      },
      new AbortController().signal,
    );

    expect(selected.assessments[0]?.supportingEvidenceRefs).toEqual(
      wideCandidates.map((candidate) => candidate.evidenceRef),
    );
  });

  test("projects raw L0 before the model-view bound without mutating provenance", async () => {
    const rawContent = `${"background context ".repeat(730)}needle answer ${"tail ".repeat(80)}`;
    expect(rawContent.length).toBeGreaterThan(8_192);
    const input = {
      query: "What was the needle answer?",
      requirements: [firstRequirement],
      candidates: [
        {
          ...japanCandidate,
          content: rawContent,
          sourceKind: "user_input" as const,
          contextEvidenceRefs: ["japan#turn-0"],
        },
      ],
    } as const;
    let requestUser = "";
    const selector = createJsonMemoryEvidenceSupportSelectorV1({
      model: {
        async complete(request) {
          requestUser = request.user;
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
              ],
            }),
          } as const;
        },
      },
    });

    const selected = await selector.select(input, new AbortController().signal);
    const payload = JSON.parse(requestUser) as {
      candidates: Array<{ content: string; evidenceRef: string }>;
    };

    expect(input.candidates[0].content).toBe(rawContent);
    expect(payload.candidates[0]?.content.length).toBeLessThanOrEqual(2_400);
    expect(payload.candidates[0]?.content).toContain("needle answer");
    expect(payload.candidates[0]?.evidenceRef).toBe("e1");
    expect(selected.assessments[0]?.supportingEvidenceRefs).toEqual([
      "japan#turn-1",
    ]);
  });

  test("keeps ordinary requests byte-stable and projection idempotent", () => {
    const input = { query: "Compare both trips", requirements, candidates };
    const first = projectMemoryEvidenceSupportSelectionInputV1(input);
    const second = projectMemoryEvidenceSupportSelectionInputV1(first);

    expect(second).toEqual(first);
    expect(buildMemoryEvidenceSupportSelectionRequestV1(input)).toEqual(
      buildMemoryEvidenceSupportSelectionRequestV1(first),
    );
    expect(input.candidates).toBe(candidates);
  });

  test("keeps malformed provenance closed before projection", () => {
    const input = {
      query: "What happened?",
      requirements: [firstRequirement],
      candidates: [japanCandidate],
    } as const;
    expect(() =>
      projectMemoryEvidenceSupportSelectionInputV1({
        ...input,
        candidates: [{ ...japanCandidate, content: "   " }],
      }),
    ).toThrow("MemoryEvidenceSupportCandidateInvalid");
    expect(() =>
      projectMemoryEvidenceSupportSelectionInputV1({
        ...input,
        candidates: [{ ...japanCandidate, evidenceRef: "r".repeat(513) }],
      }),
    ).toThrow("MemoryEvidenceSupportCandidateInvalid");
    expect(() =>
      projectMemoryEvidenceSupportSelectionInputV1({
        ...input,
        candidates: [{ ...japanCandidate, sourceId: "s".repeat(513) }],
      }),
    ).toThrow("MemoryEvidenceSupportCandidateInvalid");
    expect(() =>
      projectMemoryEvidenceSupportSelectionInputV1({
        ...input,
        candidates: [japanCandidate, japanCandidate],
      }),
    ).toThrow("MemoryEvidenceSupportCandidateDuplicate");
  });

  test("fails closed outside the code-owned raw safety envelope", () => {
    expect(() =>
      projectMemoryEvidenceSupportSelectionInputV1({
        query: "What happened?",
        requirements: [firstRequirement],
        candidates: [
          {
            ...japanCandidate,
            content: "x".repeat(256 * 1_024 + 1),
          },
        ],
      }),
    ).toThrow("MemoryEvidenceSupportRawEnvelopeInvalid");

    expect(() =>
      projectMemoryEvidenceSupportSelectionInputV1({
        query: "What happened?",
        requirements: [firstRequirement],
        candidates: Array.from({ length: 5 }, (_, index) => ({
          ...japanCandidate,
          sourceId: `source-${index}`,
          evidenceRef: `source-${index}#turn-1`,
          content: "x".repeat(220 * 1_024),
        })),
      }),
    ).toThrow("MemoryEvidenceSupportRawEnvelopeInvalid");
  });
});
