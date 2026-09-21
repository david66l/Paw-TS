import { describe, expect, test } from "bun:test";
import type { SessionInputSnapshot } from "@paw/agent-loop";
import type { MemoryEntry } from "@paw/memory/longterm";
import { type InputFactV1, parseRunJournalPrefixV1 } from "@paw/protocol";
import {
  type MemoryMaintenanceOptionsV1,
  type MemoryWriterEventV1,
  createBoundedMemoryTopicDossierProposalV1,
  createJsonMemoryAtomExtractorV1,
  createMemoryMaintenanceControllerV1,
  createMemoryTopicProposalV1,
  materializeMemoryTopicProjectionV1,
} from "../src/index.js";

const scope = {
  tenantId: "t",
  userId: "u",
  workspaceId: "w",
  repositoryId: "r",
};
const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class TestSession {
  entries: SessionInputSnapshot<InputFactV1>["entries"] = [
    {
      seq: 1,
      fact: { type: "attempt.started", goalHash: "goal", configHash: "config" },
    },
    {
      seq: 2,
      fact: {
        type: "input.promoted",
        inputId: "i",
        delivery: "initial",
        content: "请记住以后使用中文写文档。",
        contentHash: "content",
      },
    },
  ];
  async readInputSnapshot(): Promise<SessionInputSnapshot<InputFactV1>> {
    return {
      entries: this.entries,
      tailSeq: this.entries.length,
      latestInputSeq: this.entries.length,
    };
  }
  async commitInputFacts(
    tail: number,
    facts: readonly InputFactV1[],
  ): Promise<"committed" | "conflict"> {
    if (tail !== this.entries.length) return "conflict";
    this.entries = [
      ...this.entries,
      ...facts.map((fact, index) => ({ seq: tail + index + 1, fact })),
    ];
    return "committed";
  }
  facts(type: InputFactV1["type"]) {
    return this.entries.filter((entry) => entry.fact.type === type);
  }
  validate() {
    expect(() =>
      parseRunJournalPrefixV1(
        this.entries.map((entry) => ({
          schemaVersion: "paw.run-journal.v1",
          sessionId: "session",
          runId: "run",
          seq: entry.seq,
          ts: 100 + entry.seq,
          record: { kind: "input_fact", fact: entry.fact },
        })),
      ),
    ).not.toThrow();
  }
}

function fixture(trap?: string) {
  const session = new TestSession();
  const gate = deferred();
  const entered = deferred();
  const calls: string[] = [];
  const events: MemoryWriterEventV1[] = [];
  const abort = new AbortController();
  const boundary = async (name: string) => {
    calls.push(name);
    if (name === trap) {
      entered.resolve();
      await gate.promise;
    }
  };
  const extractor = createJsonMemoryAtomExtractorV1({
    model: {
      async complete() {
        await boundary("extract");
        return {
          status: "completed",
          text: JSON.stringify({
            atoms: [
              {
                kind: "instruction",
                action: "store",
                statement: "Use Chinese for documentation.",
                keywords: ["Chinese"],
                authority: "user_asserted",
                confidence: 0.98,
                priority: 90,
                sourceSeqs: [2],
                targetIds: [],
              },
            ],
          }),
        };
      },
    },
  });
  const entries: MemoryEntry[] = ["memory-1", "memory-2"].map((id) => ({
    id,
    kind: "semantic",
    fact: id,
    keywords: [id],
    embeddingKey: id,
    repo: scope.repositoryId,
    created: "2025-01-01T00:00:00.000Z",
    tValid: "2025-01-01T00:00:00.000Z",
    tInvalid: null,
    source: "user_statement",
    confidence: 0.98,
    evidence: ["journal:run#input-fact-2"],
    freq: 0,
    utility: 0,
  }));
  const proposal = createMemoryTopicProposalV1({
    scope,
    family: "instruction",
    canonicalName: "Documentation",
    confidence: 0.98,
    members: entries.map((entry) => ({
      memoryId: entry.id,
      role: "primary",
      basis: "user_asserted",
      confidence: 0.98,
    })),
  });
  const projection = materializeMemoryTopicProjectionV1({
    scope,
    proposal,
    entries,
    relations: [],
    graphRevision: "graph",
    createdAt: "2025-01-01T00:00:00.000Z",
  });
  const options: MemoryMaintenanceOptionsV1 = {
    signal: abort.signal,
    timeoutMs: 80,
    writer: {
      session: {
        async readInputSnapshot() {
          await boundary("read");
          return session.readInputSnapshot();
        },
        async commitInputFacts(tail, facts) {
          await boundary(facts[0]!.type);
          return session.commitInputFacts(tail, facts);
        },
      },
      runId: "run",
      scope,
      extractor,
      sourceAdmission: () => new Set([2]),
      store: {
        async recall() {
          await boundary("recall");
          return [];
        },
        async apply() {
          await boundary("apply");
          return {
            storedIds: ["memory-1"],
            invalidatedIds: [],
            skippedAtomIds: [],
          };
        },
      },
      evidenceArchive: {
        scope,
        async put() {
          await boundary("archive");
        },
        async resolve() {
          return [];
        },
      },
      onEvent: (event) => events.push(event),
    },
    organizer: {
      extractor: {
        extractorVersion: "paw.memory-topic-extractor.json.v1",
        async extract() {
          await boundary("topic.extract");
          return [proposal];
        },
      },
      store: {
        async prepare() {
          await boundary("topic.prepare");
          return {
            sourceRevision: "source",
            entries: [
              {
                id: "memory-1",
                kind: "profile",
                statement: "Use Chinese",
                keywords: [],
                confidence: 0.98,
              },
            ],
            existingTopics: [],
          };
        },
        async apply() {
          await boundary("topic.apply");
          return {
            topicIds: [projection.topic.id],
            snapshotIds: [projection.snapshot.id],
          };
        },
      },
    },
    catalog: {
      scope,
      async load() {
        await boundary("catalog");
        return [{ projection, entries }];
      },
    },
    dossier: {
      scope,
      maxCurrentConclusions: 1,
      extractor: {
        extractorVersion: "dossier-extractor",
        async extract(request) {
          await boundary("dossier.extract");
          return createBoundedMemoryTopicDossierProposalV1(request);
        },
      },
      store: {
        scope,
        async getExact() {
          await boundary("dossier.get");
          return undefined;
        },
        async getCurrent() {
          return undefined;
        },
        async put() {
          await boundary("dossier.put");
          return { inserted: true };
        },
      },
    },
  };
  return { options, session, gate, entered, calls, events, abort };
}

describe("bounded journal-backed memory maintenance", () => {
  test("background redelivery does not reorganize an already settled source after catalog revision changes", async () => {
    const f = fixture();
    const options = {
      ...f.options,
      writer: { ...f.options.writer, retryFailedUnstaged: true as const },
    };
    await createMemoryMaintenanceControllerV1(options).settleTerminal(
      "completed",
    );
    const before = [...f.calls];
    f.session.entries = JSON.parse(JSON.stringify(f.session.entries));
    options.organizer = {
      ...options.organizer,
      store: {
        ...options.organizer.store,
        async prepare() {
          throw new Error(
            "The catalog was already changed by this source write",
          );
        },
      },
    };
    await createMemoryMaintenanceControllerV1(options).settleTerminal(
      "completed",
    );
    const modelOrWrite = (call: string) => /extract|apply|put/.test(call);
    expect(f.calls.filter(modelOrWrite)).toEqual(before.filter(modelOrWrite));
    expect(f.session.facts("memory.topic_organization_settled")).toHaveLength(
      1,
    );
    f.session.validate();
  });
  test("explicit background retries are capped by durable evidence claims after restart", async () => {
    const f = fixture();
    let attempts = 0;
    const options: MemoryMaintenanceOptionsV1 = {
      ...f.options,
      timeoutMs: 1000,
      writer: {
        ...f.options.writer,
        retryFailedUnstaged: true,
        extractor: {
          extractorVersion: f.options.writer.extractor.extractorVersion,
          async extract() {
            attempts++;
            throw new Error("provider unavailable");
          },
        },
      },
    };
    for (let i = 0; i < 6; i++) {
      await createMemoryMaintenanceControllerV1(options).settleTerminal(
        "completed",
      );
      // Rehydrate the persisted facts as a new process would, retaining every failed attempt.
      f.session.entries = JSON.parse(JSON.stringify(f.session.entries));
    }
    expect(attempts).toBe(3);
    expect(f.session.facts("memory.write_claimed")).toHaveLength(3);
    expect(f.session.facts("memory.write_settled")).toHaveLength(3);
    expect(f.session.facts("memory.candidate_staged")).toHaveLength(0);
    f.session.validate();
  });
  test("completes writer, organization and dossier, preserving a valid replayable journal", async () => {
    const f = fixture();
    const controller = createMemoryMaintenanceControllerV1(f.options);
    expect(await controller.settleTerminal("completed")).toMatchObject({
      status: "completed",
      storedIds: ["memory-1"],
    });
    expect(f.calls).toContain("dossier.put");
    expect(await controller.settleTerminal("completed")).toBeUndefined();
    expect(f.calls.filter((call) => call === "extract")).toHaveLength(1);
    expect(f.calls.filter((call) => call === "topic.extract")).toHaveLength(1);
    expect(f.calls.filter((call) => call === "archive")).toHaveLength(1);
    f.session.validate();
  });

  test("starts the deadline at settlement, not when the task controller is constructed", async () => {
    const f = fixture();
    const controller = createMemoryMaintenanceControllerV1({
      ...f.options,
      timeoutMs: 25,
    });
    await delay(40);
    expect(await controller.settleTerminal("completed")).toMatchObject({
      status: "completed",
    });
  });

  test("a cancelled parent performs no journal, archive, model or database work", async () => {
    const f = fixture();
    f.abort.abort(new DOMException("cancel", "AbortError"));
    await expect(
      createMemoryMaintenanceControllerV1(f.options).settleTerminal(
        "completed",
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(f.calls).toEqual([]);
    expect(f.events.at(-1)?.reasonCode).toBe("MemoryMaintenanceCancelled");
  });

  for (const phase of [
    "read",
    "archive",
    "memory.write_claimed",
    "recall",
    "extract",
    "memory.candidate_staged",
    "apply",
    "memory.write_settled",
    "topic.prepare",
    "memory.topic_organization_claimed",
    "topic.extract",
    "memory.topic_candidate_staged",
    "topic.apply",
    "memory.topic_organization_settled",
    "catalog",
    "dossier.get",
    "dossier.extract",
    "dossier.put",
  ]) {
    test(`bounds ${phase} ignoring cancellation and rejects its late continuation`, async () => {
      const f = fixture(phase);
      const pending = createMemoryMaintenanceControllerV1(
        f.options,
      ).settleTerminal("completed");
      // Attach the rejection handler before waiting for the deliberately stalled port.
      const checked = expect(pending).rejects.toMatchObject({
        name: "TimeoutError",
      });
      await f.entered.promise;
      await checked;
      const callsAtReturn = [...f.calls];
      expect(f.events.at(-1)?.reasonCode).toBe(
        "MemoryMaintenanceDeadlineExceeded",
      );
      f.gate.resolve();
      await delay(5);
      // The in-flight call itself may commit late. It cannot start another port,
      // such as an extraction repair, a new model call, a stage or a store write.
      expect(f.calls).toEqual(callsAtReturn);
      f.session.validate();
    });
  }

  test("writer and organizer share one budget rather than resetting it between stages", async () => {
    const f = fixture("topic.prepare");
    const baseExtract = f.options.writer.extractor.extract;
    const start = performance.now();
    await expect(
      createMemoryMaintenanceControllerV1({
        ...f.options,
        timeoutMs: 120,
        writer: {
          ...f.options.writer,
          extractor: {
            ...f.options.writer.extractor,
            async extract(request, signal) {
              await delay(75);
              return baseExtract(request, signal);
            },
          },
        },
      }).settleTerminal("completed"),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(f.calls).toContain("topic.prepare");
    expect(performance.now() - start).toBeLessThan(180);
    f.gate.resolve();
  });

  for (const phase of [
    "apply",
    "memory.candidate_staged",
    "memory.write_settled",
    "topic.apply",
    "memory.topic_candidate_staged",
    "memory.topic_organization_settled",
  ]) {
    test(`recovers an acknowledged-lost ${phase} without a second extraction`, async () => {
      const f = fixture();
      const original = f.options.writer.session;
      const writeIds: string[] = [];
      let injected = false;
      const loseAck = () => {
        if (!injected) {
          injected = true;
          throw new Error("acknowledgement lost");
        }
      };
      const options: MemoryMaintenanceOptionsV1 = {
        ...f.options,
        writer: {
          ...f.options.writer,
          session: {
            ...original,
            async commitInputFacts(tail, facts) {
              const result = await original.commitInputFacts(tail, facts);
              if (facts[0]?.type === phase) loseAck();
              return result;
            },
          },
          store: {
            ...f.options.writer.store,
            async apply(request, signal) {
              writeIds.push(request.writeId);
              const result = await f.options.writer.store.apply(
                request,
                signal,
              );
              if (phase === "apply") loseAck();
              return result;
            },
          },
        },
        organizer: {
          ...f.options.organizer,
          store: {
            ...f.options.organizer.store,
            async apply(request, signal) {
              const result = await f.options.organizer.store.apply(
                request,
                signal,
              );
              if (phase === "topic.apply") loseAck();
              return result;
            },
          },
        },
      };
      await expect(
        createMemoryMaintenanceControllerV1(options).settleTerminal(
          "completed",
        ),
      ).rejects.toThrow("acknowledgement lost");
      expect(
        f.session.entries.some(
          (entry) =>
            (entry.fact.type === "memory.write_settled" ||
              entry.fact.type === "memory.topic_organization_settled") &&
            entry.fact.status === "failed",
        ),
      ).toBe(false);
      // Reconstruct the session snapshot and controller as a resumed process would.
      f.session.entries = JSON.parse(JSON.stringify(f.session.entries));
      await createMemoryMaintenanceControllerV1(options).settleTerminal(
        "completed",
      );
      expect(f.calls.filter((call) => call === "extract")).toHaveLength(1);
      expect(f.calls.filter((call) => call === "topic.extract")).toHaveLength(
        1,
      );
      expect(new Set(writeIds).size).toBe(1);
      expect(f.session.facts("memory.write_settled")).toHaveLength(1);
      expect(f.session.facts("memory.topic_organization_settled")).toHaveLength(
        1,
      );
      f.session.validate();
    });
  }

  test("an interrupted extractor is closed on resume without a hidden model retry", async () => {
    const f = fixture("extract");
    await expect(
      createMemoryMaintenanceControllerV1(f.options).settleTerminal(
        "completed",
      ),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(f.session.facts("memory.write_claimed")).toHaveLength(1);
    expect(f.session.facts("memory.candidate_staged")).toHaveLength(0);
    expect(
      await createMemoryMaintenanceControllerV1(f.options).settleTerminal(
        "completed",
      ),
    ).toMatchObject({
      status: "interrupted",
      reasonCode: "memory_write_claim_interrupted_before_stage",
    });
    f.gate.resolve();
    await delay(5);
    expect(f.calls.filter((call) => call === "extract")).toHaveLength(1);
    expect(f.calls).not.toContain("apply");
    f.session.validate();
  });

  test("rechecks source admission before applying a staged candidate", async () => {
    const f = fixture();
    const options = {
      ...f.options,
      writer: {
        ...f.options.writer,
        sourceAdmission: () =>
          f.session.facts("memory.candidate_staged").length
            ? new Set<number>()
            : new Set([2]),
      },
    };
    expect(
      await createMemoryMaintenanceControllerV1(options).settleTerminal(
        "completed",
      ),
    ).toMatchObject({ status: "failed" });
    expect(f.calls).not.toContain("apply");
    f.session.validate();
  });

  test("a conflict resolver ignoring abort cannot fall back to applying unchecked atoms", async () => {
    const f = fixture();
    const gate = deferred();
    let resolverCalls = 0;
    const options: MemoryMaintenanceOptionsV1 = {
      ...f.options,
      writer: {
        ...f.options.writer,
        store: {
          ...f.options.writer.store,
          async recall() {
            return [
              {
                id: "existing",
                kind: "profile",
                statement: "Use English",
                source: "user_statement",
                confidence: 0.9,
              },
            ];
          },
        },
        conflictResolver: {
          resolverVersion: "resolver",
          async resolve() {
            resolverCalls++;
            await gate.promise;
            return {
              resolverVersion: "resolver",
              resolutionRevision: "revision",
              decisions: [],
            };
          },
        },
      },
    };
    await expect(
      createMemoryMaintenanceControllerV1(options).settleTerminal("completed"),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    gate.resolve();
    await delay(5);
    expect(resolverCalls).toBe(1);
    expect(f.calls).not.toContain("apply");
    expect(f.session.facts("memory.candidate_staged")).toHaveLength(0);
    f.session.validate();
  });

  test("cancelling a running provider returns promptly and fences late stage writes", async () => {
    const f = fixture("extract");
    const pending = createMemoryMaintenanceControllerV1({
      ...f.options,
      timeoutMs: 10_000,
    }).settleTerminal("completed");
    const settled = pending.then(
      () => undefined,
      (error: unknown) => error,
    );
    await f.entered.promise;
    f.abort.abort(new DOMException("cancel", "AbortError"));
    expect(await settled).toMatchObject({ name: "AbortError" });
    f.gate.resolve();
    await delay(5);
    expect(f.calls).not.toContain("apply");
    expect(f.session.facts("memory.candidate_staged")).toHaveLength(0);
    expect(f.events.at(-1)?.reasonCode).toBe("MemoryMaintenanceCancelled");
  });
});
