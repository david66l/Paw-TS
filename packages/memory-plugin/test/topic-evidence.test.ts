import { describe, expect, test } from "bun:test";

import type { SessionInputSnapshot } from "@paw/agent-loop";
import type { MemoryEntry } from "@paw/memory/longterm";
import type { InputFactV1 } from "@paw/protocol";

import {
  type MemoryTopicEvidenceCatalogItemV1,
  type PawNextMemoryPluginProfileV1,
  createMemoryTemporalRelationV1,
  createMemoryTopicEvidenceInputPortV1,
  createMemoryTopicEvidenceSectionsV1,
  createMemoryTopicProposalV1,
  materializeMemoryTopicProjectionV1,
  memoryScopeFingerprintV1,
  planMemoryTopicEvidenceV1,
  projectCurrentMemoryQueryV1,
  projectMemoryTopicToolStatesV1,
} from "../src/index.js";

const scope = Object.freeze({
  tenantId: "tenant-1",
  userId: "user-1",
  workspaceId: "workspace-1",
  repositoryId: "repo-1",
});

describe("memory topic evidence planner", () => {
  test("keeps the complete topic index stable while selecting bounded query evidence", () => {
    const catalog = catalogFixture();
    const responsePlan = planMemoryTopicEvidenceV1({
      query: "What is the preferred response style?",
      scopeFingerprint: memoryScopeFingerprintV1(scope),
      catalog,
      maxIndexTopics: 8,
      maxSelectedTopics: 1,
      maxStates: 4,
    });
    const deploymentPlan = planMemoryTopicEvidenceV1({
      query: "Which deployment policy should be used?",
      scopeFingerprint: memoryScopeFingerprintV1(scope),
      catalog,
      maxIndexTopics: 8,
      maxSelectedTopics: 1,
      maxStates: 4,
    });

    expect(responsePlan.indexEntries).toHaveLength(2);
    expect(responsePlan.indexRevision).toBe(deploymentPlan.indexRevision);
    expect(responsePlan.evidenceStates.map((state) => state.memoryId)).toEqual([
      "response-new",
      "response-old",
    ]);
    expect(
      deploymentPlan.evidenceStates.map((state) => state.memoryId),
    ).toEqual(["deploy-current"]);
    expect(responsePlan.evidenceStates.map((state) => state.state)).toEqual([
      "current",
      "historical",
    ]);
  });

  test("renders a content-addressed index before query-specific trajectory evidence", () => {
    const plan = planMemoryTopicEvidenceV1({
      query: "preferred response style",
      scopeFingerprint: memoryScopeFingerprintV1(scope),
      catalog: catalogFixture(),
    });
    const fact = {
      type: "memory.topic_evidence_settled" as const,
      queryId: "query-1",
      plannerVersion: "paw.memory-topic-evidence-planner.v1" as const,
      scopeFingerprint: plan.scopeFingerprint,
      status: "completed" as const,
      indexRevision: plan.indexRevision,
      indexEntries: plan.indexEntries,
      evidenceStates: plan.evidenceStates,
      settledAt: 1_750_000_000_000,
    };
    const first = createMemoryTopicEvidenceSectionsV1(fact, 10);
    const second = createMemoryTopicEvidenceSectionsV1(
      { ...fact, queryId: "query-2" },
      99,
    );
    expect(first).toHaveLength(2);
    expect(first[0]?.id).toBe(second[0]?.id);
    expect(first[0]?.contentHash).toBe(second[0]?.contentHash);
    expect(first[0]?.content).toBe(second[0]?.content);
    expect(first[1]?.id).not.toBe(second[1]?.id);
  });

  test("projects compact model-facing topic states without storage relation ids", () => {
    const item = catalogFixture()[0];
    if (!item) throw new Error("expected topic fixture");
    const states = projectMemoryTopicToolStatesV1(item, 2);

    expect(states).toHaveLength(2);
    expect(states[0]).toMatchObject({
      trajectory: 1,
      position: 1,
      stateCount: 2,
      memoryId: "response-old",
      status: "historical",
    });
    expect(states[1]).toMatchObject({
      trajectory: 1,
      position: 2,
      stateCount: 2,
      memoryId: "response-new",
      status: "current",
    });
    expect(JSON.stringify(states)).not.toContain("trajectoryId");
    expect(JSON.stringify(states)).not.toContain("supersedesMemoryIds");
  });

  test("settles one plan at a safe boundary and does not reload it", async () => {
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
    const input = createMemoryTopicEvidenceInputPortV1({
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
          return catalogFixture();
        },
      },
      signal: new AbortController().signal,
      maxIndexTopics: 96,
      maxSelectedTopics: 3,
      maxStates: 16,
      maxEvidenceChars: 8_000,
      now: () => 1_750_000_000_000,
    });

    await input.reportSafeBoundary("before_first_model_request");
    await input.reportSafeBoundary("before_first_model_request");
    expect(loads).toBe(1);
    expect(baseReports).toBe(2);
    const facts = session.snapshot.entries
      .map((entry) => entry.fact)
      .filter((fact) => fact.type === "memory.topic_evidence_settled");
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      queryId: query.queryId,
      status: "completed",
    });
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

function catalogFixture(): readonly MemoryTopicEvidenceCatalogItemV1[] {
  const oldResponse = semanticEntry(
    "response-old",
    "The user previously preferred detailed answers.",
    "2026-01-01T00:00:00.000Z",
    "2026-06-01T00:00:00.000Z",
  );
  const newResponse = semanticEntry(
    "response-new",
    "The user now prefers concise response style.",
    "2026-06-01T00:00:00.000Z",
  );
  const relation = createMemoryTemporalRelationV1({
    scope,
    fromMemoryId: newResponse.id,
    toMemoryId: oldResponse.id,
    relationType: "supersedes",
    createdAt: "2026-06-01T00:00:00.000Z",
  });
  const responseProposal = createMemoryTopicProposalV1({
    scope,
    family: "profile",
    canonicalName: "Response style",
    confidence: 0.96,
    members: [oldResponse, newResponse].map((entry) => ({
      memoryId: entry.id,
      role: "primary" as const,
      confidence: 0.95,
      basis: "model_proposed" as const,
    })),
  });
  const responseProjection = materializeMemoryTopicProjectionV1({
    scope,
    proposal: responseProposal,
    entries: [oldResponse, newResponse],
    relations: [relation],
    graphRevision: "graph-revision-1",
    createdAt: "2026-06-01T00:00:00.000Z",
  });
  const deploy = semanticEntry(
    "deploy-current",
    "Use canary deployment policy for production releases.",
    "2026-05-01T00:00:00.000Z",
  );
  const deployProjection = materializeMemoryTopicProjectionV1({
    scope,
    proposal: createMemoryTopicProposalV1({
      scope,
      family: "instruction",
      canonicalName: "Deployment policy",
      confidence: 0.94,
      members: [
        {
          memoryId: deploy.id,
          role: "primary",
          confidence: 0.95,
          basis: "user_asserted",
        },
      ],
    }),
    entries: [deploy],
    relations: [],
    graphRevision: "graph-revision-1",
    createdAt: "2026-05-01T00:00:00.000Z",
  });
  return Object.freeze([
    Object.freeze({
      projection: responseProjection,
      entries: Object.freeze([oldResponse, newResponse]),
    }),
    Object.freeze({
      projection: deployProjection,
      entries: Object.freeze([deploy]),
    }),
  ]);
}

function semanticEntry(
  id: string,
  fact: string,
  tValid: string,
  tInvalid: string | null = null,
): MemoryEntry {
  return Object.freeze({
    id,
    kind: "semantic" as const,
    repo: scope.repositoryId,
    created: tValid,
    tValid,
    tInvalid,
    source: "user_statement" as const,
    confidence: 0.95,
    evidence: [`memory:${id}`],
    freq: 0,
    utility: 0,
    fact,
    keywords: fact.toLocaleLowerCase().split(/\s+/),
    embeddingKey: fact,
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
          content: "What is the preferred response style?",
          contentHash: "input-hash",
        },
      },
    ]),
    tailSeq: 2,
    latestInputSeq: 2,
  });
}
