import { describe, expect, test } from "bun:test";

import type { MemoryEntry } from "@paw/memory/longterm";
import type { RuntimeToolCallV1 } from "@paw/runtime";

import {
  type MemoryTopicDossierExtractionInputV1,
  type MemoryTopicDossierStoreV1,
  type MemoryTopicDossierV1,
  PAW_MEMORY_TOPIC_DOSSIER_EXTRACTOR_VERSION_V1,
  PAW_MEMORY_TOPIC_DOSSIER_POLICY_VERSION_V1,
  PAW_NEXT_MEMORY_PLUGIN_POLICY_VERSION_V1,
  PAW_NEXT_MEMORY_V2_PROVIDER_VERSION_V1,
  assertMemoryTopicDossierIntegrityV1,
  buildMemoryTopicDossierRequestV1,
  createJsonMemoryTopicDossierExtractorV1,
  createMemoryTemporalRelationV1,
  createMemoryTopicDossierProjectorV1,
  createMemoryTopicProposalV1,
  createPawNextMemoryToolExecutorV1,
  materializeMemoryTopicDossierV1,
  materializeMemoryTopicProjectionV1,
  parseMemoryTopicDossierProposalV1,
  projectMemoryTopicDossierToolV1,
} from "../src/index.js";

const scope = Object.freeze({
  tenantId: "tenant-1",
  userId: "user-1",
  workspaceId: "workspace-1",
  repositoryId: "repo-1",
});

describe("memory topic dossier", () => {
  test("rejects a dossier store bound to another memory scope", () => {
    expect(() =>
      createPawNextMemoryToolExecutorV1({
        delegate: {
          async executeSettled() {
            return [];
          },
        },
        profile: {
          policyVersion: PAW_NEXT_MEMORY_PLUGIN_POLICY_VERSION_V1,
          mode: "read_only",
          providerVersion: PAW_NEXT_MEMORY_V2_PROVIDER_VERSION_V1,
          scope,
          maxCards: 8,
          maxInjectedTokens: 2_048,
        },
        dossierStore: new FakeDossierStore({
          ...scope,
          workspaceId: "another-workspace",
        }),
      }),
    ).toThrow("Memory dossier store scope mismatch");
  });

  test("keeps the cacheable instruction prefix stable and lets the model select IDs only", () => {
    const first = dossierInput();
    const second = dossierInput({ currentFact: "Now prefers Rust" });
    const firstRequest = buildMemoryTopicDossierRequestV1(first);
    const secondRequest = buildMemoryTopicDossierRequestV1(second);

    expect(firstRequest.system).toBe(secondRequest.system);
    expect(firstRequest.system).toContain("Select identities only");
    expect(firstRequest.system).not.toContain("Now prefers Go");
    expect(firstRequest.user).toContain("Now prefers Go");
  });

  test("rejects unknown, historical, duplicate, and wrong-relation selections", () => {
    const input = dossierInput();
    expect(() =>
      parseMemoryTopicDossierProposalV1(
        JSON.stringify({
          currentMemoryIds: ["old"],
          evolutionRelationIds: [],
          conflictRelationIds: [],
        }),
        input,
      ),
    ).toThrow("MemoryTopicDossierCurrentSelectionInvalid");
    expect(() =>
      parseMemoryTopicDossierProposalV1(
        JSON.stringify({
          currentMemoryIds: ["current", "current"],
          evolutionRelationIds: [],
          conflictRelationIds: [],
        }),
        input,
      ),
    ).toThrow("MemoryTopicDossierCurrentSelectionInvalid");
    const contradict = input.projection.snapshot.relationRefs.find(
      (relation) => relation.relationType === "contradicts",
    );
    expect(contradict).toBeDefined();
    expect(() =>
      parseMemoryTopicDossierProposalV1(
        JSON.stringify({
          currentMemoryIds: ["current"],
          evolutionRelationIds: [contradict?.relationId],
          conflictRelationIds: [],
        }),
        input,
      ),
    ).toThrow("MemoryTopicDossierEvolutionSelectionInvalid");
    expect(() =>
      parseMemoryTopicDossierProposalV1(
        JSON.stringify({
          currentMemoryIds: ["invented"],
          evolutionRelationIds: [],
          conflictRelationIds: [],
        }),
        input,
      ),
    ).toThrow("MemoryTopicDossierCurrentSelectionInvalid");
  });

  test("repairs one invalid ID selection without weakening validation", async () => {
    const extraction = dossierInput();
    const requests: Array<{ system: string; user: string }> = [];
    const extractor = createJsonMemoryTopicDossierExtractorV1({
      model: {
        async complete(request) {
          requests.push(request);
          return {
            status: "completed" as const,
            text: JSON.stringify({
              currentMemoryIds: requests.length === 1 ? ["old"] : ["current"],
              evolutionRelationIds: [],
              conflictRelationIds: [],
            }),
          };
        },
      },
    });
    const proposal = await extractor.extract(
      extraction,
      new AbortController().signal,
    );

    expect(proposal.currentMemoryIds).toEqual(["current"]);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.system).toContain(
      "paw.memory-topic-dossier-repair-once.v1",
    );
    expect(requests[1]?.user).toBe(requests[0]?.user);
  });

  test("materializes prose, time, and evidence from L1 instead of model output", () => {
    const input = dossierInput();
    const supersedes = input.projection.snapshot.relationRefs.find(
      (relation) => relation.relationType === "supersedes",
    );
    const contradicts = input.projection.snapshot.relationRefs.find(
      (relation) => relation.relationType === "contradicts",
    );
    if (!supersedes || !contradicts) throw new Error("expected relations");
    const proposal = parseMemoryTopicDossierProposalV1(
      `model preamble ${JSON.stringify({
        currentMemoryIds: ["current", "alternative"],
        evolutionRelationIds: [supersedes.relationId],
        conflictRelationIds: [contradicts.relationId],
      })} trailing prose`,
      input,
    );
    const dossier = materializeMemoryTopicDossierV1({
      projection: input.projection,
      entries: input.entries,
      proposal,
      extractorVersion: PAW_MEMORY_TOPIC_DOSSIER_EXTRACTOR_VERSION_V1,
      createdAt: "2025-03-02T00:00:00.000Z",
    });

    expect(dossier.currentConclusions.map((item) => item.statement)).toEqual([
      "Still requires Python",
      "Now prefers Go",
    ]);
    expect(dossier.evolutions[0]).toMatchObject({
      previous: { memoryId: "old", status: "historical" },
      current: { memoryId: "current", status: "current" },
    });
    expect(dossier.conflicts[0]).toMatchObject({
      left: { memoryId: "alternative" },
      right: { memoryId: "current" },
      resolutionStatus: "unresolved",
    });
    expect(dossier.evidenceRefs).toEqual([
      "journal:run-1#old",
      "journal:run-2#alternative",
      "journal:run-2#change-confirmation",
      "journal:run-2#conflict-check",
      "journal:run-2#current",
    ]);
    expect(JSON.stringify(dossier)).not.toContain("model preamble");
    expect(() => assertMemoryTopicDossierIntegrityV1(dossier)).not.toThrow();
    const toolView = projectMemoryTopicDossierToolV1(dossier, 3, 8_000);
    expect(JSON.stringify(toolView).length).toBeLessThanOrEqual(8_000);
    expect(toolView).toMatchObject({
      currentConclusions: expect.any(Array),
      evolutions: expect.any(Array),
      conflicts: [],
      truncated: true,
    });
  });

  test("uses content addressing across rebuild time and rejects tampering", () => {
    const input = dossierInput();
    const proposal = parseMemoryTopicDossierProposalV1(
      JSON.stringify({
        currentMemoryIds: ["current"],
        evolutionRelationIds: [],
        conflictRelationIds: [],
      }),
      input,
    );
    const first = materializeMemoryTopicDossierV1({
      projection: input.projection,
      entries: input.entries,
      proposal,
      extractorVersion: "extractor-1",
      createdAt: "2025-03-02T00:00:00.000Z",
    });
    const rebuilt = materializeMemoryTopicDossierV1({
      projection: input.projection,
      entries: [...input.entries].reverse(),
      proposal,
      extractorVersion: "extractor-1",
      createdAt: "2025-04-02T00:00:00.000Z",
    });
    expect(rebuilt.id).toBe(first.id);
    const tampered = {
      ...first,
      currentConclusions: [
        { ...first.currentConclusions[0], statement: "Invented durable fact" },
      ],
    } as MemoryTopicDossierV1;
    expect(() => assertMemoryTopicDossierIntegrityV1(tampered)).toThrow(
      "MemoryTopicDossierHashMismatch",
    );
  });

  test("reuses an exact projection without paying for a second model call", async () => {
    const extraction = dossierInput();
    const store = new FakeDossierStore();
    let extractions = 0;
    const events: string[] = [];
    const projector = createMemoryTopicDossierProjectorV1({
      scope,
      store,
      extractor: {
        extractorVersion: "dossier-extractor-test.v1",
        async extract(input) {
          extractions += 1;
          const supersedes = input.projection.snapshot.relationRefs.find(
            (relation) => relation.relationType === "supersedes",
          );
          if (!supersedes) throw new Error("expected supersedes relation");
          return parseMemoryTopicDossierProposalV1(
            JSON.stringify({
              currentMemoryIds: ["current"],
              evolutionRelationIds: [supersedes.relationId],
              conflictRelationIds: [],
            }),
            input,
          );
        },
      },
      now: () => 1_741_046_400_000,
      maxCurrentConclusions: 1,
      onEvent: (event) => events.push(event.type),
    });
    const source = {
      projection: extraction.projection,
      entries: extraction.entries,
    };

    const first = await projector.project(source, new AbortController().signal);
    const replay = await projector.project(
      source,
      new AbortController().signal,
    );

    expect(replay.id).toBe(first.id);
    expect(extractions).toBe(1);
    expect(store.puts).toBe(1);
    expect(events).toEqual(["extract", "commit", "cache_hit"]);
  });

  test("emits a content-free failure code without swallowing projection errors", async () => {
    const extraction = dossierInput();
    const events: Array<Record<string, unknown>> = [];
    const store = new FakeDossierStore();
    const storeError = new Error("sensitive store text must not be logged");
    storeError.name = "MemoryDossierStoreSyntheticFailure";
    store.putError = storeError;
    const projector = createMemoryTopicDossierProjectorV1({
      scope,
      store,
      extractor: {
        extractorVersion: "dossier-extractor-failing.v1",
        async extract() {
          const error = new Error("sensitive model text must not be logged");
          error.name = "MemoryDossierModelSyntheticFailure";
          throw error;
        },
      },
      maxCurrentConclusions: 1,
      onEvent: (event) =>
        events.push(event as unknown as Record<string, unknown>),
    });
    await expect(
      projector.project(
        {
          projection: extraction.projection,
          entries: extraction.entries,
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("sensitive store text must not be logged");
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: "fallback",
      reasonCode: "MemoryDossierModelSyntheticFailure",
    });
    expect(events[1]).toMatchObject({
      type: "failed",
      reasonCode: "MemoryDossierStoreSyntheticFailure",
    });
    expect(JSON.stringify(events)).not.toContain("sensitive model text");
    expect(JSON.stringify(events)).not.toContain("sensitive store text");
  });

  test("projects a complete small topic without calling the model", async () => {
    const extraction = dossierInput();
    const store = new FakeDossierStore();
    const events: string[] = [];
    const projector = createMemoryTopicDossierProjectorV1({
      scope,
      store,
      extractor: {
        extractorVersion: "dossier-extractor-unused.v1",
        async extract() {
          throw new Error("small complete topic must not call the model");
        },
      },
      now: () => 1_741_046_400_000,
      onEvent: (event) => events.push(event.type),
    });
    const dossier = await projector.project(
      {
        projection: extraction.projection,
        entries: extraction.entries,
      },
      new AbortController().signal,
    );

    expect(dossier.coverage).toEqual({
      currentSelected: 2,
      currentAvailable: 2,
      evolutionsSelected: 1,
      evolutionsAvailable: 1,
      conflictsSelected: 1,
      conflictsAvailable: 1,
    });
    expect(events).toEqual(["deterministic", "commit"]);
  });

  test("memory.read_topic prefers the bounded dossier over legacy flat states", async () => {
    const extraction = dossierInput();
    const proposal = parseMemoryTopicDossierProposalV1(
      JSON.stringify({
        currentMemoryIds: ["current"],
        evolutionRelationIds: [],
        conflictRelationIds: [],
      }),
      extraction,
    );
    const dossier = materializeMemoryTopicDossierV1({
      projection: extraction.projection,
      entries: extraction.entries,
      proposal,
      extractorVersion: "dossier-tool-test.v1",
      createdAt: "2025-03-02T00:00:00.000Z",
    });
    const dossierStore = new FakeDossierStore();
    await dossierStore.put(dossier);
    const executor = createPawNextMemoryToolExecutorV1({
      delegate: {
        async executeSettled(calls) {
          return calls.map((call) => ({
            status: "failed" as const,
            callId: call.id,
            error: {
              name: "ToolUnknown",
              message: "unregistered memory plugin tool",
            },
          }));
        },
      },
      profile: {
        policyVersion: PAW_NEXT_MEMORY_PLUGIN_POLICY_VERSION_V1,
        mode: "read_only",
        providerVersion: PAW_NEXT_MEMORY_V2_PROVIDER_VERSION_V1,
        scope,
        maxCards: 8,
        maxInjectedTokens: 2_048,
      },
      topicStore: {
        scope,
        async load() {
          return [
            {
              projection: extraction.projection,
              entries: extraction.entries,
            },
          ];
        },
      },
      dossierStore,
    });
    const results = await executor.executeSettled(
      [
        {
          id: "read-topic-1",
          name: "memory_read_topic",
          arguments: {
            topic_id: extraction.projection.topic.id,
            max_states: 8,
          },
        } satisfies RuntimeToolCallV1,
      ],
      { turn: 1, signal: new AbortController().signal },
    );
    if (results[0]?.status !== "success") {
      throw new Error(`expected success: ${JSON.stringify(results[0])}`);
    }
    const payload = results[0].result.payload as Record<string, unknown>;
    expect(payload.dossier).toBeDefined();
    expect(payload.states).toBeUndefined();
  });
});

class FakeDossierStore implements MemoryTopicDossierStoreV1 {
  readonly scope: MemoryTopicDossierStoreV1["scope"];
  readonly values = new Map<string, MemoryTopicDossierV1>();
  puts = 0;
  putError?: Error;

  constructor(scopeValue: MemoryTopicDossierStoreV1["scope"] = scope) {
    this.scope = scopeValue;
  }

  async getExact(
    key: Parameters<MemoryTopicDossierStoreV1["getExact"]>[0],
  ): Promise<MemoryTopicDossierV1 | undefined> {
    return this.values.get(this.key(key));
  }

  async getCurrent(topicId: string): Promise<MemoryTopicDossierV1 | undefined> {
    return [...this.values.values()].find(
      (dossier) => dossier.topicId === topicId,
    );
  }

  async put(dossier: MemoryTopicDossierV1): Promise<{ inserted: boolean }> {
    if (this.putError) throw this.putError;
    this.puts += 1;
    const key = this.key({
      topicId: dossier.topicId,
      projectionHash: dossier.projectionHash,
      policyVersion: PAW_MEMORY_TOPIC_DOSSIER_POLICY_VERSION_V1,
      extractorVersion: dossier.extractorVersion,
    });
    const inserted = !this.values.has(key);
    this.values.set(key, dossier);
    return { inserted };
  }

  private key(
    key: Parameters<MemoryTopicDossierStoreV1["getExact"]>[0],
  ): string {
    return [
      key.topicId,
      key.projectionHash,
      key.policyVersion,
      key.extractorVersion,
    ].join("\n");
  }
}

function dossierInput(
  options: Readonly<{ currentFact?: string }> = {},
): MemoryTopicDossierExtractionInputV1 {
  const old = semantic({
    id: "old",
    fact: "Previously preferred Python",
    tValid: "2025-01-01T00:00:00.000Z",
    tInvalid: "2025-02-01T00:00:00.000Z",
    evidence: ["journal:run-1#old"],
  });
  const current = semantic({
    id: "current",
    fact: options.currentFact ?? "Now prefers Go",
    tValid: "2025-02-01T00:00:00.000Z",
    tInvalid: null,
    evidence: ["journal:run-2#current"],
  });
  const alternative = semantic({
    id: "alternative",
    fact: "Still requires Python",
    tValid: "2025-02-02T00:00:00.000Z",
    tInvalid: null,
    evidence: ["journal:run-2#alternative"],
  });
  const supersedes = createMemoryTemporalRelationV1({
    scope,
    fromMemoryId: current.id,
    toMemoryId: old.id,
    relationType: "supersedes",
    evidenceRefs: ["journal:run-2#change-confirmation"],
    createdAt: current.tValid,
  });
  const contradicts = createMemoryTemporalRelationV1({
    scope,
    fromMemoryId: alternative.id,
    toMemoryId: current.id,
    relationType: "contradicts",
    evidenceRefs: ["journal:run-2#conflict-check"],
    createdAt: alternative.tValid,
  });
  const proposal = createMemoryTopicProposalV1({
    scope,
    family: "profile",
    canonicalName: "Backend technology preference",
    confidence: 0.95,
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
        confidence: 0.95,
        basis: "user_asserted",
      },
      {
        memoryId: alternative.id,
        role: "supporting",
        confidence: 0.8,
        basis: "explicit_relation",
      },
    ],
  });
  return {
    projection: materializeMemoryTopicProjectionV1({
      scope,
      proposal,
      entries: [old, current, alternative],
      relations: [supersedes, contradicts],
      graphRevision: "graph-revision-3",
      createdAt: "2025-03-01T00:00:00.000Z",
    }),
    entries: [old, current, alternative],
    maxCurrentConclusions: 4,
    maxEvolutions: 4,
    maxConflicts: 4,
  };
}

function semantic(
  input: Readonly<{
    id: string;
    fact: string;
    tValid: string;
    tInvalid: string | null;
    evidence: string[];
  }>,
): MemoryEntry {
  return {
    id: input.id,
    kind: "semantic",
    repo: "repo-hash",
    created: input.tValid,
    tValid: input.tValid,
    tInvalid: input.tInvalid,
    source: "user_statement",
    confidence: 0.95,
    evidence: input.evidence,
    freq: 0,
    utility: 0,
    fact: input.fact,
    keywords: input.fact.toLocaleLowerCase().split(/\s+/),
    embeddingKey: input.fact,
  };
}
