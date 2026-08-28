import { describe, expect, test } from "bun:test";

import {
  DEFAULT_MEMORY_SOURCE_LOCAL_EVIDENCE_BUDGET_V1,
  type MemorySourceLocalEvidenceHitV1,
  type MemorySourceLocalEvidenceResultV1,
  hasMemorySourceLocalAssistantOriginCertificateV1,
  hasMemorySourceLocalDialogueCertificateV1,
  isMemorySourceLocalEvidenceEligibleV1,
  memorySourceLocalBackfillSourceIdsV1,
  memorySourceLocalDiverseCandidateCapV1,
  memorySourceLocalEvidenceCacheKeyV1,
  rankMemorySourceLocalAnchorCandidatesV1,
  validateMemorySourceLocalEvidenceResultV1,
} from "../src/index.js";

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

describe("source-local evidence locator boundary", () => {
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

  test("certifies an exact session-opening assistant turn without promoting it", () => {
    expect(
      hasMemorySourceLocalAssistantOriginCertificateV1(
        [
          {
            evidenceRef: "session#turn-1",
            sourceKind: "assistant_output",
            turnOrder: 1,
          },
        ],
        1,
        "allow_session_opening_artifact",
      ),
    ).toBe(true);
    expect(
      hasMemorySourceLocalAssistantOriginCertificateV1(
        [
          {
            evidenceRef: "session#turn-1",
            sourceKind: "assistant_output",
            turnOrder: 1,
          },
        ],
        1,
        "allow_session_opening_reported_assertion",
      ),
    ).toBe(true);
    expect(
      hasMemorySourceLocalAssistantOriginCertificateV1(
        [
          {
            evidenceRef: "session#turn-2",
            sourceKind: "assistant_output",
            turnOrder: 2,
          },
        ],
        2,
        "allow_session_opening_artifact",
      ),
    ).toBe(false);
    expect(
      hasMemorySourceLocalAssistantOriginCertificateV1(
        [
          {
            evidenceRef: "session#turn-1",
            sourceKind: "assistant_output",
            turnOrder: 1,
          },
        ],
        1,
        "addressed_reply_only",
      ),
    ).toBe(false);
  });

  test("binds the reported assertion policy to a reported requirement", () => {
    const locator = {
      locatorVersion: "test-locator.v1",
      async locate() {
        throw new Error("unused");
      },
    };
    const emptyResult = {
      locatorVersion: locator.locatorVersion,
      locatorRevision: "empty",
      hits: [] as const,
      degradedChannels: [] as const,
      telemetry: {
        lexicalCandidates: 0,
        denseCandidates: 0,
        anchorCount: 0,
        includedTurnCount: 0,
        renderedChars: 0,
        cacheHit: false,
        durationMs: 0,
      },
    };
    expect(() =>
      validateMemorySourceLocalEvidenceResultV1({
        locator,
        request: {
          requirement,
          assistantOriginPolicy:
            "allow_session_opening_reported_assertion" as const,
          lockedSourceIds: ["session"],
          budget: DEFAULT_MEMORY_SOURCE_LOCAL_EVIDENCE_BUDGET_V1,
        },
        result: emptyResult,
      }),
    ).toThrow("MemorySourceLocalEvidencePolicyInvalid");
    expect(
      validateMemorySourceLocalEvidenceResultV1({
        locator,
        request: {
          requirement: {
            ...requirement,
            roleConstraint: "user" as const,
            evidenceUse: "reported_assistant_assertion" as const,
          },
          assistantOriginPolicy:
            "allow_session_opening_reported_assertion" as const,
          lockedSourceIds: ["session"],
          budget: DEFAULT_MEMORY_SOURCE_LOCAL_EVIDENCE_BUDGET_V1,
        },
        result: emptyResult,
      }),
    ).toHaveLength(0);
  });

  test("opens only bounded assistant direct-lookup requirements", () => {
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
        answerShape: "lookup",
        temporalMode: "history",
        roleConstraint: "assistant",
        requirements: [{ ...requirement, temporalMode: "history" }],
        supportSelectorConfigured: true,
      }),
    ).toBe(false);
    expect(
      isMemorySourceLocalEvidenceEligibleV1({
        answerShape: "compare",
        temporalMode: "any",
        roleConstraint: "assistant",
        requirements: [requirement],
        supportSelectorConfigured: true,
      }),
    ).toBe(false);
  });

  test("ranks exact evidence confidence before coarse source order", () => {
    const ranked = rankMemorySourceLocalAnchorCandidatesV1({
      candidates: [
        { evidenceRef: "s1#turn-1", sourceId: "s1", score: 9 },
        { evidenceRef: "s1#turn-2", sourceId: "s1", score: 8 },
        { evidenceRef: "s1#turn-3", sourceId: "s1", score: 7 },
        { evidenceRef: "s1#turn-4", sourceId: "s1", score: 6 },
        { evidenceRef: "s2#turn-1", sourceId: "s2", score: 10 },
        { evidenceRef: "s3#turn-1", sourceId: "s3", score: 8 },
      ],
      lockedSourceIds: ["s1", "s2", "s3"],
      maxCandidates: 4,
      maxCandidatesPerSource: 2,
    });
    expect(ranked.map((candidate) => candidate.evidenceRef)).toEqual([
      "s2#turn-1",
      "s1#turn-1",
      "s1#turn-2",
      "s3#turn-1",
    ]);
  });

  test("uses coarse source order only to break equal-confidence ties", () => {
    const ranked = rankMemorySourceLocalAnchorCandidatesV1({
      candidates: [
        { evidenceRef: "s2#turn-1", sourceId: "s2", score: 1 },
        { evidenceRef: "s1#turn-1", sourceId: "s1", score: 1 },
      ],
      lockedSourceIds: ["s1", "s2"],
      maxCandidates: 2,
      maxCandidatesPerSource: 1,
    });
    expect(ranked.map((candidate) => candidate.evidenceRef)).toEqual([
      "s1#turn-1",
      "s2#turn-1",
    ]);
  });

  test("backfills sources hidden by a head source monopolizing global top-k", () => {
    const global = Array.from({ length: 32 }, (_, index) => ({
      evidenceRef: `s1#turn-${index + 1}`,
      sourceId: "s1",
      score: 32 - index,
    }));
    expect(
      memorySourceLocalBackfillSourceIdsV1({
        candidates: global,
        lockedSourceIds: ["s1", "s2", "s3"],
        minimumCandidatesPerSource: 2,
      }),
    ).toEqual(["s2", "s3"]);
    const ranked = rankMemorySourceLocalAnchorCandidatesV1({
      candidates: [
        ...global,
        { evidenceRef: "s2#turn-1", sourceId: "s2", score: -2.01 },
        { evidenceRef: "s3#turn-1", sourceId: "s3", score: -3.01 },
      ],
      lockedSourceIds: ["s1", "s2", "s3"],
      maxCandidates: 4,
      maxCandidatesPerSource: memorySourceLocalDiverseCandidateCapV1({
        lockedSourceCount: 3,
        maxAnchors: 4,
        maxAnchorsPerSource: 4,
      }),
    });
    expect(ranked.map((candidate) => candidate.sourceId)).toEqual([
      "s1",
      "s1",
      "s1",
      "s2",
    ]);
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
      assistantOriginPolicy: "addressed_reply_only" as const,
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
      assistantOriginPolicy: "addressed_reply_only" as const,
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

  test("partitions result caches by source set, role, cutoff and index revision", () => {
    const base = {
      locatorVersion: "test-locator.v1",
      scopeFingerprint: "scope",
      turnIndexRevision: "r1",
      request: {
        requirement,
        assistantOriginPolicy: "addressed_reply_only" as const,
        lockedSourceIds: ["session-1"],
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
          assistantOriginPolicy: "allow_session_opening_artifact",
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
  });
});
