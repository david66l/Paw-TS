import { describe, expect, test } from "bun:test";
import {
  type ControlDecisionActionV1,
  type DerivedDecisionV1,
  type InputFactV1,
  RUN_JOURNAL_SCHEMA_VERSION_V1,
  type RunJournalEnvelopeV1,
} from "@paw/protocol";
import {
  type ControlDecision,
  type LoopControlState,
  type ReplayVerificationV1,
  assertReplayEquivalentV1,
} from "../src/index.js";

interface ReplayConfig {
  readonly mode: "replay-test";
}

interface ReplayState extends LoopControlState {
  readonly inputCount: number;
}

const VERSION = "control-v1";

describe("canonical reducer replay", () => {
  test("validates every historical decision and never feeds decisions back", () => {
    const reducerInputs: InputFactV1[][] = [];
    let externalPortCalls = 0;
    const verification = {
      ...createVerification(),
      reducer: {
        reduce(facts: readonly InputFactV1[]) {
          reducerInputs.push([...facts]);
          return reduceFacts(facts);
        },
      },
      // These extra fields prove the pure verifier neither needs nor reaches ports.
      session: forbiddenPort(),
      model: forbiddenPort(),
      tools: forbiddenPort(),
      policy: forbiddenPort(),
      context: forbiddenPort(),
    };

    assertReplayEquivalentV1(validPrefix(), verification);

    expect(reducerInputs.map((facts) => facts.length)).toEqual([1, 2, 3]);
    expect(JSON.stringify(reducerInputs)).not.toContain("control.decided");
    expect(externalPortCalls).toBe(0);

    function forbiddenPort(): object {
      return new Proxy(
        {},
        {
          get() {
            externalPortCalls += 1;
            throw new Error("replay touched an external port");
          },
        },
      );
    }
  });

  test("reports hash, action, reason, version, and cursor divergences by seq", () => {
    const cases: ReadonlyArray<{
      readonly label: string;
      readonly prefix: readonly RunJournalEnvelopeV1[];
      readonly expected: string;
    }> = [
      {
        label: "hash",
        prefix: changeDecision(validPrefix(), 4, { stateHash: "wrong-hash" }),
        expected: "seq 4: stateHash",
      },
      {
        label: "action",
        prefix: changeDecision(validPrefix(), 4, {
          action: {
            kind: "wait",
            waitFor: "external",
            reasonCode: "need-user",
          },
        }),
        expected: "seq 4: action",
      },
      {
        label: "reason",
        prefix: changeDecision(validPrefix(), 6, {
          action: { kind: "abort", reasonCode: "wrong-reason" },
        }),
        expected: "seq 6: action",
      },
      {
        label: "version",
        prefix: changeDecision(validPrefix(), 4, {
          reducerVersion: "control-v2",
        }),
        expected: "seq 4: reducerVersion",
      },
      {
        label: "cursor",
        prefix: changeDecision(validPrefix(), 4, { inputThroughSeq: 1 }),
        expected: "seq 4: invalid canonical prefix",
      },
    ];

    for (const item of cases) {
      expect(() =>
        assertReplayEquivalentV1(item.prefix, createVerification()),
      ).toThrow(item.expected);
    }
  });

  test("detects a historical middle divergence even when the final decision matches", () => {
    const prefix = changeDecision(validPrefix(), 2, {
      stateHash: "corrupt-middle-hash",
    });

    expect(() =>
      assertReplayEquivalentV1(prefix, createVerification()),
    ).toThrow("seq 2: stateHash");
  });

  test("fails closed when StateHasher returns empty or throws", () => {
    const empty = createVerification();
    empty.stateHasher.hash = () => "";
    expect(() => assertReplayEquivalentV1(validPrefix(), empty)).toThrow(
      "seq 2: StateHasher returned an empty state hash",
    );

    const throwing = createVerification();
    throwing.stateHasher.hash = () => {
      throw new Error("hash backend unavailable");
    };
    expect(() => assertReplayEquivalentV1(validPrefix(), throwing)).toThrow(
      "seq 2: StateHasher threw: hash backend unavailable",
    );
  });

  test("a changed reducer is rejected against the recorded historical hashes", () => {
    const verification = createVerification();
    verification.reducer.reduce = (facts) => ({
      ...reduceFacts(facts),
      inputCount: facts.length + 1,
    });

    expect(() => assertReplayEquivalentV1(validPrefix(), verification)).toThrow(
      "seq 2: stateHash",
    );
  });
});

function createVerification(): ReplayVerificationV1<ReplayConfig, ReplayState> {
  return {
    runConfig: { mode: "replay-test" },
    reducerVersion: VERSION,
    reducer: { reduce: reduceFacts },
    stateHasher: { hash: hashState },
    derivedDecision({ state, inputThroughSeq, stateHash, reducerVersion }) {
      return {
        type: "control.decided",
        reducerVersion,
        inputThroughSeq,
        stateHash,
        action: decisionAction(state.decision),
      };
    },
  };
}

function validPrefix(): readonly RunJournalEnvelopeV1[] {
  return [
    factEnvelope(
      { type: "attempt.started", goalHash: "goal", configHash: "config" },
      1,
    ),
    decisionEnvelope(
      reduceFacts([
        { type: "attempt.started", goalHash: "goal", configHash: "config" },
      ]),
      1,
      2,
    ),
    factEnvelope(
      {
        type: "input.promoted",
        inputId: "input-1",
        delivery: "initial",
        content: "fix it",
        contentHash: "content-hash",
      },
      3,
    ),
    decisionEnvelope(
      reduceFacts([
        { type: "attempt.started", goalHash: "goal", configHash: "config" },
        {
          type: "input.promoted",
          inputId: "input-1",
          delivery: "initial",
          content: "fix it",
          contentHash: "content-hash",
        },
      ]),
      3,
      4,
    ),
    factEnvelope(
      { type: "abort.requested", source: "host", reason: "stop-now" },
      5,
    ),
    decisionEnvelope(
      reduceFacts([
        { type: "attempt.started", goalHash: "goal", configHash: "config" },
        {
          type: "input.promoted",
          inputId: "input-1",
          delivery: "initial",
          content: "fix it",
          contentHash: "content-hash",
        },
        { type: "abort.requested", source: "host", reason: "stop-now" },
      ]),
      5,
      6,
    ),
  ];
}

function reduceFacts(facts: readonly InputFactV1[]): ReplayState {
  const abort = [...facts]
    .reverse()
    .find((fact) => fact.type === "abort.requested");
  return {
    inputCount: facts.length,
    decision: abort
      ? { kind: "aborted", reason: abort.reason ?? "aborted" }
      : facts.some((fact) => fact.type === "input.promoted")
        ? { kind: "await_user", reason: "need-user" }
        : { kind: "continue" },
  };
}

function hashState(state: ReplayState): string {
  return JSON.stringify(state);
}

function decisionEnvelope(
  state: ReplayState,
  inputThroughSeq: number,
  seq: number,
): RunJournalEnvelopeV1 {
  return {
    schemaVersion: RUN_JOURNAL_SCHEMA_VERSION_V1,
    sessionId: "session-1",
    runId: "run-1",
    seq,
    ts: 1_750_000_000_000 + seq,
    record: {
      kind: "derived_decision",
      decision: {
        type: "control.decided",
        reducerVersion: VERSION,
        inputThroughSeq,
        stateHash: hashState(state),
        action: decisionAction(state.decision),
      },
    },
  };
}

function factEnvelope(fact: InputFactV1, seq: number): RunJournalEnvelopeV1 {
  return {
    schemaVersion: RUN_JOURNAL_SCHEMA_VERSION_V1,
    sessionId: "session-1",
    runId: "run-1",
    seq,
    ts: 1_750_000_000_000 + seq,
    record: { kind: "input_fact", fact },
  };
}

function changeDecision(
  prefix: readonly RunJournalEnvelopeV1[],
  seq: number,
  patch: Partial<DerivedDecisionV1>,
): readonly RunJournalEnvelopeV1[] {
  return prefix.map((envelope) => {
    if (envelope.seq !== seq || envelope.record.kind !== "derived_decision") {
      return envelope;
    }
    return {
      ...envelope,
      record: {
        kind: "derived_decision",
        decision: { ...envelope.record.decision, ...patch },
      },
    };
  });
}

function decisionAction(decision: ControlDecision): ControlDecisionActionV1 {
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
