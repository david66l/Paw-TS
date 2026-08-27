import { describe, expect, test } from "bun:test";
import {
  type ControlDecisionActionV1,
  type DerivedDecisionV1,
  type InputFactV1,
  RUN_JOURNAL_SCHEMA_VERSION_V1,
  type RunJournalEnvelopeV1,
  WORK_SEGMENT_POLICY_VERSION_V1,
} from "@paw/protocol";

import {
  type ControlDecision,
  INTERACTIVE_CONTROL_REDUCER_VERSION_V2,
  type InteractiveControlConfigV1,
  type InteractiveControlConfigV2,
  assertReplayEquivalentV1,
  createInteractiveControlReducerV1,
  createInteractiveControlReducerV2,
} from "../src/index.js";

const v1Config: InteractiveControlConfigV1 = {
  mode: "interactive",
  maxModelTurns: 3,
  naturalStop: "complete",
};
const config: InteractiveControlConfigV2 = {
  ...v1Config,
  maxSegments: 3,
  maxTotalModelTurns: 8,
};

describe("interactive control reducer v2 work segments", () => {
  const v1 = createInteractiveControlReducerV1();
  const v2 = createInteractiveControlReducerV2();

  test("keeps implicit segment zero decisions equivalent to reducer v1", () => {
    const cases: readonly InputFactV1[][] = [
      [],
      [model(1, "completed", false)],
      [model(1, "unknown", false)],
      [{ type: "abort.requested", source: "user", reason: "stop" }],
      [
        {
          type: "runtime.failed",
          area: "runtime",
          errorCode: "E_RUNTIME",
          message: "failed",
          retryable: false,
        },
      ],
    ];
    for (const facts of cases) {
      expect(v2.reduce(facts, config).decision).toEqual(
        v1.reduce(facts, v1Config).decision,
      );
    }
  });

  test("does not let an old terminal, abort, runtime failure, policy, model, or tool poison the active segment", () => {
    const oldControlFacts: readonly InputFactV1[] = [
      model(1, "completed", false),
      { type: "abort.requested", source: "user", reason: "old-abort" },
      {
        type: "runtime.failed",
        area: "runtime",
        errorCode: "OLD_FAILURE",
        message: "old failure",
        retryable: false,
      },
      {
        type: "policy.request_recorded",
        policyId: "old-policy",
        policyVersion: "policy.v1",
        request: "wait",
        reasonCode: "old-wait",
      },
      tool("old-call", "unknown"),
    ];
    const state = v2.reduce(
      [...oldControlFacts, segment(1), promotion("segment-1")],
      config,
    );

    expect(state).toMatchObject({
      segmentIndex: 1,
      segmentModelTurns: 0,
      totalModelTurns: 1,
      segmentSettledToolCalls: 0,
      totalSettledToolCalls: 1,
      decision: { kind: "continue" },
    });
  });

  test("applies abort, runtime, policy, model and tool outcomes inside the active segment", () => {
    const base = [
      model(1, "completed", false),
      segment(1),
      promotion("segment-1"),
    ];
    const cases: readonly [InputFactV1[], ControlDecision["kind"]][] = [
      [
        [{ type: "abort.requested", source: "user", reason: "new-abort" }],
        "aborted",
      ],
      [
        [
          {
            type: "runtime.failed",
            area: "context",
            errorCode: "NEW_FAILURE",
            message: "new failure",
            retryable: false,
          },
        ],
        "failed",
      ],
      [
        [
          {
            type: "policy.request_recorded",
            policyId: "new-policy",
            policyVersion: "policy.v1",
            request: "wait",
            reasonCode: "new-wait",
          },
        ],
        "await_user",
      ],
      [[model(2, "unknown", false)], "incomplete"],
      [
        [
          model(2, "completed", true),
          observed("new-call", 2),
          tool("new-call", "unknown"),
        ],
        "incomplete",
      ],
    ];
    for (const [facts, expected] of cases) {
      expect(v2.reduce([...base, ...facts], config).decision.kind).toBe(
        expected,
      );
    }
  });

  test("resets segment turns but preserves total model turns and global fact turn identity", () => {
    const facts: readonly InputFactV1[] = [
      model(1, "completed", false),
      segment(1),
      promotion("segment-1"),
      model(2, "completed", true),
    ];
    const state = v2.reduce(facts, config);
    expect(state).toMatchObject({
      segmentIndex: 1,
      segmentModelTurns: 1,
      totalModelTurns: 2,
    });
    expect(
      facts
        .filter((fact) => fact.type === "model.settled")
        .map((fact) => fact.turn),
    ).toEqual([1, 2]);
  });

  test("enforces segment-count, per-segment turn, and total-turn budgets independently", () => {
    expect(
      v2.reduce([segment(1), promotion("segment-1")], {
        ...config,
        maxSegments: 1,
      }).decision,
    ).toEqual({
      kind: "incomplete",
      reason: "work-segment-budget-exhausted",
    });

    expect(
      v2.reduce(
        [
          segment(1),
          promotion("segment-1"),
          model(1, "completed", true),
          model(2, "completed", true),
        ],
        { ...config, maxModelTurns: 2 },
      ).decision,
    ).toEqual({
      kind: "incomplete",
      reason: "model-turn-budget-exhausted",
    });

    expect(
      v2.reduce(
        [
          model(1, "completed", true),
          model(2, "completed", true),
          segment(1),
          promotion("segment-1"),
        ],
        { ...config, maxModelTurns: 2, maxTotalModelTurns: 2 },
      ).decision,
    ).toEqual({
      kind: "incomplete",
      reason: "total-model-turn-budget-exhausted",
    });
  });

  test("never lets a budget replace a stronger active-segment terminal decision", () => {
    const exhausted = { ...config, maxSegments: 1, maxTotalModelTurns: 3 };
    const cases: readonly [InputFactV1[], ControlDecision["kind"]][] = [
      [
        [{ type: "abort.requested", source: "user", reason: "stop-now" }],
        "aborted",
      ],
      [
        [
          {
            type: "runtime.failed",
            area: "runtime",
            errorCode: "E_FATAL",
            message: "fatal",
            retryable: false,
          },
        ],
        "failed",
      ],
      [[model(2, "unknown", false)], "incomplete"],
      [
        [
          {
            type: "policy.request_recorded",
            policyId: "wait-policy",
            policyVersion: "policy.v1",
            request: "wait",
            reasonCode: "need-user",
          },
        ],
        "await_user",
      ],
    ];
    for (const [activeFacts, expected] of cases) {
      expect(
        v2.reduce(
          [
            model(1, "completed", true),
            segment(1),
            promotion("segment-1"),
            ...activeFacts,
          ],
          exhausted,
        ).decision.kind,
      ).toBe(expected);
    }
  });

  test("rejects marker reducer drift and returns deterministic detached frozen state", () => {
    expect(() =>
      v2.reduce(
        [{ ...segment(1), reducerVersion: "paw.interactive-control.v1" }],
        config,
      ),
    ).toThrow(/does not match interactive reducer v2/i);

    const facts: InputFactV1[] = [segment(1), promotion("segment-1")];
    const first = v2.reduce(facts, config);
    const second = v2.reduce(structuredClone(facts), structuredClone(config));
    expect(second).toEqual(first);
    expect(first).not.toBe(second);
    expect(Object.isFrozen(first)).toBeTrue();
    expect(Object.isFrozen(first.decision)).toBeTrue();
    facts.push(model(2, "unknown", false));
    expect(first.decision).toEqual({ kind: "continue" });
  });

  test("replays both terminal and continuing state hashes across one segment boundary", () => {
    const prefix = replayPrefix();
    const verification = {
      runConfig: config,
      reducerVersion: INTERACTIVE_CONTROL_REDUCER_VERSION_V2,
      reducer: v2,
      stateHasher: {
        hash: (state: ReturnType<typeof v2.reduce>) => JSON.stringify(state),
      },
      derivedDecision: decisionFromState,
    };

    expect(() => assertReplayEquivalentV1(prefix, verification)).not.toThrow();
    const drifted = prefix.map((item) =>
      item.seq === 9 && item.record.kind === "derived_decision"
        ? {
            ...item,
            record: {
              kind: "derived_decision" as const,
              decision: {
                ...item.record.decision,
                stateHash: "tampered-segment-state",
              },
            },
          }
        : item,
    );
    expect(() => assertReplayEquivalentV1(drifted, verification)).toThrow(
      /Replay divergence at journal seq 9.*stateHash/i,
    );
  });
});

function replayPrefix(): readonly RunJournalEnvelopeV1[] {
  const reducer = createInteractiveControlReducerV2();
  const initialFacts: InputFactV1[] = [
    {
      type: "attempt.started",
      goalHash: "goal-hash",
      configHash: "config-hash",
    },
    promotion("initial-input", "initial"),
    {
      type: "model.dispatch_recorded",
      modelCallId: "model-1",
      turn: 1,
      requestHash: "request-1",
    },
    {
      ...model(1, "completed", false),
      response: {
        kind: "inline",
        value: {
          schemaVersion: "paw.model-response.v1",
          providerProtocol: "openai-compatible",
          assistantContent: "segment zero complete",
          finishReason: "stop",
          toolCalls: [],
        },
        hash: "model-response-hash",
      },
      finishReason: "stop",
    },
    {
      type: "input.accepted",
      inputId: "segment-1",
      delivery: "queue",
      content: "content-segment-1",
      contentHash: "hash-segment-1",
      callerId: "test-caller",
    },
  ];
  const terminal = reducer.reduce(initialFacts, config);
  const terminalHash = JSON.stringify(terminal);
  const markerFact = {
    ...segment(1),
    previousDecisionStateHash: terminalHash,
    previousAction: actionFromDecision(terminal.decision),
  };
  const allFacts: InputFactV1[] = [
    ...initialFacts,
    markerFact,
    promotion("segment-1"),
  ];
  const continuing = reducer.reduce(allFacts, config);
  const continuingHash = JSON.stringify(continuing);
  return [
    ...initialFacts.map((fact, index) => factEnvelope(index + 1, fact)),
    decisionEnvelope(6, 5, terminalHash, actionFromDecision(terminal.decision)),
    factEnvelope(7, markerFact),
    factEnvelope(8, promotion("segment-1")),
    decisionEnvelope(
      9,
      8,
      continuingHash,
      actionFromDecision(continuing.decision),
    ),
  ];
}

function decisionFromState(input: {
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
    sessionId: "replay-session",
    runId: "replay-run",
    seq,
    ts: 1_800_000_100_000 + seq,
    record: { kind: "input_fact", fact },
  };
}

function decisionEnvelope(
  seq: number,
  inputThroughSeq: number,
  stateHash: string,
  action: ControlDecisionActionV1,
): RunJournalEnvelopeV1 {
  return {
    schemaVersion: RUN_JOURNAL_SCHEMA_VERSION_V1,
    sessionId: "replay-session",
    runId: "replay-run",
    seq,
    ts: 1_800_000_100_000 + seq,
    record: {
      kind: "derived_decision",
      decision: {
        type: "control.decided",
        reducerVersion: INTERACTIVE_CONTROL_REDUCER_VERSION_V2,
        inputThroughSeq,
        stateHash,
        action,
      },
    },
  };
}

function segment(
  segmentIndex: number,
): Extract<InputFactV1, { type: "work.segment_started" }> {
  return {
    type: "work.segment_started",
    segmentIndex,
    inputId: `segment-${segmentIndex}`,
    reducerVersion: INTERACTIVE_CONTROL_REDUCER_VERSION_V2,
    previousDecisionStateHash: `state-${segmentIndex}`,
    previousAction: { kind: "complete", reasonCode: "previous-complete" },
    policyVersion: WORK_SEGMENT_POLICY_VERSION_V1,
  };
}

function promotion(
  inputId: string,
  delivery: "initial" | "queue" = "queue",
): InputFactV1 {
  return {
    type: "input.promoted",
    inputId,
    delivery,
    content: `content-${inputId}`,
    contentHash: `hash-${inputId}`,
  };
}

function model(
  turn: number,
  status: Extract<InputFactV1, { type: "model.settled" }>["status"],
  hasToolCalls: boolean,
): Extract<InputFactV1, { type: "model.settled" }> {
  return {
    type: "model.settled",
    modelCallId: `model-${turn}`,
    turn,
    status,
    hasToolCalls,
    hasVisibleOutput: status === "completed",
  };
}

function observed(
  callId: string,
  turn: number,
): Extract<InputFactV1, { type: "tool.call_observed" }> {
  return {
    type: "tool.call_observed",
    callId,
    modelCallId: `model-${turn}`,
    turn,
    tool: "workspace_read_file",
    args: { path: "file.txt" },
    order: 0,
  };
}

function tool(
  callId: string,
  status: Extract<InputFactV1, { type: "tool.settled" }>["status"],
): Extract<InputFactV1, { type: "tool.settled" }> {
  return { type: "tool.settled", callId, status };
}
