import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Session, SessionInputSnapshot } from "@paw/agent-loop";
import {
  type InputFactV1,
  type JsonValue,
  MODEL_RESPONSE_SCHEMA_VERSION_V1,
  TASK_CHECKPOINT_SCHEMA_VERSION_V1,
  TOOL_OBSERVATION_SCHEMA_VERSION_V1,
  type TaskCheckpointV1,
} from "@paw/protocol";
import {
  type FileRunSessionV1,
  type TaskCheckpointPayloadCodecV1,
  createAndCommitTaskCheckpointV1,
  createJournalContextV1,
} from "../src/index.js";
import { openFencedTestSession } from "./support/fenced-file-session.js";

const signal = new AbortController().signal;

describe("deterministic task checkpoint generation", () => {
  test("binds structured content to one consumable canonical fact range", async () => {
    const left = await createAndCommitTaskCheckpointV1(
      new MemorySession(sourceFacts()),
      checkpointInput(),
      inlineCodec(),
      signal,
    );
    const right = await createAndCommitTaskCheckpointV1(
      new MemorySession(sourceFacts()),
      checkpointInput(),
      inlineCodec(),
      signal,
    );

    expect(left).toEqual(right);
    expect(left.status).toBe("committed");
    expect(left.fact).toMatchObject({
      type: "context.checkpoint_recorded",
      checkpointId: "checkpoint-1",
      sourceFromSeq: 2,
      sourceThroughSeq: 3,
      sourceInputHash: expect.stringContaining("model.settled"),
      checkpoint: {
        kind: "inline",
        hash: expect.stringContaining("paw.task-checkpoint.v1"),
      },
    });
  });

  test("uses the same canonical hash input during generation and Context replay", async () => {
    const session = new MemorySession(sourceFacts(jsonStringHash));
    const result = await createAndCommitTaskCheckpointV1(
      session,
      checkpointInput(),
      {
        hash: jsonStringHash,
        encode: (value) => ({
          kind: "inline",
          value,
          hash: jsonStringHash(value),
        }),
      },
      signal,
    );
    expect(result.status).toBe("committed");

    const request = await createJournalContextV1({
      payloads: {
        async resolve(payload) {
          if (payload.kind !== "inline") throw new Error("unexpected artifact");
          return payload.value;
        },
        hash: jsonStringHash,
      },
      providerProtocol: "openai-compatible",
      budget: generousBudget(),
    }).build(await session.readInputSnapshot(), { signal });

    expect(request.contextSections).toHaveLength(1);
    expect(request.messages.map((message) => message.content)).not.toContain(
      "old assistant answer",
    );
  });

  test("allows an artifact payload without letting the codec mutate authority", async () => {
    let mutationBlocked = false;
    let encodedValue: JsonValue | undefined;
    const codec: TaskCheckpointPayloadCodecV1 = {
      hash: stableHash,
      encode: async (value) => {
        encodedValue = value;
        try {
          (value as { confirmedFacts?: unknown }).confirmedFacts = [];
        } catch {
          mutationBlocked = true;
        }
        return {
          kind: "artifact_ref",
          artifactRef: "artifact:checkpoint-1",
          hash: stableHash(value),
        };
      },
    };
    const result = await createAndCommitTaskCheckpointV1(
      new MemorySession(sourceFacts()),
      checkpointInput(),
      codec,
      signal,
    );

    expect(result.status).toBe("committed");
    expect(mutationBlocked).toBeTrue();
    expect(Object.isFrozen(encodedValue)).toBeTrue();
    expect(encodedValue).toEqual(checkpointValue() as unknown as JsonValue);
    expect(result.fact?.checkpoint).toEqual({
      kind: "artifact_ref",
      artifactRef: "artifact:checkpoint-1",
      hash: stableHash(checkpointValue() as unknown as JsonValue),
    });
  });

  test("rejects missing cited facts and future source ranges", async () => {
    const missing: TaskCheckpointV1 = {
      ...checkpointValue(),
      confirmedFacts: [
        { statement: "not in the source range", sourceSeqs: [4] },
      ],
    };
    await expect(
      createAndCommitTaskCheckpointV1(
        new MemorySession(sourceFacts()),
        { ...checkpointInput(), checkpoint: missing },
        inlineCodec(),
        signal,
      ),
    ).rejects.toThrow("references missing input fact seq 4");
    await expect(
      createAndCommitTaskCheckpointV1(
        new MemorySession(sourceFacts()),
        { ...checkpointInput(), sourceThroughSeq: 7 },
        inlineCodec(),
        signal,
      ),
    ).rejects.toThrow("generation input is invalid");
  });

  test("rejects protected and partial tool ranges before codec or Session writes", async () => {
    let codecCalls = 0;
    const codec: TaskCheckpointPayloadCodecV1 = {
      hash(value) {
        codecCalls += 1;
        return stableHash(value);
      },
      encode(value) {
        codecCalls += 1;
        return { kind: "inline", value, hash: stableHash(value) };
      },
    };
    const protectedSession = new MemorySession(sourceFacts());
    await expect(
      createAndCommitTaskCheckpointV1(
        protectedSession,
        { ...checkpointInput(), sourceFromSeq: 1, sourceThroughSeq: 1 },
        codec,
        signal,
      ),
    ).rejects.toThrow("covers protected context evidence");
    expect(codecCalls).toBe(0);
    expect((await protectedSession.readInputSnapshot()).tailSeq).toBe(6);

    const partialSession = new MemorySession(toolSourceFacts());
    await expect(
      createAndCommitTaskCheckpointV1(
        partialSession,
        { ...checkpointInput(), sourceFromSeq: 2, sourceThroughSeq: 4 },
        codec,
        signal,
      ),
    ).rejects.toThrow("partially covers a timeline unit");
    expect(codecCalls).toBe(0);
    expect((await partialSession.readInputSnapshot()).tailSeq).toBe(6);
  });

  test("rejects a codec that misbinds the persisted content hash", async () => {
    await expect(
      createAndCommitTaskCheckpointV1(
        new MemorySession(sourceFacts()),
        checkpointInput(),
        {
          hash: stableHash,
          encode: (value) => ({ kind: "inline", value, hash: "wrong-hash" }),
        },
        signal,
      ),
    ).rejects.toThrow("payload hash does not match");
  });

  test("uses an internal Session-bound CAS for a late stale generator", async () => {
    const session = new MemorySession(sourceFacts());
    let inserted = false;
    const result = await createAndCommitTaskCheckpointV1(
      session,
      checkpointInput(),
      {
        hash: stableHash,
        async encode(value) {
          if (!inserted) {
            inserted = true;
            await session.appendInputFacts([
              {
                type: "runtime.failed",
                area: "context",
                errorCode: "ConcurrentInput",
                message: "new fact won the race",
                retryable: true,
              },
            ]);
          }
          return { kind: "inline", value, hash: stableHash(value) };
        },
      },
      signal,
    );

    expect(result).toEqual({ status: "conflict" });
    expect(
      (await session.readInputSnapshot()).entries.some(
        (entry) => entry.fact.type === "context.checkpoint_recorded",
      ),
    ).toBeFalse();
  });

  test("persists two monotonic versions and restores a consumable latest checkpoint", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "paw-checkpoint-chain-"),
    );
    try {
      let session = openFileSession(root);
      await session.appendInputFacts(sourceFacts());
      const first = await createAndCommitTaskCheckpointV1(
        session,
        checkpointInput(),
        inlineCodec(),
        signal,
      );
      expect(first.status).toBe("committed");
      const second = await createAndCommitTaskCheckpointV1(
        session,
        {
          ...checkpointInput(),
          checkpointId: "checkpoint-2",
          checkpoint: {
            ...checkpointValue(),
            confirmedFacts: [
              { statement: "old answer remains summarized", sourceSeqs: [3] },
            ],
          },
        },
        inlineCodec(),
        signal,
      );
      expect(second.status).toBe("committed");
      expect(second.fact?.supersedesCheckpointId).toBe("checkpoint-1");
      session.close();

      session = openFileSession(root);
      const restored = await session.readInputSnapshot();
      const checkpoints = restored.entries.flatMap((entry) =>
        entry.fact.type === "context.checkpoint_recorded" ? [entry.fact] : [],
      );
      expect(checkpoints.map((item) => item.checkpointId)).toEqual([
        "checkpoint-1",
        "checkpoint-2",
      ]);
      const request = await createJournalContextV1({
        payloads: {
          async resolve(payload) {
            if (payload.kind !== "inline")
              throw new Error("unexpected artifact");
            return payload.value;
          },
          hash: stableHash,
        },
        providerProtocol: "openai-compatible",
        budget: generousBudget(),
      }).build(restored, { signal });
      expect(request.messages.map((message) => message.content)).toEqual([
        "fix the regression",
        "current request",
        "latest assistant answer",
      ]);
      expect(request.contextSections?.[0]?.id).toBe("checkpoint-2");
      session.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("honors cancellation before codec side effects", async () => {
    const controller = new AbortController();
    controller.abort("stop checkpoint");
    let calls = 0;
    await expect(
      createAndCommitTaskCheckpointV1(
        new MemorySession(sourceFacts()),
        checkpointInput(),
        {
          hash() {
            calls += 1;
            return "hash";
          },
          encode() {
            calls += 1;
            throw new Error("must not encode");
          },
        },
        controller.signal,
      ),
    ).rejects.toThrow("stop checkpoint");
    expect(calls).toBe(0);
  });
});

class MemorySession implements Session<InputFactV1, unknown> {
  private readonly entries: { seq: number; fact: InputFactV1 }[];
  private tailSeq: number;

  constructor(facts: readonly InputFactV1[]) {
    this.entries = facts.map((fact, index) => ({ seq: index + 1, fact }));
    this.tailSeq = facts.length;
  }

  async readInputSnapshot(): Promise<SessionInputSnapshot<InputFactV1>> {
    return {
      entries: this.entries.map((entry) => ({ ...entry })),
      tailSeq: this.tailSeq,
      latestInputSeq: this.entries.at(-1)?.seq ?? 0,
    };
  }

  async appendInputFacts(facts: readonly InputFactV1[]): Promise<void> {
    for (const fact of facts) {
      this.tailSeq += 1;
      this.entries.push({ seq: this.tailSeq, fact });
    }
  }

  async commitInputFacts(
    expectedTailSeq: number,
    facts: readonly InputFactV1[],
  ): Promise<"committed" | "conflict"> {
    if (expectedTailSeq !== this.tailSeq) return "conflict";
    await this.appendInputFacts(facts);
    return "committed";
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

function sourceFacts(
  hash: (value: JsonValue) => string = stableHash,
): readonly InputFactV1[] {
  return [
    promoted("goal", "initial", "fix the regression"),
    modelDispatch("old-model", 1),
    modelSettled("old-model", 1, "old assistant answer", hash),
    promoted("current", "initial", "current request"),
    modelDispatch("latest-model", 2),
    modelSettled("latest-model", 2, "latest assistant answer", hash),
  ];
}

function toolSourceFacts(): readonly InputFactV1[] {
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
    modelDispatch("tool-model", 1),
    {
      type: "model.settled",
      modelCallId: "tool-model",
      turn: 1,
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
      turn: 1,
      tool: "workspace_read_file",
      args: { path: "a.ts" },
      order: 0,
    },
    {
      type: "tool.settled",
      callId: "call-1",
      status: "completed",
      observation: {
        schemaVersion: TOOL_OBSERVATION_SCHEMA_VERSION_V1,
        summary: "read a.ts",
        isError: false,
      },
    },
    promoted("current", "initial", "current request"),
  ];
}

function checkpointInput() {
  return {
    checkpointId: "checkpoint-1",
    policyVersion: "checkpoint-policy-v1",
    sourceFromSeq: 2,
    sourceThroughSeq: 3,
    checkpoint: checkpointValue(),
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
  hash: (value: JsonValue) => string = stableHash,
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
    response: inline(response as unknown as JsonValue, hash),
  };
}

function openFileSession(root: string): FileRunSessionV1 {
  return openFencedTestSession(root, { clock: () => 42 });
}

function generousBudget() {
  return {
    contextWindowTokens: 100_000,
    reservedOutputTokens: 1_000,
    estimationMarginTokens: 1_000,
    estimatorId: "test-estimator",
    estimatorVersion: "1",
    estimator: {
      count: (text: string) => text.length,
      countMessages: (messages: readonly unknown[]) =>
        JSON.stringify(messages).length,
    },
  };
}

function inlineCodec(): TaskCheckpointPayloadCodecV1 {
  return {
    hash: stableHash,
    encode: (value) => ({ kind: "inline", value, hash: stableHash(value) }),
  };
}

function inline(
  value: JsonValue,
  hash: (value: JsonValue) => string = stableHash,
) {
  return { kind: "inline" as const, value, hash: hash(value) };
}

function jsonStringHash(value: JsonValue): string {
  return `json:${JSON.stringify(value)}`;
}

function stableHash(value: JsonValue): string {
  return `hash:${stableStringify(value)}`;
}

function stableStringify(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const record = value as Readonly<Record<string, JsonValue>>;
  return `{${Object.keys(record)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${stableStringify(record[key] as JsonValue)}`,
    )
    .join(",")}}`;
}
