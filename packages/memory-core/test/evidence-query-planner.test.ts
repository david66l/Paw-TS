import { describe, expect, test } from "bun:test";

import { validateMemoryEvidenceQueryPlanBoundary } from "../src/evidence-resolution-validation.js";
import {
  PAW_MEMORY_EVIDENCE_QUERY_PLANNER_VERSION_V3,
  buildMemoryEvidenceQueryPlanRequestV3,
  classifyMemoryEvidenceIntentBoundaryV1,
  classifyMemoryEvidenceQueryV3,
  createJsonMemoryEvidenceQueryPlannerV3,
  needsCertifiedAssistantDialogueCandidateV1,
  parseMemoryEvidenceQueryPlanV3,
} from "../src/legacy.js";

describe("typed evidence query planner v3", () => {
  test("treats all as a collection policy rather than a two-item promise", () => {
    const intent = {
      answerShape: "aggregate" as const,
      temporalMode: "range" as const,
      roleConstraint: "user" as const,
      needsPlanning: true,
    };
    expect(() =>
      validateMemoryEvidenceQueryPlanBoundary({
        query: "How many qualifying events occurred during the period?",
        intent,
        plannerVersion: PAW_MEMORY_EVIDENCE_QUERY_PLANNER_VERSION_V3,
        plan: {
          plannerVersion: PAW_MEMORY_EVIDENCE_QUERY_PLANNER_VERSION_V3,
          ...intent,
          requirements: [
            {
              requirementId: "events",
              label: "All qualifying events",
              searchText: "qualifying events during the period",
              temporalMode: "range",
              roleConstraint: "user",
              relation: "direct",
              coverageMode: "all",
              minimumEvidence: 1,
            },
          ],
        },
      }),
    ).not.toThrow();
  });
  test("plans explicit prior-assistant recall instead of sending raw candidates", () => {
    expect(
      classifyMemoryEvidenceQueryV3(
        "What move did you make after 27. Kg2 Bd5+ in our previous game?",
      ),
    ).toEqual({
      answerShape: "lookup",
      temporalMode: "range",
      roleConstraint: "assistant",
      needsPlanning: true,
    });
  });
  test("opens recommendation planning for concrete personal evidence", () => {
    expect(
      classifyMemoryEvidenceQueryV3(
        "What should I serve for dinner this weekend with my homegrown ingredients?",
      ),
    ).toEqual({
      answerShape: "recommend",
      temporalMode: "any",
      roleConstraint: "user",
      needsPlanning: true,
    });
    expect(
      classifyMemoryEvidenceQueryV3("What did you recommend last time?"),
    ).toEqual({
      answerShape: "lookup",
      temporalMode: "any",
      roleConstraint: "assistant",
      needsPlanning: true,
    });
    expect(
      JSON.parse(
        buildMemoryEvidenceQueryPlanRequestV3(
          "What did you recommend last time?",
        ).user,
      ).intentBoundary.answerShape,
    ).toBe("fixed");
    expect(
      classifyMemoryEvidenceQueryV3(
        "Can you recommend something based on what we discussed last time?",
      ).answerShape,
    ).toBe("recommend");
    expect(
      classifyMemoryEvidenceQueryV3(
        "How many recommendations did you give me last time?",
      ).answerShape,
    ).toBe("aggregate");
    expect(
      classifyMemoryEvidenceQueryV3(
        "What was the difference between the two recommendations you gave?",
      ).answerShape,
    ).toBe("compare");
    expect(
      classifyMemoryEvidenceQueryV3("What did I recommend last time?"),
    ).toMatchObject({ answerShape: "lookup", roleConstraint: "user" });
    for (const query of [
      "I've been struggling with this routine. Any advice?",
      "I'm planning a trip to Denver soon. Any suggestions on what to do?",
      "I've got some free time tonight, any documentary recommendations?",
      "Do you have any helpful tips?",
      "Do you think it would be a good idea for me to attend?",
      "My bike is performing better. Could there be a reason for this?",
    ]) {
      expect(classifyMemoryEvidenceQueryV3(query).answerShape).toBe(
        "recommend",
      );
    }
  });

  test("keeps simple lookup deterministic and model-free", async () => {
    let calls = 0;
    const planner = createJsonMemoryEvidenceQueryPlannerV3({
      model: {
        async complete() {
          calls += 1;
          return { status: "failed", errorCode: "unexpected" };
        },
      },
    });

    const plan = await planner.plan(
      "Which city did I visit?",
      new AbortController().signal,
    );

    expect(plan).toEqual({
      plannerVersion: PAW_MEMORY_EVIDENCE_QUERY_PLANNER_VERSION_V3,
      answerShape: "lookup",
      temporalMode: "any",
      roleConstraint: "user",
      needsPlanning: false,
      requirements: [],
    });
    expect(calls).toBe(0);
  });

  test("turns reason-coded verifier deficiencies into one replacement plan", async () => {
    let capturedUser = "";
    const planner = createJsonMemoryEvidenceQueryPlannerV3({
      model: {
        async complete(request) {
          capturedUser = request.user;
          return {
            status: "completed" as const,
            text: JSON.stringify({
              answerShape: "lookup",
              temporalMode: "any",
              roleConstraint: "user",
              requirements: [
                {
                  label: "Visited city",
                  searchText: "city the user visited",
                  relation: "direct",
                  coverageMode: "any",
                  minimumEvidence: 1,
                },
              ],
            }),
          };
        },
      },
    });

    const plan = await planner.plan(
      "Which city did I visit?",
      new AbortController().signal,
      {
        revision: {
          currentRequirements: [
            {
              requirementId: "root",
              label: "Travel fact",
              searchText: "travel",
              temporalMode: "any",
              roleConstraint: "user",
            },
          ],
          deficiencies: [
            {
              reason: "weak_support",
              targetRequirementId: "root",
            },
          ],
        },
      },
    );

    expect(plan.requirements[0]?.searchText).toBe("city the user visited");
    expect(JSON.parse(capturedUser).revision).toEqual({
      currentRequirements: [
        {
          requirementId: "root",
          label: "Travel fact",
          searchText: "travel",
          relation: "direct",
          coverageMode: "any",
          minimumEvidence: 1,
          temporalMode: "any",
          roleConstraint: "user",
          dependencyRelation: "independent",
          dependsOn: [],
        },
      ],
      deficiencies: [
        {
          reason: "weak_support",
          targetRequirementId: "root",
        },
      ],
    });
  });

  test("preserves ambiguous dialogue authority as any", () => {
    const query = "Could you repeat the item from our earlier conversation?";
    expect(classifyMemoryEvidenceQueryV3(query)).toEqual({
      answerShape: "lookup",
      temporalMode: "any",
      roleConstraint: "any",
      needsPlanning: true,
    });

    const plan = parseMemoryEvidenceQueryPlanV3(
      JSON.stringify({
        answerShape: "lookup",
        temporalMode: "any",
        roleConstraint: "any",
        requirements: [
          {
            label: "prior shared dialogue item",
            searchText: "item from earlier conversation",
            relation: "direct",
            coverageMode: "any",
            minimumEvidence: 1,
          },
        ],
      }),
      query,
    );

    expect(plan.roleConstraint).toBe("any");
    expect(plan.requirements[0]?.roleConstraint).toBe("any");
    for (const sharedQuestion of [
      "What name did we come up with?",
      "What topic did we discuss?",
      "Which option did we decide on?",
      "What title did you and I choose?",
    ]) {
      expect(classifyMemoryEvidenceQueryV3(sharedQuestion).roleConstraint).toBe(
        "any",
      );
    }
  });

  test("normalizes only semantic intent axes", () => {
    const ambiguousQuery =
      "Can you remind me what was ultimately proposed in the earlier conversation?";
    const ambiguousIntent = classifyMemoryEvidenceQueryV3(ambiguousQuery);
    expect(classifyMemoryEvidenceIntentBoundaryV1(ambiguousQuery)).toEqual({
      answerShape: "semantic",
      temporalMode: "semantic",
      roleConstraint: "semantic",
    });

    const assistantPlan = parseMemoryEvidenceQueryPlanV3(
      JSON.stringify({
        answerShape: "lookup",
        temporalMode: "any",
        roleConstraint: "assistant",
        requirements: [
          {
            label: "prior proposal",
            searchText: "assistant proposal from the earlier conversation",
            relation: "direct",
            coverageMode: "any",
            minimumEvidence: 1,
          },
        ],
      }),
      ambiguousQuery,
      ambiguousIntent,
    );
    expect(assistantPlan.roleConstraint).toBe("assistant");
    expect(assistantPlan.requirements[0]?.roleConstraint).toBe("assistant");

    const recommendationQuery =
      "Given my circumstances, which option fits me best?";
    const recommendationPlan = parseMemoryEvidenceQueryPlanV3(
      JSON.stringify({
        answerShape: "recommend",
        temporalMode: "any",
        roleConstraint: "user",
        requirements: [
          {
            label: "personal constraints",
            searchText: "user constraints relevant to choosing an option",
            relation: "inferred",
            coverageMode: "convergent",
            minimumEvidence: 2,
          },
        ],
      }),
      recommendationQuery,
    );
    expect(recommendationPlan.answerShape).toBe("recommend");

    const fixedQuery = "Which city did I visit?";
    expect(classifyMemoryEvidenceIntentBoundaryV1(fixedQuery)).toMatchObject({
      roleConstraint: "fixed",
    });
    const request = JSON.parse(
      buildMemoryEvidenceQueryPlanRequestV3(ambiguousQuery).user,
    );
    expect(request.intentBoundary).toEqual({
      answerShape: "semantic",
      temporalMode: "semantic",
      roleConstraint: "semantic",
    });
  });

  test("models mixed dialogue recall as a typed obligation DAG", () => {
    const query =
      "What constraint did I give you, and what answer did you provide?";
    const plan = parseMemoryEvidenceQueryPlanV3(
      JSON.stringify({
        answerShape: "lookup",
        temporalMode: "any",
        roleConstraint: "any",
        requirements: [
          {
            key: "user-request",
            label: "user constraint",
            searchText: "constraint the user gave in the prior dialogue",
            temporalMode: "any",
            roleConstraint: "user",
            relation: "direct",
            coverageMode: "any",
            minimumEvidence: 1,
            dependencyRelation: "independent",
            dependsOn: [],
          },
          {
            key: "assistant-answer",
            label: "assistant answer",
            searchText: "exact assistant answer following that constraint",
            temporalMode: "any",
            roleConstraint: "assistant",
            relation: "direct",
            coverageMode: "any",
            minimumEvidence: 1,
            dependencyRelation: "responds_to",
            dependsOn: ["user-request"],
          },
        ],
      }),
      query,
    );

    expect(plan.roleConstraint).toBe("any");
    expect(plan.requirements).toMatchObject([
      {
        requirementId: "user-request",
        roleConstraint: "user",
        dependencyRelation: "independent",
        dependsOnRequirementIds: [],
      },
      {
        requirementId: "assistant-answer",
        roleConstraint: "assistant",
        dependencyRelation: "responds_to",
        dependsOnRequirementIds: ["user-request"],
      },
    ]);
    expect(() =>
      validateMemoryEvidenceQueryPlanBoundary({
        query,
        plan,
        intent: classifyMemoryEvidenceQueryV3(query),
        plannerVersion: PAW_MEMORY_EVIDENCE_QUERY_PLANNER_VERSION_V3,
      }),
    ).not.toThrow();
  });

  test("derives the query role envelope from typed obligation leaves", () => {
    const plan = parseMemoryEvidenceQueryPlanV3(
      JSON.stringify({
        answerShape: "lookup",
        temporalMode: "any",
        roleConstraint: "any",
        requirements: [
          {
            key: "assistant-answer",
            label: "prior assistant answer",
            searchText: "exact answer from the prior dialogue",
            temporalMode: "any",
            roleConstraint: "assistant",
            relation: "direct",
            coverageMode: "any",
            minimumEvidence: 1,
            dependencyRelation: "independent",
            dependsOn: [],
          },
        ],
      }),
      "Could you repeat what was answered in our earlier conversation?",
    );
    expect(plan.roleConstraint).toBe("assistant");
    expect(plan.requirements[0]?.roleConstraint).toBe("assistant");
  });

  test("rejects cyclic or wildcard obligation leaves", () => {
    const query = "What did we each say about the project?";
    const base = {
      answerShape: "lookup",
      temporalMode: "any",
      roleConstraint: "any",
    } as const;
    const intent = { ...base, needsPlanning: true } as const;
    expect(() =>
      parseMemoryEvidenceQueryPlanV3(
        JSON.stringify({
          ...base,
          requirements: [
            {
              key: "first",
              label: "first turn",
              searchText: "first prior turn",
              temporalMode: "any",
              roleConstraint: "user",
              relation: "direct",
              coverageMode: "any",
              minimumEvidence: 1,
              dependencyRelation: "depends_on",
              dependsOn: ["second"],
            },
            {
              key: "second",
              label: "second turn",
              searchText: "second prior turn",
              temporalMode: "any",
              roleConstraint: "assistant",
              relation: "direct",
              coverageMode: "any",
              minimumEvidence: 1,
              dependencyRelation: "depends_on",
              dependsOn: ["first"],
            },
          ],
        }),
        query,
        intent,
      ),
    ).toThrow("MemoryEvidenceQueryPlanRequirementsInvalid");

    expect(() =>
      parseMemoryEvidenceQueryPlanV3(
        JSON.stringify({
          ...base,
          requirements: [
            {
              key: "shared",
              label: "shared turn",
              searchText: "prior dialogue turn",
              temporalMode: "any",
              roleConstraint: "any",
              relation: "direct",
              coverageMode: "any",
              minimumEvidence: 1,
              dependencyRelation: "independent",
              dependsOn: [],
            },
          ],
        }),
        query,
        intent,
      ),
    ).toThrow("MemoryEvidenceQueryPlanRequirementsInvalid");
  });

  test("does not let the model rewrite a fixed evidence authority", () => {
    expect(() =>
      parseMemoryEvidenceQueryPlanV3(
        JSON.stringify({
          answerShape: "lookup",
          temporalMode: "any",
          roleConstraint: "assistant",
          requirements: [
            {
              label: "visited city",
              searchText: "city the user visited",
              relation: "direct",
              coverageMode: "any",
              minimumEvidence: 1,
            },
          ],
        }),
        "Which city did I visit?",
      ),
    ).toThrow("MemoryEvidenceQueryPlanShapeInvalid");

    const userFactQuery = "Do you remember which city I visited?";
    expect(classifyMemoryEvidenceQueryV3(userFactQuery)).toEqual({
      answerShape: "lookup",
      temporalMode: "any",
      roleConstraint: "user",
      needsPlanning: false,
    });
    expect(() =>
      parseMemoryEvidenceQueryPlanV3(
        JSON.stringify({
          answerShape: "lookup",
          temporalMode: "any",
          roleConstraint: "assistant",
          requirements: [
            {
              label: "city",
              searchText: "visited city",
              relation: "direct",
              coverageMode: "any",
              minimumEvidence: 1,
            },
          ],
        }),
        userFactQuery,
      ),
    ).toThrow("MemoryEvidenceQueryPlanShapeInvalid");

    expect(
      classifyMemoryEvidenceQueryV3(
        "Can you remind me what that preference was?",
      ),
    ).toEqual({
      answerShape: "lookup",
      temporalMode: "any",
      roleConstraint: "any",
      needsPlanning: true,
    });
    expect(
      classifyMemoryEvidenceQueryV3(
        "What amount was in the plan from our previous conversation?",
      ),
    ).toEqual({
      answerShape: "lookup",
      temporalMode: "any",
      roleConstraint: "user",
      needsPlanning: true,
    });
    expect(
      classifyMemoryEvidenceQueryV3(
        "What city did I say I visited in our last conversation?",
      ).roleConstraint,
    ).toBe("user");
    expect(
      classifyMemoryEvidenceQueryV3(
        "What was my preference in the previous chat?",
      ).roleConstraint,
    ).toBe("user");
    expect(
      classifyMemoryEvidenceQueryV3(
        "What did I describe about my vacation in the previous chat?",
      ).roleConstraint,
    ).toBe("user");
    expect(
      classifyMemoryEvidenceQueryV3("上次对话里本人提过的爱好是什么？")
        .roleConstraint,
    ).toBe("user");
    expect(
      classifyMemoryEvidenceQueryV3(
        "What was my preference when we discussed the options?",
      ).roleConstraint,
    ).toBe("user");
    expect(
      classifyMemoryEvidenceQueryV3(
        "Which city did I mention when we discussed travel?",
      ).roleConstraint,
    ).toBe("user");
  });

  test("separates explicit ownership from unresolved dialogue recall", () => {
    for (const query of [
      "Do you remember which city I visited?",
      "Can you remind me what I said about the itinerary?",
      "Can you remind me what I said you recommended?",
      "Do you remember which of your suggestions I chose last time?",
      "Do you remember which gift for you I chose last time?",
      "I cannot recall which option I chose before.",
      "Do you recall where I left the keys before dinner?",
      "Do you remember who I met last time?",
      "Can you remind me where I put that file?",
      "Do you remember what I said when you and I were chatting?",
      "提醒我我之前说过的城市是什么？",
    ]) {
      expect(classifyMemoryEvidenceQueryV3(query).roleConstraint).toBe("user");
    }

    for (const query of [
      "What did you recommend for my trip?",
      "Can you remind me what you said about the itinerary?",
      "Can you remind me what you recommended for my trip last time?",
      "Can you remind me what you said about my itinerary before?",
      "Can you remind me what you said I preferred?",
      "你上次推荐了什么？",
      "提醒我你上次给我推荐了什么？",
    ]) {
      expect(classifyMemoryEvidenceQueryV3(query).roleConstraint).toBe(
        "assistant",
      );
    }

    for (const query of [
      "I lost track during our chat. Can you remind me how the final label was formed?",
      "Can you remind me what was ultimately proposed?",
      "Do you recall which one we discussed before?",
      "Can you remind me which of my ideas we chose?",
      "Do you remember what I was told last time?",
      "你还记得当时讨论的名称是什么吗？",
      "提醒我当时最终讨论的名称是什么？",
      "提醒我我的想法我们选了哪个？",
    ]) {
      expect(classifyMemoryEvidenceQueryV3(query)).toMatchObject({
        roleConstraint: "any",
        needsPlanning: true,
      });
    }

    expect(
      classifyMemoryEvidenceQueryV3(
        "Can you remind me what the capital of France is?",
      ).roleConstraint,
    ).toBe("user");
    expect(
      classifyMemoryEvidenceQueryV3(
        "Can you remind me what the capital of France was?",
      ).roleConstraint,
    ).toBe("user");
    for (const query of [
      "What was I told last time?",
      "What was I recommended in our previous chat?",
      "Do you remember what I was told I should do last time?",
      "Do you remember what I was told?",
      "Do you remember what I was shown?",
      "Do you remember what you were told last time?",
      "Can you remind me what you were shown before?",
      "提醒我你被告知了什么？",
    ]) {
      expect(classifyMemoryEvidenceQueryV3(query).roleConstraint).toBe("any");
    }
    expect(
      classifyMemoryEvidenceQueryV3(
        "Do you remember what you said after I was told to wait?",
      ).roleConstraint,
    ).toBe("assistant");
    expect(
      classifyMemoryEvidenceQueryV3(
        "Do you remember what I said after I was told to wait?",
      ).roleConstraint,
    ).toBe("user");
    expect(
      classifyMemoryEvidenceQueryV3("提醒我你的建议我采纳了哪个？")
        .roleConstraint,
    ).toBe("user");
    for (const query of [
      "Can you remind me which of my proposals you selected?",
      "提醒我我的方案你改了什么？",
      "Can you remind me which option that you described I selected?",
      "Do you remember what the idea I proposed made you change?",
      "提醒我你给我的建议我采纳了哪个？",
      "Do you remember what the medicine you recommended did to me?",
      "Can you remind me what the recipe you suggested tasted like to me?",
      "Do you recall which restaurant you recommended had outdoor seating?",
      "Can you remind me what the person you recommended told me?",
      "提醒我你推荐的药对我有什么影响？",
      "提醒我你给我的药有什么影响？",
      "提醒我你选的餐厅有什么特色？",
      "Can you remind me what happened to the report you wrote?",
      "Do you recall who reviewed the draft you created?",
    ]) {
      expect(classifyMemoryEvidenceQueryV3(query).roleConstraint).toBe("any");
    }
  });

  test("keeps unresolved assistant evidence as a certified secondary candidate", () => {
    for (const query of [
      "Can you remind me what the final label was?",
      "Can you remind me of the name from our previous conversation?",
      "I am trying to recall what the title on my draft was.",
      "In our previous conversation, what did the consultant say about the plan?",
    ]) {
      expect(needsCertifiedAssistantDialogueCandidateV1(query)).toBe(true);
    }
    expect(
      classifyMemoryEvidenceQueryV3(
        "What amount was in the plan from our previous conversation?",
      ),
    ).toMatchObject({ roleConstraint: "user", needsPlanning: true });
    expect(
      needsCertifiedAssistantDialogueCandidateV1(
        "Can you remind me what my previous draft title was?",
      ),
    ).toBe(true);
    expect(
      needsCertifiedAssistantDialogueCandidateV1(
        "In our previous conversation, what was my draft title?",
      ),
    ).toBe(true);
    expect(
      needsCertifiedAssistantDialogueCandidateV1(
        "What did I call the draft in our previous conversation?",
      ),
    ).toBe(false);
    expect(
      needsCertifiedAssistantDialogueCandidateV1("What is my current address?"),
    ).toBe(false);

    const ordinaryRequest = buildMemoryEvidenceQueryPlanRequestV3(
      "What is my current address?",
    );
    expect(ordinaryRequest.system).not.toContain(
      "certifiedAssistantDialogueCandidate=true",
    );
    expect(JSON.parse(ordinaryRequest.user)).not.toHaveProperty(
      "certifiedAssistantDialogueCandidate",
    );
    const certifiedRequest = buildMemoryEvidenceQueryPlanRequestV3(
      "What amount was in the plan from our previous conversation?",
    );
    expect(certifiedRequest.system).toContain(
      "certifiedAssistantDialogueCandidate=true",
    );
    expect(JSON.parse(certifiedRequest.user)).toMatchObject({
      certifiedAssistantDialogueCandidate: true,
    });

    for (const query of [
      "Which city did I visit?",
      "Can you remind me what I said about the itinerary?",
      "Do you remember where I left the keys?",
      "Can you remind me what my address is?",
      "Can you remind me what my preference is?",
      "Can you remind me what my job is?",
      "What did you recommend last time?",
    ]) {
      expect(needsCertifiedAssistantDialogueCandidateV1(query)).toBe(false);
    }
  });

  test("fails closed when a required model plan returns no requirements", async () => {
    const planner = createJsonMemoryEvidenceQueryPlannerV3({
      model: {
        async complete() {
          return {
            status: "completed" as const,
            text: JSON.stringify({
              answerShape: "aggregate",
              temporalMode: "latest",
              roleConstraint: "user",
              requirements: [],
            }),
          };
        },
      },
    });

    await expect(
      planner.plan(
        "How many Instagram followers do I currently have?",
        new AbortController().signal,
      ),
    ).rejects.toThrow("MemoryEvidenceQueryPlanRequirementsEmpty");
  });

  test("accepts only bounded requirements for the classified operation", () => {
    const query = "Can you suggest some evening activities?";
    const plan = parseMemoryEvidenceQueryPlanV3(
      JSON.stringify({
        answerShape: "recommend",
        temporalMode: "any",
        roleConstraint: "user",
        requirements: [
          {
            label: "sleep goals and evening constraints",
            searchText: "bedtime sleep screen time evening routine",
            relation: "inferred",
            coverageMode: "convergent",
            minimumEvidence: 2,
          },
        ],
      }),
      query,
    );
    expect(plan.requirements).toEqual([
      {
        requirementId: "requirement-1",
        label: "sleep goals and evening constraints",
        searchText: "bedtime sleep screen time evening routine",
        temporalMode: "any",
        roleConstraint: "user",
        relation: "inferred",
        coverageMode: "convergent",
        minimumEvidence: 2,
      },
    ]);
    expect(() =>
      parseMemoryEvidenceQueryPlanV3(
        JSON.stringify({
          answerShape: "lookup",
          temporalMode: "any",
          roleConstraint: "user",
          requirements: [],
        }),
        query,
      ),
    ).toThrow("MemoryEvidenceQueryPlanShapeInvalid");
    expect(() =>
      parseMemoryEvidenceQueryPlanV3(
        JSON.stringify({
          answerShape: "recommend",
          temporalMode: "any",
          roleConstraint: "user",
          requirements: [
            {
              label: "inferred preference",
              searchText: "repeated choices and reactions",
              relation: "inferred",
              coverageMode: "any",
              minimumEvidence: 1,
            },
          ],
        }),
        query,
      ),
    ).toThrow("MemoryEvidenceQueryPlanRequirementsInvalid");
  });

  test("collapses optional recommendation dimensions into one context bundle", () => {
    const query = "Can you suggest an activity that would suit me?";
    const item = (key: string, searchText: string) => ({
      key,
      label: searchText,
      searchText,
      temporalMode: "any",
      roleConstraint: "user",
      relation: "direct",
      coverageMode: "any",
      minimumEvidence: 1,
      dependencyRelation: "independent",
      dependsOn: [],
    });
    const plan = parseMemoryEvidenceQueryPlanV3(
      JSON.stringify({
        answerShape: "recommend",
        temporalMode: "any",
        roleConstraint: "user",
        requirements: [
          item("possessions", "owned equipment"),
          item("goals", "current goals"),
          item("constraints", "schedule constraints"),
          item("preferences", "explicit likes and dislikes"),
        ],
      }),
      query,
    );
    expect(plan.requirements).toHaveLength(1);
    expect(plan.requirements[0]).toMatchObject({
      requirementId: "personalization-context",
      roleConstraint: "user",
      relation: "direct",
      coverageMode: "any",
      minimumEvidence: 1,
      dependencyRelation: "independent",
      dependsOnRequirementIds: [],
    });
    expect(plan.requirements[0]?.searchText).toContain("owned equipment");
    expect(plan.requirements[0]?.searchText).toContain("current goals");

    const reversed = parseMemoryEvidenceQueryPlanV3(
      JSON.stringify({
        answerShape: "recommend",
        temporalMode: "any",
        roleConstraint: "user",
        requirements: [
          item("preferences", "explicit likes and dislikes"),
          item("constraints", "schedule constraints"),
          item("goals", "current goals"),
          item("possessions", "owned equipment"),
        ],
      }),
      query,
    );
    expect(reversed.requirements[0]?.searchText).toBe(
      plan.requirements[0]?.searchText,
    );

    const long = "x".repeat(100);
    const uncollapsed = parseMemoryEvidenceQueryPlanV3(
      JSON.stringify({
        answerShape: "recommend",
        temporalMode: "any",
        roleConstraint: "user",
        requirements: [item("first", `${long}a`), item("second", `${long}b`)],
      }),
      query,
    );
    expect(uncollapsed.requirements).toHaveLength(2);

    const explicitOperands = parseMemoryEvidenceQueryPlanV3(
      JSON.stringify({
        answerShape: "recommend",
        temporalMode: "any",
        roleConstraint: "user",
        requirements: [
          item("owned", "fact the user explicitly asks to recall"),
          item("recommend", "context for a new recommendation"),
        ],
      }),
      "What do I own and what should I buy next?",
    );
    expect(explicitOperands.requirements).toHaveLength(2);

    const semanticRewrite = parseMemoryEvidenceQueryPlanV3(
      JSON.stringify({
        answerShape: "recommend",
        temporalMode: "any",
        roleConstraint: "user",
        requirements: [
          item("first", "first proposed context"),
          item("second", "second proposed context"),
        ],
      }),
      "Tell me about the stored details.",
      {
        answerShape: "lookup",
        temporalMode: "any",
        roleConstraint: "user",
        needsPlanning: true,
      },
    );
    expect(semanticRewrite.requirements).toHaveLength(2);
  });

  test("keeps answer shape and recency as independent intent axes", () => {
    expect(
      classifyMemoryEvidenceQueryV3(
        "How many Instagram followers do I currently have?",
      ),
    ).toEqual({
      answerShape: "aggregate",
      temporalMode: "latest",
      roleConstraint: "user",
      needsPlanning: true,
    });
    expect(
      classifyMemoryEvidenceQueryV3(
        "What percentage of that property's price is the renovation cost on my current house?",
      ),
    ).toEqual({
      answerShape: "aggregate",
      temporalMode: "any",
      roleConstraint: "user",
      needsPlanning: true,
    });
  });

  test("classifies ordinal and relative-time questions as ordered evidence", () => {
    expect(
      classifyMemoryEvidenceQueryV3("Which suggestion did you mention first?"),
    ).toEqual({
      answerShape: "lookup",
      temporalMode: "history",
      roleConstraint: "assistant",
      needsPlanning: true,
    });
    expect(
      classifyMemoryEvidenceQueryV3("How many days ago did I visit that city?"),
    ).toEqual({
      answerShape: "aggregate",
      temporalMode: "range",
      roleConstraint: "user",
      needsPlanning: true,
    });
    expect(classifyMemoryEvidenceQueryV3("我第一次提到的是哪个城市？")).toEqual(
      {
        answerShape: "lookup",
        temporalMode: "history",
        roleConstraint: "user",
        needsPlanning: true,
      },
    );
    expect(
      classifyMemoryEvidenceQueryV3(
        "List the museums I visited from earliest to latest.",
      ).temporalMode,
    ).toBe("history");
    expect(
      classifyMemoryEvidenceQueryV3("Who joined me last Saturday?")
        .temporalMode,
    ).toBe("range");
    expect(
      classifyMemoryEvidenceQueryV3("What was my most recent update last week?")
        .temporalMode,
    ).toBe("latest");
  });

  test("does not confuse a profile field with an ordinal event", () => {
    expect(classifyMemoryEvidenceQueryV3("What is my first name?")).toEqual({
      answerShape: "lookup",
      temporalMode: "any",
      roleConstraint: "user",
      needsPlanning: false,
    });
  });

  test("classifies the same independent intent axes in Chinese", () => {
    expect(classifyMemoryEvidenceQueryV3("我目前一共有多少粉丝？")).toEqual({
      answerShape: "aggregate",
      temporalMode: "latest",
      roleConstraint: "user",
      needsPlanning: true,
    });
    expect(classifyMemoryEvidenceQueryV3("你上次推荐了什么？")).toEqual({
      answerShape: "lookup",
      temporalMode: "any",
      roleConstraint: "assistant",
      needsPlanning: true,
    });
    expect(
      classifyMemoryEvidenceQueryV3("我的旅行偏好这些年怎么变化的？"),
    ).toEqual({
      answerShape: "lookup",
      temporalMode: "history",
      roleConstraint: "user",
      needsPlanning: true,
    });
  });
});
