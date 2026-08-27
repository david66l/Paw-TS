import { describe, expect, test } from "bun:test";

import type { SessionInputSnapshot } from "@paw/agent-loop";
import type { MemoryEntry } from "@paw/memory/longterm";
import type { InputFactV1 } from "@paw/protocol";

import { hashTextV1 } from "../src/canonical.js";
import {
  type MemoryEvidenceCoveragePlannerV1,
  type MemoryTopicEvidenceCatalogItemV1,
  type PawNextMemoryPluginProfileV1,
  createJsonMemoryEvidenceCoveragePlannerV1,
  createMemoryEvidenceCoverageInputPortV1,
  createMemoryEvidenceCoverageSectionV1,
  createMemoryTopicProposalV1,
  materializeMemoryTopicProjectionV1,
  memoryScopeFingerprintV1,
  parseMemoryEvidenceCoverageProposalV1,
  planMemoryEvidenceCoverageV1,
  projectCurrentMemoryQueryV1,
} from "../src/index.js";

const scope = Object.freeze({
  tenantId: "tenant-1",
  userId: "user-1",
  workspaceId: "workspace-1",
  repositoryId: "repo-1",
});

describe("memory evidence coverage planner", () => {
  test("repairs one invalid model proposal without accepting unknown ids", async () => {
    let calls = 0;
    const planner = createJsonMemoryEvidenceCoveragePlannerV1({
      model: {
        async complete() {
          calls += 1;
          return {
            status: "completed" as const,
            text:
              calls === 1
                ? JSON.stringify({ requirements: [{ invented: true }] })
                : JSON.stringify({
                    requirements: [
                      {
                        description: "Deployment choice",
                        priority: "required",
                        minimumEvidence: 1,
                        coveredMemoryIds: ["memory-1"],
                        expandTopicIds: [],
                      },
                    ],
                  }),
          };
        },
      },
    });
    const proposal = await planner.plan(
      {
        query: "Why Compose?",
        evidence: [
          { memoryId: "memory-1", layer: "L1", statement: "Because cost" },
        ],
        topics: [],
        maxRequirements: 4,
        maxExpansionTopics: 3,
      },
      new AbortController().signal,
    );
    expect(calls).toBe(2);
    expect(proposal[0]?.coveredMemoryIds).toEqual(["memory-1"]);
  });

  test("short-circuits without a model call when no memory or topic exists", async () => {
    let calls = 0;
    const snapshot: SessionInputSnapshot<InputFactV1> = Object.freeze({
      entries: Object.freeze([
        { seq: 1, fact: { ...retrievalFact("query-empty"), cards: [] } },
        { seq: 2, fact: topicFact("query-empty") },
      ]),
      tailSeq: 2,
      latestInputSeq: 2,
    });
    const plan = await planMemoryEvidenceCoverageV1({
      queryId: "query-empty",
      query: "A request with no available long-term memory",
      scopeFingerprint: memoryScopeFingerprintV1(scope),
      snapshot,
      catalog: [],
      archive: {
        scope,
        async put() {},
        async resolve() {
          throw new Error("archive must not be called");
        },
      },
      planner: {
        plannerVersion: "planner-test-v1",
        async plan() {
          calls += 1;
          return [];
        },
      },
      maxRequirements: 4,
      maxExpansionTopics: 3,
      maxSupplementalStates: 8,
      maxSupplementalChars: 4_096,
      maxRawSpans: 6,
      maxRawChars: 6_000,
      signal: new AbortController().signal,
    });
    expect(calls).toBe(0);
    expect(plan.requirements).toEqual([]);
  });

  test("accepts only known evidence and topic ids from model proposals", () => {
    const input = {
      query: "Recommend dinner",
      evidence: [
        {
          memoryId: "preference-1",
          layer: "L1" as const,
          statement: "The user likes quiet restaurants.",
        },
      ],
      topics: [
        { topicId: "topic-diet", family: "profile", name: "Diet" },
        { topicId: "topic-budget", family: "profile", name: "Budget" },
        { topicId: "topic-location", family: "profile", name: "Location" },
        { topicId: "topic-time", family: "episodic", name: "Time" },
      ],
      maxRequirements: 4,
      maxExpansionTopics: 3,
    };
    expect(
      parseMemoryEvidenceCoverageProposalV1(
        JSON.stringify({
          requirements: [
            {
              description: "The user's restaurant preference",
              priority: "required",
              minimumEvidence: 1,
              coveredMemoryIds: ["preference-1"],
              expandTopicIds: [],
            },
          ],
        }),
        input,
      ),
    ).toHaveLength(1);
    const bounded = parseMemoryEvidenceCoverageProposalV1(
      JSON.stringify({
        requirements: [
          {
            description: "Diet and budget constraints",
            priority: "required",
            minimumEvidence: 2,
            coveredMemoryIds: [],
            expandTopicIds: ["topic-diet", "topic-budget"],
          },
          {
            description: "Location and time constraints",
            priority: "supporting",
            minimumEvidence: 2,
            coveredMemoryIds: [],
            expandTopicIds: ["topic-location", "topic-time"],
          },
        ],
      }),
      input,
    );
    expect(bounded.flatMap((item) => item.expandTopicIds)).toEqual([
      "topic-diet",
      "topic-budget",
      "topic-location",
    ]);
    expect(() =>
      parseMemoryEvidenceCoverageProposalV1(
        JSON.stringify({
          requirements: [
            {
              description: "Unknown evidence",
              priority: "required",
              minimumEvidence: 1,
              coveredMemoryIds: ["invented-memory"],
              expandTopicIds: [],
            },
          ],
        }),
        input,
      ),
    ).toThrow("MemoryEvidenceCoverageUnknownMemory");
  });

  test("fills a missing dynamic requirement through a bounded known topic", async () => {
    const catalog = dietCatalog();
    const topic = catalog[0];
    if (!topic) throw new Error("expected topic fixture");
    const snapshot = evidenceSnapshot(
      "query-1",
      topic.projection.topic.id,
      topic.projection.snapshot.id,
      topic.projection.topic.projectionHash,
    );
    const planner: MemoryEvidenceCoveragePlannerV1 = {
      plannerVersion: "planner-test-v1",
      async plan() {
        return [
          {
            description: "The user's restaurant atmosphere preference",
            priority: "required",
            minimumEvidence: 1,
            coveredMemoryIds: ["preference-1"],
            // The deterministic layer must ignore unnecessary expansion even
            // when the model proposes a known topic.
            expandTopicIds: [topic.projection.topic.id],
          },
          {
            description: "Dietary constraints that the meal must satisfy",
            priority: "required",
            minimumEvidence: 1,
            coveredMemoryIds: [],
            expandTopicIds: [topic.projection.topic.id],
          },
        ];
      },
    };
    const requested: string[] = [];
    const plan = await planMemoryEvidenceCoverageV1({
      queryId: "query-1",
      query: "Recommend a dinner restaurant for me",
      scopeFingerprint: memoryScopeFingerprintV1(scope),
      snapshot,
      catalog,
      archive: {
        scope,
        async put() {},
        async resolve(requests) {
          requested.push(...requests.map((request) => request.evidenceRef));
          return requests.map((request) => {
            const content = `original:${request.evidenceRef}`;
            return { ...request, content, contentHash: hashTextV1(content) };
          });
        },
      },
      planner,
      maxRequirements: 4,
      maxExpansionTopics: 3,
      maxSupplementalStates: 8,
      maxSupplementalChars: 4_096,
      maxRawSpans: 6,
      maxRawChars: 6_000,
      signal: new AbortController().signal,
    });

    expect(plan.requirements).toHaveLength(2);
    expect(plan.coverage.map((item) => item.status)).toEqual([
      "covered",
      "covered",
    ]);
    expect(plan.coverage.map((item) => item.topicIds)).toEqual([
      [],
      [topic.projection.topic.id],
    ]);
    expect(plan.supplementalStates.map((state) => state.memoryId)).toEqual([
      "diet-1",
    ]);
    expect(requested).toEqual([
      "journal:run-1#input-fact-2",
      "journal:run-2#input-fact-3",
    ]);
    expect(plan.spans).toHaveLength(2);
  });

  test("settles once and renders a replayable final coverage section", async () => {
    const session = new FakeSession(initialSnapshot());
    const query = projectCurrentMemoryQueryV1(session.snapshot, profile);
    if (!query) throw new Error("expected query");
    await session.append([
      retrievalFact(query.queryId),
      topicFact(query.queryId),
      rawFact(query.queryId),
    ]);
    let calls = 0;
    const input = createMemoryEvidenceCoverageInputPortV1({
      baseInput: {
        async reportSafeBoundary() {},
        async consumePromotedInputIds() {
          return [];
        },
      },
      session,
      profile,
      topicStore: {
        scope,
        async load() {
          return [];
        },
      },
      archive: {
        scope,
        async put() {},
        async resolve(requests) {
          return requests.map((request) => ({
            ...request,
            content: "The user likes quiet restaurants.",
            contentHash: hashTextV1("The user likes quiet restaurants."),
          }));
        },
      },
      planner: {
        plannerVersion: "planner-test-v1",
        async plan() {
          calls += 1;
          return [
            {
              description: "The user's restaurant atmosphere preference",
              priority: "required",
              minimumEvidence: 1,
              coveredMemoryIds: ["preference-1"],
              expandTopicIds: [],
            },
          ];
        },
      },
      signal: new AbortController().signal,
      maxRequirements: 4,
      maxExpansionTopics: 3,
      maxSupplementalStates: 8,
      maxSupplementalChars: 4_096,
      maxRawSpans: 6,
      maxRawChars: 6_000,
      now: () => 1_750_000_000_000,
    });

    await input.reportSafeBoundary("before_first_model_request");
    await input.reportSafeBoundary("before_first_model_request");
    expect(calls).toBe(1);
    const receipt = session.snapshot.entries.find(
      (entry) => entry.fact.type === "memory.evidence_coverage_settled",
    );
    if (receipt?.fact.type !== "memory.evidence_coverage_settled") {
      throw new Error("expected coverage receipt");
    }
    expect(receipt.fact.status).toBe("completed");
    const section = createMemoryEvidenceCoverageSectionV1(
      receipt.fact,
      receipt.seq,
    );
    expect(section?.content).toContain("paw.memory-evidence-coverage.v1");
    expect(section?.content).toContain("covered");
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
    evidencePlanner: {
      policyVersion: "paw.memory-topic-evidence-planner.v1",
      maxIndexTopics: 96,
      maxSelectedTopics: 3,
      maxStates: 16,
      maxEvidenceChars: 8_000,
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
  },
};

function dietCatalog(): readonly MemoryTopicEvidenceCatalogItemV1[] {
  const diet = semanticEntry(
    "diet-1",
    "The user avoids dairy products when choosing meals.",
    "journal:run-2#input-fact-3",
  );
  const projection = materializeMemoryTopicProjectionV1({
    scope,
    proposal: createMemoryTopicProposalV1({
      scope,
      family: "profile",
      canonicalName: "Dietary constraints",
      confidence: 0.95,
      members: [
        {
          memoryId: diet.id,
          role: "primary",
          confidence: 0.95,
          basis: "user_asserted",
        },
      ],
    }),
    entries: [diet],
    relations: [],
    graphRevision: "graph-1",
    createdAt: "2026-08-01T00:00:00.000Z",
  });
  return Object.freeze([
    Object.freeze({ projection, entries: Object.freeze([diet]) }),
  ]);
}

function semanticEntry(
  id: string,
  fact: string,
  evidenceRef: string,
): MemoryEntry {
  return Object.freeze({
    id,
    kind: "semantic" as const,
    repo: scope.repositoryId,
    created: "2026-08-01T00:00:00.000Z",
    tValid: "2026-08-01T00:00:00.000Z",
    tInvalid: null,
    source: "user_statement" as const,
    confidence: 0.95,
    evidence: [evidenceRef],
    freq: 0,
    utility: 0,
    fact,
    keywords: fact.toLocaleLowerCase().split(/\s+/),
    embeddingKey: fact,
  });
}

function evidenceSnapshot(
  queryId: string,
  topicId: string,
  snapshotId: string,
  projectionHash: string,
): SessionInputSnapshot<InputFactV1> {
  return Object.freeze({
    entries: Object.freeze([
      { seq: 1, fact: retrievalFact(queryId) },
      {
        seq: 2,
        fact: {
          ...topicFact(queryId),
          indexEntries: [
            {
              topicId,
              snapshotId,
              family: "profile" as const,
              canonicalName: "Dietary constraints",
              normalizedName: "dietary constraints",
              memberCount: 1,
              trajectoryCount: 1,
              projectionHash,
            },
          ],
        },
      },
      { seq: 3, fact: rawFact(queryId) },
    ]),
    tailSeq: 3,
    latestInputSeq: 3,
  });
}

function retrievalFact(queryId: string): InputFactV1 {
  return {
    type: "memory.retrieval_settled",
    queryId,
    trigger: "task_start",
    providerVersion: profile.providerVersion,
    policyVersion: "paw.memory-retrieval.v1",
    status: "completed",
    cards: [
      {
        id: "preference-1",
        revision: 1,
        kind: "profile",
        statement: "The user likes quiet restaurants.",
        applicability: "applicable",
        scope: { repositoryId: scope.repositoryId },
        sources: [
          {
            kind: "memory_store_evidence",
            ref: "journal:run-1#input-fact-2",
          },
        ],
        confidence: 0.95,
        contentHash: "preference-hash",
      },
    ],
  };
}

function topicFact(queryId: string): InputFactV1 {
  return {
    type: "memory.topic_evidence_settled",
    queryId,
    plannerVersion: "paw.memory-topic-evidence-planner.v1",
    scopeFingerprint: memoryScopeFingerprintV1(scope),
    status: "noop",
    indexRevision: "index-1",
    indexEntries: [],
    evidenceStates: [],
    reasonCode: "no-selected-topic",
    settledAt: 1_750_000_000_000,
  };
}

function rawFact(queryId: string): InputFactV1 {
  const content = "The user likes quiet restaurants.";
  return {
    type: "memory.raw_evidence_settled",
    queryId,
    resolverVersion: "paw.memory-raw-evidence-resolver.v1",
    scopeFingerprint: memoryScopeFingerprintV1(scope),
    status: "completed",
    resolutionRevision: "raw-1",
    spans: [
      {
        evidenceRef: "journal:run-1#input-fact-2",
        memoryIds: ["preference-1"],
        content,
        contentHash: hashTextV1(content),
      },
    ],
    settledAt: 1_750_000_000_000,
  };
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
          content: "Recommend a dinner restaurant for me",
          contentHash: "input-hash",
        },
      },
    ]),
    tailSeq: 2,
    latestInputSeq: 2,
  });
}
