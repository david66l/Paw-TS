import { describe, expect, test } from "bun:test";
import type {
  ControlDecisionActionV1,
  DerivedDecisionV1,
  DurableJsonPayloadV1,
  InputFactV1,
  ModelResponseV1,
} from "@paw/protocol";
import {
  type AgentLoopDependencies,
  type ControlDecision,
  type LoopControlState,
  type Session,
  type SessionInputSnapshot,
  type VerifiedModelResponseEvidenceV1,
  createInteractiveControlReducerV1,
  runAgentLoop,
} from "../src/index.js";
import { MemorySession } from "./fakes.js";

interface TestState extends LoopControlState {
  readonly inputCount: number;
}

type TestDependencies = AgentLoopDependencies<
  Readonly<Record<string, never>>,
  SessionInputSnapshot<InputFactV1>,
  never,
  string,
  TestToolCall,
  string,
  TestState
>;

interface TestToolCall {
  readonly id: string;
  readonly name: string;
  readonly args: Readonly<Record<string, never>>;
  readonly argumentsValid?: boolean;
}

describe("Agent Loop canonical resume", () => {
  test("reconciles terminal, incomplete, and wait prefixes before every external port", async () => {
    const decisions: readonly ControlDecision[] = [
      { kind: "completed", reason: "done" },
      { kind: "incomplete", reason: "unknown-result" },
      { kind: "await_user", reason: "approval" },
      { kind: "await_external", reason: "dependency" },
    ];

    for (const decision of decisions) {
      const harness = createHarness({
        facts: [attemptStarted()],
        decide: () => decision,
      });
      const state = await runAgentLoop(harness.dependencies);

      expect(state.decision).toEqual(decision);
      expect(harness.externalCalls()).toEqual({
        boundaries: 0,
        inputs: 0,
        contexts: 0,
        models: 0,
        tools: 0,
      });
      expect(harness.session.decisionCommitCalls).toBe(1);
      expect(harness.trace.at(-1)).toBe(
        `decision:${decisionAction(decision).kind}`,
      );
    }
  });

  test("continues after the maximum persisted model turn without replaying model-1", async () => {
    const harness = createHarness({
      facts: [...modelTurn(1)],
      decide(facts) {
        return modelSettlements(facts) >= 2
          ? { kind: "completed", reason: "done" }
          : { kind: "continue" };
      },
    });

    const state = await runAgentLoop(harness.dependencies);

    expect(state.decision.kind).toBe("completed");
    expect(harness.modelTurns).toEqual([2]);
    expect(
      harness.session.inputFacts
        .filter((fact) => fact.type === "model.dispatch_recorded")
        .map((fact) => fact.turn),
    ).toEqual([1, 2]);
  });

  test("restores the safe boundary from fresh, bare-model, and settled-tool frontiers", async () => {
    const cases: readonly {
      readonly name: string;
      readonly facts: readonly InputFactV1[];
      readonly expected: string;
      readonly nextTurn: number;
    }[] = [
      {
        name: "fresh",
        facts: [attemptStarted()],
        expected: "before_first_model_request",
        nextTurn: 1,
      },
      {
        name: "bare model",
        facts: modelTurn(1),
        expected: "after_model_turn_without_tool_calls",
        nextTurn: 2,
      },
      {
        name: "tool batch",
        facts: toolTurn(1),
        expected: "after_tool_batch_settled",
        nextTurn: 2,
      },
    ];

    for (const item of cases) {
      const startingSettlements = modelSettlements(item.facts);
      const harness = createHarness({
        facts: item.facts,
        decide(facts) {
          return modelSettlements(facts) > startingSettlements
            ? { kind: "completed", reason: "done" }
            : { kind: "continue" };
        },
      });

      await runAgentLoop(harness.dependencies);

      expect(harness.boundaries, item.name).toEqual([item.expected]);
      expect(harness.modelTurns, item.name).toEqual([item.nextTurn]);
    }
  });

  test("reuses an identical trailing decision without appending a consecutive decision", async () => {
    const terminal = { kind: "completed", reason: "done" } as const;
    const state: TestState = { inputCount: 1, decision: terminal };
    const existing = derivedDecision(state, 1);
    const harness = createHarness({
      facts: [attemptStarted()],
      trailingDecision: existing,
      decide: () => terminal,
    });
    const initialTail = harness.session.tailSeq;

    const result = await runAgentLoop(harness.dependencies);

    expect(result).toEqual(state);
    expect(harness.session.tailSeq).toBe(initialTail);
    expect(harness.session.appendedDecisions).toHaveLength(0);
    expect(harness.session.reusedDecisions).toBe(1);
    expect(harness.externalCalls()).toEqual({
      boundaries: 0,
      inputs: 0,
      contexts: 0,
      models: 0,
      tools: 0,
    });
  });

  test("fails closed when the trailing derived decision differs from replay truth", async () => {
    const terminal = { kind: "completed", reason: "done" } as const;
    const expected = derivedDecision({ inputCount: 1, decision: terminal }, 1);
    const harness = createHarness({
      facts: [attemptStarted()],
      trailingDecision: { ...expected, stateHash: "tampered" },
      decide: () => terminal,
    });

    await expect(runAgentLoop(harness.dependencies)).rejects.toThrow(
      "decision",
    );
    expect(harness.session.appendedDecisions).toHaveLength(0);
    expect(harness.externalCalls()).toEqual({
      boundaries: 0,
      inputs: 0,
      contexts: 0,
      models: 0,
      tools: 0,
    });
  });

  test("fails closed on duplicate, decreasing, or gapped model turns before external work", async () => {
    const invalidHistories: readonly (readonly InputFactV1[])[] = [
      [...modelTurn(1), ...modelTurn(1, "model-duplicate")],
      [...modelTurn(1), ...modelTurn(2), ...modelTurn(1, "model-backwards")],
      modelTurn(2),
    ];

    for (const facts of invalidHistories) {
      const harness = createHarness({
        facts,
        decide: () => ({ kind: "continue" }),
      });
      await expect(runAgentLoop(harness.dependencies)).rejects.toThrow("turn");
      expect(harness.session.decisionCommitCalls).toBe(0);
      expect(harness.externalCalls()).toEqual({
        boundaries: 0,
        inputs: 0,
        contexts: 0,
        models: 0,
        tools: 0,
      });
    }
  });

  test("returns a terminal replay without deriving an otherwise invalid model cursor", async () => {
    const harness = createHarness({
      facts: modelTurn(2),
      decide: () => ({ kind: "incomplete", reason: "terminal-first" }),
    });

    const state = await runAgentLoop(harness.dependencies);

    expect(state.decision).toEqual({
      kind: "incomplete",
      reason: "terminal-first",
    });
    expect(harness.session.decisionCommitCalls).toBe(1);
    expect(harness.externalCalls()).toEqual({
      boundaries: 0,
      inputs: 0,
      contexts: 0,
      models: 0,
      tools: 0,
    });
  });

  test("fails closed on unrepaired model or tool lifecycle before external work", async () => {
    const invalidHistories: readonly (readonly InputFactV1[])[] = [
      [modelDispatch(1)],
      [
        ...modelTurn(1, "model-1", true),
        observedTool(1, 0),
        toolDispatch(1, 0),
        toolPermission(1, 0),
      ],
    ];

    for (const facts of invalidHistories) {
      const harness = createHarness({
        facts,
        decide: () => ({ kind: "continue" }),
      });
      await expect(runAgentLoop(harness.dependencies)).rejects.toThrow();
      expect(harness.session.decisionCommitCalls).toBe(0);
      expect(harness.externalCalls()).toEqual({
        boundaries: 0,
        inputs: 0,
        contexts: 0,
        models: 0,
        tools: 0,
      });
    }
  });

  test("fails closed before external work when inline response calls do not match the settled observed batch", async () => {
    const facts = toolTurn(1);
    const settledIndex = facts.findIndex(
      (fact) => fact.type === "model.settled",
    );
    const settled = facts[settledIndex];
    if (!settled || settled.type !== "model.settled") {
      throw new Error("expected model settlement fixture");
    }
    facts[settledIndex] = {
      ...settled,
      response: {
        kind: "inline",
        value: {
          schemaVersion: "paw.model-response.v1",
          providerProtocol: "openai-compatible",
          assistantContent: "",
          finishReason: "tool_calls",
          toolCalls: [
            providerToolCall("call-1-0", 0),
            providerToolCall("call-1-1", 1),
          ],
        },
        hash: "response-two-calls",
      },
    };
    const harness = createHarness({
      facts,
      decide(currentFacts) {
        return modelSettlements(currentFacts) > 1
          ? { kind: "completed", reason: "must-not-reach-model" }
          : { kind: "continue" };
      },
    });

    await expect(runAgentLoop(harness.dependencies)).rejects.toThrow();
    expect(harness.session.decisionCommitCalls).toBe(0);
    expect(harness.externalCalls()).toEqual({
      boundaries: 0,
      inputs: 0,
      contexts: 0,
      models: 0,
      tools: 0,
    });
  });

  test("fails closed on artifact-backed tool history when startup cannot prove the tool boundary", async () => {
    const facts = toolTurn(1);
    const settledIndex = facts.findIndex(
      (fact) => fact.type === "model.settled",
    );
    const settled = facts[settledIndex];
    if (!settled || settled.type !== "model.settled") {
      throw new Error("expected model settlement fixture");
    }
    facts[settledIndex] = {
      ...settled,
      response: {
        kind: "artifact_ref",
        artifactRef: "model-response/history",
        hash: "artifact-response-hash",
      },
    };
    const harness = createHarness({
      facts,
      decide(currentFacts) {
        return modelSettlements(currentFacts) > 1
          ? { kind: "completed", reason: "must-not-reach-model" }
          : { kind: "continue" };
      },
    });

    await expect(runAgentLoop(harness.dependencies)).rejects.toThrow();
    expect(harness.session.decisionCommitCalls).toBe(0);
    expect(harness.externalCalls().models).toBe(0);
  });

  test("resumes a plain artifact-backed latest model turn only from exact verified evidence", async () => {
    const facts = modelTurn(1);
    const settled = facts[1];
    if (!settled || settled.type !== "model.settled") {
      throw new Error("expected model settlement fixture");
    }
    facts[1] = {
      ...settled,
      response: {
        kind: "artifact_ref",
        artifactRef: "model-response/plain-history",
        hash: "plain-artifact-hash",
      },
    };
    const harness = createHarness({
      facts,
      decide(currentFacts) {
        return modelSettlements(currentFacts) > 1
          ? { kind: "completed", reason: "done" }
          : { kind: "continue" };
      },
    });

    const response = plainModelResponse();
    let evidenceLoads = 0;
    await runAgentLoop(harness.dependencies, {
      loadStartupModelResponseEvidence(snapshot) {
        evidenceLoads += 1;
        return exactModelResponseEvidence({
          snapshot,
          carrierSeq: 2,
          modelCallId: "model-1",
          payload:
            facts[1]?.type === "model.settled" ? facts[1].response : undefined,
          response,
        });
      },
    });

    expect(evidenceLoads).toBe(1);
    expect(harness.boundaries).toEqual(["after_model_turn_without_tool_calls"]);
    expect(harness.modelTurns).toEqual([2]);
  });

  test("resumes an artifact-backed settled tool frontier and continues at the next turn", async () => {
    const facts = artifactBackedToolTurn(1);
    const harness = createHarness({
      facts,
      decide(currentFacts) {
        return modelSettlements(currentFacts) > 1
          ? { kind: "completed", reason: "done" }
          : { kind: "continue" };
      },
    });

    await runAgentLoop(harness.dependencies, {
      loadStartupModelResponseEvidence(snapshot) {
        return exactModelResponseEvidence({
          snapshot,
          carrierSeq: 2,
          modelCallId: "model-1",
          payload: requiredModelPayload(facts),
          response: toolModelResponse(1),
        });
      },
    });

    expect(harness.boundaries).toEqual(["after_tool_batch_settled"]);
    expect(harness.modelTurns).toEqual([2]);
  });

  test("fails before decision or external work when startup evidence drifts", async () => {
    const cases = ["snapshot", "carrier", "payload"] as const;
    for (const drift of cases) {
      const facts = artifactBackedToolTurn(1);
      const harness = createHarness({
        facts,
        decide: () => ({ kind: "continue" }),
      });

      await expect(
        runAgentLoop(harness.dependencies, {
          loadStartupModelResponseEvidence(snapshot) {
            const evidence = exactModelResponseEvidence({
              snapshot,
              carrierSeq: drift === "carrier" ? 99 : 2,
              modelCallId: "model-1",
              payload:
                drift === "payload"
                  ? {
                      kind: "artifact_ref",
                      artifactRef: "model-response/other",
                      hash: "other-hash",
                    }
                  : requiredModelPayload(facts),
              response: toolModelResponse(1),
            });
            return drift === "snapshot"
              ? {
                  ...evidence,
                  assertSnapshot() {
                    throw new Error("verified snapshot tail drift");
                  },
                }
              : evidence;
          },
        }),
      ).rejects.toThrow();

      expect(harness.session.decisionCommitCalls, drift).toBe(0);
      expect(harness.externalCalls(), drift).toEqual({
        boundaries: 0,
        inputs: 0,
        contexts: 0,
        models: 0,
        tools: 0,
      });
    }
  });

  test("does not load model evidence for a terminal replay", async () => {
    const harness = createHarness({
      facts: artifactBackedToolTurn(1),
      decide: () => ({ kind: "completed", reason: "already-terminal" }),
    });
    let evidenceLoads = 0;

    const state = await runAgentLoop(harness.dependencies, {
      loadStartupModelResponseEvidence() {
        evidenceLoads += 1;
        throw new Error("terminal must not load evidence");
      },
    });

    expect(state.decision).toEqual({
      kind: "completed",
      reason: "already-terminal",
    });
    expect(evidenceLoads).toBe(0);
    expect(harness.externalCalls()).toEqual({
      boundaries: 0,
      inputs: 0,
      contexts: 0,
      models: 0,
      tools: 0,
    });
  });

  test("reloads artifact evidence after a startup decision CAS conflict", async () => {
    const facts = artifactBackedToolTurn(1);
    let inserted = false;
    const harness = createHarness({
      facts,
      decide(currentFacts) {
        return modelSettlements(currentFacts) > 1
          ? { kind: "completed", reason: "done" }
          : { kind: "continue" };
      },
      async beforeDecisionCommit(session, decision) {
        if (inserted || decision.action.kind !== "continue") return;
        inserted = true;
        await session.appendInputFacts([
          {
            type: "runtime.failed",
            area: "runtime",
            errorCode: "RacedAuditFact",
            message: "inserted between evidence load and decision CAS",
            retryable: true,
          },
        ]);
      },
    });
    const loadedTails: number[] = [];

    await runAgentLoop(harness.dependencies, {
      loadStartupModelResponseEvidence(snapshot) {
        loadedTails.push(snapshot.tailSeq);
        return exactModelResponseEvidence({
          snapshot,
          carrierSeq: 2,
          modelCallId: "model-1",
          payload: requiredModelPayload(facts),
          response: toolModelResponse(1),
        });
      },
    });

    expect(inserted).toBe(true);
    expect(loadedTails).toEqual([facts.length, facts.length + 1]);
    expect(harness.boundaries).toEqual(["after_tool_batch_settled"]);
    expect(harness.modelTurns).toEqual([2]);
  });

  test("an abort raised inside the startup evidence loader wins before continue is committed", async () => {
    const controller = new AbortController();
    const facts = artifactBackedToolTurn(1);
    const harness = createHarness({
      facts,
      decide(currentFacts) {
        const abort = currentFacts.find(
          (fact) => fact.type === "abort.requested",
        );
        return abort
          ? { kind: "aborted", reason: abort.reason ?? "loader-abort" }
          : { kind: "continue" };
      },
    });
    let evidenceLoads = 0;

    const state = await runAgentLoop(harness.dependencies, {
      signal: controller.signal,
      loadStartupModelResponseEvidence(snapshot) {
        evidenceLoads += 1;
        controller.abort("loader-abort");
        return exactModelResponseEvidence({
          snapshot,
          carrierSeq: 2,
          modelCallId: "model-1",
          payload: requiredModelPayload(facts),
          response: toolModelResponse(1),
        });
      },
    });

    expect(state.decision).toEqual({ kind: "aborted", reason: "loader-abort" });
    expect(evidenceLoads).toBe(1);
    expect(
      harness.session.appendedDecisions.map((decision) => decision.action.kind),
    ).toEqual(["abort"]);
    expect(harness.session.inputCommitCalls).toBe(1);
    expect(harness.externalCalls()).toEqual({
      boundaries: 0,
      inputs: 0,
      contexts: 0,
      models: 0,
      tools: 0,
    });
  });

  test("fails a continuing invalid-arguments frontier when its runtime.failed evidence is missing", async () => {
    const facts = invalidArgumentsModelTurn();
    const harness = createHarness({
      facts,
      decide: () => ({ kind: "continue" }),
    });

    await expect(runAgentLoop(harness.dependencies)).rejects.toThrow(
      "runtime.failed",
    );
    expect(harness.session.decisionCommitCalls).toBe(0);
    expect(harness.externalCalls().boundaries).toBe(0);
  });

  test("runtime.failed evidence cannot make an invalid-arguments frontier resumable under a bad reducer", async () => {
    const harness = createHarness({
      facts: [
        ...invalidArgumentsModelTurn(),
        {
          type: "runtime.failed",
          area: "runtime",
          errorCode: "INVALID_TOOL_ARGUMENTS",
          message: "native tool arguments are invalid",
          retryable: false,
        },
      ],
      decide: () => ({ kind: "continue" }),
    });

    await expect(runAgentLoop(harness.dependencies)).rejects.toThrow(
      "no resumable safe boundary",
    );
    expect(harness.session.decisionCommitCalls).toBe(0);
    expect(harness.externalCalls()).toEqual({
      boundaries: 0,
      inputs: 0,
      contexts: 0,
      models: 0,
      tools: 0,
    });
  });

  test("the interactive reducer may terminate an invalid-arguments frontier from runtime.failed", async () => {
    const interactive = createInteractiveControlReducerV1();
    const harness = createHarness({
      facts: [
        ...invalidArgumentsModelTurn(),
        {
          type: "runtime.failed",
          area: "runtime",
          errorCode: "INVALID_TOOL_ARGUMENTS",
          message: "native tool arguments are invalid",
          retryable: false,
        },
      ],
      decide(facts) {
        return interactive.reduce(facts, {
          mode: "interactive",
          maxModelTurns: 8,
          naturalStop: "complete",
        }).decision;
      },
    });

    const state = await runAgentLoop(harness.dependencies);

    expect(state.decision).toEqual({
      kind: "failed",
      reason: "INVALID_TOOL_ARGUMENTS",
    });
    expect(harness.session.appendedDecisions).toHaveLength(1);
    expect(harness.session.appendedDecisions[0]?.action.kind).toBe("failed");
    expect(harness.externalCalls()).toEqual({
      boundaries: 0,
      inputs: 0,
      contexts: 0,
      models: 0,
      tools: 0,
    });
  });

  test("deep response identity checks only the latest continuing frontier", async () => {
    const oldToolTurn = toolTurn(1);
    const oldSettlementIndex = oldToolTurn.findIndex(
      (fact) => fact.type === "model.settled",
    );
    const oldSettlement = oldToolTurn[oldSettlementIndex];
    if (!oldSettlement || oldSettlement.type !== "model.settled") {
      throw new Error("expected model settlement fixture");
    }
    oldToolTurn[oldSettlementIndex] = {
      ...oldSettlement,
      response: {
        kind: "inline",
        value: {
          schemaVersion: "paw.model-response.v1",
          providerProtocol: "openai-compatible",
          assistantContent: "",
          finishReason: "tool_calls",
          toolCalls: [
            providerToolCall("call-1-0", 0),
            providerToolCall("historical-unobserved", 1),
          ],
        },
        hash: "historical-drift",
      },
    };
    const harness = createHarness({
      facts: [...oldToolTurn, ...modelTurn(2)],
      decide(facts) {
        return modelSettlements(facts) > 2
          ? { kind: "completed", reason: "done" }
          : { kind: "continue" };
      },
    });

    await runAgentLoop(harness.dependencies);

    expect(harness.modelTurns).toEqual([3]);
    expect(harness.boundaries).toEqual(["after_model_turn_without_tool_calls"]);
  });

  test("never feeds a reused DerivedDecision back into the reducer", async () => {
    const terminal = { kind: "completed", reason: "done" } as const;
    const state: TestState = { inputCount: 1, decision: terminal };
    const harness = createHarness({
      facts: [attemptStarted()],
      trailingDecision: derivedDecision(state, 1),
      decide(facts) {
        expect(facts).toEqual([attemptStarted()]);
        expect(
          facts.some(
            (fact) => (fact as { type: string }).type === "control.decided",
          ),
        ).toBe(false);
        return terminal;
      },
    });

    await runAgentLoop(harness.dependencies);

    expect(harness.reducerCalls).toBe(1);
  });

  test("replays an existing terminal before a pre-aborted caller can append abort", async () => {
    const controller = new AbortController();
    controller.abort("caller-aborted-before-resume");
    const harness = createHarness({
      facts: [attemptStarted()],
      decide: () => ({ kind: "completed", reason: "already-done" }),
    });

    const state = await runAgentLoop(harness.dependencies, {
      signal: controller.signal,
    });

    expect(state.decision).toEqual({
      kind: "completed",
      reason: "already-done",
    });
    expect(
      harness.session.inputFacts.some(
        (fact) => fact.type === "abort.requested",
      ),
    ).toBe(false);
    expect(harness.externalCalls()).toEqual({
      boundaries: 0,
      inputs: 0,
      contexts: 0,
      models: 0,
      tools: 0,
    });
  });

  test("a pre-aborted continuing resume records abort before deriving an invalid cursor", async () => {
    const controller = new AbortController();
    controller.abort("caller-aborted-before-invalid-resume");
    let evidenceLoads = 0;
    const harness = createHarness({
      facts: modelTurn(2),
      decide(facts) {
        return facts.some((fact) => fact.type === "abort.requested")
          ? { kind: "aborted", reason: "caller-aborted-before-invalid-resume" }
          : { kind: "continue" };
      },
    });

    const state = await runAgentLoop(harness.dependencies, {
      signal: controller.signal,
      loadStartupModelResponseEvidence() {
        evidenceLoads += 1;
        throw new Error("pre-abort must not load model evidence");
      },
    });

    expect(state.decision).toEqual({
      kind: "aborted",
      reason: "caller-aborted-before-invalid-resume",
    });
    expect(
      harness.session.inputFacts.filter(
        (fact) => fact.type === "abort.requested",
      ),
    ).toHaveLength(1);
    expect(
      harness.session.appendedDecisions.map((decision) => decision.action.kind),
    ).toEqual(["abort"]);
    expect(harness.session.inputCommitCalls).toBe(1);
    expect(evidenceLoads).toBe(0);
    expect(harness.externalCalls()).toEqual({
      boundaries: 0,
      inputs: 0,
      contexts: 0,
      models: 0,
      tools: 0,
    });
  });

  test("a pre-aborted startup CAS conflict re-reads the winning abort without duplicating it", async () => {
    const controller = new AbortController();
    controller.abort("caller-aborted-before-raced-resume");
    let inserted = false;
    const harness = createHarness({
      facts: modelTurn(2),
      decide(facts) {
        const abort = facts.find((fact) => fact.type === "abort.requested");
        return abort
          ? { kind: "aborted", reason: abort.reason ?? "raced-abort" }
          : { kind: "continue" };
      },
      async beforeInputCommit(session) {
        if (inserted) return;
        inserted = true;
        await session.appendInputFacts([
          { type: "abort.requested", source: "host", reason: "raced-abort" },
        ]);
      },
    });

    const state = await runAgentLoop(harness.dependencies, {
      signal: controller.signal,
    });

    expect(inserted).toBe(true);
    expect(state.decision).toEqual({ kind: "aborted", reason: "raced-abort" });
    expect(
      harness.session.inputFacts.filter(
        (fact) => fact.type === "abort.requested",
      ),
    ).toHaveLength(1);
    expect(
      harness.session.appendedDecisions.map((decision) => decision.action.kind),
    ).toEqual(["abort"]);
    expect(harness.session.inputCommitCalls).toBe(1);
    expect(harness.externalCalls()).toEqual({
      boundaries: 0,
      inputs: 0,
      contexts: 0,
      models: 0,
      tools: 0,
    });
  });

  test("appends one new terminal after repair facts that follow an old terminal decision", async () => {
    const oldState: TestState = {
      inputCount: 1,
      decision: { kind: "completed", reason: "old-terminal" },
    };
    const harness = createHarness({
      facts: [attemptStarted()],
      decide(facts) {
        return facts.some(
          (fact) => fact.type === "model.settled" && fact.status === "unknown",
        )
          ? { kind: "incomplete", reason: "repaired-model-unknown" }
          : oldState.decision;
      },
    });
    harness.session.seedDecisionThenFacts(derivedDecision(oldState, 1), [
      modelDispatch(1),
      {
        type: "model.settled",
        modelCallId: "model-1",
        turn: 1,
        status: "unknown",
        hasToolCalls: false,
        hasVisibleOutput: false,
      },
    ]);
    const beforeTail = harness.session.tailSeq;

    const result = await runAgentLoop(harness.dependencies);

    expect(result.decision).toEqual({
      kind: "incomplete",
      reason: "repaired-model-unknown",
    });
    expect(harness.session.tailSeq).toBe(beforeTail + 1);
    expect(harness.session.appendedDecisions).toHaveLength(1);
    expect(harness.session.appendedDecisions[0]?.action).toEqual({
      kind: "incomplete",
      reasonCode: "repaired-model-unknown",
    });
    expect(harness.externalCalls().models).toBe(0);
  });

  test("fails closed when any trailing decision field drifts from replay truth", async () => {
    const complete = { kind: "completed", reason: "done" } as const;
    const completeState: TestState = { inputCount: 1, decision: complete };
    const completeDecision = derivedDecision(completeState, 1);
    const wait = { kind: "await_user", reason: "approval" } as const;
    const waitState: TestState = { inputCount: 1, decision: wait };
    const waitDecision = derivedDecision(waitState, 1);
    const cases: readonly {
      readonly name: string;
      readonly decide: ControlDecision;
      readonly trailing: DerivedDecisionV1;
    }[] = [
      {
        name: "action",
        decide: complete,
        trailing: {
          ...completeDecision,
          action: { kind: "failed", reasonCode: "done" },
        },
      },
      {
        name: "reason",
        decide: complete,
        trailing: {
          ...completeDecision,
          action: { kind: "complete", reasonCode: "wrong" },
        },
      },
      {
        name: "waitFor",
        decide: wait,
        trailing: {
          ...waitDecision,
          action: {
            kind: "wait",
            waitFor: "external",
            reasonCode: "approval",
          },
        },
      },
      {
        name: "hash",
        decide: complete,
        trailing: { ...completeDecision, stateHash: "wrong" },
      },
      {
        name: "version",
        decide: complete,
        trailing: { ...completeDecision, reducerVersion: "wrong" },
      },
      {
        name: "cursor",
        decide: complete,
        trailing: { ...completeDecision, inputThroughSeq: 0 },
      },
    ];

    for (const item of cases) {
      const harness = createHarness({
        facts: [attemptStarted()],
        trailingDecision: item.trailing,
        decide: () => item.decide,
      });
      await expect(runAgentLoop(harness.dependencies)).rejects.toThrow(
        "decision",
      );
      expect(harness.session.appendedDecisions, item.name).toHaveLength(0);
      expect(harness.externalCalls().models, item.name).toBe(0);
    }
  });

  test("recomputes after startup CAS inserts abort and never executes a stale continue", async () => {
    let inserted = false;
    const harness = createHarness({
      facts: [attemptStarted()],
      decide(facts) {
        return facts.some((fact) => fact.type === "abort.requested")
          ? { kind: "aborted", reason: "raced-abort" }
          : { kind: "continue" };
      },
      async beforeDecisionCommit(session) {
        if (inserted) return;
        inserted = true;
        await session.appendInputFacts([
          { type: "abort.requested", source: "host", reason: "raced-abort" },
        ]);
      },
    });

    const result = await runAgentLoop(harness.dependencies);

    expect(result.decision).toEqual({
      kind: "aborted",
      reason: "raced-abort",
    });
    expect(
      harness.session.appendedDecisions.map((decision) => decision.action.kind),
    ).toEqual(["abort"]);
    expect(harness.externalCalls().models).toBe(0);
  });

  test("does not reuse a trailing continue decision to append fresh dispatch intents", async () => {
    const continueState: TestState = {
      inputCount: 1,
      decision: { kind: "continue" },
    };
    const existing = derivedDecision(continueState, 1);
    const session = new ResumeSession([attemptStarted()], existing, []);

    await expect(
      session.commitDecisionAndInputFacts(session.tailSeq, existing, [
        toolDispatch(1, 0),
      ]),
    ).rejects.toThrow("trailing decision");
    expect(session.tailSeq).toBe(2);
    expect(session.inputFacts).toEqual([attemptStarted()]);
  });

  test("two consecutive starts append one decision and then reuse it", async () => {
    const harness = createHarness({
      facts: [attemptStarted()],
      decide: () => ({ kind: "completed", reason: "done" }),
    });

    await runAgentLoop(harness.dependencies);
    const afterFirst = harness.session.tailSeq;
    await runAgentLoop(harness.dependencies);

    expect(harness.session.appendedDecisions).toHaveLength(1);
    expect(harness.session.reusedDecisions).toBe(1);
    expect(harness.session.tailSeq).toBe(afterFirst);
    expect(harness.externalCalls().models).toBe(0);
  });

  test("MemorySession reuses only an exact tail decision and never reuses it for decision-plus-input", async () => {
    const session = new MemorySession();
    await session.appendInputFacts([attemptStarted()]);
    const state: TestState = {
      inputCount: 1,
      decision: { kind: "continue" },
    };
    const decision = derivedDecision(state, 1);
    expect(await session.commitDerivedDecision(1, decision)).toBe("committed");
    const firstTail = (await session.readInputSnapshot()).tailSeq;

    expect(await session.commitDerivedDecision(firstTail, decision)).toBe(
      "committed",
    );
    expect((await session.readInputSnapshot()).tailSeq).toBe(firstTail);
    expect(session.derivedDecisions).toHaveLength(1);
    await expect(
      session.commitDerivedDecision(firstTail, {
        ...decision,
        action: { kind: "continue", reasonCode: "tampered" },
      }),
    ).rejects.toThrow("conflicting derived decision");
    await expect(
      session.commitDecisionAndInputFacts(firstTail, decision, [
        modelDispatch(1),
      ]),
    ).rejects.toThrow("derived decision");
    expect((await session.readInputSnapshot()).tailSeq).toBe(firstTail);
  });
});

interface HarnessOptions {
  readonly facts: readonly InputFactV1[];
  readonly trailingDecision?: DerivedDecisionV1;
  readonly decide: (facts: readonly InputFactV1[]) => ControlDecision;
  readonly beforeDecisionCommit?: (
    session: ResumeSession,
    decision: DerivedDecisionV1,
  ) => void | Promise<void>;
  readonly beforeInputCommit?: (
    session: ResumeSession,
    facts: readonly InputFactV1[],
  ) => void | Promise<void>;
}

function createHarness(options: HarnessOptions) {
  const trace: string[] = [];
  const session = new ResumeSession(
    options.facts,
    options.trailingDecision,
    trace,
    options.beforeDecisionCommit,
    options.beforeInputCommit,
  );
  const boundaries: string[] = [];
  const modelTurns: number[] = [];
  let boundaryCalls = 0;
  let inputCalls = 0;
  let contextCalls = 0;
  let modelCalls = 0;
  let toolCalls = 0;
  let reducerCalls = 0;

  const dependencies: TestDependencies = {
    session,
    runConfig: {},
    reducerVersion: "resume-test-v1",
    input: {
      async reportSafeBoundary(boundary) {
        boundaryCalls += 1;
        boundaries.push(boundary);
        trace.push(`boundary:${boundary}`);
      },
      async consumePromotedInputIds() {
        inputCalls += 1;
        return [];
      },
    },
    context: {
      async build(snapshot) {
        contextCalls += 1;
        return snapshot;
      },
    },
    model: {
      async execute() {
        modelCalls += 1;
        return { status: "success", message: "done", toolCalls: [] };
      },
    },
    tools: {
      async executeSettled() {
        toolCalls += 1;
        return [];
      },
    },
    reducer: {
      reduce(facts) {
        reducerCalls += 1;
        return { inputCount: facts.length, decision: options.decide(facts) };
      },
    },
    stateHasher: { hash: hashState },
    facts: {
      modelRequestIntent({ turn }) {
        modelTurns.push(turn);
        return modelDispatch(turn);
      },
      modelSettled({ turn, settlement }) {
        if (settlement.status === "success") {
          return modelSettlement(turn, settlement.toolCalls.length > 0);
        }
        return {
          type: "model.settled",
          modelCallId: `model-${turn}`,
          turn,
          status: settlement.status,
          hasToolCalls: false,
          hasVisibleOutput: false,
        };
      },
      toolCallObserved({ turn, sourceIndex, call }) {
        return {
          type: "tool.call_observed",
          callId: call.id,
          modelCallId: `model-${turn}`,
          turn,
          tool: call.name,
          args: call.args,
          order: sourceIndex,
        };
      },
      toolDispatchIntent({ turn, sourceIndex, call }) {
        return {
          type: "tool.dispatch_recorded",
          callId: call.id,
          turn,
          sourceIndex,
          batchId: `batch-${turn}`,
          mode: "parallel",
        };
      },
      toolSettled({ settlement }) {
        return {
          type: "tool.settled",
          callId: settlement.callId,
          status:
            settlement.status === "success"
              ? "completed"
              : settlement.status === "denied"
                ? "rejected"
                : settlement.status,
        };
      },
      runAbortObserved({ reason }) {
        return { type: "abort.requested", source: "signal", reason };
      },
      runtimeFailed({ area, error }) {
        return {
          type: "runtime.failed",
          area,
          errorCode: error.name,
          message: error.message,
          retryable: false,
        };
      },
      derivedDecision({ state, inputThroughSeq }) {
        return derivedDecision(state, inputThroughSeq);
      },
    },
  };

  return {
    dependencies,
    session,
    trace,
    boundaries,
    modelTurns,
    get reducerCalls() {
      return reducerCalls;
    },
    externalCalls() {
      return {
        boundaries: boundaryCalls,
        inputs: inputCalls,
        contexts: contextCalls,
        models: modelCalls,
        tools: toolCalls,
      };
    },
  };
}

class ResumeSession implements Session<InputFactV1, DerivedDecisionV1> {
  readonly inputFacts: InputFactV1[] = [];
  readonly inputEntries: Array<{
    readonly seq: number;
    readonly fact: InputFactV1;
  }> = [];
  readonly appendedDecisions: DerivedDecisionV1[] = [];
  readonly trace: string[];
  private trailingDecision: DerivedDecisionV1 | undefined;
  private journalSeq = 0;
  private latestInputSeq = 0;
  decisionCommitCalls = 0;
  inputCommitCalls = 0;
  reusedDecisions = 0;

  constructor(
    facts: readonly InputFactV1[],
    trailingDecision: DerivedDecisionV1 | undefined,
    trace: string[],
    private readonly beforeDecisionCommit?: (
      session: ResumeSession,
      decision: DerivedDecisionV1,
    ) => void | Promise<void>,
    private readonly beforeInputCommit?: (
      session: ResumeSession,
      facts: readonly InputFactV1[],
    ) => void | Promise<void>,
  ) {
    this.trace = trace;
    this.appendSeedFacts(facts);
    if (trailingDecision) {
      this.journalSeq += 1;
      this.trailingDecision = trailingDecision;
    }
  }

  get tailSeq(): number {
    return this.journalSeq;
  }

  async readInputSnapshot() {
    return {
      entries: [...this.inputEntries],
      tailSeq: this.journalSeq,
      latestInputSeq: this.latestInputSeq,
    };
  }

  async appendInputFacts(facts: readonly InputFactV1[]): Promise<void> {
    this.trailingDecision = undefined;
    this.appendSeedFacts(facts);
  }

  async commitInputFacts(
    expectedTailSeq: number,
    facts: readonly InputFactV1[],
  ): Promise<"committed" | "conflict"> {
    this.inputCommitCalls += 1;
    await this.beforeInputCommit?.(this, facts);
    if (this.journalSeq !== expectedTailSeq) return "conflict";
    await this.appendInputFacts(facts);
    return "committed";
  }

  async commitDerivedDecision(
    expectedTailSeq: number,
    decision: DerivedDecisionV1,
  ): Promise<"committed" | "conflict"> {
    this.decisionCommitCalls += 1;
    await this.beforeDecisionCommit?.(this, decision);
    if (this.journalSeq !== expectedTailSeq) return "conflict";
    if (this.trailingDecision) {
      if (JSON.stringify(this.trailingDecision) !== JSON.stringify(decision)) {
        throw new Error(
          "Trailing derived decision differs from replay decision",
        );
      }
      this.reusedDecisions += 1;
      this.trace.push(`decision:${decision.action.kind}`);
      return "committed";
    }
    this.journalSeq += 1;
    this.trailingDecision = decision;
    this.appendedDecisions.push(decision);
    this.trace.push(`decision:${decision.action.kind}`);
    return "committed";
  }

  async commitDecisionAndInputFacts(
    expectedTailSeq: number,
    decision: DerivedDecisionV1,
    facts: readonly InputFactV1[],
  ): Promise<"committed" | "conflict"> {
    if (this.journalSeq !== expectedTailSeq) return "conflict";
    if (this.trailingDecision) {
      throw new Error(
        "Decision-and-input commit cannot reuse a trailing decision",
      );
    }
    this.journalSeq += 1;
    this.appendedDecisions.push(decision);
    this.trailingDecision = undefined;
    this.appendSeedFacts(facts);
    return "committed";
  }

  seedDecisionThenFacts(
    decision: DerivedDecisionV1,
    facts: readonly InputFactV1[],
  ): void {
    this.journalSeq += 1;
    this.trailingDecision = decision;
    this.trailingDecision = undefined;
    this.appendSeedFacts(facts);
  }

  private appendSeedFacts(facts: readonly InputFactV1[]): void {
    for (const fact of facts) {
      this.journalSeq += 1;
      this.latestInputSeq = this.journalSeq;
      this.inputFacts.push(fact);
      this.inputEntries.push({ seq: this.journalSeq, fact });
      this.trace.push(`fact:${fact.type}`);
    }
  }
}

function attemptStarted(): InputFactV1 {
  return {
    type: "attempt.started",
    goalHash: "goal",
    configHash: "config",
  };
}

function modelTurn(
  turn: number,
  modelCallId = `model-${turn}`,
  hasToolCalls = false,
): InputFactV1[] {
  return [
    modelDispatch(turn, modelCallId),
    modelSettlement(turn, hasToolCalls, modelCallId),
  ];
}

function invalidArgumentsModelTurn(): InputFactV1[] {
  const facts = modelTurn(1, "model-1", true);
  const settled = facts[1];
  if (!settled || settled.type !== "model.settled") {
    throw new Error("expected model settlement fixture");
  }
  facts[1] = {
    ...settled,
    response: {
      kind: "inline",
      value: {
        schemaVersion: "paw.model-response.v1",
        providerProtocol: "openai-compatible",
        assistantContent: "",
        finishReason: "tool_calls",
        toolCalls: [
          {
            callId: "call-1-0",
            name: "read_file",
            rawArguments: "not-json",
            args: {},
            sourceIndex: 0,
            argumentsValid: false,
          },
        ],
      },
      hash: "invalid-response",
    },
  };
  return facts;
}

function modelDispatch(
  turn: number,
  modelCallId = `model-${turn}`,
): Extract<InputFactV1, { type: "model.dispatch_recorded" }> {
  return {
    type: "model.dispatch_recorded",
    modelCallId,
    turn,
    requestHash: `request-${turn}`,
  };
}

function modelSettlement(
  turn: number,
  hasToolCalls: boolean,
  modelCallId = `model-${turn}`,
): Extract<InputFactV1, { type: "model.settled" }> {
  return {
    type: "model.settled",
    modelCallId,
    turn,
    status: "completed",
    hasToolCalls,
    hasVisibleOutput: !hasToolCalls,
    response: {
      kind: "inline",
      value: {
        schemaVersion: "paw.model-response.v1",
        providerProtocol: "openai-compatible",
        assistantContent: hasToolCalls ? "" : "done",
        finishReason: hasToolCalls ? "tool_calls" : "stop",
        toolCalls: hasToolCalls
          ? [
              {
                callId: `call-${turn}-0`,
                name: "read_file",
                rawArguments: "{}",
                args: {},
                sourceIndex: 0,
                argumentsValid: true,
              },
            ]
          : [],
      },
      hash: `response-${turn}`,
    },
  };
}

function providerToolCall(callId: string, sourceIndex: number) {
  return {
    callId,
    name: "read_file",
    rawArguments: "{}",
    args: {},
    sourceIndex,
    argumentsValid: true,
  } as const;
}

function plainModelResponse(): ModelResponseV1 {
  return {
    schemaVersion: "paw.model-response.v1",
    providerProtocol: "openai-compatible",
    assistantContent: "done",
    finishReason: "stop",
    toolCalls: [],
  };
}

function toolModelResponse(turn: number): ModelResponseV1 {
  return {
    schemaVersion: "paw.model-response.v1",
    providerProtocol: "openai-compatible",
    assistantContent: "",
    finishReason: "tool_calls",
    toolCalls: [providerToolCall(`call-${turn}-0`, 0)],
  };
}

function artifactBackedToolTurn(turn: number): InputFactV1[] {
  const facts = toolTurn(turn);
  const settledIndex = facts.findIndex((fact) => fact.type === "model.settled");
  const settled = facts[settledIndex];
  if (!settled || settled.type !== "model.settled") {
    throw new Error("expected model settlement fixture");
  }
  facts[settledIndex] = {
    ...settled,
    response: {
      kind: "artifact_ref",
      artifactRef: `model-response/tool-turn-${turn}`,
      hash: `artifact-response-${turn}`,
    },
  };
  return facts;
}

function requiredModelPayload(
  facts: readonly InputFactV1[],
): DurableJsonPayloadV1 {
  const settled = facts.find((fact) => fact.type === "model.settled");
  if (!settled || settled.type !== "model.settled" || !settled.response) {
    throw new Error("expected durable model response payload");
  }
  return settled.response;
}

function exactModelResponseEvidence(options: {
  readonly snapshot: SessionInputSnapshot<InputFactV1>;
  readonly carrierSeq: number;
  readonly modelCallId: string;
  readonly payload: DurableJsonPayloadV1 | undefined;
  readonly response: ModelResponseV1;
}): VerifiedModelResponseEvidenceV1 {
  if (!options.payload) throw new Error("missing expected model payload");
  const expectedSnapshot = JSON.stringify(options.snapshot);
  const expectedPayload = JSON.stringify(options.payload);
  return {
    assertSnapshot(snapshot) {
      if (JSON.stringify(snapshot) !== expectedSnapshot) {
        throw new Error("verified model response snapshot mismatch");
      }
    },
    requireModelResponse(input) {
      this.assertSnapshot(input.snapshot);
      if (
        input.carrierSeq !== options.carrierSeq ||
        input.modelCallId !== options.modelCallId ||
        JSON.stringify(input.payload) !== expectedPayload
      ) {
        throw new Error("verified model response carrier mismatch");
      }
      return options.response;
    },
  };
}

function toolTurn(turn: number): InputFactV1[] {
  return [
    ...modelTurn(turn, `model-${turn}`, true),
    observedTool(turn, 0),
    toolDispatch(turn, 0),
    toolPermission(turn, 0),
    {
      type: "tool.settled",
      callId: `call-${turn}-0`,
      status: "completed",
      result: { ok: true },
    },
  ];
}

function observedTool(
  turn: number,
  sourceIndex: number,
): Extract<InputFactV1, { type: "tool.call_observed" }> {
  return {
    type: "tool.call_observed",
    callId: `call-${turn}-${sourceIndex}`,
    modelCallId: `model-${turn}`,
    turn,
    tool: "read_file",
    args: {},
    order: sourceIndex,
  };
}

function toolDispatch(
  turn: number,
  sourceIndex: number,
): Extract<InputFactV1, { type: "tool.dispatch_recorded" }> {
  return {
    type: "tool.dispatch_recorded",
    callId: `call-${turn}-${sourceIndex}`,
    turn,
    sourceIndex,
    batchId: `batch-${turn}`,
    mode: "parallel",
  };
}

function toolPermission(
  turn: number,
  sourceIndex: number,
): Extract<InputFactV1, { type: "tool.permission_resolved" }> {
  return {
    type: "tool.permission_resolved",
    turn,
    sourceIndex,
    callId: `call-${turn}-${sourceIndex}`,
    tool: "read_file",
    policyVersion: "permission-v1",
    resolution: "allow_once",
    source: "base_policy",
  };
}

function modelSettlements(facts: readonly InputFactV1[]): number {
  return facts.filter((fact) => fact.type === "model.settled").length;
}

function hashState(state: TestState): string {
  return JSON.stringify(state);
}

function derivedDecision(
  state: TestState,
  inputThroughSeq: number,
): DerivedDecisionV1 {
  return {
    type: "control.decided",
    reducerVersion: "resume-test-v1",
    inputThroughSeq,
    stateHash: hashState(state),
    action: decisionAction(state.decision),
  };
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
