import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Session, SessionInputSnapshot } from "@paw/agent-loop";
import {
  type DurableJsonPayloadV1,
  type InputFactV1,
  type JsonValue,
  MODEL_RESPONSE_SCHEMA_VERSION_V1,
  RUN_JOURNAL_SCHEMA_VERSION_V1,
  type RunJournalEnvelopeV1,
  TASK_CHECKPOINT_SCHEMA_VERSION_V1,
  type TaskCheckpointV1,
} from "@paw/protocol";
import {
  type FileRunSessionV1,
  type LocationAwarePayloadMaterializerV1,
  type LocationAwarePayloadSessionSourceV1,
  type TaskCheckpointDistillationCodecV1,
  VERIFIED_CANONICAL_PAYLOAD_BUDGET_POLICY_VERSION_V1,
  type VerifiedCanonicalPayloadEvidenceV1,
  buildVerifiedCanonicalPayloadIndexV1,
  createLocationAwarePayloadSessionV1,
  createVerifiedCanonicalPayloadEvidenceV1,
  runTaskCheckpointDistillationV1,
} from "../src/index.js";
import { openFencedTestSession } from "./support/fenced-file-session.js";

const signal = new AbortController().signal;
const TEST_PAYLOAD_BUDGET = Object.freeze({
  policyVersion: VERIFIED_CANONICAL_PAYLOAD_BUDGET_POLICY_VERSION_V1,
  maxTotalBytes: 1_000_000,
});

describe("crash-safe task checkpoint distillation", () => {
  test("persists claim before one distiller call, then settlement and checkpoint", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paw-distillation-"));
    try {
      let session = openFileSession(root);
      await session.appendInputFacts(sourceFacts());
      let calls = 0;
      const first = await runTaskCheckpointDistillationV1(
        session,
        distillationInput(),
        {
          async distill(input) {
            calls += 1;
            expect(input.boundary).toBe("after_model_turn_without_tool_calls");
            const during = await session.readInputSnapshot();
            expect(during.entries.at(-1)?.fact.type).toBe(
              "context.checkpoint_distillation_claimed",
            );
            expect(Object.isFrozen(input.sourceEntries)).toBeTrue();
            return { status: "completed", checkpoint: checkpointValue() };
          },
        },
        inlineCodec(),
        signal,
      );

      expect(first.status).toBe("committed");
      expect(first.distillerCalls).toBe(1);
      expect(calls).toBe(1);
      expect(
        (await session.readInputSnapshot()).entries
          .slice(-3)
          .map((entry) => entry.fact.type),
      ).toEqual([
        "context.checkpoint_distillation_claimed",
        "context.checkpoint_distillation_settled",
        "context.checkpoint_recorded",
      ]);
      session.close();

      session = openFileSession(root);
      const replay = await runTaskCheckpointDistillationV1(
        session,
        distillationInput(),
        {
          async distill() {
            calls += 1;
            throw new Error("settled work must not rerun");
          },
        },
        inlineCodec(),
        signal,
      );
      expect(replay.status).toBe("reused");
      expect(replay.distillerCalls).toBe(0);
      expect(calls).toBe(1);
      session.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("an unresolved durable claim resumes as interrupted without a second call", async () => {
    const session = new MemorySession(sourceFacts(), {
      rejectSettlementAppend: true,
    });
    let calls = 0;
    await expect(
      runTaskCheckpointDistillationV1(
        session,
        distillationInput(),
        {
          async distill() {
            calls += 1;
            return { status: "completed", checkpoint: checkpointValue() };
          },
        },
        inlineCodec(),
        signal,
      ),
    ).rejects.toThrow("simulated settlement crash");

    const resumed = await runTaskCheckpointDistillationV1(
      session,
      distillationInput(),
      {
        async distill() {
          calls += 1;
          throw new Error("must not repeat after claim");
        },
      },
      inlineCodec(),
      signal,
    );
    expect(resumed.status).toBe("interrupted");
    expect(resumed.distillerCalls).toBe(0);
    expect(calls).toBe(1);
  });

  test("a settled result survives final-CAS conflict and resumes without rerun", async () => {
    const session = new MemorySession(sourceFacts(), { conflictCommit: 2 });
    let calls = 0;
    const first = await runTaskCheckpointDistillationV1(
      session,
      distillationInput(),
      {
        async distill() {
          calls += 1;
          return { status: "completed", checkpoint: checkpointValue() };
        },
      },
      inlineCodec(),
      signal,
    );
    expect(first.status).toBe("conflict");
    expect(first.distillerCalls).toBe(1);

    const resumed = await runTaskCheckpointDistillationV1(
      session,
      distillationInput(),
      {
        async distill() {
          calls += 1;
          throw new Error("must reuse durable settlement");
        },
      },
      inlineCodec(),
      signal,
    );
    expect(resumed.status).toBe("committed");
    expect(resumed.distillerCalls).toBe(0);
    expect(calls).toBe(1);
  });

  test("a claim CAS conflict cannot call the distiller", async () => {
    const session = new MemorySession(sourceFacts(), { conflictCommit: 1 });
    let calls = 0;
    const value = await runTaskCheckpointDistillationV1(
      session,
      distillationInput(),
      {
        async distill() {
          calls += 1;
          return { status: "completed", checkpoint: checkpointValue() };
        },
      },
      inlineCodec(),
      signal,
    );
    expect(value).toMatchObject({ status: "conflict", distillerCalls: 0 });
    expect(calls).toBe(0);
    expect((await session.readInputSnapshot()).tailSeq).toBe(6);
  });

  test("a missing settled artifact fails closed without repeating distillation", async () => {
    const session = new MemorySession(sourceFacts(), { conflictCommit: 2 });
    const artifacts = new Map<string, JsonValue>();
    const codec = artifactCodec(artifacts);
    const evidenceStats = { loads: 0, lookups: 0 };
    let calls = 0;
    const first = await runTaskCheckpointDistillationV1(
      session,
      distillationInput(),
      {
        async distill() {
          calls += 1;
          return { status: "completed", checkpoint: checkpointValue() };
        },
      },
      codec,
      signal,
      {
        loadPayloadEvidence: artifactCheckpointEvidenceLoader(
          artifacts,
          evidenceStats,
        ),
      },
    );
    expect(first.status).toBe("conflict");
    artifacts.clear();

    const resumed = await runTaskCheckpointDistillationV1(
      session,
      distillationInput(),
      {
        async distill() {
          calls += 1;
          throw new Error("a missing artifact must not repeat semantic work");
        },
      },
      codec,
      signal,
      {
        loadPayloadEvidence: artifactCheckpointEvidenceLoader(
          artifacts,
          evidenceStats,
        ),
      },
    );
    expect(resumed).toMatchObject({
      status: "invalid_settlement",
      distillerCalls: 0,
    });
    expect(calls).toBe(1);
    expect(evidenceStats.loads).toBe(2);
  });

  test("reuses one canonical artifact settlement after final CAS conflict without rerunning the distiller", async () => {
    const session = new MemorySession(sourceFacts(), { conflictCommit: 2 });
    const artifacts = new Map<string, JsonValue>();
    const codecStats = { artifactResolveCalls: 0 };
    const codec = artifactCodec(artifacts, codecStats);
    const evidenceStats = { loads: 0, lookups: 0 };
    let calls = 0;

    const first = await runTaskCheckpointDistillationV1(
      session,
      distillationInput(),
      {
        async distill() {
          calls += 1;
          return { status: "completed", checkpoint: checkpointValue() };
        },
      },
      codec,
      signal,
      {
        loadPayloadEvidence: artifactCheckpointEvidenceLoader(
          artifacts,
          evidenceStats,
        ),
      },
    );
    expect(first).toMatchObject({ status: "conflict", distillerCalls: 1 });

    const second = await runTaskCheckpointDistillationV1(
      session,
      distillationInput(),
      {
        async distill() {
          calls += 1;
          throw new Error("durable artifact settlement must be reused");
        },
      },
      codec,
      signal,
      {
        loadPayloadEvidence: artifactCheckpointEvidenceLoader(
          artifacts,
          evidenceStats,
        ),
      },
    );

    expect(second).toMatchObject({ status: "committed", distillerCalls: 0 });
    expect(calls).toBe(1);
    expect(codecStats.artifactResolveCalls).toBe(0);
    expect(evidenceStats).toEqual({ loads: 2, lookups: 2 });
    const snapshot = await session.readInputSnapshot();
    const settled = snapshot.entries.find(
      (entry) => entry.fact.type === "context.checkpoint_distillation_settled",
    )?.fact;
    const recorded = snapshot.entries.find(
      (entry) => entry.fact.type === "context.checkpoint_recorded",
    )?.fact;
    expect(settled?.type).toBe("context.checkpoint_distillation_settled");
    expect(recorded?.type).toBe("context.checkpoint_recorded");
    if (
      settled?.type !== "context.checkpoint_distillation_settled" ||
      settled.status !== "completed" ||
      settled.checkpoint === undefined ||
      recorded?.type !== "context.checkpoint_recorded"
    ) {
      throw new Error("expected canonical checkpoint facts");
    }
    expect(recorded.checkpoint).toEqual(settled.checkpoint);
  });

  test("propagates the exact LeaseLost error from recorded commit without redistilling or legacy artifact reads", async () => {
    const session = new MemorySession(sourceFacts(), { conflictCommit: 2 });
    const artifacts = new Map<string, JsonValue>();
    const codecStats = { artifactResolveCalls: 0 };
    const codec = artifactCodec(artifacts, codecStats);
    const evidenceStats = { loads: 0, lookups: 0 };
    let setupDistillerCalls = 0;
    const first = await runTaskCheckpointDistillationV1(
      session,
      distillationInput(),
      {
        async distill() {
          setupDistillerCalls += 1;
          return { status: "completed", checkpoint: checkpointValue() };
        },
      },
      codec,
      signal,
      {
        loadPayloadEvidence: artifactCheckpointEvidenceLoader(
          artifacts,
          evidenceStats,
        ),
      },
    );
    expect(first).toMatchObject({ status: "conflict", distillerCalls: 1 });

    const leaseLost = Object.assign(new Error("issued lease was lost"), {
      name: "LeaseLost",
    });
    session.failNextCommit(leaseLost);
    let recoveryDistillerCalls = 0;
    let caught: unknown;
    try {
      await runTaskCheckpointDistillationV1(
        session,
        distillationInput(),
        {
          async distill() {
            recoveryDistillerCalls += 1;
            throw new Error("completed settlement must not redistill");
          },
        },
        codec,
        signal,
        {
          loadPayloadEvidence: artifactCheckpointEvidenceLoader(
            artifacts,
            evidenceStats,
          ),
        },
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(leaseLost);
    expect(setupDistillerCalls).toBe(1);
    expect(recoveryDistillerCalls).toBe(0);
    expect(codecStats.artifactResolveCalls).toBe(0);
    expect(
      (await session.readInputSnapshot()).entries.filter(
        (entry) => entry.fact.type === "context.checkpoint_recorded",
      ),
    ).toHaveLength(0);
  });

  test("rereads an inline draft materialized by the location-aware Session and reuses its exact ref", async () => {
    const source = new MemorySession(canonicalSourceFacts(), {
      conflictCommit: 3,
    });
    const materializer = new DistillationMaterializer();
    const session = createLocationAwarePayloadSessionV1({
      source,
      sessionId: "session-distillation",
      runId: "run-distillation",
      materializer,
      budget: TEST_PAYLOAD_BUDGET,
    });
    let distillerCalls = 0;
    let evidenceLoads = 0;
    const loadPayloadEvidence = async (
      snapshot: SessionInputSnapshot<InputFactV1>,
    ) => {
      evidenceLoads += 1;
      const fullPrefix = await session.readCanonicalPrefix();
      const budget = {
        policyVersion: VERIFIED_CANONICAL_PAYLOAD_BUDGET_POLICY_VERSION_V1,
        maxTotalBytes: 1_000_000,
      } as const;
      const index = await buildVerifiedCanonicalPayloadIndexV1({
        fullPrefix,
        resolver: materializer,
        budget,
      });
      const evidence = createVerifiedCanonicalPayloadEvidenceV1({
        index,
        fullPrefix,
        identity: materializer.readCanonicalPayloadIdentity(),
        budget,
      });
      evidence.assertSnapshot(snapshot);
      return evidence;
    };

    const first = await runTaskCheckpointDistillationV1(
      session,
      distillationInput(),
      {
        async distill() {
          distillerCalls += 1;
          return { status: "completed", checkpoint: checkpointValue() };
        },
      },
      inlineCodec(),
      signal,
      { loadPayloadEvidence },
    );
    expect(first).toMatchObject({ status: "conflict", distillerCalls: 1 });

    const second = await runTaskCheckpointDistillationV1(
      session,
      distillationInput(),
      {
        async distill() {
          distillerCalls += 1;
          throw new Error("materialized settlement must not redistill");
        },
      },
      inlineCodec(),
      signal,
      { loadPayloadEvidence },
    );
    expect(second).toMatchObject({ status: "committed", distillerCalls: 0 });
    expect(distillerCalls).toBe(1);
    expect(evidenceLoads).toBe(2);

    const snapshot = await session.readInputSnapshot();
    const settled = snapshot.entries.find(
      (entry) => entry.fact.type === "context.checkpoint_distillation_settled",
    )?.fact;
    const recorded = snapshot.entries.find(
      (entry) => entry.fact.type === "context.checkpoint_recorded",
    )?.fact;
    if (
      settled?.type !== "context.checkpoint_distillation_settled" ||
      settled.status !== "completed" ||
      !settled.checkpoint ||
      recorded?.type !== "context.checkpoint_recorded"
    ) {
      throw new Error("expected materialized checkpoint facts");
    }
    expect(settled.checkpoint.kind).toBe("artifact_ref");
    expect(recorded.checkpoint).toEqual(settled.checkpoint);
    expect(materializer.preparedBindings).toEqual([
      expect.objectContaining({
        originSeq: 9,
        field: {
          kind: "task_checkpoint",
          checkpointId: "checkpoint-distilled-1",
        },
      }),
    ]);
  });

  test("an abort raised by artifact evidence never records a checkpoint", async () => {
    const session = new MemorySession(sourceFacts());
    const artifacts = new Map<string, JsonValue>();
    const controller = new AbortController();

    await expect(
      runTaskCheckpointDistillationV1(
        session,
        distillationInput(),
        {
          async distill() {
            return { status: "completed", checkpoint: checkpointValue() };
          },
        },
        artifactCodec(artifacts),
        controller.signal,
        {
          loadPayloadEvidence(snapshot) {
            const evidence = artifactCheckpointEvidence(snapshot, artifacts, {
              loads: 0,
              lookups: 0,
            });
            return {
              ...evidence,
              requirePayload(input) {
                controller.abort("abort-inside-artifact-evidence");
                return evidence.requirePayload(input);
              },
            };
          },
        },
      ),
    ).rejects.toThrow("abort-inside-artifact-evidence");
    expect(
      (await session.readInputSnapshot()).entries.some(
        (entry) => entry.fact.type === "context.checkpoint_recorded",
      ),
    ).toBe(false);
  });

  test("invalid or cancelled work settles honestly and never creates a checkpoint", async () => {
    const invalidSession = new MemorySession(sourceFacts());
    let invalidCalls = 0;
    const invalid = await runTaskCheckpointDistillationV1(
      invalidSession,
      distillationInput(),
      {
        async distill() {
          invalidCalls += 1;
          return {
            status: "completed",
            checkpoint: {
              ...checkpointValue(),
              confirmedFacts: [
                { statement: "outside range", sourceSeqs: [99] },
              ],
            },
          };
        },
      },
      inlineCodec(),
      signal,
    );
    expect(invalid).toMatchObject({
      status: "settled_without_checkpoint",
      settlementStatus: "unknown",
    });
    const invalidReplay = await runTaskCheckpointDistillationV1(
      invalidSession,
      distillationInput(),
      {
        async distill() {
          invalidCalls += 1;
          throw new Error("invalid settled output cannot rerun");
        },
      },
      inlineCodec(),
      signal,
    );
    expect(invalidReplay.distillerCalls).toBe(0);
    expect(invalidCalls).toBe(1);

    const controller = new AbortController();
    const cancelledSession = new MemorySession(sourceFacts());
    const cancelled = await runTaskCheckpointDistillationV1(
      cancelledSession,
      distillationInput(),
      {
        async distill() {
          controller.abort("user cancelled distillation");
          throw new Error("provider aborted");
        },
      },
      inlineCodec(),
      controller.signal,
    );
    expect(cancelled).toMatchObject({
      status: "settled_without_checkpoint",
      settlementStatus: "cancelled",
      distillerCalls: 1,
    });
  });

  test("protected source ranges fail before claim or distiller side effects", async () => {
    const session = new MemorySession(sourceFacts());
    let calls = 0;
    await expect(
      runTaskCheckpointDistillationV1(
        session,
        { ...distillationInput(), sourceFromSeq: 1, sourceThroughSeq: 1 },
        {
          async distill() {
            calls += 1;
            return { status: "completed", checkpoint: checkpointValue() };
          },
        },
        inlineCodec(),
        signal,
      ),
    ).rejects.toThrow("covers protected context evidence");
    expect(calls).toBe(0);
    expect((await session.readInputSnapshot()).tailSeq).toBe(6);
  });

  test("the declared stable boundary must match the latest completed turn", async () => {
    let calls = 0;
    const wrongKind = new MemorySession(sourceFacts());
    await expect(
      runTaskCheckpointDistillationV1(
        wrongKind,
        { ...distillationInput(), boundary: "after_tool_batch_settled" },
        {
          async distill() {
            calls += 1;
            return { status: "completed", checkpoint: checkpointValue() };
          },
        },
        inlineCodec(),
        signal,
      ),
    ).rejects.toThrow("boundary does not match");

    const inputAfterTurn = new MemorySession(sourceFacts().slice(0, 4));
    await expect(
      runTaskCheckpointDistillationV1(
        inputAfterTurn,
        distillationInput(),
        {
          async distill() {
            calls += 1;
            return { status: "completed", checkpoint: checkpointValue() };
          },
        },
        inlineCodec(),
        signal,
      ),
    ).rejects.toThrow("boundary is not stable");
    expect(calls).toBe(0);
  });

  test("a completely settled native tool batch is a valid stable boundary", async () => {
    const session = new MemorySession(toolBoundaryFacts());
    const value = await runTaskCheckpointDistillationV1(
      session,
      { ...distillationInput(), boundary: "after_tool_batch_settled" },
      {
        async distill() {
          return { status: "completed", checkpoint: checkpointValue() };
        },
      },
      inlineCodec(),
      signal,
    );
    expect(value.status).toBe("committed");
  });

  test("abort, runtime failure, or a new attempt after the turn forbids distillation", async () => {
    const tailFacts: readonly InputFactV1[] = [
      { type: "abort.requested", source: "host" },
      {
        type: "runtime.failed",
        area: "context",
        errorCode: "ContextFailed",
        message: "context failed after the visible turn",
        retryable: true,
      },
      {
        type: "attempt.started",
        goalHash: "new-goal-hash",
        configHash: "new-config-hash",
      },
    ];
    for (const tailFact of tailFacts) {
      const session = new MemorySession([...sourceFacts(), tailFact]);
      let calls = 0;
      await expect(
        runTaskCheckpointDistillationV1(
          session,
          distillationInput(),
          {
            async distill() {
              calls += 1;
              return { status: "completed", checkpoint: checkpointValue() };
            },
          },
          inlineCodec(),
          signal,
        ),
      ).rejects.toThrow(`followed by ${tailFact.type}`);
      expect(calls).toBe(0);
      expect((await session.readInputSnapshot()).entries).toHaveLength(7);
    }
  });
});

class MemorySession
  implements Session<InputFactV1, unknown>, LocationAwarePayloadSessionSourceV1
{
  private readonly entries: { seq: number; fact: InputFactV1 }[];
  private tailSeq: number;
  private commitCount = 0;
  private nextCommitError: unknown;
  private rejectSettlementAppend: boolean;
  private readonly conflictCommit?: number;

  constructor(
    facts: readonly InputFactV1[],
    options: {
      readonly rejectSettlementAppend?: boolean;
      readonly conflictCommit?: number;
    } = {},
  ) {
    this.entries = facts.map((fact, index) => ({ seq: index + 1, fact }));
    this.tailSeq = facts.length;
    this.rejectSettlementAppend = options.rejectSettlementAppend ?? false;
    this.conflictCommit = options.conflictCommit;
  }

  async readInputSnapshot(): Promise<SessionInputSnapshot<InputFactV1>> {
    return {
      entries: this.entries.map((entry) => ({ ...entry })),
      tailSeq: this.tailSeq,
      latestInputSeq: this.entries.at(-1)?.seq ?? 0,
    };
  }

  readCanonicalJournalIdentity() {
    return {
      workspaceRoot: "E:/distillation-fixture",
      sessionId: "session-distillation",
      runId: "run-distillation",
    } as const;
  }

  async readCanonicalPrefix(): Promise<readonly RunJournalEnvelopeV1[]> {
    return this.entries.map((entry) => ({
      schemaVersion: RUN_JOURNAL_SCHEMA_VERSION_V1,
      sessionId: "session-distillation",
      runId: "run-distillation",
      seq: entry.seq,
      ts: entry.seq,
      record: { kind: "input_fact" as const, fact: entry.fact },
    }));
  }

  async appendInputFacts(facts: readonly InputFactV1[]): Promise<void> {
    if (
      this.rejectSettlementAppend &&
      facts.some(
        (fact) => fact.type === "context.checkpoint_distillation_settled",
      )
    ) {
      this.rejectSettlementAppend = false;
      throw new Error("simulated settlement crash");
    }
    for (const fact of facts) {
      this.tailSeq += 1;
      this.entries.push({ seq: this.tailSeq, fact });
    }
  }

  async commitInputFacts(
    expectedTailSeq: number,
    facts: readonly InputFactV1[],
  ): Promise<"committed" | "conflict"> {
    this.commitCount += 1;
    if (this.nextCommitError !== undefined) {
      const error = this.nextCommitError;
      this.nextCommitError = undefined;
      throw error;
    }
    if (
      expectedTailSeq !== this.tailSeq ||
      this.commitCount === this.conflictCommit
    ) {
      return "conflict";
    }
    await this.appendInputFacts(facts);
    return "committed";
  }

  failNextCommit(error: unknown): void {
    this.nextCommitError = error;
  }

  async commitDerivedDecision(
    expectedTailSeq: number,
    _decision: unknown,
  ): Promise<"committed" | "conflict"> {
    if (expectedTailSeq !== this.tailSeq) return "conflict";
    this.tailSeq += 1;
    return "committed";
  }

  async commitDecisionAndInputFacts(
    expectedTailSeq: number,
    _decision: unknown,
    facts: readonly InputFactV1[],
  ): Promise<"committed" | "conflict"> {
    if (expectedTailSeq !== this.tailSeq) return "conflict";
    this.tailSeq += 1;
    await this.appendInputFacts(facts);
    return "committed";
  }
}

function distillationInput() {
  return {
    checkpointId: "checkpoint-distilled-1",
    policyVersion: "checkpoint-distiller-v1",
    boundary: "after_model_turn_without_tool_calls" as const,
    sourceFromSeq: 2,
    sourceThroughSeq: 3,
  };
}

function checkpointValue(): TaskCheckpointV1 {
  return {
    schemaVersion: TASK_CHECKPOINT_SCHEMA_VERSION_V1,
    confirmedFacts: [
      { statement: "old answer was inspected", sourceSeqs: [3] },
    ],
    currentHypotheses: [],
    ruledOut: [],
    changedFiles: [],
    verification: [],
    unresolved: [],
  };
}

function sourceFacts(): readonly InputFactV1[] {
  return [
    promoted("goal", "initial", "fix the regression"),
    modelDispatch("old-model", 1),
    modelSettled("old-model", 1, "old assistant answer"),
    promoted("current", "initial", "current request"),
    modelDispatch("latest-model", 2),
    modelSettled("latest-model", 2, "latest assistant answer"),
  ];
}

function canonicalSourceFacts(): readonly InputFactV1[] {
  return [
    promoted("goal", "initial", "fix the regression"),
    modelDispatch("old-model", 1),
    modelSettled("old-model", 1, "old assistant answer"),
    {
      type: "input.accepted",
      inputId: "current",
      delivery: "steer",
      content: "current request",
      contentHash: "hash:current",
      callerId: "distillation-test",
    },
    promoted("current", "steer", "current request"),
    modelDispatch("latest-model", 2),
    modelSettled("latest-model", 2, "latest assistant answer"),
  ];
}

function toolBoundaryFacts(): readonly InputFactV1[] {
  const response = {
    schemaVersion: MODEL_RESPONSE_SCHEMA_VERSION_V1,
    providerProtocol: "openai-compatible" as const,
    assistantContent: "",
    finishReason: "tool_calls",
    toolCalls: [
      {
        callId: "call-1",
        name: "workspace_read_file",
        rawArguments: '{"path":"a.ts"}',
        args: { path: "a.ts" },
        sourceIndex: 0,
        argumentsValid: true,
      },
    ],
  };
  return [
    promoted("goal", "initial", "fix the regression"),
    modelDispatch("old-model", 1),
    modelSettled("old-model", 1, "old assistant answer"),
    promoted("current", "initial", "current request"),
    modelDispatch("tool-model", 2),
    {
      type: "model.settled",
      modelCallId: "tool-model",
      turn: 2,
      status: "completed",
      hasToolCalls: true,
      hasVisibleOutput: false,
      finishReason: "tool_calls",
      response: inline(response as unknown as JsonValue),
    },
    {
      type: "tool.call_observed",
      callId: "call-1",
      modelCallId: "tool-model",
      turn: 2,
      tool: "workspace_read_file",
      args: { path: "a.ts" },
      order: 0,
    },
    {
      type: "tool.dispatch_recorded",
      callId: "call-1",
      batchId: "batch-1",
      turn: 2,
      sourceIndex: 0,
      mode: "serial",
    },
    {
      type: "tool.permission_resolved",
      callId: "call-1",
      turn: 2,
      sourceIndex: 0,
      tool: "workspace_read_file",
      policyVersion: "permission-v1",
      resolution: "allow_once",
      source: "user_prompt",
    },
    { type: "tool.settled", callId: "call-1", status: "completed" },
  ];
}

function promoted(
  inputId: string,
  delivery: "initial" | "steer",
  content: string,
): InputFactV1 {
  return {
    type: "input.promoted",
    inputId,
    delivery,
    content,
    contentHash: `hash:${inputId}`,
  };
}

function modelDispatch(modelCallId: string, turn: number): InputFactV1 {
  return {
    type: "model.dispatch_recorded",
    modelCallId,
    turn,
    requestHash: `request:${modelCallId}`,
  };
}

function modelSettled(
  modelCallId: string,
  turn: number,
  assistantContent: string,
): InputFactV1 {
  const response = {
    schemaVersion: MODEL_RESPONSE_SCHEMA_VERSION_V1,
    providerProtocol: "openai-compatible" as const,
    assistantContent,
    finishReason: "stop",
    toolCalls: [],
  };
  return {
    type: "model.settled",
    modelCallId,
    turn,
    status: "completed",
    hasToolCalls: false,
    hasVisibleOutput: true,
    finishReason: "stop",
    response: inline(response as unknown as JsonValue),
  };
}

function openFileSession(root: string): FileRunSessionV1 {
  return openFencedTestSession(root, { clock: () => 42 });
}

function inlineCodec(): TaskCheckpointDistillationCodecV1 {
  return {
    hash: stableHash,
    encode: (value) => ({ kind: "inline", value, hash: stableHash(value) }),
    resolve: (payload) => {
      if (payload.kind !== "inline") throw new Error("unexpected artifact");
      return payload.value;
    },
  };
}

function artifactCodec(
  artifacts: Map<string, JsonValue>,
  stats?: { artifactResolveCalls: number },
): TaskCheckpointDistillationCodecV1 {
  return {
    hash: stableHash,
    encode: (value) => {
      const hash = stableHash(value);
      const artifactRef = `artifact:${hash}`;
      artifacts.set(artifactRef, value);
      return { kind: "artifact_ref", artifactRef, hash };
    },
    resolve: (payload) => {
      if (payload.kind !== "artifact_ref") {
        throw new Error("unexpected inline payload");
      }
      if (stats) stats.artifactResolveCalls += 1;
      const value = artifacts.get(payload.artifactRef);
      if (!value) throw new Error("artifact is missing");
      return value;
    },
  };
}

function artifactCheckpointEvidenceLoader(
  artifacts: ReadonlyMap<string, JsonValue>,
  stats: { loads: number; lookups: number },
) {
  return (snapshot: SessionInputSnapshot<InputFactV1>) => {
    stats.loads += 1;
    return artifactCheckpointEvidence(snapshot, artifacts, stats);
  };
}

function artifactCheckpointEvidence(
  expectedSnapshot: SessionInputSnapshot<InputFactV1>,
  artifacts: ReadonlyMap<string, JsonValue>,
  stats: { loads: number; lookups: number },
): VerifiedCanonicalPayloadEvidenceV1 {
  const expected = stableStringify(expectedSnapshot as unknown as JsonValue);
  const assertSnapshot = (
    snapshot: SessionInputSnapshot<InputFactV1>,
  ): void => {
    if (stableStringify(snapshot as unknown as JsonValue) !== expected) {
      throw new Error("distillation evidence snapshot drift");
    }
  };
  return {
    assertSnapshot,
    requirePayload(input) {
      assertSnapshot(input.snapshot);
      stats.lookups += 1;
      if (
        input.location.kind !== "task_checkpoint" ||
        input.location.carrierType !==
          "context.checkpoint_distillation_settled" ||
        input.location.checkpointId !== "checkpoint-distilled-1"
      ) {
        throw new Error("distillation evidence location drift");
      }
      if (input.payload.kind !== "artifact_ref") {
        throw new Error("expected artifact checkpoint payload");
      }
      const value = artifacts.get(input.payload.artifactRef);
      if (value === undefined) throw new Error("artifact is missing");
      return value;
    },
    requireModelResponse() {
      throw new Error("distillation evidence cannot expose model response");
    },
  };
}

class DistillationMaterializer implements LocationAwarePayloadMaterializerV1 {
  readonly values = new Map<string, JsonValue>();
  readonly preparedBindings: Array<{
    readonly originSeq: number;
    readonly field: Readonly<Record<string, unknown>>;
  }> = [];

  readCanonicalPayloadIdentity() {
    return {
      workspaceRoot: "E:/distillation-fixture",
      sessionId: "session-distillation",
      runId: "run-distillation",
    } as const;
  }

  prepare(
    value: JsonValue,
    binding: Parameters<LocationAwarePayloadMaterializerV1["prepare"]>[1],
  ): DurableJsonPayloadV1 {
    const artifactRef = `artifact:location-aware:${binding.originSeq}`;
    this.values.set(artifactRef, value);
    this.preparedBindings.push({
      originSeq: binding.originSeq,
      field: binding.field,
    });
    return { kind: "artifact_ref", artifactRef, hash: stableHash(value) };
  }

  resolve(payload: DurableJsonPayloadV1): JsonValue {
    if (payload.kind === "inline") return payload.value;
    const value = this.values.get(payload.artifactRef);
    if (value === undefined) throw new Error("materialized artifact missing");
    return value;
  }

  hash = stableHash;
}

function inline(value: JsonValue) {
  return { kind: "inline" as const, value, hash: stableHash(value) };
}

function stableHash(value: JsonValue): string {
  return `hash:${stableStringify(value)}`;
}

function stableStringify(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Readonly<Record<string, JsonValue>>;
  return `{${Object.keys(record)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${stableStringify(record[key] as JsonValue)}`,
    )
    .join(",")}}`;
}
