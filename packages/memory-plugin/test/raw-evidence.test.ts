import { describe, expect, test } from "bun:test";

import type { SessionInputSnapshot } from "@paw/agent-loop";
import type { InputFactV1 } from "@paw/protocol";

import { hashTextV1 } from "../src/canonical.js";
import {
  type PawNextMemoryPluginProfileV1,
  createMemoryRawEvidenceInputPortV1,
  createMemoryRawEvidenceSectionV1,
  projectCurrentMemoryQueryV1,
  resolveMemoryRawEvidenceV1,
} from "../src/index.js";

const scope = Object.freeze({
  tenantId: "tenant-1",
  userId: "user-1",
  workspaceId: "workspace-1",
  repositoryId: "repo-1",
});

describe("memory raw evidence hydration", () => {
  test("resolves only already-selected refs and preserves their product order", async () => {
    const snapshot = evidenceSnapshot("query-1");
    const requested: string[] = [];
    const resolution = await resolveMemoryRawEvidenceV1({
      snapshot,
      queryId: "query-1",
      archive: {
        scope,
        async put() {},
        async resolve(requests) {
          requested.push(...requests.map((request) => request.evidenceRef));
          return requests.map((request) => {
            const content = `raw:${request.evidenceRef}`;
            return {
              ...request,
              content,
              contentHash: hashTextV1(content),
            };
          });
        },
      },
      maxSpans: 4,
      maxChars: 1_000,
      signal: new AbortController().signal,
    });

    expect(requested).toEqual([
      "journal:run-1#input-fact-2",
      "journal:run-2#input-fact-4",
    ]);
    expect(resolution.spans).toHaveLength(2);
    expect(resolution.spans[0]?.memoryIds).toEqual(["memory-card-1"]);
    expect(resolution.spans[1]?.memoryIds).toEqual(["memory-topic-1"]);
  });

  test("enforces the complete character budget after archive resolution", async () => {
    const resolution = await resolveMemoryRawEvidenceV1({
      snapshot: evidenceSnapshot("query-1"),
      queryId: "query-1",
      archive: {
        scope,
        async put() {},
        async resolve(requests) {
          return requests.map((request) => ({
            ...request,
            content: "x".repeat(400),
            contentHash: hashTextV1("x".repeat(400)),
          }));
        },
      },
      maxSpans: 4,
      maxChars: 500,
      signal: new AbortController().signal,
    });

    expect(resolution.spans.map((span) => span.content.length)).toEqual([
      400, 100,
    ]);
    expect(
      resolution.spans.reduce((total, span) => total + span.content.length, 0),
    ).toBe(500);
  });

  test("settles once at a safe boundary and renders a dynamic final section", async () => {
    const session = new FakeSession(initialSnapshot());
    const query = projectCurrentMemoryQueryV1(session.snapshot, profile);
    if (!query) throw new Error("expected memory query");
    await session.append([
      retrievalFact(query.queryId, "journal:prior-run#input-fact-2"),
    ]);
    let resolves = 0;
    const content = "The original user message contains the exact shared fact.";
    const input = createMemoryRawEvidenceInputPortV1({
      baseInput: {
        async reportSafeBoundary() {},
        async consumePromotedInputIds() {
          return [];
        },
      },
      session,
      profile,
      archive: {
        scope,
        async put() {},
        async resolve(requests) {
          resolves += 1;
          return requests.map((request) => ({
            ...request,
            content,
            contentHash: hashTextV1(content),
          }));
        },
      },
      signal: new AbortController().signal,
      maxSpans: 6,
      maxChars: 6_000,
      now: () => 1_750_000_000_000,
    });

    await input.reportSafeBoundary("before_first_model_request");
    await input.reportSafeBoundary("before_first_model_request");
    expect(resolves).toBe(1);
    const receipt = session.snapshot.entries.find(
      (entry) => entry.fact.type === "memory.raw_evidence_settled",
    );
    expect(receipt?.fact).toMatchObject({ status: "completed" });
    if (receipt?.fact.type !== "memory.raw_evidence_settled") {
      throw new Error("expected raw evidence receipt");
    }
    const section = createMemoryRawEvidenceSectionV1(receipt.fact, receipt.seq);
    expect(section?.content).toContain("paw.memory-raw-evidence.v1");
    expect(section?.content).toContain(content);
  });

  test("rejects an archive bound to another exact scope", () => {
    expect(() =>
      createMemoryRawEvidenceInputPortV1({
        baseInput: {
          async reportSafeBoundary() {},
          async consumePromotedInputIds() {
            return [];
          },
        },
        session: new FakeSession(initialSnapshot()),
        profile,
        archive: {
          scope: { ...scope, repositoryId: "other-repo" },
          async put() {},
          async resolve() {
            return [];
          },
        },
        signal: new AbortController().signal,
        maxSpans: 6,
        maxChars: 6_000,
      }),
    ).toThrow("scope mismatch");
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

function evidenceSnapshot(queryId: string): SessionInputSnapshot<InputFactV1> {
  return Object.freeze({
    entries: Object.freeze([
      { seq: 1, fact: retrievalFact(queryId, "journal:run-1#input-fact-2") },
      {
        seq: 2,
        fact: {
          type: "memory.topic_evidence_settled" as const,
          queryId,
          plannerVersion: "paw.memory-topic-evidence-planner.v1" as const,
          scopeFingerprint: "scope-fingerprint",
          status: "completed" as const,
          indexRevision: "index-1",
          indexEntries: [
            {
              topicId: "topic-1",
              snapshotId: "snapshot-1",
              family: "profile" as const,
              canonicalName: "User facts",
              normalizedName: "user facts",
              memberCount: 1,
              trajectoryCount: 1,
              projectionHash: "projection-1",
            },
          ],
          evidenceStates: [
            {
              topicId: "topic-1",
              snapshotId: "snapshot-1",
              trajectoryId: "trajectory-1",
              memoryId: "memory-topic-1",
              state: "current" as const,
              statement: "A selected topic statement.",
              validFrom: "2026-08-25T00:00:00.000Z",
              evidenceRefs: ["journal:run-2#input-fact-4"],
            },
          ],
          settledAt: 1_750_000_000_000,
        },
      },
    ]),
    tailSeq: 2,
    latestInputSeq: 2,
  });
}

function retrievalFact(queryId: string, evidenceRef: string): InputFactV1 {
  return {
    type: "memory.retrieval_settled",
    queryId,
    trigger: "task_start",
    providerVersion: profile.providerVersion,
    policyVersion: "paw.memory-retrieval.v1",
    status: "completed",
    cards: [
      {
        id: "memory-card-1",
        revision: 1,
        kind: "semantic",
        statement: "A selected memory statement.",
        applicability: "applicable",
        scope: { repositoryId: scope.repositoryId },
        sources: [{ kind: "memory_store_evidence", ref: evidenceRef }],
        confidence: 0.95,
        contentHash: "memory-card-hash",
      },
    ],
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
          content: "Recall the exact fact I previously shared.",
          contentHash: "input-hash",
        },
      },
    ]),
    tailSeq: 2,
    latestInputSeq: 2,
  });
}
