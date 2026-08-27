import { describe, expect, test } from "bun:test";

import type { SessionInputSnapshot } from "@paw/agent-loop";
import { type InputFactV1, parseRunJournalPrefixV1 } from "@paw/protocol";

import {
  type MemoryTopicOrganizerEventV1,
  type PawNextMemoryScopeV1,
  createMemoryTopicOrganizerControllerV1,
  createMemoryTopicProposalV1,
  memoryScopeFingerprintV1,
} from "../src/index.js";

const scope: PawNextMemoryScopeV1 = Object.freeze({
  tenantId: "tenant-1",
  userId: "user-1",
  workspaceId: "workspace-1",
  repositoryId: "repo-1",
});

describe("journal-backed memory topic organizer", () => {
  test("claims, stages, applies, and never repeats extraction for one source write", async () => {
    const session = new FakeSession(sourceWriteSnapshot());
    const events: MemoryTopicOrganizerEventV1[] = [];
    let extractorCalls = 0;
    let applyCalls = 0;
    const controller = createMemoryTopicOrganizerControllerV1({
      session,
      runId: "run-1",
      scope,
      extractor: {
        extractorVersion: "paw.memory-topic-extractor.json.v1",
        async extract(input) {
          extractorCalls += 1;
          const [entry] = input.entries;
          if (!entry) throw new Error("expected one extraction entry");
          return [
            createMemoryTopicProposalV1({
              scope,
              family: "instruction",
              canonicalName: "Documentation language",
              confidence: 0.96,
              members: [
                {
                  memoryId: entry.id,
                  role: "primary",
                  confidence: 0.98,
                  basis: "model_proposed",
                },
              ],
            }),
          ];
        },
      },
      store: {
        async prepare() {
          return {
            sourceRevision: "source-revision-1",
            entries: [
              {
                id: "memory-1",
                kind: "profile",
                statement: "Use Chinese for documentation.",
                keywords: ["Chinese", "documentation"],
                confidence: 0.98,
              },
            ],
            existingTopics: [],
          };
        },
        async apply(input) {
          applyCalls += 1;
          expect(input.proposals).toHaveLength(1);
          return {
            topicIds: ["topic-1"],
            snapshotIds: ["snapshot-1"],
          };
        },
      },
      signal: new AbortController().signal,
      now: () => 1_750_000_000_500,
      onEvent: (event) => events.push(event),
    });

    const settlement = sourceWriteSettlement();
    expect(await controller.settleSourceWrite(settlement)).toMatchObject({
      status: "completed",
      topicIds: ["topic-1"],
      snapshotIds: ["snapshot-1"],
    });
    expect(await controller.settleSourceWrite(settlement)).toBeUndefined();
    expect(extractorCalls).toBe(1);
    expect(applyCalls).toBe(1);
    expect(events.map((event) => event.type)).toEqual([
      "claim",
      "stage",
      "apply",
      "settle",
      "claim",
    ]);
    expect(JSON.stringify(events)).not.toContain("Documentation language");
    expect(() => parseRunJournalPrefixV1(session.envelopes())).not.toThrow();
  });

  test("replays a durable staged proposal after a crash without calling the model", async () => {
    const base = sourceWriteSnapshot();
    const proposal = createMemoryTopicProposalV1({
      scope,
      family: "profile",
      canonicalName: "Response style",
      confidence: 0.94,
      members: [
        {
          memoryId: "memory-1",
          role: "primary",
          confidence: 0.95,
          basis: "model_proposed",
        },
      ],
    });
    const session = new FakeSession(base);
    await session.append([
      {
        type: "memory.topic_organization_claimed",
        organizationId: "organization-crashed",
        policyVersion: "paw.memory-topic-organization.v1",
        extractorVersion: "paw.memory-topic-extractor.json.v1",
        scopeFingerprint: memoryScopeFingerprintV1(scope),
        sourceWriteId: "write-1",
        sourceProposalHash: "write-proposal-hash",
        sourceMemoryIds: ["memory-1"],
        sourceRevision: "source-revision-1",
        claimedAt: 1_750_000_000_400,
      },
      {
        type: "memory.topic_candidate_staged",
        organizationId: "organization-crashed",
        proposalHash: "topic-proposal-hash",
        topics: [proposal],
      },
    ]);
    let extractorCalls = 0;
    let prepareCalls = 0;
    let applyCalls = 0;
    const controller = createMemoryTopicOrganizerControllerV1({
      session,
      runId: "run-1",
      scope,
      extractor: {
        extractorVersion: "paw.memory-topic-extractor.json.v1",
        async extract() {
          extractorCalls += 1;
          return [];
        },
      },
      store: {
        async prepare() {
          prepareCalls += 1;
          throw new Error("recovery must not reload extraction input");
        },
        async apply(input) {
          applyCalls += 1;
          expect(input.proposals).toEqual([proposal]);
          return {
            topicIds: ["topic-recovered"],
            snapshotIds: ["snapshot-recovered"],
          };
        },
      },
      signal: new AbortController().signal,
      now: () => 1_750_000_000_600,
    });

    expect(
      await controller.settleSourceWrite(sourceWriteSettlement()),
    ).toMatchObject({
      organizationId: "organization-crashed",
      status: "completed",
      topicIds: ["topic-recovered"],
    });
    expect(extractorCalls).toBe(0);
    expect(prepareCalls).toBe(0);
    expect(applyCalls).toBe(1);
    expect(() => parseRunJournalPrefixV1(session.envelopes())).not.toThrow();
  });

  test("closes an interrupted pre-stage claim without paying for extraction", async () => {
    const session = new FakeSession(sourceWriteSnapshot());
    await session.append([
      {
        type: "memory.topic_organization_claimed",
        organizationId: "organization-pre-stage-crash",
        policyVersion: "paw.memory-topic-organization.v1",
        extractorVersion: "paw.memory-topic-extractor.json.v1",
        scopeFingerprint: memoryScopeFingerprintV1(scope),
        sourceWriteId: "write-1",
        sourceProposalHash: "write-proposal-hash",
        sourceMemoryIds: ["memory-1"],
        sourceRevision: "source-revision-1",
        claimedAt: 1_750_000_000_400,
      },
    ]);
    let extractorCalls = 0;
    const controller = createMemoryTopicOrganizerControllerV1({
      session,
      runId: "run-1",
      scope,
      extractor: {
        extractorVersion: "paw.memory-topic-extractor.json.v1",
        async extract() {
          extractorCalls += 1;
          return [];
        },
      },
      store: {
        async prepare() {
          throw new Error("recovery must not prepare a new extraction");
        },
        async apply() {
          throw new Error("an unstaged claim must not be applied");
        },
      },
      signal: new AbortController().signal,
      now: () => 1_750_000_000_700,
    });

    expect(
      await controller.settleSourceWrite(sourceWriteSettlement()),
    ).toMatchObject({
      organizationId: "organization-pre-stage-crash",
      status: "interrupted",
      reasonCode: "memory_topic_claim_interrupted_before_stage",
    });
    expect(extractorCalls).toBe(0);
    expect(() => parseRunJournalPrefixV1(session.envelopes())).not.toThrow();
  });
});

class FakeSession {
  snapshot: SessionInputSnapshot<InputFactV1>;

  constructor(snapshot: SessionInputSnapshot<InputFactV1>) {
    this.snapshot = snapshot;
  }

  async readInputSnapshot(): Promise<SessionInputSnapshot<InputFactV1>> {
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

  async append(facts: readonly InputFactV1[]): Promise<void> {
    const entries = [...this.snapshot.entries];
    let seq = this.snapshot.tailSeq;
    for (const fact of facts) entries.push({ seq: ++seq, fact });
    this.snapshot = Object.freeze({
      entries: Object.freeze(entries),
      tailSeq: seq,
      latestInputSeq: seq,
    });
  }

  envelopes() {
    return this.snapshot.entries.map((entry) => ({
      schemaVersion: "paw.run-journal.v1" as const,
      sessionId: "session-1",
      runId: "run-1",
      seq: entry.seq,
      ts: 1_750_000_000_000 + entry.seq,
      record: {
        kind: "input_fact" as const,
        fact: entry.fact,
      },
    }));
  }
}

function sourceWriteSnapshot(): SessionInputSnapshot<InputFactV1> {
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
          type: "memory.write_claimed" as const,
          writeId: "write-1",
          trigger: "explicit_user_request" as const,
          policyVersion: "paw.memory-writer.v1" as const,
          extractorVersion: "paw.memory-atom-extractor.json.v1",
          scopeFingerprint: memoryScopeFingerprintV1(scope),
          sourceFromSeq: 1,
          sourceThroughSeq: 1,
          sourceInputHash: "source-hash",
          claimedAt: 1_750_000_000_000,
        },
      },
      {
        seq: 3,
        fact: {
          type: "memory.candidate_staged" as const,
          writeId: "write-1",
          proposalHash: "write-proposal-hash",
          atoms: [],
        },
      },
      { seq: 4, fact: sourceWriteSettlement() },
    ]),
    tailSeq: 4,
    latestInputSeq: 4,
  });
}

function sourceWriteSettlement() {
  return Object.freeze({
    type: "memory.write_settled" as const,
    writeId: "write-1",
    status: "completed" as const,
    proposalHash: "write-proposal-hash",
    storedIds: Object.freeze(["memory-1"]),
    invalidatedIds: Object.freeze([]),
    skippedAtomIds: Object.freeze([]),
    settledAt: 1_750_000_000_100,
  });
}
