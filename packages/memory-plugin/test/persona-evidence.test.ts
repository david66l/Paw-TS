import { describe, expect, test } from "bun:test";

import type { SessionInputSnapshot } from "@paw/agent-loop";
import type { MemoryEntry } from "@paw/memory/longterm";
import type { InputFactV1 } from "@paw/protocol";

import {
  type PawNextMemoryPluginProfileV1,
  createMemoryPersonaEvidenceSectionV1,
  createMemoryPersonaInputPortV1,
  projectCurrentMemoryQueryV1,
  projectMemoryPersonaEvidenceV1,
} from "../src/index.js";

const scope = Object.freeze({
  tenantId: "tenant-1",
  userId: "user-1",
  workspaceId: "workspace-1",
  repositoryId: "repo-1",
});

describe("memory persona evidence projection", () => {
  test("is query-independent, deterministic, and preserves source diversity", () => {
    const entries = [
      profileEntry("profile-a", "Prefers concise answers.", 0.98, "doc-a#1"),
      profileEntry("profile-b", "Prefers bullet lists.", 0.97, "doc-a#2"),
      profileEntry(
        "profile-c",
        "Primarily works in TypeScript.",
        0.9,
        "doc-b#1",
      ),
    ];
    const first = projectMemoryPersonaEvidenceV1({
      entries,
      minimumConfidence: 0.7,
      maxClaims: 2,
      maxChars: 1_000,
    });
    const second = projectMemoryPersonaEvidenceV1({
      entries: [...entries].reverse(),
      minimumConfidence: 0.7,
      maxClaims: 2,
      maxChars: 1_000,
    });

    expect(first).toEqual(second);
    expect(first.claims.map((claim) => claim.memoryId)).toEqual([
      "profile-a",
      "profile-c",
    ]);
    expect(first.sourceCount).toBe(2);
  });

  test("excludes inactive, episodic, and low-confidence atoms", () => {
    const inactive = {
      ...profileEntry("inactive", "Old preference.", 0.99, "doc-a#1"),
      tInvalid: "2026-08-25T00:00:00.000Z",
    } as MemoryEntry;
    const low = profileEntry("low", "Weak inference.", 0.4, "doc-b#1");
    const semantic = semanticEntry(
      "semantic",
      "A normal fact must remain outside L3.",
      0.99,
      "doc-c#1",
    );
    const episodic = episodicEntry("episode");
    const projection = projectMemoryPersonaEvidenceV1({
      entries: [inactive, low, semantic, episodic],
      minimumConfidence: 0.7,
      maxClaims: 8,
      maxChars: 1_000,
    });

    expect(projection.claims).toEqual([]);
    expect(projection.sourceCount).toBe(0);
  });

  test("renders a stable prefix that excludes query identity", () => {
    const projection = projectMemoryPersonaEvidenceV1({
      entries: [
        profileEntry("profile-a", "Prefers concise answers.", 0.98, "doc-a#1"),
      ],
      minimumConfidence: 0.7,
      maxClaims: 8,
      maxChars: 1_000,
    });
    const fact = {
      type: "memory.persona_projection_settled" as const,
      queryId: "query-1",
      projectorVersion: "paw.memory-persona-evidence-projector.v1" as const,
      scopeFingerprint: "scope-fingerprint",
      status: "completed" as const,
      ...projection,
      settledAt: 1_750_000_000_000,
    };
    const first = createMemoryPersonaEvidenceSectionV1(fact, 10);
    const second = createMemoryPersonaEvidenceSectionV1(
      { ...fact, queryId: "query-2" },
      99,
    );

    expect(first?.id).toBe(second?.id);
    expect(first?.contentHash).toBe(second?.contentHash);
    expect(first?.content).toBe(second?.content);
    expect(first?.content).not.toContain("query-1");
  });

  test("settles once at a safe boundary and never reloads the same query", async () => {
    const session = new FakeSession(initialSnapshot());
    const query = projectCurrentMemoryQueryV1(session.snapshot, profile);
    if (!query) throw new Error("expected memory query");
    await session.append([
      {
        type: "memory.retrieval_settled",
        queryId: query.queryId,
        trigger: query.trigger,
        providerVersion: profile.providerVersion,
        policyVersion: "paw.memory-retrieval.v1",
        status: "completed",
        cards: [],
      },
    ]);
    let loads = 0;
    let baseReports = 0;
    const input = createMemoryPersonaInputPortV1({
      baseInput: {
        async reportSafeBoundary() {
          baseReports += 1;
        },
        async consumePromotedInputIds() {
          return [];
        },
      },
      session,
      profile,
      store: {
        scope,
        async load() {
          loads += 1;
          return [
            profileEntry(
              "profile-a",
              "Prefers concise answers.",
              0.98,
              "doc-a#1",
            ),
          ];
        },
      },
      signal: new AbortController().signal,
      maxClaims: 8,
      maxChars: 1_000,
      minimumConfidence: 0.7,
      now: () => 1_750_000_000_000,
    });

    await input.reportSafeBoundary("before_first_model_request");
    await input.reportSafeBoundary("before_first_model_request");
    expect(loads).toBe(1);
    expect(baseReports).toBe(2);
    expect(
      session.snapshot.entries.filter(
        (entry) => entry.fact.type === "memory.persona_projection_settled",
      ),
    ).toHaveLength(1);
  });
});

const profile: PawNextMemoryPluginProfileV1 = {
  policyVersion: "paw.next-memory-plugin.v1",
  mode: "read_write",
  providerVersion: "paw.memory-v2-readonly-provider.v1",
  scope,
  maxCards: 3,
  maxInjectedTokens: 512,
  writer: {
    policyVersion: "paw.memory-writer.v1",
    extractorVersion: "paw.memory-atom-extractor.json.v1",
    maxAtoms: 8,
    maxSourceChars: 24_000,
    topicOrganizer: {
      policyVersion: "paw.memory-topic-organization.v1",
      extractorVersion: "paw.memory-topic-extractor.json.v1",
      maxTopics: 8,
    },
    personaProjector: {
      policyVersion: "paw.memory-persona-evidence-projector.v1",
      maxClaims: 8,
      maxChars: 2_048,
      minimumConfidence: 0.7,
    },
    rawEvidenceResolver: {
      policyVersion: "paw.memory-raw-evidence-resolver.v1",
      maxSpans: 6,
      maxChars: 6_000,
    },
    coveragePlanner: {
      policyVersion: "paw.memory-evidence-coverage-planner.v1",
      extractorVersion: "paw.memory-evidence-requirement-planner.json.v1",
      maxRequirements: 4,
      maxExpansionTopics: 3,
      maxSupplementalStates: 8,
      maxSupplementalChars: 4_096,
    },
    evidencePlanner: {
      policyVersion: "paw.memory-topic-evidence-planner.v1",
      maxIndexTopics: 96,
      maxSelectedTopics: 3,
      maxStates: 16,
      maxEvidenceChars: 8_000,
    },
  },
};

function baseEntry(id: string, confidence: number, evidence: string) {
  return {
    id,
    repo: scope.repositoryId,
    created: "2026-08-25T00:00:00.000Z",
    tValid: "2026-08-25T00:00:00.000Z",
    tInvalid: null,
    source: "user_statement" as const,
    confidence,
    evidence: [evidence],
    freq: 0,
    utility: 0,
  };
}

function profileEntry(
  id: string,
  insight: string,
  confidence: number,
  evidence: string,
): MemoryEntry {
  return Object.freeze({
    ...baseEntry(id, confidence, evidence),
    kind: "profile" as const,
    insight,
    supportCount: 3,
  });
}

function semanticEntry(
  id: string,
  fact: string,
  confidence: number,
  evidence: string,
): MemoryEntry {
  return Object.freeze({
    ...baseEntry(id, confidence, evidence),
    kind: "semantic" as const,
    fact,
    keywords: fact.toLocaleLowerCase().split(/\s+/),
    embeddingKey: fact,
  });
}

function episodicEntry(id: string): MemoryEntry {
  return Object.freeze({
    ...baseEntry(id, 0.99, "doc-c#1"),
    kind: "episodic" as const,
    whenToUse: "When a prior task recurs.",
    perspective: "Use the prior sequence.",
    modification: [],
    issueType: "test",
    taskId: "task-1",
  });
}

class FakeSession {
  snapshot: SessionInputSnapshot<InputFactV1>;

  constructor(snapshot: SessionInputSnapshot<InputFactV1>) {
    this.snapshot = snapshot;
  }

  async readInputSnapshot() {
    return this.snapshot;
  }

  async commitInputFacts(
    expectedTailSeq: number,
    facts: readonly InputFactV1[],
  ): Promise<"committed" | "conflict"> {
    if (expectedTailSeq !== this.snapshot.tailSeq) return "conflict";
    await this.append(facts);
    return "committed";
  }

  async append(facts: readonly InputFactV1[]) {
    const entries = [...this.snapshot.entries];
    let seq = this.snapshot.tailSeq;
    for (const fact of facts) entries.push({ seq: ++seq, fact });
    this.snapshot = Object.freeze({
      entries: Object.freeze(entries),
      tailSeq: seq,
      latestInputSeq: seq,
    });
  }
}

function initialSnapshot(): SessionInputSnapshot<InputFactV1> {
  return Object.freeze({
    entries: Object.freeze([
      {
        seq: 1,
        fact: {
          type: "attempt.started" as const,
          goalHash: "goal-hash",
          configHash: "config-hash",
        },
      },
      {
        seq: 2,
        fact: {
          type: "input.promoted" as const,
          inputId: "input-1",
          delivery: "initial" as const,
          content: "How should the answer be written?",
          contentHash: "input-hash",
        },
      },
    ]),
    tailSeq: 2,
    latestInputSeq: 2,
  });
}
