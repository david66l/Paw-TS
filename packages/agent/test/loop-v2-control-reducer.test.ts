import { describe, expect, test } from "bun:test";

import {
  CONTROL_STATE_SCHEMA_VERSION,
  type ControlReducerInputV1,
  type ControlStateV1,
  controlInputFromLoopV2EnvelopeV1,
  controlStateHashV1,
  createControlStateV1,
  reduceControlStateV1,
  replayControlFactsV1,
} from "../src/loop-v2/index.js";

const RUN_ID = "control-reducer-v1";

function input(
  seq: number,
  fact: ControlReducerInputV1["fact"],
): ControlReducerInputV1 {
  return { runId: RUN_ID, seq, fact };
}

function started(): ControlStateV1 {
  return reduceControlStateV1(
    createControlStateV1(RUN_ID),
    input(1, { type: "run.started", goalHash: "goal-hash" }),
  ).state;
}

function candidateState(): ControlStateV1 {
  const mutated = reduceControlStateV1(
    started(),
    input(2, {
      type: "mutation.committed",
      revision: 1,
      paths: ["src/value.ts"],
    }),
  ).state;
  return reduceControlStateV1(
    mutated,
    input(3, {
      type: "candidate.submitted",
      candidate: {
        id: "candidate-1",
        mutationRevision: 1,
        candidateInputHash: "candidate-hash",
      },
    }),
  ).state;
}

function directRepairState(): ControlStateV1 {
  return reduceControlStateV1(
    candidateState(),
    input(4, {
      type: "readiness.evaluated",
      candidateId: "candidate-1",
      mutationRevision: 1,
      result: {
        kind: "repair_required",
        requirement: {
          kind: "direct_verification",
          revision: 1,
          runnerFamily: "bun_test",
          scope: ["src/value.ts"],
        },
      },
    }),
  ).state;
}

describe("Loop v2 pure control reducer", () => {
  test("R11 natural stop is only a turn boundary", () => {
    const reduced = reduceControlStateV1(
      started(),
      input(2, {
        type: "provider.turn_stopped",
        turn: 1,
        empty: false,
      }),
    );

    expect(reduced.state).toMatchObject({
      schemaVersion: CONTROL_STATE_SCHEMA_VERSION,
      status: "running",
      turn: 1,
      consecutiveNoActionStops: 1,
    });
    expect(reduced.state.candidate).toBeUndefined();
    expect(reduced.effects).toEqual([
      { type: "call_model", reason: "turn_boundary" },
    ]);
  });

  test("only explicit candidate intent requests readiness", () => {
    const state = started();
    const reduced = reduceControlStateV1(
      state,
      input(2, {
        type: "candidate.submitted",
        candidate: {
          id: "candidate-0",
          mutationRevision: 0,
          candidateInputHash: "candidate-hash",
        },
      }),
    );

    expect(reduced.state.status).toBe("candidate");
    expect(reduced.effects).toEqual([
      { type: "request_readiness", candidateId: "candidate-0" },
    ]);
  });

  test("R21/R22 wrong or unrelated successful actions do not clear repair", () => {
    const repair = directRepairState();
    const obligation = repair.openRepairObligation;
    const read = reduceControlStateV1(
      repair,
      input(5, { type: "tool.settled", tool: "workspace.read_file", ok: true }),
    );
    const unrelatedVerification = reduceControlStateV1(
      read.state,
      input(6, {
        type: "verification.observed",
        verification: {
          revision: 1,
          runnerFamily: "bun_test",
          scope: ["test/unrelated.test.ts"],
          outcome: "passed",
        },
      }),
    );

    expect(read.state.openRepairObligation).toEqual(obligation);
    expect(unrelatedVerification.state.openRepairObligation).toEqual(
      obligation,
    );
    expect(unrelatedVerification.state.status).toBe("repair_required");
  });

  test("R23 code failure opens material repair and only matching change clears it", () => {
    const failed = reduceControlStateV1(
      directRepairState(),
      input(5, {
        type: "verification.observed",
        verification: {
          revision: 1,
          runnerFamily: "bun_test",
          scope: ["src/value.ts"],
          outcome: "code_failed",
        },
      }),
    );
    expect(failed.state.openRepairObligation).toMatchObject({
      kind: "material_change",
      afterRevision: 1,
      scope: ["src/value.ts"],
    });
    expect(failed.state.status).toBe("repair_required");

    const unrelated = reduceControlStateV1(
      failed.state,
      input(6, {
        type: "mutation.committed",
        revision: 2,
        paths: ["README.md"],
      }),
    );
    expect(unrelated.state.openRepairObligation).toEqual(
      failed.state.openRepairObligation,
    );
    expect(unrelated.state.status).toBe("repair_required");

    const matching = reduceControlStateV1(
      unrelated.state,
      input(7, {
        type: "mutation.committed",
        revision: 3,
        paths: ["src/value.ts"],
      }),
    );
    expect(matching.state.openRepairObligation).toBeUndefined();
    expect(matching.state.status).toBe("running");
    expect(matching.state.candidate).toBeUndefined();
  });

  test("R24 split replay preserves durable obligation identity", () => {
    const facts = [
      input(1, { type: "run.started", goalHash: "goal-hash" }),
      input(2, {
        type: "mutation.committed",
        revision: 1,
        paths: ["src/value.ts"],
      }),
      input(3, {
        type: "candidate.submitted",
        candidate: {
          id: "candidate-1",
          mutationRevision: 1,
          candidateInputHash: "candidate-hash",
        },
      }),
      input(4, {
        type: "readiness.evaluated",
        candidateId: "candidate-1",
        mutationRevision: 1,
        result: {
          kind: "repair_required",
          requirement: {
            kind: "direct_verification",
            revision: 1,
            runnerFamily: "bun_test",
            scope: ["src/value.ts"],
          },
        },
      }),
      input(5, {
        type: "tool.settled",
        tool: "workspace.read_file",
        ok: true,
      }),
    ] satisfies readonly ControlReducerInputV1[];

    const uninterrupted = replayControlFactsV1(RUN_ID, facts);
    const beforeResume = replayControlFactsV1(RUN_ID, facts.slice(0, 4));
    const resumed = replayControlFactsV1(
      RUN_ID,
      facts.slice(4),
      beforeResume.state,
    );

    expect(resumed.stateHash).toBe(uninterrupted.stateHash);
    expect(resumed.state.openRepairObligation).toEqual(
      uninterrupted.state.openRepairObligation,
    );
  });

  test("R25 an immediate duplicate is idempotent and a conflict is corruption", () => {
    const fact = input(2, {
      type: "provider.turn_stopped",
      turn: 1,
      empty: false,
    });
    const first = reduceControlStateV1(started(), fact);
    const duplicate = reduceControlStateV1(first.state, fact);

    expect(duplicate.state).toBe(first.state);
    expect(duplicate.effects).toEqual([]);
    expect(controlStateHashV1(duplicate.state)).toBe(
      controlStateHashV1(first.state),
    );
    expect(() =>
      reduceControlStateV1(
        first.state,
        input(2, {
          type: "provider.turn_stopped",
          turn: 1,
          empty: true,
        }),
      ),
    ).toThrow("Conflicting control fact");
  });

  test("adapts existing Loop v2 facts without another journal envelope", () => {
    const adapted = controlInputFromLoopV2EnvelopeV1({
      schemaVersion: 2,
      runId: RUN_ID,
      seq: 1,
      ts: 1,
      event: {
        type: "task.started",
        goal: "Fix the bug",
        sourceHash: "goal-hash",
      },
    });
    const advisorOnly = controlInputFromLoopV2EnvelopeV1({
      schemaVersion: 2,
      runId: RUN_ID,
      seq: 2,
      ts: 2,
      event: { type: "phase.changed", phase: "discover" },
    });

    expect(adapted).toEqual(
      input(1, { type: "run.started", goalHash: "goal-hash" }),
    );
    expect(advisorOnly).toBeUndefined();

    const mutation = controlInputFromLoopV2EnvelopeV1({
      schemaVersion: 2,
      runId: RUN_ID,
      seq: 3,
      ts: 3,
      event: {
        type: "mutation.recorded",
        mutation: {
          seq: 3,
          callId: "edit-1",
          mutationRevision: 1,
          paths: ["src/value.ts"],
          beforeHashes: { "src/value.ts": "before" },
          afterHashes: { "src/value.ts": "after" },
          beforeContentRefs: { "src/value.ts": "artifact:before" },
          afterContentRefs: { "src/value.ts": "artifact:after" },
          patch: "patch",
          workspaceEffect: "product",
        },
      },
    });
    if (!adapted || !mutation) throw new Error("Missing control projection");
    const withGap = replayControlFactsV1(RUN_ID, [adapted, mutation]);
    expect(withGap.state.lastSeq).toBe(3);
    expect(withGap.state.mutationRevision).toBe(1);
  });
});
