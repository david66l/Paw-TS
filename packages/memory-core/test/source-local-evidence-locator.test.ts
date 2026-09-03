import { describe, expect, test } from "bun:test";

import {
  DEFAULT_MEMORY_SOURCE_LOCAL_EVIDENCE_BUDGET_V1,
  PAW_MEMORY_TEMPORAL_EVIDENCE_FRONTIER_VERSION_V1,
  type MemorySourceLocalEvidenceHitV1,
  type MemorySourceLocalEvidenceResultV1,
  createMemoryTemporalEvidenceFrontierSnapshotV1,
  createMemoryTemporalRoundPostingV1,
  evaluateMemorySourceLocalLeafEligibilityV2,
  hasMemorySourceLocalDialogueCertificateV1,
  hydrateMemorySourceLocalEvidenceResultV1,
  isMemorySourceLocalEvidenceEligibleV1,
  isMemorySourceLocalEvidenceRouteEligibleV2,
  memorySourceLocalAnchorKindsV1,
  memorySourceLocalEvidenceCacheKeyV1,
  validateMemoryTemporalEvidenceFrontierSnapshotV1,
  validateMemorySourceLocalEvidenceResultV1,
} from "../src/legacy.js";
import { hashTextV1 } from "../src/canonical.js";
import {
  authorizeMemoryQueryAnswerOriginMaterializationV1,
  compileMemoryQueryAnswerOriginV1,
} from "../src/query-answer-origin.js";
import {
  bindMemoryEvidenceTemporalConstraintV1,
  compileMemoryEvidenceTemporalConstraintV1,
} from "../src/temporal-constraint.js";

const requirement = Object.freeze({
  requirementId: "assistant-answer",
  label: "prior assistant answer",
  searchText: "the answer you gave",
  temporalMode: "any" as const,
  roleConstraint: "assistant" as const,
  relation: "direct" as const,
  coverageMode: "any" as const,
  minimumEvidence: 1,
});

const unownedDialogueQuery = "Can you remember the earlier label for me?";

function lateBindingAuthorization(requirementId = requirement.requirementId) {
  const origin = compileMemoryQueryAnswerOriginV1(unownedDialogueQuery);
  const authorization = authorizeMemoryQueryAnswerOriginMaterializationV1({
    origin,
    requirement: {
      ...requirement,
      requirementId,
      roleConstraint: "user" as const,
    },
    effectiveRequirementRole: "any",
    mode: "late_binding",
  });
  if (!authorization) throw new Error("test authorization missing");
  return authorization;
}

describe("source-local evidence locator boundary", () => {
  test("derives one shared role aperture for every locator adapter", () => {
    const request = {
      requirement,
      lockedSourceIds: ["session-1"],
      budget: DEFAULT_MEMORY_SOURCE_LOCAL_EVIDENCE_BUDGET_V1,
    };
    expect(memorySourceLocalAnchorKindsV1(request)).toEqual([
      "assistant_output",
    ]);
    expect(
      memorySourceLocalAnchorKindsV1({
        ...request,
        requirement: { ...requirement, roleConstraint: "user" },
      }),
    ).toEqual(["user_input"]);
    expect(
      memorySourceLocalAnchorKindsV1({
        ...request,
        requirement: { ...requirement, roleConstraint: "user" },
        assistantDialogueCandidate: true,
      }),
    ).toEqual(["user_input", "assistant_output"]);
  });

  test("certifies only an exact preceding user request", () => {
    expect(
      hasMemorySourceLocalDialogueCertificateV1(
        [
          {
            evidenceRef: "session#turn-1",
            sourceKind: "user_input",
            turnOrder: 1,
          },
          {
            evidenceRef: "session#turn-2",
            sourceKind: "assistant_output",
            turnOrder: 2,
          },
        ],
        2,
      ),
    ).toBe(true);
    expect(
      hasMemorySourceLocalDialogueCertificateV1(
        [
          {
            evidenceRef: "session#turn-1",
            sourceKind: "assistant_output",
            turnOrder: 1,
          },
          {
            evidenceRef: "session#turn-2",
            sourceKind: "assistant_output",
            turnOrder: 2,
          },
        ],
        2,
      ),
    ).toBe(false);
  });

  test("opens bounded dialogue retrieval without owning answer semantics", () => {
    expect(
      isMemorySourceLocalEvidenceEligibleV1({
        answerShape: "lookup",
        temporalMode: "any",
        roleConstraint: "assistant",
        requirements: [requirement],
        supportSelectorConfigured: true,
      }),
    ).toBe(true);
    expect(
      isMemorySourceLocalEvidenceEligibleV1({
        answerShape: "lookup",
        temporalMode: "any",
        roleConstraint: "any",
        requirements: [{ ...requirement, roleConstraint: "any" }],
        supportSelectorConfigured: true,
      }),
    ).toBe(true);
    expect(
      isMemorySourceLocalEvidenceEligibleV1({
        answerShape: "lookup",
        temporalMode: "any",
        roleConstraint: "user",
        requirements: [{ ...requirement, roleConstraint: "user" }],
        supportSelectorConfigured: true,
        certifiedAssistantDialogueCandidate: true,
      }),
    ).toBe(true);
    expect(
      isMemorySourceLocalEvidenceEligibleV1({
        answerShape: "lookup",
        temporalMode: "any",
        roleConstraint: "user",
        requirements: [
          { ...requirement, roleConstraint: "user" },
          {
            ...requirement,
            requirementId: "explicit-user-fact",
            searchText: "the user's address",
            roleConstraint: "user",
          },
        ],
        supportSelectorConfigured: true,
        certifiedAssistantDialogueCandidate: true,
      }),
    ).toBe(false);
    expect(
      isMemorySourceLocalEvidenceEligibleV1({
        answerShape: "aggregate",
        temporalMode: "any",
        roleConstraint: "user",
        requirements: [
          {
            ...requirement,
            roleConstraint: "user",
            relation: "temporal",
            coverageMode: "all",
            minimumEvidence: 2,
          },
        ],
        supportSelectorConfigured: true,
      }),
    ).toBe(true);
    expect(
      isMemorySourceLocalEvidenceEligibleV1({
        answerShape: "recommend",
        temporalMode: "any",
        roleConstraint: "user",
        requirements: [
          { ...requirement, roleConstraint: "user" },
          {
            ...requirement,
            requirementId: "recommendation-input-2",
            roleConstraint: "user",
          },
        ],
        supportSelectorConfigured: true,
      }),
    ).toBe(false);
    expect(
      isMemorySourceLocalEvidenceEligibleV1({
        answerShape: "lookup",
        temporalMode: "any",
        roleConstraint: "user",
        requirements: [{ ...requirement, roleConstraint: "user" }],
        supportSelectorConfigured: true,
      }),
    ).toBe(false);
    expect(
      isMemorySourceLocalEvidenceEligibleV1({
        answerShape: "lookup",
        temporalMode: "any",
        roleConstraint: "assistant",
        requirements: [
          requirement,
          {
            ...requirement,
            requirementId: "assistant-answer-2",
            searchText: "the second answer you gave",
          },
        ],
        supportSelectorConfigured: true,
      }),
    ).toBe(true);
    expect(
      isMemorySourceLocalEvidenceEligibleV1({
        answerShape: "lookup",
        temporalMode: "any",
        roleConstraint: "assistant",
        requirements: [
          requirement,
          {
            ...requirement,
            requirementId: "assistant-inference",
            relation: "inferred",
            coverageMode: "convergent",
            minimumEvidence: 2,
          },
        ],
        supportSelectorConfigured: true,
      }),
    ).toBe(false);
    expect(
      isMemorySourceLocalEvidenceEligibleV1({
        answerShape: "aggregate",
        temporalMode: "range",
        roleConstraint: "assistant",
        requirements: [
          {
            ...requirement,
            temporalMode: "range",
            relation: "temporal",
            coverageMode: "all",
            minimumEvidence: 2,
          },
        ],
        supportSelectorConfigured: true,
      }),
    ).toBe(true);
    expect(
      isMemorySourceLocalEvidenceEligibleV1({
        answerShape: "compare",
        temporalMode: "history",
        roleConstraint: "assistant",
        requirements: [
          {
            ...requirement,
            temporalMode: "history",
            relation: "comparative",
            coverageMode: "all",
            minimumEvidence: 2,
          },
        ],
        supportSelectorConfigured: true,
      }),
    ).toBe(true);
    expect(
      isMemorySourceLocalEvidenceEligibleV1({
        answerShape: "aggregate",
        temporalMode: "any",
        roleConstraint: "assistant",
        requirements: [
          {
            ...requirement,
            relation: "inferred",
            coverageMode: "convergent",
            minimumEvidence: 2,
          },
        ],
        supportSelectorConfigured: true,
      }),
    ).toBe(false);
  });

  test("evaluates mixed temporal and recommendation leaves independently", () => {
    const query = "Based on my history, what should I choose next?";
    const directConstraint = compileMemoryEvidenceTemporalConstraintV1({
      query,
      queryEnvelopeMode: "any",
      leafMode: "any",
    });
    const rangeConstraint = compileMemoryEvidenceTemporalConstraintV1({
      query,
      queryEnvelopeMode: "any",
      leafMode: "range",
    });
    const requirements = [
      {
        ...requirement,
        requirementId: "preference-input",
        roleConstraint: "user" as const,
        temporalConstraint: directConstraint,
      },
      {
        ...requirement,
        requirementId: "history-input",
        roleConstraint: "user" as const,
        temporalMode: "range" as const,
        relation: "temporal" as const,
        coverageMode: "all" as const,
        temporalConstraint: rangeConstraint,
      },
    ];
    const routeEligible = isMemorySourceLocalEvidenceRouteEligibleV2({
      answerShape: "recommend",
      temporalMode: "any",
      roleConstraint: "user",
      requirements,
      supportSelectorConfigured: true,
    });
    expect(routeEligible).toBe(true);
    for (const item of requirements) {
      const bound = bindMemoryEvidenceTemporalConstraintV1({
        query,
        queryEnvelopeMode: "any",
        leafMode: item.temporalMode,
        constraint: item.temporalConstraint,
        evidenceTimeUpperBound: "2026-01-01T00:00:00Z",
      });
      expect(
        evaluateMemorySourceLocalLeafEligibilityV2({
          requirement: item,
          temporalBindingRevision: bound.bindingRevision,
          routeEligible,
          supportSelectorConfigured: true,
        }),
      ).toMatchObject({ eligible: true, reasonCode: "eligible" });
    }
    const firstRequirement = requirements[0];
    if (!firstRequirement) throw new Error("test requirement missing");
    const inferred = evaluateMemorySourceLocalLeafEligibilityV2({
      requirement: {
        ...firstRequirement,
        relation: "inferred",
        coverageMode: "convergent",
      },
      temporalBindingRevision: bindMemoryEvidenceTemporalConstraintV1({
        query,
        queryEnvelopeMode: "any",
        leafMode: "any",
        constraint: directConstraint,
      }).bindingRevision,
      routeEligible,
      supportSelectorConfigured: true,
    });
    expect(inferred).toMatchObject({
      eligible: false,
      reasonCode: "relation_ineligible",
    });
  });

  test("rejects source escape, wrong-role anchors and missing trace addresses", () => {
    const locator = {
      locatorVersion: "test-locator.v1",
      async locate() {
        throw new Error("unused");
      },
    };
    const request = {
      requirement,
      lockedSourceIds: ["session-1"],
      budget: DEFAULT_MEMORY_SOURCE_LOCAL_EVIDENCE_BUDGET_V1,
    };
    const result = {
      locatorVersion: locator.locatorVersion,
      locatorRevision: "revision",
      hits: [
        {
          sourceId: "session-2",
          evidenceRef: "session-2#turn-2",
          anchorEvidenceRef: "session-2#turn-2",
          contextEvidenceRefs: ["session-2#turn-2"],
          sourceKind: "assistant_output" as const,
          content: "assistant answer",
          authority: "context_only" as const,
          turnOrder: 2,
          includedTurns: [
            {
              evidenceRef: "session-2#turn-2",
              sourceKind: "assistant_output" as const,
              turnOrder: 2,
            },
          ],
        },
      ],
      degradedChannels: [] as const,
      telemetry: {
        lexicalCandidates: 1,
        denseCandidates: 1,
        anchorCount: 1,
        includedTurnCount: 1,
        renderedChars: "assistant answer".length,
        cacheHit: false,
        durationMs: 1,
      },
    };
    expect(() =>
      validateMemorySourceLocalEvidenceResultV1({
        locator,
        request,
        result,
      }),
    ).toThrow("MemorySourceLocalEvidenceHitInvalid");
  });

  test("binds every trace address and timestamp to the locked source and anchor", () => {
    const locator = {
      locatorVersion: "test-locator.v1",
      async locate() {
        throw new Error("unused");
      },
    };
    const request = {
      requirement,
      lockedSourceIds: ["session-1"],
      evidenceTimeUpperBound: "2026-01-02T00:00:00.000Z",
      budget: DEFAULT_MEMORY_SOURCE_LOCAL_EVIDENCE_BUDGET_V1,
    };
    const validHit: MemorySourceLocalEvidenceHitV1 = {
      sourceId: "session-1",
      evidenceRef: "session-1#thread#turn-2",
      anchorEvidenceRef: "session-1#thread#turn-2",
      contextEvidenceRefs: ["session-1#thread#turn-2"],
      sourceKind: "assistant_output",
      content: "assistant answer",
      authority: "context_only",
      observedAt: "2026-01-01T00:00:00.000Z",
      turnOrder: 2,
      includedTurns: [
        {
          evidenceRef: "session-1#thread#turn-2",
          sourceKind: "assistant_output",
          observedAt: "2026-01-01T00:00:00.000Z",
          turnOrder: 2,
        },
      ],
    };
    const resultFor = (
      hit: MemorySourceLocalEvidenceHitV1,
    ): MemorySourceLocalEvidenceResultV1 => ({
      locatorVersion: locator.locatorVersion,
      locatorRevision: "revision",
      hits: [hit],
      degradedChannels: [],
      telemetry: {
        lexicalCandidates: 1,
        denseCandidates: 0,
        anchorCount: 1,
        includedTurnCount: hit.includedTurns.length,
        renderedChars: hit.content.length,
        cacheHit: false,
        durationMs: 1,
      },
    });
    const validAnchor = validHit.includedTurns[0];
    if (!validAnchor) throw new Error("valid anchor fixture is missing");
    expect(
      validateMemorySourceLocalEvidenceResultV1({
        locator,
        request,
        result: resultFor(validHit),
      }),
    ).toHaveLength(1);
    const escapedRef = "session-2#thread#turn-2";
    expect(() =>
      validateMemorySourceLocalEvidenceResultV1({
        locator,
        request,
        result: resultFor({
          ...validHit,
          evidenceRef: escapedRef,
          anchorEvidenceRef: escapedRef,
          contextEvidenceRefs: [escapedRef],
          includedTurns: [{ ...validAnchor, evidenceRef: escapedRef }],
        }),
      }),
    ).toThrow("MemorySourceLocalEvidenceHitInvalid");
    expect(() =>
      validateMemorySourceLocalEvidenceResultV1({
        locator,
        request,
        result: resultFor({
          ...validHit,
          observedAt: "not-a-time",
          includedTurns: [{ ...validAnchor, observedAt: "not-a-time" }],
        }),
      }),
    ).toThrow("MemorySourceLocalEvidenceHitInvalid");
    expect(() =>
      validateMemorySourceLocalEvidenceResultV1({
        locator,
        request,
        result: resultFor({
          ...validHit,
          contextEvidenceRefs: ["session-1#thread#turn-99"],
        }),
      }),
    ).toThrow("MemorySourceLocalEvidenceTraceInvalid");
    expect(() =>
      validateMemorySourceLocalEvidenceResultV1({
        locator,
        request,
        result: resultFor({
          ...validHit,
          includedTurns: [{ ...validAnchor, turnOrder: 3 }],
        }),
      }),
    ).toThrow("MemorySourceLocalEvidenceAnchorRoleInvalid");
    expect(() =>
      validateMemorySourceLocalEvidenceResultV1({
        locator,
        request,
        result: resultFor({
          ...validHit,
          turnOrder: 0,
          includedTurns: [{ ...validAnchor, turnOrder: 0 }],
        }),
      }),
    ).toThrow("MemorySourceLocalEvidenceHitInvalid");

    const sharedDialogueRequest = {
      ...request,
      requirement: { ...requirement, roleConstraint: "any" as const },
    };
    expect(() =>
      validateMemorySourceLocalEvidenceResultV1({
        locator,
        request: sharedDialogueRequest,
        result: resultFor(validHit),
      }),
    ).toThrow("MemorySourceLocalEvidenceProvenanceInvalid");
    const userRequestRef = "session-1#thread#turn-1";
    const certifiedSharedDialogueHit: MemorySourceLocalEvidenceHitV1 = {
      ...validHit,
      contextEvidenceRefs: [userRequestRef, validHit.evidenceRef],
      includedTurns: [
        {
          evidenceRef: userRequestRef,
          sourceKind: "user_input",
          observedAt: "2026-01-01T00:00:00.000Z",
          turnOrder: 1,
        },
        validAnchor,
      ],
    };
    expect(
      validateMemorySourceLocalEvidenceResultV1({
        locator,
        request: sharedDialogueRequest,
        result: resultFor(certifiedSharedDialogueHit),
      }),
    ).toHaveLength(1);
  });

  test("partitions result caches by acquisition, source, role, cutoff and index", () => {
    const base = {
      locatorVersion: "test-locator.v1",
      scopeFingerprint: "scope",
      turnIndexRevision: "r1",
      request: {
        requirement,
        lockedSourceIds: ["session-1"],
        sourceAcquisitionRevision: "acquisition-v1",
        evidenceTimeUpperBound: "2026-01-01T00:00:00.000Z",
        budget: DEFAULT_MEMORY_SOURCE_LOCAL_EVIDENCE_BUDGET_V1,
      },
      adjacencyPolicyVersion: "neighbors-v1",
      rankerVersion: "rrf-v1",
    };
    const first = memorySourceLocalEvidenceCacheKeyV1(base);
    expect(memorySourceLocalEvidenceCacheKeyV1(base)).toBe(first);
    expect(
      memorySourceLocalEvidenceCacheKeyV1({
        ...base,
        request: {
          ...base.request,
          sourceAcquisitionRevision: "acquisition-v2",
        },
      }),
    ).not.toBe(first);
    expect(
      memorySourceLocalEvidenceCacheKeyV1({
        ...base,
        request: {
          ...base.request,
          requirement: {
            ...base.request.requirement,
            searchText: "  the   answer you gave  ",
          },
        },
      }),
    ).toBe(first);
    expect(
      memorySourceLocalEvidenceCacheKeyV1({
        ...base,
        request: {
          ...base.request,
          requirement: {
            ...base.request.requirement,
            searchText: "THE ANSWER YOU GAVE",
          },
        },
      }),
    ).not.toBe(first);
    expect(
      memorySourceLocalEvidenceCacheKeyV1({
        ...base,
        request: {
          ...base.request,
          requirement: {
            ...base.request.requirement,
            searchText: "a different answer",
          },
        },
      }),
    ).not.toBe(first);
    expect(
      memorySourceLocalEvidenceCacheKeyV1({
        ...base,
        request: { ...base.request, lockedSourceIds: ["session-2"] },
      }),
    ).not.toBe(first);
    expect(
      memorySourceLocalEvidenceCacheKeyV1({
        ...base,
        turnIndexRevision: "r2",
      }),
    ).not.toBe(first);
    expect(
      memorySourceLocalEvidenceCacheKeyV1({
        ...base,
        request: {
          ...base.request,
          evidenceTimeUpperBound: "2026-01-02T00:00:00.000Z",
        },
      }),
    ).not.toBe(first);
    expect(
      memorySourceLocalEvidenceCacheKeyV1({
        ...base,
        request: {
          ...base.request,
          assistantDialogueCandidate: true,
        },
      }),
    ).not.toBe(first);
    expect(
      memorySourceLocalEvidenceCacheKeyV1({
        ...base,
        request: {
          ...base.request,
          assistantDialogueCandidate: true,
          requirement: {
            ...base.request.requirement,
            roleConstraint: "any" as const,
          },
          respondingAssistantMaterialization: {
            originalQuery: unownedDialogueQuery,
            sourcePriorityIds: ["session-1"],
            maxPromptAnchorsPerSource: 1,
            authorization: lateBindingAuthorization(),
          },
        },
      }),
    ).not.toBe(first);
  });

  test("rejects an unbounded or provenance-free responding-assistant request", () => {
    const base = {
      locatorVersion: "test-locator.v1",
      scopeFingerprint: "scope",
      turnIndexRevision: "r1",
      request: {
        requirement: { ...requirement, roleConstraint: "any" as const },
        lockedSourceIds: ["session-1", "session-2", "session-3"],
        budget: {
          ...DEFAULT_MEMORY_SOURCE_LOCAL_EVIDENCE_BUDGET_V1,
          maxAnchors: 2,
          maxAnchorsPerSource: 2,
        },
        respondingAssistantMaterialization: {
          originalQuery: unownedDialogueQuery,
          sourcePriorityIds: ["session-1", "session-2", "session-3"],
          maxPromptAnchorsPerSource: 1 as const,
          authorization: lateBindingAuthorization(),
        },
      },
      adjacencyPolicyVersion: "neighbors-v1",
      rankerVersion: "rrf-v1",
    };
    expect(() => memorySourceLocalEvidenceCacheKeyV1(base)).toThrow(
      "MemorySourceLocalEvidenceAnswerOriginInvalid",
    );
    expect(() =>
      memorySourceLocalEvidenceCacheKeyV1({
        ...base,
        request: {
          ...base.request,
          lockedSourceIds: ["session-1"],
          assistantDialogueCandidate: true,
          respondingAssistantMaterialization: {
            ...base.request.respondingAssistantMaterialization,
            sourcePriorityIds: ["session-1"],
          },
        },
      }),
    ).not.toThrow();
  });

  test("accepts exact user anchors without opening uncertified assistant prose", () => {
    const locator = {
      locatorVersion: "test-locator.v2",
      async locate() {
        throw new Error("unused");
      },
    };
    const userRequirement = {
      ...requirement,
      requirementId: "user-history",
      roleConstraint: "user" as const,
      relation: "temporal" as const,
      coverageMode: "all" as const,
      minimumEvidence: 2,
    };
    const request = {
      requirement: userRequirement,
      lockedSourceIds: ["session-1"],
      budget: DEFAULT_MEMORY_SOURCE_LOCAL_EVIDENCE_BUDGET_V1,
    };
    const userHit: MemorySourceLocalEvidenceHitV1 = {
      sourceId: "session-1",
      evidenceRef: "session-1#turn-3",
      anchorEvidenceRef: "session-1#turn-3",
      contextEvidenceRefs: ["session-1#turn-3"],
      sourceKind: "user_input",
      content: "[user_input hit] the exact user statement",
      authority: "user_asserted",
      turnOrder: 3,
      includedTurns: [
        {
          evidenceRef: "session-1#turn-3",
          sourceKind: "user_input",
          turnOrder: 3,
        },
      ],
    };
    const resultFor = (
      hit: MemorySourceLocalEvidenceHitV1,
    ): MemorySourceLocalEvidenceResultV1 => ({
      locatorVersion: locator.locatorVersion,
      locatorRevision: "revision",
      hits: [hit],
      degradedChannels: [],
      telemetry: {
        lexicalCandidates: 1,
        denseCandidates: 0,
        anchorCount: 1,
        includedTurnCount: hit.includedTurns.length,
        renderedChars: hit.content.length,
        cacheHit: false,
        durationMs: 1,
      },
    });
    expect(
      validateMemorySourceLocalEvidenceResultV1({
        locator,
        request,
        result: resultFor(userHit),
      }),
    ).toHaveLength(1);

    const assistantHit: MemorySourceLocalEvidenceHitV1 = {
      ...userHit,
      evidenceRef: "session-1#turn-4",
      anchorEvidenceRef: "session-1#turn-4",
      contextEvidenceRefs: ["session-1#turn-3", "session-1#turn-4"],
      sourceKind: "assistant_output",
      authority: "context_only",
      turnOrder: 4,
      includedTurns: [
        {
          evidenceRef: "session-1#turn-3",
          sourceKind: "user_input",
          turnOrder: 3,
        },
        {
          evidenceRef: "session-1#turn-4",
          sourceKind: "assistant_output",
          turnOrder: 4,
        },
      ],
    };
    expect(() =>
      validateMemorySourceLocalEvidenceResultV1({
        locator,
        request,
        result: resultFor(assistantHit),
      }),
    ).toThrow("MemorySourceLocalEvidenceHitInvalid");
    expect(
      validateMemorySourceLocalEvidenceResultV1({
        locator,
        request: { ...request, assistantDialogueCandidate: true },
        result: resultFor(assistantHit),
      }),
    ).toHaveLength(1);
  });

  test("binds an exact temporal frontier to the original query and locked rounds", async () => {
    const query = "What did I do last month?";
    const temporalConstraint = compileMemoryEvidenceTemporalConstraintV1({
      query,
      queryEnvelopeMode: "range",
      leafMode: "range",
    });
    const temporalBinding = bindMemoryEvidenceTemporalConstraintV1({
      query,
      queryEnvelopeMode: "range",
      leafMode: "range",
      constraint: temporalConstraint,
      evidenceTimeUpperBound: "2025-05-20T00:00:00.000Z",
    });
    const request = {
      requirement: {
        ...requirement,
        requirementId: "last-month-event",
        searchText: "the relevant event",
        temporalMode: "range" as const,
        roleConstraint: "user" as const,
        relation: "temporal" as const,
        coverageMode: "all" as const,
        temporalConstraint,
      },
      temporalFrontier: {
        frontierVersion: PAW_MEMORY_TEMPORAL_EVIDENCE_FRONTIER_VERSION_V1,
        originalQuery: query,
        temporalBinding,
        lanePolicy: "original_and_requirement" as const,
        baselineEvidenceRefs: [] as const,
      },
      lockedSourceIds: ["session-1", "session-2"],
      sourceAcquisitionRevision: "acquisition-v1",
      evidenceTimeUpperBound: "2025-05-20T00:00:00.000Z",
      budget: DEFAULT_MEMORY_SOURCE_LOCAL_EVIDENCE_BUDGET_V1,
    };
    const inside = createMemoryTemporalRoundPostingV1({
      sourceId: "session-1",
      evidenceRef: "session-1#turn-1",
      role: "user_input",
      contentDigest: "a".repeat(64),
      observedAt: "2025-04-10T00:00:00.000Z",
      episodeOrder: 1,
      turnOrder: 1,
      timeBasis: "source_observed_at",
    });
    const outside = createMemoryTemporalRoundPostingV1({
      sourceId: "session-2",
      evidenceRef: "session-2#turn-1",
      role: "user_input",
      contentDigest: "b".repeat(64),
      observedAt: "2025-03-10T00:00:00.000Z",
      episodeOrder: 0,
      turnOrder: 1,
      timeBasis: "source_observed_at",
    });
    const snapshot = createMemoryTemporalEvidenceFrontierSnapshotV1({
      request,
      indexRevision: "turn-index-v1",
      postings: [inside, outside],
      returnedEvidenceRefs: [inside.evidenceRef],
    });
    expect(snapshot).toMatchObject({
      status: "adapter_enumerated",
      temporalBindingRevision: temporalBinding.bindingRevision,
      partitions: {
        eventInsideWindowEvidenceRefs: [],
        eventOutsideWindowEvidenceRefs: [],
        sourceClockHintInsideEvidenceRefs: [inside.evidenceRef],
        sourceClockHintOutsideEvidenceRefs: [outside.evidenceRef],
        timeUnboundEvidenceRefs: [],
      },
      omitted: [
        { evidenceRef: outside.evidenceRef, reason: "rank_budget" },
      ],
    });
    expect(snapshot.introducedEvidenceRefs).toEqual([inside.evidenceRef]);
    expect(() =>
      validateMemoryTemporalEvidenceFrontierSnapshotV1({
        request,
        snapshot,
        returnedEvidenceRefs: [inside.evidenceRef],
      }),
    ).not.toThrow();
    expect(() =>
      validateMemoryTemporalEvidenceFrontierSnapshotV1({
        request,
        snapshot: { ...snapshot, introducedEvidenceRefs: [] },
        returnedEvidenceRefs: [inside.evidenceRef],
      }),
    ).toThrow("MemorySourceLocalEvidenceTemporalFrontierInvalid");
    expect(() =>
      validateMemoryTemporalEvidenceFrontierSnapshotV1({
        request: {
          ...request,
          lockedSourceIds: [...request.lockedSourceIds].reverse(),
        },
        snapshot,
        returnedEvidenceRefs: [inside.evidenceRef],
      }),
    ).toThrow("MemorySourceLocalEvidenceTemporalFrontierInvalid");
    const baselineSnapshot = createMemoryTemporalEvidenceFrontierSnapshotV1({
      request: {
        ...request,
        temporalFrontier: {
          ...request.temporalFrontier,
          baselineEvidenceRefs: [inside.evidenceRef],
        },
      },
      indexRevision: "turn-index-v1",
      postings: [inside, outside],
      returnedEvidenceRefs: [inside.evidenceRef],
    });
    expect(baselineSnapshot.introducedEvidenceRefs).toEqual([]);
    expect(() =>
      createMemoryTemporalEvidenceFrontierSnapshotV1({
        request,
        indexRevision: "turn-index-v1",
        postings: [
          createMemoryTemporalRoundPostingV1({
            ...inside,
            sourceId: "session-3",
            evidenceRef: "session-3#turn-1",
          }),
        ],
        returnedEvidenceRefs: [],
      }),
    ).toThrow("MemorySourceLocalEvidenceTemporalFrontierPostingInvalid");
    expect(() =>
      memorySourceLocalEvidenceCacheKeyV1({
        locatorVersion: "test-locator.v1",
        scopeFingerprint: "scope",
        turnIndexRevision: "turn-index-v1",
        request: {
          ...request,
          temporalFrontier: {
            ...request.temporalFrontier,
            originalQuery: "What did I do last week?",
          },
        },
        adjacencyPolicyVersion: "neighbors-v1",
        rankerVersion: "frontier-v1",
      }),
    ).toThrow("MemorySourceLocalEvidenceTemporalFrontierRequestInvalid");

    const cacheInput = {
      locatorVersion: "test-locator.v1",
      scopeFingerprint: "scope",
      turnIndexRevision: "turn-index-v1",
      request,
      adjacencyPolicyVersion: "neighbors-v1",
      rankerVersion: "frontier-v1",
    };
    const cacheKey = memorySourceLocalEvidenceCacheKeyV1(cacheInput);
    for (const changedRequest of [
      { ...request, lockedSourceIds: [...request.lockedSourceIds].reverse() },
      { ...request, sourceAcquisitionRevision: "acquisition-v2" },
      {
        ...request,
        requirement: { ...request.requirement, label: "different lane label" },
      },
      {
        ...request,
        budget: { ...request.budget, maxAnchors: 5 },
      },
      {
        ...request,
        temporalFrontier: {
          ...request.temporalFrontier,
          baselineEvidenceRefs: [inside.evidenceRef],
        },
      },
    ]) {
      expect(
        memorySourceLocalEvidenceCacheKeyV1({
          ...cacheInput,
          request: changedRequest,
        }),
      ).not.toBe(cacheKey);
    }

    const immutableContent = "the immutable omitted frontier turn";
    const immutablePosting = createMemoryTemporalRoundPostingV1({
      sourceId: "session-1",
      evidenceRef: "session-1#turn-9",
      role: "user_input",
      contentDigest: hashTextV1(immutableContent),
      observedAt: "2025-04-12T00:00:00.000Z",
      turnOrder: 9,
      timeBasis: "source_observed_at",
    });
    const omittedSnapshot = createMemoryTemporalEvidenceFrontierSnapshotV1({
      request,
      indexRevision: "turn-index-v1",
      postings: [immutablePosting],
      returnedEvidenceRefs: [],
    });
    await expect(
      hydrateMemorySourceLocalEvidenceResultV1({
        hydrator: {
          hydratorVersion: "test-hydrator.v1",
          async hydrate(evidenceRefs) {
            return evidenceRefs.map((evidenceRef) => ({
              evidenceRef,
              sourceKind: "user_input" as const,
              turnOrder: 9,
              observedAt: "2025-04-12T00:00:00.000Z",
              content: `${immutableContent} tampered`,
              contentHash: hashTextV1(`${immutableContent} tampered`),
            }));
          },
        },
        request,
        result: {
          locatorVersion: "test-locator.v1",
          locatorRevision: "locator-revision",
          hits: [],
          degradedChannels: [],
          temporalFrontier: omittedSnapshot,
          telemetry: {
            lexicalCandidates: 0,
            denseCandidates: 0,
            anchorCount: 0,
            includedTurnCount: 0,
            renderedChars: 0,
            cacheHit: false,
            durationMs: 1,
          },
        },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(
      "MemorySourceLocalEvidenceTemporalFrontierPostingInvalid",
    );
  });
});
