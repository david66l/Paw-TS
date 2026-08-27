import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { Session, SessionInputSnapshot } from "@paw/agent-loop";
import {
  type InputFactV1,
  type JsonValue,
  MODEL_RESPONSE_SCHEMA_VERSION_V1,
  TASK_CHECKPOINT_SCHEMA_VERSION_V1,
} from "@paw/protocol";

import {
  type ContextCompactionBoundaryDecisionV1,
  createContextCompactionControllerV1,
} from "../src/index.js";

const signal = new AbortController().signal;

describe("context compaction controller", () => {
  test("uses Runtime's claim, settlement, and checkpoint transaction", async () => {
    const session = new MemorySession(sourceFacts());
    let calls = 0;
    const controller = createContextCompactionControllerV1({
      session,
      distiller: {
        async distill() {
          calls += 1;
          expect(
            (await session.readInputSnapshot()).entries.at(-1)?.fact.type,
          ).toBe("context.checkpoint_distillation_claimed");
          return { status: "completed", checkpoint: checkpoint() };
        },
      },
      codec: inlineCodec(),
      signal,
    });

    const first = await controller.handleDecision(distillDecision());
    expect(first.status).toBe("ran");
    expect(first.status === "ran" && first.result.status).toBe("committed");
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

    expect(await controller.handleDecision(distillDecision())).toEqual({
      status: "throttled",
      reason: "cooldown",
    });
    expect(calls).toBe(1);
  });

  test("reuses an interrupted durable claim without a second model call", async () => {
    const session = new MemorySession(sourceFacts());
    session.failNextSettlement = true;
    let calls = 0;
    const controller = createContextCompactionControllerV1({
      session,
      distiller: {
        async distill() {
          calls += 1;
          return { status: "completed", checkpoint: checkpoint() };
        },
      },
      codec: inlineCodec(),
      signal,
    });

    await expect(controller.handleDecision(distillDecision())).rejects.toThrow(
      "simulated settlement crash",
    );
    const resumed = await controller.handleDecision(distillDecision());

    expect(resumed.status).toBe("ran");
    expect(resumed.status === "ran" && resumed.result.status).toBe(
      "interrupted",
    );
    expect(calls).toBe(1);
  });
});

class MemorySession implements Session<InputFactV1, unknown> {
  private readonly facts: InputFactV1[];
  failNextSettlement = false;

  constructor(facts: readonly InputFactV1[]) {
    this.facts = [...facts];
  }

  async readInputSnapshot(): Promise<SessionInputSnapshot<InputFactV1>> {
    return {
      tailSeq: this.facts.length,
      latestInputSeq: this.facts.length,
      entries: this.facts.map((fact, index) => ({ seq: index + 1, fact })),
    };
  }

  async appendInputFacts(facts: readonly InputFactV1[]): Promise<void> {
    if (
      this.failNextSettlement &&
      facts.some(
        (fact) => fact.type === "context.checkpoint_distillation_settled",
      )
    ) {
      this.failNextSettlement = false;
      throw new Error("simulated settlement crash");
    }
    this.facts.push(...facts);
  }

  async commitInputFacts(
    expectedTailSeq: number,
    facts: readonly InputFactV1[],
  ): Promise<"committed" | "conflict"> {
    if (expectedTailSeq !== this.facts.length) return "conflict";
    await this.appendInputFacts(facts);
    return "committed";
  }

  async commitDerivedDecision(
    _expectedTailSeq: number,
    _decision: unknown,
  ): Promise<"committed" | "conflict"> {
    return "conflict";
  }

  async commitDecisionAndInputFacts(
    expectedTailSeq: number,
    _decision: unknown,
    facts: readonly InputFactV1[],
  ): Promise<"committed" | "conflict"> {
    return this.commitInputFacts(expectedTailSeq, facts);
  }
}

function distillDecision(): ContextCompactionBoundaryDecisionV1 {
  return {
    boundary: "after_model_turn_without_tool_calls",
    context: {
      request: { messages: [] },
      level: "lossless_projection",
      tokens: {
        contextWindowTokens: 12_000,
        reservedOutputTokens: 1_000,
        hardInputLimitTokens: 11_000,
        softTargetTokens: 9_000,
        fixedInputTokens: 100,
        protectedInputTokens: 1_000,
        fullInputTokens: 10_000,
        selectedInputTokens: 10_000,
        estimatedOmittedInputTokens: 0,
        hardHeadroomTokens: 1_000,
        softHeadroomTokens: -1_000,
        estimatorId: "test",
        estimatorVersion: "v1",
      },
      selection: {
        eligibleUnits: [],
        eligibleUnitSourceSeqs: [],
        protectedUnitSourceSeqs: [],
        selectedUnitSourceSeqs: [],
        omittedUnitSourceSeqs: [],
        checkpointCoveredUnitSourceSeqs: [],
      },
    },
    compaction: {
      action: "distill",
      reason: "near_soft_limit",
      usageRatioBasisPoints: 9_000,
      range: {
        sourceFromSeq: 2,
        sourceThroughSeq: 3,
        newUnitSourceSeqs: [2],
      },
    },
  };
}

function sourceFacts(): readonly InputFactV1[] {
  return [
    promoted("goal", "fix the regression"),
    {
      type: "model.dispatch_recorded",
      modelCallId: "old",
      turn: 1,
      requestHash: "h1",
    },
    settled("old", 1, "inspected old behavior"),
    promoted("current", "continue the task"),
    {
      type: "model.dispatch_recorded",
      modelCallId: "latest",
      turn: 2,
      requestHash: "h2",
    },
    settled("latest", 2, "latest answer"),
  ];
}

function promoted(inputId: string, content: string): InputFactV1 {
  return {
    type: "input.promoted",
    inputId,
    delivery: "initial",
    content,
    contentHash: stableHash(content as unknown as JsonValue),
  };
}

function settled(
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

function checkpoint() {
  return {
    schemaVersion: TASK_CHECKPOINT_SCHEMA_VERSION_V1,
    confirmedFacts: [
      { statement: "Old behavior was inspected", sourceSeqs: [3] },
    ],
    currentHypotheses: [],
    ruledOut: [],
    changedFiles: [],
    verification: [],
    unresolved: [],
  };
}

function inlineCodec() {
  return {
    hash: stableHash,
    encode: (value: JsonValue) => inline(value),
    resolve: (payload: ReturnType<typeof inline>) => payload.value,
  };
}

function inline(value: JsonValue) {
  return { kind: "inline" as const, value, hash: stableHash(value) };
}

function stableHash(value: JsonValue): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
