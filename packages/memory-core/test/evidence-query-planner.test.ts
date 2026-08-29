import { describe, expect, test } from "bun:test";

import {
  PAW_MEMORY_EVIDENCE_QUERY_PLANNER_VERSION_V3,
  buildMemoryEvidenceQueryPlanRequestV3,
  classifyMemoryEvidenceQueryV3,
  classifyMemoryAssistantOriginApertureV1,
  createJsonMemoryEvidenceQueryPlannerV3,
  needsCertifiedAssistantDialogueCandidateV1,
  parseMemoryEvidenceQueryPlanV3,
  proposesMemorySessionOpeningAssistantOriginV1,
  reconcileMemoryAssistantOriginApertureV1,
} from "../src/index.js";

describe("typed evidence query planner v3", () => {
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
      answerShape: "recommend",
      temporalMode: "any",
      roleConstraint: "assistant",
      needsPlanning: true,
    });
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

  test("keeps session-opening assistant authority limited to dialogue artifacts", () => {
    expect(
      proposesMemorySessionOpeningAssistantOriginV1(
        "Do you remember what you recommended?",
      ),
    ).toBe(true);
    expect(
      proposesMemorySessionOpeningAssistantOriginV1(
        "Do you remember what was proposed in the earlier chat?",
      ),
    ).toBe(true);
    expect(
      proposesMemorySessionOpeningAssistantOriginV1(
        "What was the recommendation in our previous conversation?",
      ),
    ).toBe(true);
    expect(
      proposesMemorySessionOpeningAssistantOriginV1("之前对话里的建议是什么？"),
    ).toBe(true);
    expect(
      proposesMemorySessionOpeningAssistantOriginV1(
        "What was your response to our message in the previous conversation?",
      ),
    ).toBe(true);
    expect(
      proposesMemorySessionOpeningAssistantOriginV1(
        "What did you say about my recommendation?",
      ),
    ).toBe(true);
    expect(
      proposesMemorySessionOpeningAssistantOriginV1(
        "Which points did you add to our draft?",
      ),
    ).toBe(true);
    expect(
      proposesMemorySessionOpeningAssistantOriginV1(
        "Do you remember what was recommended by you?",
      ),
    ).toBe(true);
    expect(
      proposesMemorySessionOpeningAssistantOriginV1(
        "Do you remember what was the color of the cover?",
      ),
    ).toBe(true);
    expect(
      proposesMemorySessionOpeningAssistantOriginV1(
        "What name did we come up with?",
      ),
    ).toBe(false);
    expect(
      proposesMemorySessionOpeningAssistantOriginV1(
        "Which option did we decide on in our previous conversation?",
      ),
    ).toBe(false);
    for (const sharedOutcome of [
      "What decision did we reach in our previous conversation?",
      "What was our agreed plan in the previous conversation?",
      "Which option was chosen in our previous conversation?",
      "Do you remember what was agreed?",
      "Do you remember which option was finally decided on?",
      "Do you remember which plan was selected last time?",
      "Do you remember what was confirmed?",
      "Do you remember which option was picked?",
      "Do you remember what was approved?",
      "Do you remember what resolution was reached?",
      "Do you remember what Alex recommended?",
      "Do you remember what my doctor suggested?",
      "Do you remember what the team proposed?",
      "Do you remember what was recommended by Alex?",
      "Do you remember what was suggested by my doctor?",
      "Do you remember what was recommended by me?",
      "Do you remember what was recommended by us?",
      "What was Alex's recommendation in the previous conversation?",
      "What was my doctor's suggestion in the previous conversation?",
      "What was the recommendation by Alex in our previous conversation?",
      "What was the recommendation by me in our previous conversation?",
      "What was the recommendation by us in our previous conversation?",
      "What was the recommendation from Alex in our previous conversation?",
      "Which suggestion came from my doctor in the previous conversation?",
      "What was the recommendation according to Alex in our previous conversation?",
      "Do you remember what was the address I gave you?",
      "Do you remember what was the plan Alex approved?",
      "Do you remember what was the diagnosis according to my doctor?",
      "What was our recommendation in the previous conversation?",
      "What was our response to your message in the previous conversation?",
      "我们上次聊天最终选择了哪个方案？",
      "我们之前对话里达成的方案是什么？",
      "你还记得上次最后选定的是哪个方案吗？",
      "你记得之前同意的是什么吗？",
      "你还记得最后确认的是哪个方案吗？",
      "你还记得最后通过的是哪个方案吗？",
      "你还记得医生建议了什么吗？",
      "你还记得小王推荐了什么吗？",
      "医生的建议是什么？",
      "小王的推荐是什么？",
      "之前对话里小王的建议是什么？",
      "之前对话里的建议是小王的吗？",
      "之前对话中来自小王的建议是什么？",
      "我们的建议是什么？",
    ]) {
      expect(proposesMemorySessionOpeningAssistantOriginV1(sharedOutcome)).toBe(
        false,
      );
    }
    expect(
      proposesMemorySessionOpeningAssistantOriginV1("Which city did I visit?"),
    ).toBe(false);
  });

  test("binds a reported-origin proposal only after authority is fixed", () => {
    const query = "Do you remember what was the color earlier?";
    const proposal = classifyMemoryAssistantOriginApertureV1(query);
    expect(proposal).toBe("session_opening_reported_assistant_assertion");

    const requirement = {
      requirementId: "prior-color",
      label: "prior color",
      searchText: "color from earlier",
      temporalMode: "any" as const,
      roleConstraint: "user" as const,
    };
    const intent = {
      answerShape: "lookup" as const,
      temporalMode: "any" as const,
      roleConstraint: "user" as const,
      needsPlanning: true,
    };
    expect(
      reconcileMemoryAssistantOriginApertureV1({
        proposal,
        intent,
        requirements: [requirement],
      }),
    ).toBe("session_opening_reported_assistant_assertion");
    expect(
      reconcileMemoryAssistantOriginApertureV1({
        proposal,
        intent,
        requirements: [
          requirement,
          { ...requirement, requirementId: "prior-material" },
        ],
      }),
    ).toBe("closed");
    for (const roleConstraint of ["any", "assistant"] as const) {
      expect(
        reconcileMemoryAssistantOriginApertureV1({
          proposal,
          intent: { ...intent, roleConstraint },
          requirements: [{ ...requirement, roleConstraint }],
        }),
      ).toBe("session_opening_assistant_artifact");
    }
    expect(
      reconcileMemoryAssistantOriginApertureV1({
        proposal: "addressed_reply_only",
        intent,
        requirements: [requirement],
      }),
    ).toBe("addressed_reply_only");
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

  test("classifies the same independent intent axes in Chinese", () => {
    expect(classifyMemoryEvidenceQueryV3("我目前一共有多少粉丝？")).toEqual({
      answerShape: "aggregate",
      temporalMode: "latest",
      roleConstraint: "user",
      needsPlanning: true,
    });
    expect(classifyMemoryEvidenceQueryV3("你上次推荐了什么？")).toEqual({
      answerShape: "recommend",
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
