import { describe, expect, test } from "bun:test";

import type { MemoryEntry } from "@paw/memory/longterm";

import {
  type MemoryTopicProjectionV1,
  type PawNextMemoryScopeV1,
  assertMemoryTopicProjectionIntegrityV1,
  buildMemoryTopicExtractionRequestV1,
  createMemoryTemporalRelationV1,
  createMemoryTopicProposalV1,
  createPostgresMemoryTopicProjectionStoreV1,
  deriveMemoryTopicIdV1,
  materializeMemoryTopicProjectionV1,
  normalizeMemoryTopicNameV1,
  parseMemoryTopicExtractionV1,
} from "../src/index.js";

const scope: PawNextMemoryScopeV1 = Object.freeze({
  tenantId: "tenant-1",
  userId: "user-1",
  workspaceId: "workspace-1",
  repositoryId: "repo-1",
});

describe("dynamic memory topic trajectories", () => {
  test("keeps the model prompt prefix stable and reuses only known topic identity", () => {
    const extractionInput = {
      scope,
      sourceRevision: "source-revision-1",
      maxTopics: 4,
      entries: [
        {
          id: "memory-1",
          kind: "profile" as const,
          statement: "Prefers concise answers",
          keywords: ["concise", "answers"],
          confidence: 0.95,
        },
      ],
      existingTopics: [
        {
          id: deriveMemoryTopicIdV1({
            scope,
            family: "profile",
            normalizedName: "response style",
          }),
          family: "profile" as const,
          canonicalName: "Response style",
          normalizedName: "response style",
        },
      ],
    };
    const firstPrompt = buildMemoryTopicExtractionRequestV1(extractionInput);
    const secondPrompt = buildMemoryTopicExtractionRequestV1({
      ...extractionInput,
      sourceRevision: "source-revision-2",
      entries: [
        {
          id: "memory-1",
          kind: "profile" as const,
          statement: "Prefers detailed technical answers",
          keywords: ["detailed", "technical"],
          confidence: 0.95,
        },
      ],
    });
    expect(firstPrompt.system).toBe(secondPrompt.system);

    const proposals = parseMemoryTopicExtractionV1(
      JSON.stringify({
        topics: [
          {
            topicId: extractionInput.existingTopics[0]?.id,
            family: "semantic",
            canonicalName: "Model attempted rename",
            confidence: 0.9,
            members: [
              {
                memoryId: "memory-1",
                role: "primary",
                confidence: 0.92,
              },
            ],
          },
        ],
      }),
      extractionInput,
    );
    expect(proposals[0]).toMatchObject({
      targetTopicId: extractionInput.existingTopics[0]?.id,
      family: "profile",
      canonicalName: "Response style",
    });
    const unknownTarget = parseMemoryTopicExtractionV1(
      JSON.stringify({
        topics: [
          {
            topicId: "model-invented-topic-id",
            family: "profile",
            canonicalName: "New response constraint",
            confidence: 0.9,
            members: [
              {
                memoryId: "memory-1",
                role: "primary",
                confidence: 0.92,
              },
            ],
          },
        ],
      }),
      extractionInput,
    );
    expect(unknownTarget[0]).toMatchObject({
      family: "profile",
      canonicalName: "New response constraint",
    });
    expect(unknownTarget[0]?.targetTopicId).toBeUndefined();
  });

  test("keeps coarse families fixed while deriving concrete topic identity dynamically", () => {
    expect(normalizeMemoryTopicNameV1("  后端　技术栈偏好  ")).toBe(
      "后端 技术栈偏好",
    );
    const proposal = createMemoryTopicProposalV1({
      scope,
      family: "profile",
      canonicalName: "后端技术栈偏好",
      confidence: 0.91,
      members: [
        {
          memoryId: "memory-1",
          role: "primary",
          confidence: 0.95,
          basis: "model_proposed",
        },
      ],
    });
    expect(proposal.canonicalName).toBe("后端技术栈偏好");
    expect(proposal.normalizedName).toBe("后端技术栈偏好");
    expect(proposal.proposalId).toHaveLength(64);

    const otherScopeId = deriveMemoryTopicIdV1({
      scope: { ...scope, userId: "user-2" },
      family: proposal.family,
      normalizedName: proposal.normalizedName,
    });
    const currentScopeId = deriveMemoryTopicIdV1({
      scope,
      family: proposal.family,
      normalizedName: proposal.normalizedName,
    });
    expect(otherScopeId).not.toBe(currentScopeId);
  });

  test("deterministically promotes one selected member when the model omits a primary", () => {
    const input = {
      scope,
      sourceRevision: "source-revision-normalize",
      maxTopics: 2,
      entries: [
        {
          id: "memory-low",
          kind: "profile" as const,
          statement: "Prefers short summaries",
          keywords: ["summaries"],
          confidence: 0.8,
        },
        {
          id: "memory-high",
          kind: "profile" as const,
          statement: "Prefers Chinese summaries",
          keywords: ["Chinese", "summaries"],
          confidence: 0.95,
        },
      ],
      existingTopics: [],
    };
    const proposals = parseMemoryTopicExtractionV1(
      JSON.stringify({
        topics: [
          {
            topicId: null,
            family: "profile",
            canonicalName: "Summary preferences",
            confidence: 0.9,
            members: [
              {
                memoryId: "memory-low",
                role: "supporting",
                confidence: 0.75,
              },
              {
                memoryId: "memory-high",
                role: "supporting",
                confidence: 0.96,
              },
            ],
          },
        ],
      }),
      input,
    );
    expect(proposals[0]?.members).toContainEqual(
      expect.objectContaining({
        memoryId: "memory-low",
        role: "supporting",
      }),
    );
    expect(proposals[0]?.members).toContainEqual(
      expect.objectContaining({ memoryId: "memory-high", role: "primary" }),
    );
  });

  test("materializes the same immutable snapshot across deterministic rebuilds", () => {
    const old = semantic({
      id: "old",
      fact: "Prefers Python",
      source: "user_statement",
      tValid: "2025-01-01T00:00:00.000Z",
      tInvalid: "2025-02-01T00:00:00.000Z",
    });
    const current = semantic({
      id: "current",
      fact: "Uses Go for the new backend",
      source: "agent_verified",
      tValid: "2025-02-01T00:00:00.000Z",
      tInvalid: null,
    });
    const relation = createMemoryTemporalRelationV1({
      scope,
      fromMemoryId: current.id,
      toMemoryId: old.id,
      relationType: "supersedes",
      evidenceRefs: ["journal:run-2#verification"],
      createdAt: current.tValid,
    });
    const proposal = createMemoryTopicProposalV1({
      scope,
      family: "profile",
      canonicalName: "Backend technology preference",
      confidence: 0.9,
      members: [
        {
          memoryId: old.id,
          role: "supporting",
          confidence: 0.9,
          basis: "explicit_relation",
        },
        {
          memoryId: current.id,
          role: "primary",
          confidence: 0.96,
          basis: "user_asserted",
        },
      ],
    });
    const first = materializeMemoryTopicProjectionV1({
      scope,
      proposal,
      entries: [old, current],
      relations: [relation],
      graphRevision: "graph-revision-2",
      createdAt: "2025-02-02T00:00:00.000Z",
    });
    const rebuilt = materializeMemoryTopicProjectionV1({
      scope,
      proposal,
      entries: [current, old],
      relations: [relation],
      graphRevision: "graph-revision-2",
      createdAt: "2025-03-01T00:00:00.000Z",
    });

    expect(rebuilt.topic.id).toBe(first.topic.id);
    expect(rebuilt.snapshot.id).toBe(first.snapshot.id);
    expect(rebuilt.snapshot.projectionHash).toBe(first.snapshot.projectionHash);
    expect(first.snapshot.trajectories).toHaveLength(1);
    expect(
      first.snapshot.trajectories[0]?.states.map((state) => state.memoryId),
    ).toEqual(["old", "current"]);
    expect(() => assertMemoryTopicProjectionIntegrityV1(first)).not.toThrow();
  });

  test("rejects snapshot tampering and a store bound to another scope before SQL", async () => {
    const entry = semantic({
      id: "memory-1",
      fact: "Prefers compact answers",
      source: "user_statement",
      tValid: "2025-01-01T00:00:00.000Z",
      tInvalid: null,
    });
    const proposal = createMemoryTopicProposalV1({
      scope,
      family: "profile",
      canonicalName: "Response style",
      confidence: 0.93,
      members: [
        {
          memoryId: entry.id,
          role: "primary",
          confidence: 0.93,
          basis: "user_asserted",
        },
      ],
    });
    const projection = materializeMemoryTopicProjectionV1({
      scope,
      proposal,
      entries: [entry],
      relations: [],
      graphRevision: "graph-revision-1",
      createdAt: "2025-01-02T00:00:00.000Z",
    });
    const tampered = {
      ...projection,
      snapshot: {
        ...projection.snapshot,
        memberMemoryIds: ["foreign-memory"],
      },
    } as MemoryTopicProjectionV1;
    expect(() => assertMemoryTopicProjectionIntegrityV1(tampered)).toThrow(
      "MemoryTopicProjectionMembersMismatch",
    );

    const foreignStore = createPostgresMemoryTopicProjectionStoreV1({
      scope: { ...scope, userId: "user-2" },
    });
    await expect(
      foreignStore.replaceProjection(projection, new AbortController().signal),
    ).rejects.toThrow("MemoryTopicStoreScopeMismatch");
  });
});

function semantic(
  input: Readonly<{
    id: string;
    fact: string;
    source: MemoryEntry["source"];
    tValid: string;
    tInvalid: string | null;
  }>,
): MemoryEntry {
  return {
    id: input.id,
    kind: "semantic",
    repo: scope.repositoryId,
    created: input.tValid,
    tValid: input.tValid,
    tInvalid: input.tInvalid,
    source: input.source,
    confidence: 0.9,
    evidence: [`journal:${input.id}`],
    freq: 0,
    utility: 0,
    fact: input.fact,
    keywords: [input.id],
    embeddingKey: `${input.fact} ${input.id}`,
  };
}
