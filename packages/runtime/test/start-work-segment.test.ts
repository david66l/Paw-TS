import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";
import {
  type ControlDecision,
  INTERACTIVE_CONTROL_REDUCER_VERSION_V2,
  type InteractiveControlConfigV2,
  type VerifiedModelResponseEvidenceV1,
  createInteractiveControlReducerV2,
} from "@paw/agent-loop";
import {
  type ControlDecisionActionV1,
  type DerivedDecisionV1,
  type InputAcceptedFactV1,
  type InputFactV1,
  RUN_JOURNAL_SCHEMA_VERSION_V1,
  type RunJournalEnvelopeV1,
  parseRunJournalPrefixV1,
} from "@paw/protocol";
import {
  DEFAULT_FILE_DURABLE_JSON_PAYLOAD_POLICY_V1,
  EMPTY_RUN_JOURNAL_PREFIX_HASH_V1,
  FileRunSessionV1,
  type LocationAwarePayloadMaterializerV1,
  SessionExecutionLeaseLostError,
  VERIFIED_CANONICAL_PAYLOAD_BUDGET_POLICY_VERSION_V1,
  type WorkSegmentStartSessionV1,
  acquireFileSessionExecutionLeaseV1,
  buildVerifiedCanonicalPayloadIndexV1,
  createFileDurableJsonPayloadWriterV1,
  createInputPromotionFactV1,
  createLocationAwarePayloadSessionV1,
  createVerifiedCanonicalPayloadEvidenceV1,
  projectCanonicalDurableJsonPayloadBindingsV1,
  readFileSessionAuthorityInventoryV1,
  startWorkSegmentV1,
} from "@paw/runtime";

const config: InteractiveControlConfigV2 = {
  mode: "interactive",
  maxModelTurns: 4,
  naturalStop: "complete",
  maxSegments: 4,
  maxTotalModelTurns: 12,
};
const signal = new AbortController().signal;
const roots: string[] = [];
const payloadBudget = Object.freeze({
  policyVersion: VERIFIED_CANONICAL_PAYLOAD_BUDGET_POLICY_VERSION_V1,
  maxTotalBytes: 1_000_000,
});

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("start work segment memory transaction", () => {
  test("uses the two-fact CAS path when the eligible decision is already the tail", async () => {
    const session = new MemoryWorkSegmentSession(
      prefixWithDecisionTail([accepted("queue-1")]),
    );
    const result = await start(session, "queue-1");

    expect(result).toEqual({
      status: "started",
      inputId: "queue-1",
      segmentIndex: 1,
    });
    expect(session.inputCommits).toHaveLength(1);
    expect(session.decisionAndInputCommits).toHaveLength(0);
    expect(session.inputCommits[0]?.facts.map((fact) => fact.type)).toEqual([
      "work.segment_started",
      "input.promoted",
    ]);
  });

  test("atomically commits decision+marker+promotion when accepted is the tail", async () => {
    const session = new MemoryWorkSegmentSession(
      prefixWithAcceptedTail("queue-1"),
    );
    await start(session, "queue-1");

    expect(session.inputCommits).toHaveLength(0);
    expect(session.decisionAndInputCommits).toHaveLength(1);
    expect(session.prefix.slice(-3).map(recordType)).toEqual([
      "control.decided",
      "work.segment_started",
      "input.promoted",
    ]);
  });

  test("is idempotent for the same input and never opens a second segment", async () => {
    const session = new MemoryWorkSegmentSession(
      prefixWithDecisionTail([accepted("queue-1")]),
    );
    expect(await start(session, "queue-1")).toMatchObject({
      status: "started",
      segmentIndex: 1,
    });
    expect(await start(session, "queue-1")).toEqual({
      status: "already_started",
      inputId: "queue-1",
      segmentIndex: 1,
    });
    expect(countFact(session.prefix, "work.segment_started")).toBe(1);
  });

  test("lets two same-input starters linearize to started then already_started", async () => {
    const session = new MemoryWorkSegmentSession(
      prefixWithDecisionTail([accepted("queue-1")]),
    );
    const results = await Promise.all([
      start(session, "queue-1"),
      start(session, "queue-1"),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual([
      "already_started",
      "started",
    ]);
    expect(countFact(session.prefix, "work.segment_started")).toBe(1);
  });

  test("revalidates the current prefix before returning already_started", async () => {
    const session = new MemoryWorkSegmentSession(
      prefixWithDecisionTail([accepted("queue-1")]),
    );
    await start(session, "queue-1");
    const commitCount = session.inputCommits.length;
    const failure = new Error("current artifact evidence failed");

    await expect(
      startWorkSegmentV1({
        session,
        inputId: "queue-1",
        verification: verification(),
        preflight: () => {
          throw failure;
        },
        signal,
      }),
    ).rejects.toBe(failure);
    expect(session.inputCommits).toHaveLength(commitCount);

    const controller = new AbortController();
    const abortReason = new Error("abort inside current evidence");
    await expect(
      startWorkSegmentV1({
        session,
        inputId: "queue-1",
        verification: verification(),
        preflight: () => evidenceThatAborts(controller, abortReason),
        signal: controller.signal,
      }),
    ).rejects.toBe(abortReason);
    expect(session.inputCommits).toHaveLength(commitCount);
  });

  test("rereads after a CAS conflict but remains bound to the requested inputId", async () => {
    const session = new MemoryWorkSegmentSession(
      prefixWithDecisionTail([accepted("queue-1")]),
    );
    let injected = false;
    session.beforeInputCommit = () => {
      if (injected) return;
      injected = true;
      session.appendExternalFacts([accepted("queue-2")]);
    };

    expect(await start(session, "queue-1")).toMatchObject({
      status: "started",
    });
    const markers = facts(session.prefix).filter(
      (fact) => fact.type === "work.segment_started",
    );
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ inputId: "queue-1" });
    expect(session.inputCommits).toHaveLength(1);
    expect(session.decisionAndInputCommits).toHaveLength(1);
  });

  test("fails closed after a conflicting abort and writes no marker", async () => {
    const session = new MemoryWorkSegmentSession(
      prefixWithDecisionTail([accepted("queue-1")]),
    );
    session.beforeInputCommit = () => {
      session.beforeInputCommit = undefined;
      session.appendExternalFacts([
        { type: "abort.requested", source: "user", reason: "stop" },
      ]);
    };

    await expect(start(session, "queue-1")).rejects.toThrow(
      /completed, await_user, or crash-recovered incomplete/i,
    );
    expect(countFact(session.prefix, "work.segment_started")).toBe(0);
    expect(countFact(session.prefix, "input.promoted")).toBe(1);
  });

  test("preflight sees the frozen prospective cursor and errors before any commit", async () => {
    const cases = [
      new Error("preflight failed"),
      new Error("stale evidence"),
      new Error("preflight abort"),
    ];
    for (const [index, failure] of cases.entries()) {
      const session = new MemoryWorkSegmentSession(
        prefixWithDecisionTail([accepted("queue-1")]),
      );
      const controller = new AbortController();
      let prospective: readonly RunJournalEnvelopeV1[] | undefined;
      const preflight = async (prefix: readonly RunJournalEnvelopeV1[]) => {
        prospective = prefix;
        if (index === 1) return throwingEvidence(failure);
        if (index === 2) {
          controller.abort(failure);
          return undefined;
        }
        throw failure;
      };

      await expect(
        startWorkSegmentV1({
          session,
          inputId: "queue-1",
          verification: verification(),
          preflight,
          signal: controller.signal,
        }),
      ).rejects.toBe(failure);
      expect(isDeepFrozen(prospective)).toBeTrue();
      expect(session.inputCommits).toHaveLength(0);
      expect(session.decisionAndInputCommits).toHaveLength(0);
    }
  });

  test("checks abort again when prospective evidence returns normally", async () => {
    const session = new MemoryWorkSegmentSession(
      prefixWithDecisionTail([accepted("queue-1")]),
    );
    const controller = new AbortController();
    const abortReason = new Error("abort inside prospective evidence");

    await expect(
      startWorkSegmentV1({
        session,
        inputId: "queue-1",
        verification: verification(),
        preflight: () => evidenceThatAborts(controller, abortReason),
        signal: controller.signal,
      }),
    ).rejects.toBe(abortReason);
    expect(session.inputCommits).toHaveLength(0);
    expect(session.decisionAndInputCommits).toHaveLength(0);
  });

  test("propagates commit failures unchanged and does not retry them", async () => {
    const failure = new Error("fenced commit lost");
    const session = new MemoryWorkSegmentSession(
      prefixWithDecisionTail([accepted("queue-1")]),
    );
    session.inputFailure = failure;

    await expect(start(session, "queue-1")).rejects.toBe(failure);
    expect(session.inputCommits).toHaveLength(1);
    expect(countFact(session.prefix, "work.segment_started")).toBe(0);
  });

  test("rejects a later queued input and tampered history before preflight or commit", async () => {
    const later = new MemoryWorkSegmentSession(
      prefixWithDecisionTail([accepted("queue-1"), accepted("queue-2")]),
    );
    let preflightCalls = 0;
    await expect(
      startWorkSegmentV1({
        session: later,
        inputId: "queue-2",
        verification: verification(),
        preflight: () => {
          preflightCalls += 1;
          return undefined;
        },
        signal,
      }),
    ).rejects.toThrow(/exact first pending queue input/i);
    expect(preflightCalls).toBe(0);

    const tamperedPrefix = prefixWithDecisionTail([accepted("queue-1")]).map(
      (envelope) =>
        envelope.record.kind === "derived_decision"
          ? {
              ...envelope,
              record: {
                kind: "derived_decision" as const,
                decision: {
                  ...envelope.record.decision,
                  stateHash: "tampered",
                },
              },
            }
          : envelope,
    );
    const tampered = new MemoryWorkSegmentSession(tamperedPrefix);
    await expect(
      startWorkSegmentV1({
        session: tampered,
        inputId: "queue-1",
        verification: verification(),
        preflight: () => {
          preflightCalls += 1;
          return undefined;
        },
        signal,
      }),
    ).rejects.toThrow(/replay divergence/i);
    expect(preflightCalls).toBe(0);
    expect(tampered.inputCommits).toHaveLength(0);
  });

  test("maps accepted attachments into one detached frozen promotion", () => {
    const source = accepted("queue-1", [
      {
        attachmentId: "attachment-1",
        type: "file",
        name: "attachment.txt",
        mimeType: "text/plain",
        content: {
          kind: "artifact_ref",
          artifactRef: `paw-payload:v1:${"a".repeat(64)}`,
          hash: "attachment-hash",
        },
      },
    ]);
    const result = createInputPromotionFactV1(source);
    expect(result).toMatchObject({
      inputId: "queue-1",
      attachments: source.attachments,
    });
    expect(isDeepFrozen(result)).toBeTrue();
    expect(result.attachments).not.toBe(source.attachments);
  });

  test("reuses one real artifact attachment binding through a fenced LocationAware Session", async () => {
    const workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "paw-segment-location-"),
    );
    roots.push(workspaceRoot);
    const leaseResult = acquireFileSessionExecutionLeaseV1({
      workspaceRoot,
      sessionId: "segment-session",
      runId: "segment-run",
      ownerId: "segment-owner",
      ttlMs: 1_000_000,
      baseTailSeq: 0,
      basePrefixHash: EMPTY_RUN_JOURNAL_PREFIX_HASH_V1,
      clock: () => 42,
    });
    if (leaseResult.status !== "acquired") {
      throw new Error(`lease failed: ${leaseResult.status}`);
    }
    const raw = new FileRunSessionV1({
      workspaceRoot,
      sessionId: "segment-session",
      runId: "segment-run",
      executionLease: leaseResult.lease,
      clock: () => 42,
    });
    const writer = createFileDurableJsonPayloadWriterV1({
      workspaceRoot,
      sessionId: "segment-session",
      runId: "segment-run",
      executionLease: leaseResult.lease,
      policy: DEFAULT_FILE_DURABLE_JSON_PAYLOAD_POLICY_V1,
    });
    let prepareCalls = 0;
    const countingMaterializer: LocationAwarePayloadMaterializerV1 = {
      readCanonicalPayloadIdentity:
        writer.readCanonicalPayloadIdentity.bind(writer),
      resolve: writer.resolve.bind(writer),
      hash: writer.hash.bind(writer),
      async prepare(value, binding, prepareSignal) {
        prepareCalls += 1;
        return writer.prepare(value, binding, prepareSignal);
      },
    };
    const session = createLocationAwarePayloadSessionV1({
      source: raw,
      sessionId: "segment-session",
      runId: "segment-run",
      materializer: countingMaterializer,
      budget: payloadBudget,
    });
    const seededFacts = baseFacts();
    const modelSettled = seededFacts[3];
    if (
      modelSettled?.type !== "model.settled" ||
      modelSettled.response?.kind !== "inline"
    ) {
      throw new Error("expected model settlement fixture");
    }
    seededFacts[3] = {
      ...modelSettled,
      response: {
        ...modelSettled.response,
        hash: await writer.hash(modelSettled.response.value),
      },
    };
    const attachmentValue = "durable attachment";
    seededFacts.push(
      accepted("queue-1", [
        {
          attachmentId: "attachment-1",
          type: "file",
          name: "attachment.txt",
          mimeType: "text/plain",
          content: {
            kind: "inline",
            value: attachmentValue,
            hash: await writer.hash(attachmentValue),
          },
        },
      ]),
    );
    expect(await session.commitInputFacts(0, seededFacts)).toBe("committed");
    const seededPrefix = await session.readCanonicalPrefix();
    const seededInputFacts = facts(seededPrefix);
    const terminalEnvelope = decisionEnvelope(seededInputFacts);
    const terminal = terminalEnvelope.record;
    if (terminal.kind !== "derived_decision") {
      throw new Error("expected derived terminal fixture");
    }
    expect(
      await session.commitDerivedDecision(
        seededPrefix.length,
        terminal.decision,
      ),
    ).toBe("committed");
    const preparesAfterSeed = prepareCalls;
    let preflightPrefix: readonly RunJournalEnvelopeV1[] | undefined;

    expect(
      await startWorkSegmentV1({
        session,
        inputId: "queue-1",
        verification: verification(),
        async preflight(prospectivePrefix) {
          preflightPrefix = prospectivePrefix;
          const index = await buildVerifiedCanonicalPayloadIndexV1({
            fullPrefix: prospectivePrefix,
            resolver: writer,
            budget: payloadBudget,
          });
          return createVerifiedCanonicalPayloadEvidenceV1({
            index,
            fullPrefix: prospectivePrefix,
            identity: writer.readCanonicalPayloadIdentity(),
            budget: payloadBudget,
          });
        },
        signal,
      }),
    ).toMatchObject({ status: "started", segmentIndex: 1 });
    expect(isDeepFrozen(preflightPrefix)).toBeTrue();
    expect(prepareCalls).toBe(preparesAfterSeed);

    const finalPrefix = await session.readCanonicalPrefix();
    const attachmentOccurrences = projectCanonicalDurableJsonPayloadBindingsV1(
      finalPrefix,
    ).filter(
      (occurrence) => occurrence.binding.field.kind === "input_attachment",
    );
    expect(attachmentOccurrences).toHaveLength(2);
    expect(attachmentOccurrences[0]?.payload).toEqual(
      attachmentOccurrences[1]?.payload,
    );
    expect(attachmentOccurrences[0]?.binding).toEqual(
      attachmentOccurrences[1]?.binding,
    );
    expect(finalPrefix.slice(-2).map(recordType)).toEqual([
      "work.segment_started",
      "input.promoted",
    ]);
    const headBeforeLoss = readFileSessionAuthorityInventoryV1({
      workspaceRoot,
      sessionId: "segment-session",
    }).runs[0]?.head;
    expect(headBeforeLoss).toBeDefined();
    expect(await leaseResult.lease.release()).toBe("released");
    await expect(
      startWorkSegmentV1({
        session,
        inputId: "queue-1",
        verification: verification(),
        preflight: () => undefined,
        signal,
      }),
    ).rejects.toBeInstanceOf(SessionExecutionLeaseLostError);
    expect(
      readFileSessionAuthorityInventoryV1({
        workspaceRoot,
        sessionId: "segment-session",
      }).runs[0]?.head,
    ).toEqual(headBeforeLoss);
    raw.close();
  });
});

class MemoryWorkSegmentSession implements WorkSegmentStartSessionV1 {
  prefix: RunJournalEnvelopeV1[];
  readonly inputCommits: Array<{
    expectedTailSeq: number;
    facts: readonly InputFactV1[];
  }> = [];
  readonly decisionAndInputCommits: Array<{
    expectedTailSeq: number;
    decision: DerivedDecisionV1;
    facts: readonly InputFactV1[];
  }> = [];
  beforeInputCommit?: () => void;
  inputFailure?: Error;

  constructor(prefix: readonly RunJournalEnvelopeV1[]) {
    this.prefix = [...structuredClone(prefix)];
  }

  async readCanonicalPrefix(): Promise<readonly RunJournalEnvelopeV1[]> {
    return structuredClone(this.prefix);
  }

  async commitInputFacts(
    expectedTailSeq: number,
    inputFacts: readonly InputFactV1[],
  ): Promise<"committed" | "conflict"> {
    this.inputCommits.push({
      expectedTailSeq,
      facts: structuredClone(inputFacts),
    });
    this.beforeInputCommit?.();
    if (this.inputFailure) throw this.inputFailure;
    if (expectedTailSeq !== this.prefix.length) return "conflict";
    this.appendExternalFacts(inputFacts);
    return "committed";
  }

  async commitDecisionAndInputFacts(
    expectedTailSeq: number,
    decision: DerivedDecisionV1,
    inputFacts: readonly InputFactV1[],
  ): Promise<"committed" | "conflict"> {
    this.decisionAndInputCommits.push({
      expectedTailSeq,
      decision: structuredClone(decision),
      facts: structuredClone(inputFacts),
    });
    if (expectedTailSeq !== this.prefix.length) return "conflict";
    this.appendDecision(decision);
    this.appendExternalFacts(inputFacts);
    return "committed";
  }

  appendExternalFacts(inputFacts: readonly InputFactV1[]): void {
    for (const fact of inputFacts) {
      this.prefix.push(factEnvelope(this.prefix.length + 1, fact));
    }
    this.prefix = [...structuredClone(parseRunJournalPrefixV1(this.prefix))];
  }

  private appendDecision(decision: DerivedDecisionV1): void {
    this.prefix.push({
      schemaVersion: RUN_JOURNAL_SCHEMA_VERSION_V1,
      sessionId: "segment-session",
      runId: "segment-run",
      seq: this.prefix.length + 1,
      ts: 2_000_000_000_000 + this.prefix.length + 1,
      record: { kind: "derived_decision", decision },
    });
  }
}

function start(session: WorkSegmentStartSessionV1, inputId: string) {
  return startWorkSegmentV1({
    session,
    inputId,
    verification: verification(),
    preflight: () => undefined,
    signal,
  });
}

function verification() {
  return {
    runConfig: config,
    stateHasher: { hash: (state: unknown) => JSON.stringify(state) },
    derivedDecision,
  };
}

function prefixWithDecisionTail(
  acceptedFacts: readonly InputAcceptedFactV1[],
): readonly RunJournalEnvelopeV1[] {
  const inputFacts = [...baseFacts(), ...acceptedFacts];
  return [
    ...inputFacts.map((fact, index) => factEnvelope(index + 1, fact)),
    decisionEnvelope(inputFacts),
  ];
}

function prefixWithAcceptedTail(
  inputId: string,
): readonly RunJournalEnvelopeV1[] {
  const inputFacts = baseFacts();
  return [
    ...inputFacts.map((fact, index) => factEnvelope(index + 1, fact)),
    decisionEnvelope(inputFacts),
    factEnvelope(inputFacts.length + 2, accepted(inputId)),
  ];
}

function baseFacts(): InputFactV1[] {
  return [
    {
      type: "attempt.started",
      goalHash: "goal-hash",
      configHash: "config-hash",
    },
    {
      type: "input.promoted",
      inputId: "initial-input",
      delivery: "initial",
      content: "initial-content",
      contentHash: "initial-hash",
    },
    {
      type: "model.dispatch_recorded",
      modelCallId: "model-1",
      turn: 1,
      requestHash: "request-1",
    },
    {
      type: "model.settled",
      modelCallId: "model-1",
      turn: 1,
      status: "completed",
      response: {
        kind: "inline",
        value: {
          schemaVersion: "paw.model-response.v1",
          providerProtocol: "openai-compatible",
          assistantContent: "done",
          finishReason: "stop",
          toolCalls: [],
        },
        hash: "model-response-hash",
      },
      finishReason: "stop",
      hasToolCalls: false,
      hasVisibleOutput: true,
    },
  ];
}

function accepted(
  inputId: string,
  attachments?: InputAcceptedFactV1["attachments"],
): InputAcceptedFactV1 {
  return {
    type: "input.accepted",
    inputId,
    delivery: "queue",
    content: `content-${inputId}`,
    contentHash: `hash-${inputId}`,
    callerId: "segment-test",
    ...(attachments === undefined ? {} : { attachments }),
  };
}

function decisionEnvelope(
  inputFacts: readonly InputFactV1[],
): RunJournalEnvelopeV1 {
  const reducer = createInteractiveControlReducerV2();
  const state = reducer.reduce(inputFacts, config);
  const stateHash = JSON.stringify(state);
  return {
    schemaVersion: RUN_JOURNAL_SCHEMA_VERSION_V1,
    sessionId: "segment-session",
    runId: "segment-run",
    seq: inputFacts.length + 1,
    ts: 2_000_000_000_000 + inputFacts.length + 1,
    record: {
      kind: "derived_decision",
      decision: derivedDecision({
        state,
        inputThroughSeq: inputFacts.length,
        stateHash,
        reducerVersion: INTERACTIVE_CONTROL_REDUCER_VERSION_V2,
      }),
    },
  };
}

function derivedDecision(input: {
  readonly state: ReturnType<
    ReturnType<typeof createInteractiveControlReducerV2>["reduce"]
  >;
  readonly inputThroughSeq: number;
  readonly stateHash: string;
  readonly reducerVersion: string;
}): DerivedDecisionV1 {
  return {
    type: "control.decided",
    reducerVersion: input.reducerVersion,
    inputThroughSeq: input.inputThroughSeq,
    stateHash: input.stateHash,
    action: actionFromDecision(input.state.decision),
  };
}

function actionFromDecision(
  decision: ControlDecision,
): ControlDecisionActionV1 {
  switch (decision.kind) {
    case "continue":
      return { kind: "continue", reasonCode: "continue" };
    case "await_user":
      return { kind: "wait", waitFor: "user", reasonCode: decision.reason };
    case "await_external":
      return {
        kind: "wait",
        waitFor: "external",
        reasonCode: decision.reason,
      };
    case "completed":
      return { kind: "complete", reasonCode: decision.reason };
    case "incomplete":
      return { kind: "incomplete", reasonCode: decision.reason };
    case "failed":
      return { kind: "failed", reasonCode: decision.reason };
    case "aborted":
      return { kind: "abort", reasonCode: decision.reason };
  }
}

function factEnvelope(seq: number, fact: InputFactV1): RunJournalEnvelopeV1 {
  return {
    schemaVersion: RUN_JOURNAL_SCHEMA_VERSION_V1,
    sessionId: "segment-session",
    runId: "segment-run",
    seq,
    ts: 2_000_000_000_000 + seq,
    record: { kind: "input_fact", fact },
  };
}

function facts(
  prefix: readonly RunJournalEnvelopeV1[],
): readonly InputFactV1[] {
  return prefix.flatMap((envelope) =>
    envelope.record.kind === "input_fact" ? [envelope.record.fact] : [],
  );
}

function countFact(
  prefix: readonly RunJournalEnvelopeV1[],
  type: InputFactV1["type"],
): number {
  return facts(prefix).filter((fact) => fact.type === type).length;
}

function recordType(envelope: RunJournalEnvelopeV1): string {
  return envelope.record.kind === "input_fact"
    ? envelope.record.fact.type
    : envelope.record.decision.type;
}

function throwingEvidence(error: Error): VerifiedModelResponseEvidenceV1 {
  return {
    assertSnapshot() {
      throw error;
    },
    requireModelResponse() {
      throw error;
    },
  };
}

function evidenceThatAborts(
  controller: AbortController,
  reason: Error,
): VerifiedModelResponseEvidenceV1 {
  return {
    assertSnapshot() {
      controller.abort(reason);
    },
    requireModelResponse() {
      throw new Error(
        "inline model response must not require artifact evidence",
      );
    },
  };
}

function isDeepFrozen(value: unknown): boolean {
  if (value === undefined) return false;
  if (value === null || typeof value !== "object") return true;
  if (!Object.isFrozen(value)) return false;
  return Object.values(value).every(isDeepFrozen);
}
