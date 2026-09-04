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
const secondRequirement = requirements[1];
if (!secondRequirement)
  throw new Error("support selector requirement fixture is incomplete");

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
        async complete(request) {
          const payload = JSON.parse(request.user) as {
            candidates: Array<{
              evidenceRef: string;
              eligibleRequirementIds: string[];
            }>;
          };
          return {
            status: "completed",
            text: JSON.stringify({
              assessments: [
                {
                  requirementId: firstRequirement.requirementId,
                  supportingEvidenceRefs: payload.candidates.map(
                    (candidate) => candidate.evidenceRef,
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

  test("reserves the final shard manifest inside the twelve-thousand-character body limit", async () => {
    const boundaryCandidates = Array.from({ length: 12 }, (_, index) => ({
      sourceId: `boundary-${index}`,
      evidenceRef: `boundary-${index}#turn-1`,
      content: `${index}:${"x".repeat(1_200)}`,
      authority: "user_asserted" as const,
    }));
    const bodySizes: number[] = [];
    const selector = createJsonMemoryEvidenceSupportSelectorV1({
      model: {
        async complete(request) {
          bodySizes.push(request.user.length);
          const payload = JSON.parse(request.user) as {
            candidates: Array<{ evidenceRef: string }>;
          };
          return {
            status: "completed",
            text: JSON.stringify({
              assessments: [
                {
                  requirementId: firstRequirement.requirementId,
                  supportingEvidenceRefs: payload.candidates.map(
                    (candidate) => candidate.evidenceRef,
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
        query: "Summarize every boundary observation.",
        requirements: [firstRequirement],
        candidates: boundaryCandidates,
      },
      new AbortController().signal,
    );

    expect(bodySizes.length).toBeGreaterThan(1);
    expect(bodySizes.every((size) => size <= 12_000)).toBe(true);
    expect(selected.assessments[0]?.supportingEvidenceRefs).toEqual(
      boundaryCandidates.map((candidate) => candidate.evidenceRef),
    );
  });

  test("projects the 32-candidate aperture once, then batches two mixed-root scopes fairly", async () => {
    const batchRequirements = [
      { ...firstRequirement, requirementId: "user-scope" },
      {
        ...secondRequirement,
        requirementId: "assistant-scope",
        roleConstraint: "assistant" as const,
      },
    ] as const;
    const userCandidates = Array.from({ length: 18 }, (_, index) => ({
      sourceId: `user-root-${index % 3}`,
      evidenceRef: `user-${index}`,
      content: `user-${index} direct observation`,
      authority: "user_asserted" as const,
      sourceKind: "user_input" as const,
    }));
    const assistantCandidates = Array.from({ length: 14 }, (_, index) => ({
      sourceId: `assistant-root-${index % 2}`,
      evidenceRef: `assistant-${index}`,
      content: `assistant-${index} addressed reply`,
      authority: "context_only" as const,
      sourceKind: "assistant_output" as const,
      contextEvidenceRefs: [`user-${index}`],
    }));
    const requests: Array<{
      bodyChars: number;
      candidates: string[];
      options: unknown;
      shardManifest?: {
        globalCandidateCount: number;
        globalEligibleCounts: Array<{ requirementId: string; count: number }>;
        batchIndex: number;
        batchCount: number;
      };
    }> = [];
    const selector = createJsonMemoryEvidenceSupportSelectorV1({
      model: {
        async complete(request, options) {
          const payload = JSON.parse(request.user) as {
            requirements: Array<{ requirementId: string }>;
            candidates: Array<{
              evidenceRef: string;
              eligibleRequirementIds: string[];
              content: string;
            }>;
            shardManifest?: {
              globalCandidateCount: number;
              globalEligibleCounts: Array<{
                requirementId: string;
                count: number;
              }>;
              batchIndex: number;
              batchCount: number;
            };
          };
          requests.push({
            bodyChars: request.user.length,
            candidates: payload.candidates.map(
              (candidate) => candidate.content,
            ),
            options,
            shardManifest: payload.shardManifest,
          });
          return {
            status: "completed",
            text: JSON.stringify({
              assessments: payload.requirements.map((requirement) => ({
                requirementId: requirement.requirementId,
                supportingEvidenceRefs: payload.candidates
                  .filter((candidate) =>
                    candidate.eligibleRequirementIds.includes(
                      requirement.requirementId,
                    ),
                  )
                  .map((candidate) => candidate.evidenceRef),
                contradictingEvidenceRefs: [],
                unknownEvidenceRefs: [],
              })),
            }),
          } as const;
        },
      },
    });
    const selected = await selector.select(
      {
        query: "Recover every observation from both roots.",
        requirements: batchRequirements,
        candidates: [...userCandidates, ...assistantCandidates],
        candidateScopes: [
          {
            requirementId: "user-scope",
            evidenceRefs: userCandidates.map((item) => item.evidenceRef),
          },
          {
            requirementId: "assistant-scope",
            evidenceRefs: assistantCandidates.map((item) => item.evidenceRef),
          },
        ],
        certifiedAssistantDialogueEvidenceRefs: assistantCandidates.map(
          (item) => item.evidenceRef,
        ),
      },
      new AbortController().signal,
    );

    expect(requests).toHaveLength(3);
    expect(
      requests.every(
        (item) => item.candidates.length <= 12 && item.bodyChars <= 12_000,
      ),
    ).toBe(true);
    expect(
      requests.every(
        (item) =>
          (item.options as { maxOutputTokens?: number }).maxOutputTokens ===
          8_192,
      ),
    ).toBe(true);
    expect(new Set(requests.flatMap((item) => item.candidates))).toEqual(
      new Set([
        ...userCandidates.map((item) => item.content),
        ...assistantCandidates.map((item) => item.content),
      ]),
    );
    const firstUserCandidate = userCandidates[0];
    const secondUserCandidate = userCandidates[1];
    const firstAssistantCandidate = assistantCandidates[0];
    const secondAssistantCandidate = assistantCandidates[1];
    if (
      !firstUserCandidate ||
      !secondUserCandidate ||
      !firstAssistantCandidate ||
      !secondAssistantCandidate
    ) {
      throw new Error("support selector batch fixture is incomplete");
    }
    expect(requests[0]?.candidates.slice(0, 4)).toEqual([
      firstUserCandidate.content,
      firstAssistantCandidate.content,
      secondUserCandidate.content,
      secondAssistantCandidate.content,
    ]);
    expect(requests.map((request) => request.shardManifest)).toEqual([
      {
        globalCandidateCount: 32,
        globalEligibleCounts: [
          { requirementId: "user-scope", count: 18 },
          { requirementId: "assistant-scope", count: 14 },
        ],
        batchIndex: 1,
        batchCount: 3,
      },
      {
        globalCandidateCount: 32,
        globalEligibleCounts: [
          { requirementId: "user-scope", count: 18 },
          { requirementId: "assistant-scope", count: 14 },
        ],
        batchIndex: 2,
        batchCount: 3,
      },
      {
        globalCandidateCount: 32,
        globalEligibleCounts: [
          { requirementId: "user-scope", count: 18 },
          { requirementId: "assistant-scope", count: 14 },
        ],
        batchIndex: 3,
        batchCount: 3,
      },
    ]);
    expect(
      selected.batchTelemetry?.batches.reduce(
        (sum, item) => sum + item.certifiedAssistantCoverage,
        0,
      ),
    ).toBe(14);
    expect(
      selected.assessments.map((item) => item.supportingEvidenceRefs.length),
    ).toEqual([18, 14]);
  });

  test("recovers one truncated batch by recursively splitting 12 to 6 to 3", async () => {
    const twelve = Array.from({ length: 12 }, (_, index) => ({
      sourceId: "root",
      evidenceRef: `evidence-${index}`,
      content: `evidence ${index}`,
      authority: "user_asserted" as const,
    }));
    const sizes: number[] = [];
    const selector = createJsonMemoryEvidenceSupportSelectorV1({
      model: {
        async complete(request) {
          const payload = JSON.parse(request.user) as {
            candidates: Array<{ evidenceRef: string }>;
          };
          sizes.push(payload.candidates.length);
          if (payload.candidates.length > 3) {
            return {
              status: "truncated",
              errorCode: "MemoryWriterModelTruncated",
            } as const;
          }
          return {
            status: "completed",
            text: JSON.stringify({
              assessments: [
                {
                  requirementId: firstRequirement.requirementId,
                  supportingEvidenceRefs: payload.candidates.map(
                    (item) => item.evidenceRef,
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
        query: "List evidence.",
        requirements: [firstRequirement],
        candidates: twelve,
      },
      new AbortController().signal,
    );

    expect(sizes).toEqual([12, 6, 3, 3, 6, 3, 3]);
    expect(selected.assessments[0]?.supportingEvidenceRefs).toEqual(
      twelve.map((item) => item.evidenceRef),
    );
    expect(
      selected.batchTelemetry?.batches.filter(
        (item) => item.status === "truncated",
      ),
    ).toHaveLength(3);
  });

  test("runs at most two batches concurrently and merges completed shards by ordinal", async () => {
    const twentyFour = Array.from({ length: 24 }, (_, index) => ({
      sourceId: "root",
      evidenceRef: `parallel-${index}`,
      content: `parallel ${index}`,
      authority: "user_asserted" as const,
    }));
    let inFlight = 0;
    let maxInFlight = 0;
    const started: number[] = [];
    const completed: number[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const selector = createJsonMemoryEvidenceSupportSelectorV1({
      model: {
        async complete(request) {
          const payload = JSON.parse(request.user) as {
            candidates: Array<{ evidenceRef: string }>;
            shardManifest: { batchIndex: number };
          };
          const batchIndex = payload.shardManifest.batchIndex;
          started.push(batchIndex);
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          if (batchIndex === 1) {
            await firstGate;
          } else {
            // Complete the later shard first; host merge must nevertheless
            // retain the planned batch ordinal.
            releaseFirst();
          }
          completed.push(batchIndex);
          inFlight -= 1;
          return {
            status: "completed",
            text: JSON.stringify({
              assessments: [
                {
                  requirementId: firstRequirement.requirementId,
                  supportingEvidenceRefs: payload.candidates.map(
                    (candidate) => candidate.evidenceRef,
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
        query: "List every observation.",
        requirements: [firstRequirement],
        candidates: twentyFour,
      },
      new AbortController().signal,
    );

    expect(maxInFlight).toBe(2);
    expect(started).toEqual([1, 2]);
    expect(completed).toEqual([2, 1]);
    expect(selected.assessments[0]?.supportingEvidenceRefs).toEqual(
      twentyFour.map((candidate) => candidate.evidenceRef),
    );
    expect(
      selected.batchTelemetry?.batches.map((batch) => batch.candidateCount),
    ).toEqual([12, 12]);
  });

  test("keeps a concurrently failed transaction group atomic", async () => {
    const twentyFour = Array.from({ length: 24 }, (_, index) => ({
      sourceId: "root",
      evidenceRef: `atomic-${index}`,
      content: `atomic ${index}`,
      authority: "user_asserted" as const,
    }));
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const started: number[] = [];
    const selector = createJsonMemoryEvidenceSupportSelectorV1({
      model: {
        async complete(request) {
          const payload = JSON.parse(request.user) as {
            candidates: Array<{ evidenceRef: string }>;
            shardManifest: { batchIndex: number };
          };
          const batchIndex = payload.shardManifest.batchIndex;
          started.push(batchIndex);
          if (batchIndex === 1) {
            await firstGate;
            return {
              status: "completed",
              text: JSON.stringify({
                assessments: [
                  {
                    requirementId: firstRequirement.requirementId,
                    supportingEvidenceRefs: payload.candidates.map(
                      (candidate) => candidate.evidenceRef,
                    ),
                    contradictingEvidenceRefs: [],
                    unknownEvidenceRefs: [],
                  },
                ],
              }),
            } as const;
          }
          releaseFirst();
          return { status: "failed", errorCode: "SyntheticFailure" } as const;
        },
      },
    });
    const grouped = await selector.selectGrouped?.(
      {
        query: "List every observation.",
        requirements: [firstRequirement],
        candidates: twentyFour,
      },
      [
        {
          groupId: "atomic-group",
          requirementIds: [firstRequirement.requirementId],
        },
      ],
      new AbortController().signal,
    );

    expect(started).toEqual([1, 2]);
    expect(grouped?.groups).toEqual([
      {
        groupId: "atomic-group",
        status: "fallback",
        assessments: [],
        failureCodes: ["SyntheticFailure"],
      },
    ]);
    expect(
      grouped?.batchTelemetry?.batches.map((batch) => batch.status),
    ).toEqual(["completed", "failed"]);
  });

  test("permanent truncation closes only its transaction group after prior batches", async () => {
    const groupRequirements = [
      { ...firstRequirement, requirementId: "good" },
      { ...secondRequirement, requirementId: "bad" },
    ] as const;
    const good = Array.from({ length: 8 }, (_, index) => ({
      sourceId: "good-root",
      evidenceRef: `good-${index}`,
      content: `good ${index}`,
      authority: "user_asserted" as const,
    }));
    const bad = Array.from({ length: 24 }, (_, index) => ({
      sourceId: "bad-root",
      evidenceRef: `bad-${index}`,
      content: `bad ${index}`,
      authority: "user_asserted" as const,
    }));
    const selector = createJsonMemoryEvidenceSupportSelectorV1({
      model: {
        async complete(request) {
          const payload = JSON.parse(request.user) as {
            requirements: Array<{ requirementId: string }>;
            candidates: Array<{ evidenceRef: string; content: string }>;
          };
          if (
            payload.requirements[0]?.requirementId === "bad" &&
            payload.candidates.some((item) => item.content === "bad 12")
          ) {
            return {
              status: "truncated",
              errorCode: "MemoryWriterModelTruncated",
            } as const;
          }
          return {
            status: "completed",
            text: JSON.stringify({
              assessments: payload.requirements.map((requirement) => ({
                requirementId: requirement.requirementId,
                supportingEvidenceRefs: payload.candidates.map(
                  (candidate) => candidate.evidenceRef,
                ),
                contradictingEvidenceRefs: [],
                unknownEvidenceRefs: [],
              })),
            }),
          } as const;
        },
      },
    });
    const grouped = await selector.selectGrouped?.(
      {
        query: "Compare scoped evidence.",
        requirements: groupRequirements,
        candidates: [...good, ...bad],
        candidateScopes: [
          {
            requirementId: "good",
            evidenceRefs: good.map((item) => item.evidenceRef),
          },
          {
            requirementId: "bad",
            evidenceRefs: bad.map((item) => item.evidenceRef),
          },
        ],
      },
      [
        { groupId: "good-group", requirementIds: ["good"] },
        { groupId: "bad-group", requirementIds: ["bad"] },
      ],
      new AbortController().signal,
    );

    expect(
      grouped?.groups.map((group) => [
        group.groupId,
        group.status,
        group.assessments.length,
      ]),
    ).toEqual([
      ["good-group", "completed", 1],
      ["bad-group", "fallback", 0],
    ]);
    expect(grouped?.groups[1]?.failureCodes).toEqual([
      "MemoryWriterModelTruncated",
    ]);
  });

  test("does not widen an assistant certificate into an inferred user subgroup", async () => {
    const userRequirement = {
      ...firstRequirement,
      requirementId: "user-inference",
      relation: "inferred" as const,
      coverageMode: "convergent" as const,
      minimumEvidence: 2,
    };
    const assistantRequirement = {
      ...secondRequirement,
      requirementId: "assistant-dialogue",
      roleConstraint: "assistant" as const,
    };
    const assistantCandidate = {
      sourceId: "session",
      evidenceRef: "session#assistant-2",
      content: "The assistant proposed the label Northstar.",
      authority: "context_only" as const,
      sourceKind: "assistant_output" as const,
      contextEvidenceRefs: ["session#user-1", "session#assistant-2"],
      turnOrder: 2,
    };
    const modelRequirementIds: string[] = [];
    const selector = createJsonMemoryEvidenceSupportSelectorV1({
      model: {
        async complete(request) {
          const payload = JSON.parse(request.user) as {
            requirements: Array<{ requirementId: string }>;
            candidates: Array<{ evidenceRef: string }>;
          };
          modelRequirementIds.push(
            ...payload.requirements.map((item) => item.requirementId),
          );
          return {
            status: "completed",
            text: JSON.stringify({
              assessments: payload.requirements.map((requirement) => ({
                requirementId: requirement.requirementId,
                supportingEvidenceRefs: payload.candidates.map(
                  (candidate) => candidate.evidenceRef,
                ),
                contradictingEvidenceRefs: [],
                unknownEvidenceRefs: [],
              })),
            }),
          } as const;
        },
      },
    });

    const grouped = await selector.selectGrouped?.(
      {
        query: "Infer the user preference and recover the assistant label.",
        requirements: [userRequirement, assistantRequirement],
        candidates: [assistantCandidate],
        candidateScopes: [
          {
            requirementId: userRequirement.requirementId,
            evidenceRefs: [assistantCandidate.evidenceRef],
          },
          {
            requirementId: assistantRequirement.requirementId,
            evidenceRefs: [assistantCandidate.evidenceRef],
          },
        ],
        certifiedAssistantDialogueEvidenceRefs: [
          assistantCandidate.evidenceRef,
        ],
      },
      [
        {
          groupId: "user-group",
          requirementIds: [userRequirement.requirementId],
        },
        {
          groupId: "assistant-group",
          requirementIds: [assistantRequirement.requirementId],
        },
      ],
      new AbortController().signal,
    );

    expect(grouped?.groups).toEqual([
      {
        groupId: "user-group",
        status: "fallback",
        assessments: [],
        failureCodes: ["MemoryEvidenceSupportCertificateInvalid"],
      },
      {
        groupId: "assistant-group",
        status: "completed",
        assessments: [
          {
            requirementId: assistantRequirement.requirementId,
            supportingEvidenceRefs: [assistantCandidate.evidenceRef],
            contradictingEvidenceRefs: [],
            unknownEvidenceRefs: [],
          },
        ],
        failureCodes: [],
      },
    ]);
    expect(modelRequirementIds).toEqual([assistantRequirement.requirementId]);
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
