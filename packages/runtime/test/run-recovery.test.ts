import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  SessionInputSnapshot,
  VerifiedModelResponseEvidenceV1,
} from "@paw/agent-loop";
import {
  type DurableJsonPayloadV1,
  type InputFactV1,
  type ModelResponseV1,
  RUN_JOURNAL_SCHEMA_VERSION_V1,
  type RunJournalEnvelopeV1,
  parseRunJournalPrefixV1,
} from "@paw/protocol";
import {
  EMPTY_RUN_JOURNAL_PREFIX_HASH_V1,
  FileRunSessionV1,
  type FileSessionExecutionLeaseV1,
  SessionExecutionLeaseLostError,
  acquireFileSessionExecutionLeaseV1,
  classifyRunRecoveryV1,
  readFileSessionJournalCommitIndexV1,
  releaseFileSessionExecutionLeaseV1,
  repairRunRecoveryV1,
} from "../src/index.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("canonical run recovery", () => {
  test("R1 settles an in-flight model dispatch as unknown with the same identity and invokes no external port", () => {
    const plan = classifyRunRecoveryV1(
      prefix([
        {
          type: "model.dispatch_recorded",
          modelCallId: "model-original",
          turn: 7,
          requestHash: "request-hash",
        },
      ]),
    );

    expect(plan.status).toBe("repair");
    if (plan.status !== "repair") throw new Error("expected repair plan");
    expect(plan.facts).toEqual([
      expect.objectContaining({
        type: "model.settled",
        modelCallId: "model-original",
        turn: 7,
        status: "unknown",
        hasToolCalls: false,
        hasVisibleOutput: false,
      }),
    ]);
    // The classifier signature accepts only a prefix: Model and ToolExecutor
    // cannot accidentally be reached by recovery.
  });

  test("R2 classifies every unsettled tool from canonical dispatch and permission evidence", () => {
    const cases: readonly {
      readonly name: string;
      readonly tail: readonly InputFactV1[];
      readonly status: "cancelled" | "rejected" | "unknown";
    }[] = [
      {
        name: "observed but not dispatched",
        tail: [],
        status: "cancelled",
      },
      {
        name: "permission denied",
        tail: [dispatchFact(0), permissionFact(0, "deny")],
        status: "rejected",
      },
      {
        name: "dispatch and allow",
        tail: [dispatchFact(0), permissionFact(0, "allow_once")],
        status: "unknown",
      },
      {
        name: "dispatch without permission",
        tail: [dispatchFact(0)],
        status: "cancelled",
      },
    ];

    for (const item of cases) {
      const plan = classifyRunRecoveryV1(
        prefix([...toolModelFacts(1), ...item.tail]),
      );
      expect(plan.status, item.name).toBe("repair");
      if (plan.status !== "repair") throw new Error("expected repair plan");
      expect(plan.facts, item.name).toHaveLength(1);
      expect(plan.facts[0], item.name).toMatchObject({
        type: "tool.settled",
        callId: "call-0",
        status: item.status,
        observation: { isError: true },
      });
    }
  });

  test("R3 repairs only missing parallel settlements in provider source order", () => {
    const facts = [
      ...toolModelFacts(4),
      ...[0, 1, 2, 3].map(dispatchFact),
      ...[0, 1, 2, 3].map((index) => permissionFact(index, "allow_once")),
      completedToolFact(1),
      completedToolFact(3),
    ];
    const plan = classifyRunRecoveryV1(prefix(facts));

    expect(plan.status).toBe("repair");
    if (plan.status !== "repair") throw new Error("expected repair plan");
    expect(plan.facts.map((fact) => fact.type)).toEqual([
      "tool.settled",
      "tool.settled",
    ]);
    expect(
      plan.facts.map((fact) =>
        fact.type === "tool.settled" ? [fact.callId, fact.status] : [],
      ),
    ).toEqual([
      ["call-0", "unknown"],
      ["call-2", "unknown"],
    ]);
  });

  test("repairs every permission frontier from an artifact-backed model response", () => {
    const cases: readonly {
      readonly name: string;
      readonly tail: readonly InputFactV1[];
      readonly status: "cancelled" | "rejected" | "unknown";
    }[] = [
      { name: "observed", tail: [], status: "cancelled" },
      {
        name: "denied",
        tail: [dispatchFact(0), permissionFact(0, "deny")],
        status: "rejected",
      },
      {
        name: "allowed",
        tail: [dispatchFact(0), permissionFact(0, "allow_once")],
        status: "unknown",
      },
      {
        name: "dispatched without permission",
        tail: [dispatchFact(0)],
        status: "cancelled",
      },
    ];

    for (const item of cases) {
      const canonical = prefix([...artifactToolModelFacts(1), ...item.tail]);
      const plan = classifyRunRecoveryV1(canonical, {
        modelResponses: exactRecoveryEvidence(
          canonical,
          modelResponse([providerCall(0)]),
        ),
      });

      expect(plan.status, item.name).toBe("repair");
      if (plan.status !== "repair") throw new Error("expected repair plan");
      expect(plan.facts, item.name).toEqual([
        expect.objectContaining({
          type: "tool.settled",
          callId: "call-0",
          status: item.status,
        }),
      ]);
    }
  });

  test("repairs a partial artifact-backed parallel batch in source order", () => {
    const canonical = prefix([
      ...artifactToolModelFacts(4),
      ...[0, 1, 2, 3].map(dispatchFact),
      ...[0, 1, 2, 3].map((index) => permissionFact(index, "allow_once")),
      completedToolFact(1),
      completedToolFact(3),
    ]);
    const plan = classifyRunRecoveryV1(canonical, {
      modelResponses: exactRecoveryEvidence(
        canonical,
        modelResponse(
          Array.from({ length: 4 }, (_, index) => providerCall(index)),
        ),
      ),
    });

    expect(plan.status).toBe("repair");
    if (plan.status !== "repair") throw new Error("expected repair plan");
    expect(
      plan.facts.map((fact) =>
        fact.type === "tool.settled" ? [fact.callId, fact.status] : [],
      ),
    ).toEqual([
      ["call-0", "unknown"],
      ["call-2", "unknown"],
    ]);
  });

  test("rejects stale snapshot, carrier, or payload evidence before repair commit", async () => {
    const canonical = prefix([
      ...artifactToolModelFacts(1),
      dispatchFact(0),
      permissionFact(0, "allow_once"),
    ]);
    const response = modelResponse([providerCall(0)]);
    const drifts = ["snapshot", "carrier", "payload"] as const;

    for (const drift of drifts) {
      let commitCalls = 0;
      const evidence = exactRecoveryEvidence(canonical, response, {
        carrierSeq: drift === "carrier" ? 99 : undefined,
        payload:
          drift === "payload"
            ? {
                kind: "artifact_ref",
                artifactRef: "model-response/other",
                hash: "other-hash",
              }
            : undefined,
      });
      await expect(
        repairRunRecoveryV1({
          session: {
            async readCanonicalPrefix() {
              return canonical;
            },
            async commitInputFacts() {
              commitCalls += 1;
              return "committed" as const;
            },
          },
          loadModelResponseEvidence() {
            return drift === "snapshot"
              ? {
                  ...evidence,
                  assertSnapshot() {
                    throw new Error("stale prefix and tail evidence");
                  },
                }
              : evidence;
          },
        }),
      ).rejects.toThrow();
      expect(commitCalls, drift).toBe(0);
    }
  });

  test("drops stale evidence and rebuilds it after a repair CAS conflict", async () => {
    let current = prefix([
      ...artifactToolModelFacts(1),
      dispatchFact(0),
      permissionFact(0, "allow_once"),
    ]);
    let firstCommit = true;
    const loadedTails: number[] = [];
    const successfulBatches: InputFactV1[][] = [];

    const result = await repairRunRecoveryV1({
      session: {
        async readCanonicalPrefix() {
          return current;
        },
        async commitInputFacts(expectedTailSeq, facts) {
          if (firstCommit) {
            firstCommit = false;
            current = parseRunJournalPrefixV1([
              ...current,
              envelope(
                {
                  type: "runtime.failed",
                  area: "runtime",
                  errorCode: "ConcurrentAudit",
                  message: "won the first repair CAS",
                  retryable: true,
                },
                current.length + 1,
              ),
            ]);
            return "conflict";
          }
          expect(expectedTailSeq).toBe(current.length);
          successfulBatches.push([...facts]);
          current = parseRunJournalPrefixV1([
            ...current,
            ...facts.map((fact, index) =>
              envelope(fact, expectedTailSeq + index + 1),
            ),
          ]);
          return "committed";
        },
      },
      loadModelResponseEvidence(canonical) {
        loadedTails.push(canonical.length);
        return exactRecoveryEvidence(
          canonical,
          modelResponse([providerCall(0)]),
        );
      },
    });

    expect(result.status).toBe("repaired");
    expect(loadedTails).toEqual([5, 6]);
    expect(successfulBatches).toHaveLength(1);
    expect(successfulBatches[0]).toEqual([
      expect.objectContaining({
        type: "tool.settled",
        callId: "call-0",
        status: "unknown",
      }),
    ]);
  });

  test("R4 rejects corrupt identity, order, and ghost settlement without committing", async () => {
    const corruptPrefixes = [
      prefixUnchecked([...modelFacts(1), observedFact(1, { order: 1 })]),
      prefixUnchecked([
        {
          type: "tool.settled",
          callId: "ghost",
          status: "rejected",
        },
      ]),
      prefixUnchecked([
        ...toolModelFacts(1),
        dispatchFact(0),
        permissionFact(0, "allow_once", { tool: "wrong-tool" }),
      ]),
    ];

    for (const corrupt of corruptPrefixes) {
      let commitCalls = 0;
      await expect(
        repairRunRecoveryV1({
          session: {
            async readCanonicalPrefix() {
              return corrupt;
            },
            async commitInputFacts() {
              commitCalls += 1;
              return "committed" as const;
            },
          },
        }),
      ).rejects.toThrow();
      expect(commitCalls).toBe(0);
    }
  });

  test("fails closed when a protocol-valid model response declares an unobserved native call", async () => {
    const canonical = prefix([
      ...modelFactsWithResponseCalls([providerCall(0), providerCall(1)]),
      observedFact(0),
    ]);
    let commitCalls = 0;

    await expect(
      repairRunRecoveryV1({
        session: {
          async readCanonicalPrefix() {
            return canonical;
          },
          async commitInputFacts() {
            commitCalls += 1;
            return "committed" as const;
          },
        },
      }),
    ).rejects.toThrow();
    expect(commitCalls).toBe(0);
  });

  test("fails closed on an unresolved artifact-backed model response instead of guessing tool identity", async () => {
    const [dispatch, settled] = modelFacts(1);
    if (!settled || settled.type !== "model.settled") {
      throw new Error("expected model settlement fixture");
    }
    const canonical = prefix([
      dispatch as InputFactV1,
      {
        ...settled,
        response: {
          kind: "artifact_ref",
          artifactRef: "model-response/artifact-1",
          hash: "response-hash",
        },
      },
      observedFact(0),
    ]);
    let commitCalls = 0;

    await expect(
      repairRunRecoveryV1({
        session: {
          async readCanonicalPrefix() {
            return canonical;
          },
          async commitInputFacts() {
            commitCalls += 1;
            return "committed" as const;
          },
        },
      }),
    ).rejects.toThrow();
    expect(commitCalls).toBe(0);
  });

  test("keeps a fully settled artifact-backed history and repairs only the later in-flight model", () => {
    const [dispatch, settled] = modelFacts(1);
    if (!dispatch || !settled || settled.type !== "model.settled") {
      throw new Error("expected complete model fixture");
    }
    const canonical = prefix([
      dispatch,
      {
        ...settled,
        response: {
          kind: "artifact_ref",
          artifactRef: "model-response/settled-history",
          hash: "settled-response-hash",
        },
      },
      observedFact(0),
      dispatchFact(0),
      permissionFact(0, "allow_once"),
      completedToolFact(0),
      {
        type: "model.dispatch_recorded",
        modelCallId: "model-2",
        turn: 2,
        requestHash: "request-2",
      },
    ]);

    const plan = classifyRunRecoveryV1(canonical);
    expect(plan.status).toBe("repair");
    if (plan.status !== "repair") throw new Error("expected repair plan");
    expect(plan.facts).toEqual([
      expect.objectContaining({
        type: "model.settled",
        modelCallId: "model-2",
        turn: 2,
        status: "unknown",
      }),
    ]);
  });

  test("treats the canonical invalid-tool response plus runtime failure as clean with zero repair commit", async () => {
    const invalidCall = providerCall(0, {
      rawArguments: "not-json",
      args: {},
      argumentsValid: false,
    });
    const canonical = prefix([
      ...modelFactsWithResponseCalls([invalidCall]),
      invalidToolRuntimeFailure(),
    ]);
    const classification = classifyRunRecoveryV1(canonical);
    expect(classification).toEqual({
      status: "clean",
      expectedTailSeq: canonical.length,
    });
    let commitCalls = 0;

    const result = await repairRunRecoveryV1({
      session: {
        async readCanonicalPrefix() {
          return canonical;
        },
        async commitInputFacts() {
          commitCalls += 1;
          return "committed" as const;
        },
      },
    });

    expect(result.status).toBe("clean");
    expect(result.repairedFacts).toHaveLength(0);
    expect(commitCalls).toBe(0);
  });

  test("fails closed if an invalid native call is nevertheless forged into observed tool lifecycle", async () => {
    const canonical = prefix([
      ...modelFactsWithResponseCalls([
        providerCall(0, {
          rawArguments: "not-json",
          args: {},
          argumentsValid: false,
        }),
      ]),
      observedFact(0, { args: {} }),
      invalidToolRuntimeFailure(),
    ]);
    let commitCalls = 0;

    await expect(
      repairRunRecoveryV1({
        session: {
          async readCanonicalPrefix() {
            return canonical;
          },
          async commitInputFacts() {
            commitCalls += 1;
            return "committed" as const;
          },
        },
      }),
    ).rejects.toThrow();
    expect(commitCalls).toBe(0);
  });

  test("fails closed on every protocol-valid observed-call drift from the durable model response", async () => {
    const cases: readonly {
      readonly name: string;
      readonly responseCalls: readonly ProviderToolCall[];
      readonly observed: readonly Extract<
        InputFactV1,
        { type: "tool.call_observed" }
      >[];
    }[] = [
      {
        name: "callId",
        responseCalls: [providerCall(0, { callId: "provider-call" })],
        observed: [observedFact(0)],
      },
      {
        name: "name",
        responseCalls: [providerCall(0, { name: "shell" })],
        observed: [observedFact(0)],
      },
      {
        name: "sourceIndex",
        responseCalls: [providerCall(0), providerCall(1)],
        observed: [
          observedFact(1, { order: 0 }),
          observedFact(0, { order: 1 }),
        ],
      },
      {
        name: "args",
        responseCalls: [providerCall(0, { path: "provider-path" })],
        observed: [observedFact(0)],
      },
      {
        name: "argumentsValid",
        responseCalls: [
          providerCall(0, {
            rawArguments: "not-json",
            args: {},
            argumentsValid: false,
          }),
        ],
        observed: [observedFact(0, { args: {} })],
      },
    ];

    for (const item of cases) {
      const canonical = prefix([
        ...modelFactsWithResponseCalls(item.responseCalls),
        ...item.observed,
      ]);
      let commitCalls = 0;
      await expect(
        repairRunRecoveryV1({
          session: {
            async readCanonicalPrefix() {
              return canonical;
            },
            async commitInputFacts() {
              commitCalls += 1;
              return "committed" as const;
            },
          },
        }),
      ).rejects.toThrow();
      expect(commitCalls, item.name).toBe(0);
    }
  });

  test("fails closed when a later model dispatch overlaps an unsettled prior tool batch", async () => {
    const canonical = prefix([
      ...toolModelFacts(1),
      dispatchFact(0),
      permissionFact(0, "allow_once"),
      {
        type: "model.dispatch_recorded",
        modelCallId: "model-2",
        turn: 2,
        requestHash: "request-2",
      },
    ]);
    let commitCalls = 0;

    await expect(
      repairRunRecoveryV1({
        session: {
          async readCanonicalPrefix() {
            return canonical;
          },
          async commitInputFacts() {
            commitCalls += 1;
            return "committed" as const;
          },
        },
      }),
    ).rejects.toThrow();
    expect(commitCalls).toBe(0);
  });

  test("R5 lets two repair workers race from one tail but commits only one batch", async () => {
    const session = new MemoryRecoverySession(
      prefix([...toolModelFacts(1)]),
      2,
    );

    const results = await Promise.all([
      repairRunRecoveryV1({ session }),
      repairRunRecoveryV1({ session }),
    ]);

    expect(results.map(({ status }) => status).sort()).toEqual([
      "clean",
      "repaired",
    ]);
    expect(session.committedBatches).toHaveLength(1);
    expect(session.committedBatches[0]).toHaveLength(1);
    expect(
      session.currentPrefix.filter(
        (entry) =>
          entry.record.kind === "input_fact" &&
          entry.record.fact.type === "tool.settled",
      ),
    ).toHaveLength(1);
  });

  test("R6 does not duplicate a repair committed before the process crashes", async () => {
    const root = tempRoot();
    let crashAfterRepairCommit = false;
    const firstLease = acquire(root, "owner-a", 0, 100);
    const first = new FileRunSessionV1({
      workspaceRoot: root,
      sessionId: "session",
      runId: "run",
      executionLease: firstLease,
      clock: () => 0,
      commitHooks: {
        afterJournalLinearized() {
          if (crashAfterRepairCommit) throw new Error("simulated crash");
        },
      },
    });
    await first.appendInputFacts([
      {
        type: "model.dispatch_recorded",
        modelCallId: "model-crashed",
        turn: 1,
        requestHash: "request-hash",
      },
    ]);
    crashAfterRepairCommit = true;

    await expect(repairRunRecoveryV1({ session: first })).rejects.toThrow(
      "simulated crash",
    );
    expect(
      await releaseFileSessionExecutionLeaseV1(
        firstLease,
        root,
        "session",
        "run",
      ),
    ).toBe("released");

    const committedHead = readFileSessionJournalCommitIndexV1({
      workspaceRoot: root,
      sessionId: "session",
      runId: "run",
    }).head;
    const secondLease = acquire(root, "owner-b", 0, 100, committedHead);
    const reopened = new FileRunSessionV1({
      workspaceRoot: root,
      sessionId: "session",
      runId: "run",
      executionLease: secondLease,
      clock: () => 0,
    });

    const result = await repairRunRecoveryV1({ session: reopened });
    expect(result.status).toBe("clean");
    expect(result.repairedFacts).toHaveLength(0);
    const canonical = await reopened.readCanonicalPrefix();
    expect(
      canonical.filter(
        (entry) =>
          entry.record.kind === "input_fact" &&
          entry.record.fact.type === "model.settled",
      ),
    ).toHaveLength(1);
    reopened.close();
    await releaseFileSessionExecutionLeaseV1(
      secondLease,
      root,
      "session",
      "run",
    );
  });

  test("R7 loses the fence during repair without making the orphan artifact authoritative", async () => {
    const root = tempRoot();
    let now = 0;
    let armTakeover = false;
    let successor: FileSessionExecutionLeaseV1 | undefined;
    const firstLease = acquire(root, "owner-a", now, 50);
    const first = new FileRunSessionV1({
      workspaceRoot: root,
      sessionId: "session",
      runId: "run",
      executionLease: firstLease,
      clock: () => now,
      commitHooks: {
        afterArtifactPublished() {
          if (!armTakeover) return;
          now = 50;
          const head = readFileSessionJournalCommitIndexV1({
            workspaceRoot: root,
            sessionId: "session",
            runId: "run",
          }).head;
          successor = acquire(root, "owner-b", now, 50, head);
        },
      },
    });
    await first.appendInputFacts([
      {
        type: "model.dispatch_recorded",
        modelCallId: "model-lost-fence",
        turn: 1,
        requestHash: "request-hash",
      },
    ]);
    armTakeover = true;

    await expect(
      repairRunRecoveryV1({ session: first }),
    ).rejects.toBeInstanceOf(SessionExecutionLeaseLostError);
    const index = readFileSessionJournalCommitIndexV1({
      workspaceRoot: root,
      sessionId: "session",
      runId: "run",
    });
    expect(index.commits).toHaveLength(1);
    expect(index.head.tailSeq).toBe(1);
    if (!successor) throw new Error("successor did not acquire the lease");
    await releaseFileSessionExecutionLeaseV1(successor, root, "session", "run");
  });
});

class MemoryRecoverySession {
  currentPrefix: readonly RunJournalEnvelopeV1[];
  readonly committedBatches: InputFactV1[][] = [];
  private readonly initialReadBarrier: ReturnType<typeof deferred<void>>;
  private initialReads = 0;

  constructor(
    initialPrefix: readonly RunJournalEnvelopeV1[],
    private readonly synchronizedInitialReaders = 0,
  ) {
    this.currentPrefix = initialPrefix;
    this.initialReadBarrier = deferred<void>();
    if (synchronizedInitialReaders === 0) this.initialReadBarrier.resolve();
  }

  async readCanonicalPrefix(): Promise<readonly RunJournalEnvelopeV1[]> {
    if (this.initialReads < this.synchronizedInitialReaders) {
      this.initialReads += 1;
      const snapshot = this.currentPrefix;
      if (this.initialReads === this.synchronizedInitialReaders) {
        this.initialReadBarrier.resolve();
      }
      await this.initialReadBarrier.promise;
      return snapshot;
    }
    return this.currentPrefix;
  }

  async commitInputFacts(
    expectedTailSeq: number,
    facts: readonly InputFactV1[],
  ): Promise<"committed" | "conflict"> {
    if ((this.currentPrefix.at(-1)?.seq ?? 0) !== expectedTailSeq) {
      return "conflict";
    }
    const next = facts.map((fact, index) =>
      envelope(fact, expectedTailSeq + index + 1),
    );
    this.currentPrefix = parseRunJournalPrefixV1([
      ...this.currentPrefix,
      ...next,
    ]);
    this.committedBatches.push([...facts]);
    return "committed";
  }
}

function toolModelFacts(callCount: number): InputFactV1[] {
  return [
    ...modelFacts(callCount),
    ...Array.from({ length: callCount }, (_, index) => observedFact(index)),
  ];
}

function artifactToolModelFacts(callCount: number): InputFactV1[] {
  const facts = toolModelFacts(callCount);
  const settled = facts[1];
  if (!settled || settled.type !== "model.settled") {
    throw new Error("expected model settlement fixture");
  }
  facts[1] = {
    ...settled,
    response: {
      kind: "artifact_ref",
      artifactRef: `model-response/artifact-${callCount}`,
      hash: `artifact-hash-${callCount}`,
    },
  };
  return facts;
}

function modelFacts(callCount: number): InputFactV1[] {
  return modelFactsWithResponseCalls(
    Array.from({ length: callCount }, (_, index) => providerCall(index)),
  );
}

interface ProviderToolCall {
  readonly callId: string;
  readonly name: string;
  readonly rawArguments: string;
  readonly args: Readonly<Record<string, import("@paw/protocol").JsonValue>>;
  readonly sourceIndex: number;
  readonly argumentsValid: boolean;
}

function providerCall(
  index: number,
  overrides: Partial<ProviderToolCall> & { readonly path?: string } = {},
): ProviderToolCall {
  const pathValue = overrides.path ?? `file-${index}`;
  const { path: _path, ...callOverrides } = overrides;
  return {
    callId: `call-${index}`,
    name: "read_file",
    rawArguments: JSON.stringify({ path: pathValue }),
    args: { path: pathValue },
    sourceIndex: index,
    argumentsValid: true,
    ...callOverrides,
  };
}

function modelFactsWithResponseCalls(
  calls: readonly ProviderToolCall[],
): InputFactV1[] {
  return [
    {
      type: "model.dispatch_recorded",
      modelCallId: "model-1",
      turn: 1,
      requestHash: "request-hash",
    },
    {
      type: "model.settled",
      modelCallId: "model-1",
      turn: 1,
      status: "completed",
      hasToolCalls: calls.length > 0,
      hasVisibleOutput: false,
      response: {
        kind: "inline",
        value: {
          schemaVersion: "paw.model-response.v1",
          providerProtocol: "openai-compatible",
          assistantContent: "",
          finishReason: calls.length > 0 ? "tool_calls" : "stop",
          toolCalls: calls.map((call) => ({ ...call })),
        },
        hash: "response-hash",
      },
    },
  ];
}

function modelResponse(calls: readonly ProviderToolCall[]): ModelResponseV1 {
  return {
    schemaVersion: "paw.model-response.v1",
    providerProtocol: "openai-compatible",
    assistantContent: "",
    finishReason: calls.length > 0 ? "tool_calls" : "stop",
    toolCalls: calls.map((call) => ({ ...call })),
  };
}

function exactRecoveryEvidence(
  canonical: readonly RunJournalEnvelopeV1[],
  response: ModelResponseV1,
  overrides: {
    readonly carrierSeq?: number;
    readonly payload?: DurableJsonPayloadV1;
  } = {},
): VerifiedModelResponseEvidenceV1 {
  const snapshot = recoverySnapshot(canonical);
  const settlementEnvelope = canonical.find(
    (entry) =>
      entry.record.kind === "input_fact" &&
      entry.record.fact.type === "model.settled",
  );
  if (
    !settlementEnvelope ||
    settlementEnvelope.record.kind !== "input_fact" ||
    settlementEnvelope.record.fact.type !== "model.settled" ||
    !settlementEnvelope.record.fact.response
  ) {
    throw new Error("expected durable model settlement fixture");
  }
  const expectedSnapshot = stableTestJson(snapshot);
  const expectedCarrier = overrides.carrierSeq ?? settlementEnvelope.seq;
  const expectedPayload = JSON.stringify(
    overrides.payload ?? settlementEnvelope.record.fact.response,
  );
  return {
    assertSnapshot(actual) {
      if (stableTestJson(actual) !== expectedSnapshot) {
        throw new Error("verified recovery snapshot mismatch");
      }
    },
    requireModelResponse(input) {
      this.assertSnapshot(input.snapshot);
      if (
        input.carrierSeq !== expectedCarrier ||
        input.modelCallId !== "model-1" ||
        JSON.stringify(input.payload) !== expectedPayload
      ) {
        throw new Error("verified recovery carrier mismatch");
      }
      return response;
    },
  };
}

function recoverySnapshot(
  canonical: readonly RunJournalEnvelopeV1[],
): SessionInputSnapshot<InputFactV1> {
  const entries = canonical.flatMap((entry) =>
    entry.record.kind === "input_fact"
      ? [{ seq: entry.seq, fact: entry.record.fact }]
      : [],
  );
  return {
    entries,
    tailSeq: canonical.at(-1)?.seq ?? 0,
    latestInputSeq: entries.at(-1)?.seq ?? 0,
  };
}

function stableTestJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableTestJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableTestJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function observedFact(
  index: number,
  overrides: Partial<Extract<InputFactV1, { type: "tool.call_observed" }>> = {},
): Extract<InputFactV1, { type: "tool.call_observed" }> {
  return {
    type: "tool.call_observed",
    callId: `call-${index}`,
    modelCallId: "model-1",
    turn: 1,
    tool: "read_file",
    args: { path: `file-${index}` },
    order: index,
    ...overrides,
  };
}

function dispatchFact(
  index: number,
): Extract<InputFactV1, { type: "tool.dispatch_recorded" }> {
  return {
    type: "tool.dispatch_recorded",
    callId: `call-${index}`,
    turn: 1,
    sourceIndex: index,
    batchId: "batch-1",
    mode: "parallel",
  };
}

function permissionFact(
  index: number,
  resolution: "allow_once" | "deny",
  overrides: Partial<
    Extract<InputFactV1, { type: "tool.permission_resolved" }>
  > = {},
): Extract<InputFactV1, { type: "tool.permission_resolved" }> {
  return {
    type: "tool.permission_resolved",
    turn: 1,
    sourceIndex: index,
    callId: `call-${index}`,
    tool: "read_file",
    policyVersion: "permission-v1",
    resolution,
    source: resolution === "deny" ? "user_prompt" : "base_policy",
    ...overrides,
  };
}

function completedToolFact(
  index: number,
): Extract<InputFactV1, { type: "tool.settled" }> {
  return {
    type: "tool.settled",
    callId: `call-${index}`,
    status: "completed",
    result: { ok: true },
  };
}

function invalidToolRuntimeFailure(): Extract<
  InputFactV1,
  { type: "runtime.failed" }
> {
  return {
    type: "runtime.failed",
    area: "runtime",
    errorCode: "InvalidToolCall",
    message: "Model returned an invalid native tool call",
    retryable: false,
  };
}

function prefix(
  facts: readonly InputFactV1[],
): readonly RunJournalEnvelopeV1[] {
  return parseRunJournalPrefixV1(
    facts.map((fact, index) => envelope(fact, index + 1)),
  );
}

function prefixUnchecked(
  facts: readonly InputFactV1[],
): readonly RunJournalEnvelopeV1[] {
  return facts.map((fact, index) => envelope(fact, index + 1));
}

function envelope(fact: InputFactV1, seq: number): RunJournalEnvelopeV1 {
  return {
    schemaVersion: RUN_JOURNAL_SCHEMA_VERSION_V1,
    sessionId: "session",
    runId: "run",
    seq,
    ts: seq,
    record: { kind: "input_fact", fact },
  };
}

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paw-run-recovery-"));
  roots.push(root);
  return root;
}

function acquire(
  root: string,
  ownerId: string,
  now: number,
  ttlMs: number,
  base = { tailSeq: 0, prefixHash: EMPTY_RUN_JOURNAL_PREFIX_HASH_V1 },
): FileSessionExecutionLeaseV1 {
  const result = acquireFileSessionExecutionLeaseV1({
    workspaceRoot: root,
    sessionId: "session",
    runId: "run",
    ownerId,
    ttlMs,
    baseTailSeq: base.tailSeq,
    basePrefixHash: base.prefixHash,
    clock: () => now,
  });
  if (result.status !== "acquired") {
    throw new Error(`expected acquired lease, got ${result.status}`);
  }
  return result.lease;
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}
