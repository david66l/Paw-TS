import { describe, expect, test } from "bun:test";
import {
  type ControlDecisionActionV1,
  type DerivedDecisionV1,
  type InputAcceptedFactV1,
  type InputFactV1,
  type InputPromotedFactV1,
  RUN_JOURNAL_SCHEMA_VERSION_V1,
  type RunJournalEnvelopeV1,
} from "@paw/protocol";

import {
  type ControlDecision,
  INTERACTIVE_CONTROL_REDUCER_VERSION_V2,
  type InteractiveControlConfigV2,
  createInteractiveControlReducerV2,
  planWorkSegmentStartV1,
} from "../src/index.js";

const config: InteractiveControlConfigV2 = {
  mode: "interactive",
  maxModelTurns: 4,
  naturalStop: "complete",
  maxSegments: 3,
  maxTotalModelTurns: 12,
};

describe("work segment start planner", () => {
  test("plans marker+promotion directly after an exact terminal decision tail", () => {
    const prefix = prefixWithDecisionTail("queue-1");
    const segmentPlan = buildPlan(prefix, "queue-1", promotion("queue-1"));

    expect(segmentPlan.expectedTailSeq).toBe(prefix.length);
    expect(segmentPlan.decisionToCommit).toBeUndefined();
    expect(segmentPlan.facts).toEqual([
      expect.objectContaining({
        type: "work.segment_started",
        segmentIndex: 1,
        inputId: "queue-1",
        reducerVersion: INTERACTIVE_CONTROL_REDUCER_VERSION_V2,
      }),
      promotion("queue-1"),
    ]);
    expect(segmentPlan.prospectivePrefix.slice(-2).map(recordType)).toEqual([
      "work.segment_started",
      "input.promoted",
    ]);
    expect(segmentPlan.cursor).toEqual({
      lastModelTurn: 1,
      nextBoundary: "before_first_model_request",
    });
  });

  test("atomically plans the current decision before marker+promotion when accepted is the tail", () => {
    const prefix = prefixWithAcceptedTail("queue-1");
    const segmentPlan = buildPlan(prefix, "queue-1", promotion("queue-1"));

    expect(segmentPlan.expectedTailSeq).toBe(prefix.length);
    expect(segmentPlan.decisionToCommit).toMatchObject({
      type: "control.decided",
      reducerVersion: INTERACTIVE_CONTROL_REDUCER_VERSION_V2,
      inputThroughSeq: prefix.length,
      action: { kind: "complete", reasonCode: "interactive-natural-stop" },
    });
    expect(segmentPlan.prospectivePrefix.slice(-3).map(recordType)).toEqual([
      "control.decided",
      "work.segment_started",
      "input.promoted",
    ]);
    expect(segmentPlan.prospectiveSnapshot.tailSeq).toBe(prefix.length + 3);
  });

  test("requires the exact first pending queue input and never falls back", () => {
    const prefix = prefixWithDecisionTail("queue-1", [accepted("queue-2")]);

    expect(() => buildPlan(prefix, "queue-2", promotion("queue-2"))).toThrow(
      /exact first pending queue input/i,
    );
    expect(() => buildPlan(prefix, "missing", promotion("missing"))).toThrow(
      /exact first pending queue input/i,
    );
    expect(() =>
      buildPlan(prefix, "queue-1", {
        ...promotion("queue-1"),
        delivery: "steer",
      }),
    ).toThrow(/identity mismatch/i);
  });

  test("rejects a legacy promoted input, replay drift, and exhausted prospective segment", () => {
    const promotedPrefix = [
      ...prefixWithDecisionTail("queue-1"),
      factEnvelope(7, promotion("queue-1")),
    ];
    expect(() =>
      buildPlan(promotedPrefix, "queue-1", promotion("queue-1")),
    ).toThrow();

    const drifted = prefixWithDecisionTail("queue-1").map((envelope) =>
      envelope.record.kind === "derived_decision"
        ? {
            ...envelope,
            record: {
              kind: "derived_decision" as const,
              decision: {
                ...envelope.record.decision,
                stateHash: "tampered-state-hash",
              },
            },
          }
        : envelope,
    );
    expect(() => buildPlan(drifted, "queue-1", promotion("queue-1"))).toThrow(
      /replay divergence/i,
    );

    expect(() =>
      planWorkSegmentStartV1({
        fullPrefix: prefixWithDecisionTail("queue-1"),
        inputId: "queue-1",
        promotion: promotion("queue-1"),
        verification: verification({ ...config, maxSegments: 1 }),
      }),
    ).toThrow(/does not reduce to one continuing segment/i);
  });

  test("validates the full historical lifecycle before deriving the segment cursor", () => {
    const valid = prefixWithDecisionTail("queue-1");
    const openModel = valid.flatMap((envelope) =>
      envelope.seq === 4
        ? []
        : [envelope.seq > 4 ? resequence(envelope, -1) : envelope],
    );
    expect(() =>
      buildPlan(openModel, "queue-1", promotion("queue-1")),
    ).toThrow();

    const wrongTurn = valid.map((envelope) =>
      envelope.record.kind === "input_fact" &&
      envelope.record.fact.type === "model.settled"
        ? {
            ...envelope,
            record: {
              kind: "input_fact" as const,
              fact: { ...envelope.record.fact, turn: 6 },
            },
          }
        : envelope,
    );
    expect(() =>
      buildPlan(wrongTurn, "queue-1", promotion("queue-1")),
    ).toThrow();
  });

  test("does not reuse a previous segment terminal for newly completed work", () => {
    const first = buildPlan(
      prefixWithDecisionTail("queue-1"),
      "queue-1",
      promotion("queue-1"),
    );
    const activeFacts: InputFactV1[] = [
      {
        type: "model.dispatch_recorded",
        modelCallId: "model-2",
        turn: 2,
        requestHash: "request-2",
      },
      {
        type: "model.settled",
        modelCallId: "model-2",
        turn: 2,
        status: "completed",
        response: {
          kind: "inline",
          value: {
            schemaVersion: "paw.model-response.v1",
            providerProtocol: "openai-compatible",
            assistantContent: "segment one done",
            finishReason: "stop",
            toolCalls: [],
          },
          hash: "response-hash-2",
        },
        finishReason: "stop",
        hasToolCalls: false,
        hasVisibleOutput: true,
      },
      accepted("queue-2"),
    ];
    const missingCurrentDecision = [
      ...first.prospectivePrefix,
      ...activeFacts.map((fact, index) =>
        factEnvelope(first.prospectivePrefix.length + index + 1, fact),
      ),
    ];

    expect(() =>
      buildPlan(missingCurrentDecision, "queue-2", promotion("queue-2")),
    ).toThrow(/current segment.*terminal decision/i);
  });

  test("returns a deterministic detached recursively frozen plan", () => {
    const mutablePrefix = structuredClone(prefixWithDecisionTail("queue-1"));
    const mutablePromotion = structuredClone(promotion("queue-1"));
    const first = buildPlan(mutablePrefix, "queue-1", mutablePromotion);
    const second = buildPlan(
      structuredClone(mutablePrefix),
      "queue-1",
      structuredClone(mutablePromotion),
    );

    expect(second).toEqual(first);
    expect(first).not.toBe(second);
    expect(isDeepFrozen(first)).toBeTrue();
    (mutablePromotion as { content: string }).content = "mutated";
    const acceptedFact = mutablePrefix.find(
      (item) =>
        item.record.kind === "input_fact" &&
        item.record.fact.type === "input.accepted",
    );
    if (
      acceptedFact?.record.kind === "input_fact" &&
      acceptedFact.record.fact.type === "input.accepted"
    ) {
      (acceptedFact.record.fact as { content: string }).content = "mutated";
    }
    expect(first.facts[1].content).toBe("content-queue-1");
  });
});

function prefixWithDecisionTail(
  inputId: string,
  extraAccepted: readonly InputAcceptedFactV1[] = [],
): readonly RunJournalEnvelopeV1[] {
  const facts = [...baseFacts(), accepted(inputId), ...extraAccepted];
  return [
    ...facts.map((fact, index) => factEnvelope(index + 1, fact)),
    decisionEnvelope(facts),
  ];
}

function prefixWithAcceptedTail(
  inputId: string,
): readonly RunJournalEnvelopeV1[] {
  const facts = baseFacts();
  return [
    ...facts.map((fact, index) => factEnvelope(index + 1, fact)),
    decisionEnvelope(facts),
    factEnvelope(facts.length + 2, accepted(inputId)),
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
        hash: "response-hash",
      },
      finishReason: "stop",
      hasToolCalls: false,
      hasVisibleOutput: true,
    },
  ];
}

function accepted(inputId: string): InputAcceptedFactV1 {
  return {
    type: "input.accepted",
    inputId,
    delivery: "queue",
    content: `content-${inputId}`,
    contentHash: `hash-${inputId}`,
    callerId: "planner-test",
  };
}

function promotion(inputId: string): InputPromotedFactV1 {
  return {
    type: "input.promoted",
    inputId,
    delivery: "queue",
    content: `content-${inputId}`,
    contentHash: `hash-${inputId}`,
  };
}

function decisionEnvelope(facts: readonly InputFactV1[]): RunJournalEnvelopeV1 {
  const reducer = createInteractiveControlReducerV2();
  const state = reducer.reduce(facts, config);
  const stateHash = JSON.stringify(state);
  return {
    schemaVersion: RUN_JOURNAL_SCHEMA_VERSION_V1,
    sessionId: "planner-session",
    runId: "planner-run",
    seq: facts.length + 1,
    ts: 1_900_000_000_000 + facts.length + 1,
    record: {
      kind: "derived_decision",
      decision: derivedDecision({
        state,
        inputThroughSeq: facts.length,
        stateHash,
        reducerVersion: INTERACTIVE_CONTROL_REDUCER_VERSION_V2,
      }),
    },
  };
}

function buildPlan(
  fullPrefix: readonly RunJournalEnvelopeV1[],
  inputId: string,
  inputPromotion: InputPromotedFactV1,
) {
  return planWorkSegmentStartV1({
    fullPrefix,
    inputId,
    promotion: inputPromotion,
    verification: verification(config),
  });
}

function verification(runConfig: InteractiveControlConfigV2) {
  return {
    runConfig,
    stateHasher: { hash: (state: unknown) => JSON.stringify(state) },
    derivedDecision,
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
    sessionId: "planner-session",
    runId: "planner-run",
    seq,
    ts: 1_900_000_000_000 + seq,
    record: { kind: "input_fact", fact },
  };
}

function resequence(
  envelope: RunJournalEnvelopeV1,
  delta: number,
): RunJournalEnvelopeV1 {
  return { ...envelope, seq: envelope.seq + delta };
}

function recordType(envelope: RunJournalEnvelopeV1): string {
  return envelope.record.kind === "input_fact"
    ? envelope.record.fact.type
    : envelope.record.decision.type;
}

function isDeepFrozen(value: unknown): boolean {
  if (value === null || typeof value !== "object") return true;
  if (!Object.isFrozen(value)) return false;
  return Object.values(value).every(isDeepFrozen);
}
