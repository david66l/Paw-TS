import { describe, expect, test } from "bun:test";

import {
  type ControlDecisionActionV1,
  CRASH_RECOVERY_INCOMPLETE_REASONS_V1,
  RUN_JOURNAL_SCHEMA_VERSION_V1,
  type RunJournalEnvelopeV1,
  WORK_SEGMENT_POLICY_VERSION_V1,
  parseRunJournalEnvelopeV1,
  parseRunJournalPrefixV1,
} from "../src/index.js";

const REDUCER_V2 = "paw.interactive-control.v2";
const COMPLETE = { kind: "complete", reasonCode: "segment-done" } as const;

describe("canonical work segment protocol", () => {
  test("strictly parses the exact marker shape", () => {
    const exact = marker(1, "next-input", COMPLETE, "state-terminal");
    expect(parseRunJournalEnvelopeV1(envelope(5, exact))).toEqual(
      envelope(5, exact),
    );

    for (const invalid of [
      { ...exact, segmentIndex: 0 },
      { ...exact, segmentIndex: 1.5 },
      { ...exact, inputId: "" },
      { ...exact, reducerVersion: "" },
      { ...exact, previousDecisionStateHash: "" },
      { ...exact, policyVersion: "paw.work-segment.v2" },
      { ...exact, extra: true },
    ]) {
      expect(() => parseRunJournalEnvelopeV1(envelope(5, invalid))).toThrow();
    }
  });

  test("accepts only decision then bound marker then matching promotion", () => {
    const complete = segmentPrefix({ action: COMPLETE });
    expect(parseRunJournalPrefixV1(complete)).toEqual(complete);

    const waitUser = segmentPrefix({
      action: {
        kind: "wait",
        waitFor: "user",
        reasonCode: "need-user-input",
      },
    });
    expect(parseRunJournalPrefixV1(waitUser)).toEqual(waitUser);
  });

  test("keeps legacy bare terminal promotion readable but forbids it after segment mode begins", () => {
    const legacy = [
      ...segmentPrefix({ action: COMPLETE }).slice(0, 4),
      envelope(5, promoted("next-input", "next-content")),
    ];
    expect(parseRunJournalPrefixV1(legacy)).toEqual(legacy);

    const segmented = [
      ...segmentPrefix({ action: COMPLETE }),
      envelope(7, accepted("segment-2", "segment-2-content")),
      decision(8, 7, COMPLETE, "state-segment-2"),
      envelope(9, promoted("segment-2", "segment-2-content")),
    ];
    expect(() => parseRunJournalPrefixV1(segmented)).toThrow(
      /requires a work segment marker/i,
    );
  });

  test("rejects half segments and every previous-decision identity drift", () => {
    const valid = segmentPrefix({ action: COMPLETE });
    expect(() => parseRunJournalPrefixV1(valid.slice(0, -1))).toThrow(
      /immediately precede its promotion/i,
    );

    for (const mutate of [
      (fact: Marker): Marker => ({
        ...fact,
        previousDecisionStateHash: "wrong-state",
      }),
      (fact: Marker): Marker => ({
        ...fact,
        previousAction: {
          kind: "complete" as const,
          reasonCode: "wrong-reason",
        },
      }),
      (fact: Marker): Marker => ({
        ...fact,
        reducerVersion: "wrong-reducer",
      }),
    ]) {
      const candidate = replaceMarker(valid, mutate(markerFrom(valid)));
      expect(() => parseRunJournalPrefixV1(candidate)).toThrow();
    }
  });

  test("rejects non-eligible terminal actions", () => {
    const actions: readonly ControlDecisionActionV1[] = [
      { kind: "continue", reasonCode: "continue" },
      { kind: "wait", waitFor: "external", reasonCode: "external" },
      { kind: "incomplete", reasonCode: "incomplete" },
      { kind: "incomplete", reasonCode: "model-turn-budget-exhausted" },
      { kind: "failed", reasonCode: "failed" },
      { kind: "abort", reasonCode: "abort" },
    ];
    for (const action of actions) {
      expect(() => parseRunJournalPrefixV1(segmentPrefix({ action }))).toThrow(
        /eligible terminal decision/i,
      );
    }
  });

  test("accepts crash-recovered incomplete terminal actions", () => {
    // 用户决策（2026-08-21）：repair 结算的 unknown 族 incomplete 可接续段。
    for (const reasonCode of CRASH_RECOVERY_INCOMPLETE_REASONS_V1) {
      expect(() =>
        parseRunJournalPrefixV1(
          segmentPrefix({ action: { kind: "incomplete", reasonCode } }),
        ),
      ).not.toThrow();
    }
  });

  test("rejects missing or mismatched admission, promotion reuse, and index gaps", () => {
    const valid = segmentPrefix({ action: COMPLETE });
    const withoutAdmission = valid.filter((item) => item.seq !== 3);
    expect(() => parseRunJournalPrefixV1(resequence(withoutAdmission))).toThrow(
      /no durable admission/i,
    );

    const wrongPromotion = valid.map((item) =>
      item.seq === 6
        ? envelope(6, promoted("next-input", "different-content"))
        : item,
    );
    expect(() => parseRunJournalPrefixV1(wrongPromotion)).toThrow(
      /identity mismatch/i,
    );

    const gap = replaceMarker(valid, { ...markerFrom(valid), segmentIndex: 2 });
    expect(() => parseRunJournalPrefixV1(gap)).toThrow(/contiguous from 1/i);

    const reused = [
      ...valid,
      envelope(7, accepted("another-input", "another-content")),
      decision(8, 7, COMPLETE, "state-second"),
      envelope(9, marker(2, "next-input", COMPLETE, "state-second")),
      envelope(10, promoted("next-input", "next-content")),
    ];
    expect(() => parseRunJournalPrefixV1(reused)).toThrow(/already promoted/i);
  });

  test("rejects dispatch or a segment marker across unfinished canonical work", () => {
    const terminalThenDispatch = [
      ...segmentPrefix({ action: COMPLETE }).slice(0, 4),
      envelope(5, {
        type: "model.dispatch_recorded",
        modelCallId: "model-after-terminal",
        turn: 1,
        requestHash: "request-after-terminal",
      }),
    ];
    expect(() => parseRunJournalPrefixV1(terminalThenDispatch)).toThrow(
      /work segment/i,
    );

    const openModel = boundaryPrefix([
      {
        type: "model.dispatch_recorded",
        modelCallId: "open-model",
        turn: 1,
        requestHash: "open-request",
      },
    ]);
    expect(() => parseRunJournalPrefixV1(openModel)).toThrow(
      /unsettled model/i,
    );

    const openTool = boundaryPrefix(openToolFacts());
    expect(() => parseRunJournalPrefixV1(openTool)).toThrow(/tool lifecycle/i);

    const openClaim = boundaryPrefix([distillationClaim()]);
    expect(() => parseRunJournalPrefixV1(openClaim)).toThrow(/distillation/i);

    const completedUnrecorded = boundaryPrefix([
      distillationClaim(),
      {
        type: "context.checkpoint_distillation_settled",
        claimId: "segment-claim",
        status: "completed",
        checkpoint: {
          kind: "inline",
          value: checkpoint(),
          hash: "checkpoint-hash",
        },
      },
    ]);
    expect(() => parseRunJournalPrefixV1(completedUnrecorded)).toThrow(
      /distillation/i,
    );
  });

  test("keeps model turns globally increasing across a segment marker", () => {
    const prefix = [
      ...segmentPrefix({ action: COMPLETE }),
      envelope(7, {
        type: "model.dispatch_recorded",
        modelCallId: "model-2",
        turn: 2,
        requestHash: "request-2",
      }),
      envelope(8, {
        type: "model.settled",
        modelCallId: "model-2",
        turn: 2,
        status: "completed",
        hasToolCalls: false,
        hasVisibleOutput: true,
        response: {
          kind: "inline",
          value: {
            schemaVersion: "paw.model-response.v1",
            providerProtocol: "openai-compatible",
            assistantContent: "segment two",
            finishReason: "stop",
            toolCalls: [],
          },
          hash: "response-2",
        },
        finishReason: "stop",
      }),
    ];
    expect(parseRunJournalPrefixV1(prefix)).toEqual(prefix);
  });

  test("allows any positive first turn but rejects reset, duplicate, or decreasing turns after a segment", () => {
    expect(parseRunJournalPrefixV1(globalTurnPrefix(6))).toEqual(
      globalTurnPrefix(6),
    );
    for (const turn of [1, 4, 5]) {
      expect(() => parseRunJournalPrefixV1(globalTurnPrefix(turn))).toThrow(
        /model dispatch turn/i,
      );
    }
  });
});

type Marker = ReturnType<typeof marker>;

function segmentPrefix(input: {
  readonly action: ControlDecisionActionV1;
}): readonly RunJournalEnvelopeV1[] {
  const stateHash = "state-terminal";
  return [
    envelope(1, {
      type: "attempt.started",
      goalHash: "goal-hash",
      configHash: "config-hash",
    }),
    envelope(2, {
      type: "input.promoted",
      inputId: "initial-input",
      delivery: "initial",
      content: "initial-content",
      contentHash: "initial-hash",
    }),
    envelope(3, accepted("next-input", "next-content")),
    decision(4, 3, input.action, stateHash),
    envelope(5, marker(1, "next-input", input.action, stateHash)),
    envelope(6, promoted("next-input", "next-content")),
  ];
}

function boundaryPrefix(
  interveningFacts: readonly unknown[],
): readonly RunJournalEnvelopeV1[] {
  const prefix: RunJournalEnvelopeV1[] = [
    envelope(1, {
      type: "attempt.started",
      goalHash: "goal-hash",
      configHash: "config-hash",
    }),
    envelope(2, {
      type: "input.promoted",
      inputId: "initial-input",
      delivery: "initial",
      content: "initial-content",
      contentHash: "initial-hash",
    }),
    envelope(3, accepted("next-input", "next-content")),
  ];
  for (const fact of interveningFacts) {
    prefix.push(envelope(prefix.length + 1, fact));
  }
  const stateHash = "boundary-state";
  const decisionSeq = prefix.length + 1;
  prefix.push(decision(decisionSeq, decisionSeq - 1, COMPLETE, stateHash));
  prefix.push(
    envelope(prefix.length + 1, marker(1, "next-input", COMPLETE, stateHash)),
  );
  prefix.push(
    envelope(prefix.length + 1, promoted("next-input", "next-content")),
  );
  return prefix;
}

function globalTurnPrefix(secondTurn: number): readonly RunJournalEnvelopeV1[] {
  const firstResponse = {
    kind: "inline" as const,
    value: {
      schemaVersion: "paw.model-response.v1",
      providerProtocol: "openai-compatible",
      assistantContent: "first segment",
      finishReason: "stop",
      toolCalls: [],
    },
    hash: "first-response",
  };
  return [
    envelope(1, {
      type: "attempt.started",
      goalHash: "goal-hash",
      configHash: "config-hash",
    }),
    envelope(2, {
      type: "input.promoted",
      inputId: "initial-input",
      delivery: "initial",
      content: "initial-content",
      contentHash: "initial-hash",
    }),
    envelope(3, {
      type: "model.dispatch_recorded",
      modelCallId: "model-5",
      turn: 5,
      requestHash: "request-5",
    }),
    envelope(4, {
      type: "model.settled",
      modelCallId: "model-5",
      turn: 5,
      status: "completed",
      hasToolCalls: false,
      hasVisibleOutput: true,
      response: firstResponse,
      finishReason: "stop",
    }),
    envelope(5, accepted("next-input", "next-content")),
    decision(6, 5, COMPLETE, "global-turn-state"),
    envelope(7, marker(1, "next-input", COMPLETE, "global-turn-state")),
    envelope(8, promoted("next-input", "next-content")),
    envelope(9, {
      type: "model.dispatch_recorded",
      modelCallId: `model-next-${secondTurn}`,
      turn: secondTurn,
      requestHash: `request-${secondTurn}`,
    }),
  ];
}

function openToolFacts(): readonly unknown[] {
  const call = {
    callId: "open-call",
    name: "workspace_read_file",
    rawArguments: JSON.stringify({ path: "file.txt" }),
    args: { path: "file.txt" },
    sourceIndex: 0,
    argumentsValid: true,
  };
  return [
    {
      type: "model.dispatch_recorded",
      modelCallId: "tool-model",
      turn: 1,
      requestHash: "tool-request",
    },
    {
      type: "model.settled",
      modelCallId: "tool-model",
      turn: 1,
      status: "completed",
      hasToolCalls: true,
      hasVisibleOutput: false,
      response: {
        kind: "inline",
        value: {
          schemaVersion: "paw.model-response.v1",
          providerProtocol: "openai-compatible",
          assistantContent: "",
          finishReason: "tool_calls",
          toolCalls: [call],
        },
        hash: "tool-response-hash",
      },
      finishReason: "tool_calls",
    },
    {
      type: "tool.call_observed",
      callId: call.callId,
      modelCallId: "tool-model",
      turn: 1,
      tool: call.name,
      args: call.args,
      order: 0,
    },
    {
      type: "tool.dispatch_recorded",
      callId: call.callId,
      turn: 1,
      sourceIndex: 0,
      batchId: "tool-batch",
      mode: "serial",
    },
    {
      type: "tool.permission_resolved",
      turn: 1,
      sourceIndex: 0,
      callId: call.callId,
      tool: call.name,
      policyVersion: "permission.v1",
      resolution: "allow_once",
      source: "base_policy",
    },
  ];
}

function distillationClaim() {
  return {
    type: "context.checkpoint_distillation_claimed" as const,
    claimId: "segment-claim",
    checkpointId: "segment-checkpoint",
    boundary: "after_model_turn_without_tool_calls" as const,
    policyVersion: "checkpoint.v1",
    sourceFromSeq: 1,
    sourceThroughSeq: 2,
    sourceInputHash: "source-input-hash",
  };
}

function checkpoint() {
  return {
    schemaVersion: "paw.task-checkpoint.v1",
    goal: { statement: "goal", sourceSeqs: [1] },
    confirmedFacts: [],
    currentHypotheses: [],
    ruledOut: [],
    changedFiles: [],
    verification: [],
    unresolved: [],
    nextAction: { statement: "next", sourceSeqs: [2] },
  };
}

function accepted(inputId: string, content: string) {
  return {
    type: "input.accepted" as const,
    inputId,
    delivery: "queue" as const,
    content,
    contentHash: `${content}-hash`,
    callerId: "test-caller",
  };
}

function promoted(inputId: string, content: string) {
  return {
    type: "input.promoted" as const,
    inputId,
    delivery: "queue" as const,
    content,
    contentHash: `${content}-hash`,
  };
}

function marker(
  segmentIndex: number,
  inputId: string,
  previousAction: ControlDecisionActionV1,
  previousDecisionStateHash: string,
) {
  return {
    type: "work.segment_started" as const,
    segmentIndex,
    inputId,
    reducerVersion: REDUCER_V2,
    previousDecisionStateHash,
    previousAction,
    policyVersion: WORK_SEGMENT_POLICY_VERSION_V1,
  };
}

function decision(
  seq: number,
  inputThroughSeq: number,
  action: ControlDecisionActionV1,
  stateHash: string,
): RunJournalEnvelopeV1 {
  return {
    schemaVersion: RUN_JOURNAL_SCHEMA_VERSION_V1,
    sessionId: "segment-session",
    runId: "segment-run",
    seq,
    ts: 1_800_000_000_000 + seq,
    record: {
      kind: "derived_decision",
      decision: {
        type: "control.decided",
        reducerVersion: REDUCER_V2,
        inputThroughSeq,
        stateHash,
        action,
      },
    },
  };
}

function envelope(seq: number, fact: unknown): RunJournalEnvelopeV1 {
  return {
    schemaVersion: RUN_JOURNAL_SCHEMA_VERSION_V1,
    sessionId: "segment-session",
    runId: "segment-run",
    seq,
    ts: 1_800_000_000_000 + seq,
    record: {
      kind: "input_fact",
      fact,
    } as RunJournalEnvelopeV1["record"],
  };
}

function markerFrom(prefix: readonly RunJournalEnvelopeV1[]): Marker {
  const fact = prefix.find(
    (item) =>
      item.record.kind === "input_fact" &&
      item.record.fact.type === "work.segment_started",
  )?.record;
  if (
    !fact ||
    fact.kind !== "input_fact" ||
    fact.fact.type !== "work.segment_started"
  ) {
    throw new Error("missing marker fixture");
  }
  return fact.fact;
}

function replaceMarker(
  prefix: readonly RunJournalEnvelopeV1[],
  next: Marker,
): readonly RunJournalEnvelopeV1[] {
  return prefix.map((item) =>
    item.record.kind === "input_fact" &&
    item.record.fact.type === "work.segment_started"
      ? envelope(item.seq, next)
      : item,
  );
}

function resequence(
  prefix: readonly RunJournalEnvelopeV1[],
): readonly RunJournalEnvelopeV1[] {
  return prefix.map((item, index) => ({
    ...item,
    seq: index + 1,
    ts: 1_800_000_000_001 + index,
    ...(item.record.kind === "derived_decision"
      ? {
          record: {
            kind: "derived_decision" as const,
            decision: {
              ...item.record.decision,
              inputThroughSeq: index,
            },
          },
        }
      : {}),
  }));
}
