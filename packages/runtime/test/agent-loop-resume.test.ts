import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  INTERACTIVE_CONTROL_REDUCER_VERSION_V1,
  type InteractiveControlStateV1,
  type LoopToolCall,
  createInteractiveControlReducerV1,
  runAgentLoop,
} from "@paw/agent-loop";
import type {
  ControlDecisionActionV1,
  DerivedDecisionV1,
  InputFactV1,
} from "@paw/protocol";
import {
  EMPTY_RUN_JOURNAL_PREFIX_HASH_V1,
  FileRunSessionV1,
  type FileSessionExecutionLeaseV1,
  acquireFileSessionExecutionLeaseV1,
  releaseFileSessionExecutionLeaseV1,
  repairRunRecoveryV1,
} from "../src/index.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("File Session Agent Loop resume", () => {
  test("reuses only an exact trailing decision and never reuses it to append intents", async () => {
    const fixture = fileSessionFixture();
    const decision: DerivedDecisionV1 = {
      type: "control.decided",
      reducerVersion: "test-v1",
      inputThroughSeq: 1,
      stateHash: "state-hash",
      action: { kind: "continue", reasonCode: "continue" },
    };
    await fixture.session.appendInputFacts([attemptStarted()]);
    expect(await fixture.session.commitDerivedDecision(1, decision)).toBe(
      "committed",
    );
    const firstTail = (await fixture.session.readInputSnapshot()).tailSeq;

    expect(
      await fixture.session.commitDerivedDecision(firstTail, decision),
    ).toBe("committed");
    expect((await fixture.session.readInputSnapshot()).tailSeq).toBe(firstTail);
    expect(await fixture.session.readCanonicalPrefix()).toHaveLength(2);
    let conflictingDecisionError: unknown;
    try {
      await fixture.session.commitDerivedDecision(firstTail, {
        ...decision,
        action: { kind: "continue", reasonCode: "tampered" },
      });
    } catch (error) {
      conflictingDecisionError = error;
    }
    expect(conflictingDecisionError).toBeInstanceOf(Error);
    expect((conflictingDecisionError as Error).message).toContain(
      "conflicting derived decision",
    );
    let decisionAndInputError: unknown;
    try {
      await fixture.session.commitDecisionAndInputFacts(firstTail, decision, [
        modelDispatch(1, "must-not-append"),
      ]);
    } catch (error) {
      decisionAndInputError = error;
    }
    expect(decisionAndInputError).toBeInstanceOf(Error);
    expect((await fixture.session.readInputSnapshot()).tailSeq).toBe(firstTail);

    expect(
      await fixture.session.commitInputFacts(firstTail, [
        modelDispatch(1, "repair-model"),
      ]),
    ).toBe("committed");
    expect((await fixture.session.readInputSnapshot()).tailSeq).toBe(
      firstTail + 1,
    );
    await fixture.close();
  });

  test("a durably repaired unknown model result terminates on startup with zero model call", async () => {
    const fixture = fileSessionFixture();
    await fixture.session.appendInputFacts([
      modelDispatch(1, "model-crashed-after-dispatch"),
    ]);
    const repair = await repairRunRecoveryV1({ session: fixture.session });
    expect(repair.status).toBe("repaired");
    expect(repair.repairedFacts).toEqual([
      expect.objectContaining({
        type: "model.settled",
        modelCallId: "model-crashed-after-dispatch",
        status: "unknown",
      }),
    ]);

    const calls = { boundary: 0, input: 0, context: 0, model: 0, tool: 0 };
    const reducer = createInteractiveControlReducerV1();
    const state = await runAgentLoop<
      {
        readonly mode: "interactive";
        readonly maxModelTurns: number;
        readonly naturalStop: "complete";
      },
      string,
      never,
      string,
      LoopToolCall,
      string,
      InteractiveControlStateV1
    >({
      session: fixture.session,
      runConfig: {
        mode: "interactive",
        maxModelTurns: 8,
        naturalStop: "complete",
      },
      reducerVersion: INTERACTIVE_CONTROL_REDUCER_VERSION_V1,
      reducer,
      stateHasher: { hash: (value) => JSON.stringify(value) },
      input: {
        async reportSafeBoundary() {
          calls.boundary += 1;
        },
        async consumePromotedInputIds() {
          calls.input += 1;
          return [];
        },
      },
      context: {
        async build() {
          calls.context += 1;
          return "must-not-build";
        },
      },
      model: {
        async execute() {
          calls.model += 1;
          return { status: "success", message: "bad", toolCalls: [] };
        },
      },
      tools: {
        async executeSettled() {
          calls.tool += 1;
          return [];
        },
      },
      facts: terminalOnlyFactMapper(),
    });

    expect(state.decision).toEqual({
      kind: "incomplete",
      reason: "model-result-unknown",
    });
    expect(calls).toEqual({
      boundary: 0,
      input: 0,
      context: 0,
      model: 0,
      tool: 0,
    });
    const prefix = await fixture.session.readCanonicalPrefix();
    expect(prefix.at(-1)?.record).toMatchObject({
      kind: "derived_decision",
      decision: {
        action: {
          kind: "incomplete",
          reasonCode: "model-result-unknown",
        },
      },
    });
    await fixture.close();
  });
});

function terminalOnlyFactMapper() {
  return {
    modelRequestIntent(): never {
      throw new Error("model intent must not be mapped during terminal resume");
    },
    modelSettled(): never {
      throw new Error(
        "model settlement must not be mapped during terminal resume",
      );
    },
    toolCallObserved(): never {
      throw new Error(
        "tool observation must not be mapped during terminal resume",
      );
    },
    toolDispatchIntent(): never {
      throw new Error(
        "tool dispatch must not be mapped during terminal resume",
      );
    },
    toolSettled(): never {
      throw new Error(
        "tool settlement must not be mapped during terminal resume",
      );
    },
    runAbortObserved(): never {
      throw new Error("abort must not be mapped during terminal resume");
    },
    runtimeFailed(): never {
      throw new Error(
        "runtime failure must not be mapped during terminal resume",
      );
    },
    derivedDecision(input: {
      readonly state: InteractiveControlStateV1;
      readonly inputThroughSeq: number;
      readonly stateHash: string;
      readonly reducerVersion: string;
    }): DerivedDecisionV1 {
      return {
        type: "control.decided",
        reducerVersion: input.reducerVersion,
        inputThroughSeq: input.inputThroughSeq,
        stateHash: input.stateHash,
        action: decisionAction(input.state.decision),
      };
    },
  };
}

function decisionAction(
  decision: InteractiveControlStateV1["decision"],
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

function attemptStarted(): InputFactV1 {
  return {
    type: "attempt.started",
    goalHash: "goal",
    configHash: "config",
  };
}

function modelDispatch(
  turn: number,
  modelCallId: string,
): Extract<InputFactV1, { type: "model.dispatch_recorded" }> {
  return {
    type: "model.dispatch_recorded",
    modelCallId,
    turn,
    requestHash: `request-${turn}`,
  };
}

function fileSessionFixture(): {
  readonly root: string;
  readonly lease: FileSessionExecutionLeaseV1;
  readonly session: FileRunSessionV1;
  close(): Promise<void>;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paw-loop-resume-"));
  roots.push(root);
  const acquired = acquireFileSessionExecutionLeaseV1({
    workspaceRoot: root,
    sessionId: "session",
    runId: "run",
    ownerId: "owner",
    ttlMs: 1_000,
    baseTailSeq: 0,
    basePrefixHash: EMPTY_RUN_JOURNAL_PREFIX_HASH_V1,
    clock: () => 0,
  });
  if (acquired.status !== "acquired") {
    throw new Error(`expected acquired lease, got ${acquired.status}`);
  }
  const lease = acquired.lease;
  const session = new FileRunSessionV1({
    workspaceRoot: root,
    sessionId: "session",
    runId: "run",
    executionLease: lease,
    clock: () => 0,
  });
  return {
    root,
    lease,
    session,
    async close() {
      session.close();
      await releaseFileSessionExecutionLeaseV1(lease, root, "session", "run");
    },
  };
}
