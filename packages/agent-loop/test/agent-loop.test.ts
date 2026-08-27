import { describe, expect, test } from "bun:test";
import type {
  ControlDecisionActionV1,
  InputFactV1,
  JsonValue,
} from "@paw/protocol";
import {
  type AgentLoopDependencies,
  type AgentLoopFactMapper,
  type ControlDecision,
  type LoopControlState,
  type ModelSettlement,
  type SessionInputSnapshot,
  type ToolSettlement,
  runAgentLoop,
} from "../src/index.js";
import { MemoryLoopInput, MemorySession, deferred } from "./fakes.js";

interface TestConfig {
  readonly mode: "test";
}

interface TestToolCall {
  readonly id: string;
  readonly name: string;
  readonly args: JsonValue;
  readonly argumentsValid?: boolean;
}

type TestRequest = SessionInputSnapshot<InputFactV1>;

interface TestState extends LoopControlState {
  readonly canonicalFactCount: number;
}

type TestModelSettlement = ModelSettlement<string, TestToolCall>;
type TestToolSettlement = ToolSettlement<string>;
type TestDependencies = AgentLoopDependencies<
  TestConfig,
  TestRequest,
  string,
  string,
  TestToolCall,
  string,
  TestState
>;

type ModelStep =
  | TestModelSettlement
  | Error
  | ((
      request: TestRequest,
      signal: AbortSignal,
    ) => Promise<TestModelSettlement>);

interface HarnessOptions {
  readonly model: readonly ModelStep[];
  readonly promoted?: readonly (readonly string[])[];
  readonly decide?: (facts: readonly InputFactV1[]) => ControlDecision;
  readonly executeTools?: (
    calls: readonly TestToolCall[],
    signal: AbortSignal,
  ) => Promise<readonly TestToolSettlement[]>;
}

function createHarness(options: HarnessOptions) {
  const trace: string[] = [];
  const session = new MemorySession(trace);
  const input = new MemoryLoopInput(options.promoted, trace);
  const requests: TestRequest[] = [];
  const reducerInputs: InputFactV1[][] = [];
  const modelSteps = [...options.model];
  const toolTurns: number[] = [];
  let modelCalls = 0;
  let toolCalls = 0;

  const dependencies: TestDependencies = {
    session,
    input,
    runConfig: { mode: "test" },
    reducerVersion: "test-v1",
    facts: createFactMapper(),
    context: {
      async build(contextInput) {
        const request = {
          entries: [...contextInput.entries],
          tailSeq: contextInput.tailSeq,
          latestInputSeq: contextInput.latestInputSeq,
        };
        requests.push(request);
        trace.push(`context:${request.latestInputSeq}`);
        return request;
      },
    },
    model: {
      async execute(request, callOptions) {
        modelCalls += 1;
        trace.push(`model.execute:${modelCalls}`);
        await callOptions.onStreamEvent(`stream-${modelCalls}`);
        const step = modelSteps.shift();
        if (step instanceof Error) throw step;
        if (typeof step === "function") {
          return step(request, callOptions.signal);
        }
        if (step === undefined) throw new Error("No scripted model step");
        return step;
      },
    },
    tools: {
      async executeSettled(calls, callOptions) {
        toolCalls += 1;
        toolTurns.push(callOptions.turn);
        trace.push(`tools.execute:${calls.map((call) => call.id).join("|")}`);
        if (options.executeTools) {
          return options.executeTools(calls, callOptions.signal);
        }
        return calls.map((call) => ({
          status: "success" as const,
          callId: call.id,
          result: `ok:${call.id}`,
        }));
      },
    },
    reducer: {
      reduce(facts) {
        const snapshot = [...facts];
        reducerInputs.push(snapshot);
        return {
          canonicalFactCount: snapshot.length,
          decision:
            options.decide?.(snapshot) ?? decisionAfterLatestFact(snapshot),
        };
      },
    },
    stateHasher: {
      hash: hashTestState,
    },
  };

  return {
    dependencies,
    input,
    reducerInputs,
    requests,
    session,
    trace,
    toolTurns,
    get modelCalls() {
      return modelCalls;
    },
    get toolCalls() {
      return toolCalls;
    },
  };
}

describe("minimal agent loop", () => {
  test("L01 natural stop ends only when ControlReducer says so", async () => {
    const harness = createHarness({ model: [modelSuccess("done")] });

    const state = await runAgentLoop(harness.dependencies);

    expect(state.decision).toEqual({
      kind: "completed",
      reason: "natural-stop",
    });
    expect(harness.modelCalls).toBe(1);
    expect(harness.session.inputFacts.map((fact) => fact.type)).toEqual([
      "model.dispatch_recorded",
      "model.settled",
    ]);
  });

  test("L02 natural stop continues when ControlReducer says continue", async () => {
    const harness = createHarness({
      model: [modelSuccess("first"), modelSuccess("second")],
      decide(facts) {
        const settled = facts.filter((fact) => fact.type === "model.settled");
        return settled.length < 2
          ? { kind: "continue" }
          : { kind: "completed", reason: "two-turns" };
      },
    });

    const state = await runAgentLoop(harness.dependencies);

    expect(state.decision).toEqual({ kind: "completed", reason: "two-turns" });
    expect(harness.modelCalls).toBe(2);
    expect(harness.input.boundaries).toEqual([
      "before_first_model_request",
      "after_model_turn_without_tool_calls",
    ]);
  });

  test("L03 single tool follows intent, settlement, reducer, next turn order", async () => {
    const call = toolCall("call-1");
    const harness = createHarness({
      model: [modelSuccess("use tool", [call]), modelSuccess("done")],
    });

    await runAgentLoop(harness.dependencies);

    expect(harness.toolCalls).toBe(1);
    expect(harness.toolTurns).toEqual([1]);
    expect(harness.session.inputFacts.map((fact) => fact.type)).toEqual([
      "model.dispatch_recorded",
      "model.settled",
      "tool.call_observed",
      "tool.dispatch_recorded",
      "tool.settled",
      "model.dispatch_recorded",
      "model.settled",
    ]);
    expect(
      harness.trace.indexOf("append:tool.dispatch_recorded:call-1"),
    ).toBeLessThan(harness.trace.indexOf("tools.execute:call-1"));
  });

  test("ToolExecutor receives the actual model turn instead of a batch-local constant", async () => {
    const harness = createHarness({
      model: [
        modelSuccess("first turn without tools"),
        modelSuccess("second turn tool", [toolCall("turn-two-call")]),
      ],
      decide(facts) {
        return facts.some((fact) => fact.type === "tool.settled")
          ? { kind: "completed", reason: "tool-accounted" }
          : { kind: "continue" };
      },
    });

    await runAgentLoop(harness.dependencies);

    expect(harness.modelCalls).toBe(2);
    expect(harness.toolTurns).toEqual([2]);
  });

  test("L04 parallel completion may differ but tool settlements return in model source order", async () => {
    const first = toolCall("call-1");
    const second = toolCall("call-2");
    const releaseFirst = deferred<void>();
    const completionOrder: string[] = [];
    let parallelObserved = false;
    const harness = createHarness({
      model: [modelSuccess("parallel", [first, second]), modelSuccess("done")],
      async executeTools(calls) {
        const firstCall = calls[0];
        const secondCall = calls[1];
        if (!firstCall || !secondCall) {
          throw new Error("Expected two tool calls");
        }
        const firstTask = (async (): Promise<TestToolSettlement> => {
          await releaseFirst.promise;
          completionOrder.push(firstCall.id);
          return { status: "success", callId: firstCall.id, result: "first" };
        })();
        const secondTask = (async (): Promise<TestToolSettlement> => {
          parallelObserved = true;
          completionOrder.push(secondCall.id);
          releaseFirst.resolve();
          return { status: "success", callId: secondCall.id, result: "second" };
        })();
        const [firstResult, secondResult] = await Promise.all([
          firstTask,
          secondTask,
        ]);
        return [secondResult, firstResult];
      },
    });

    await runAgentLoop(harness.dependencies);

    expect(parallelObserved).toBe(true);
    expect(completionOrder).toEqual(["call-2", "call-1"]);
    expect(
      harness.session.inputFacts
        .filter((fact) => fact.type === "tool.settled")
        .map((fact) => fact.callId),
    ).toEqual(["call-1", "call-2"]);
  });

  test("L05 known model failure is settled and reduced without throwing", async () => {
    const harness = createHarness({
      model: [
        {
          status: "failed",
          error: { name: "ProviderError", message: "unavailable" },
        },
      ],
    });

    const state = await runAgentLoop(harness.dependencies);

    expect(state.decision.kind).toBe("incomplete");
    expect(findModelSettlement(harness.session.inputFacts)?.status).toBe(
      "failed",
    );
  });

  test("truncated output is settled but never authorizes partial tool calls", async () => {
    const harness = createHarness({
      model: [
        {
          status: "truncated",
          message: "partial assistant response",
          toolCalls: [toolCall("partial-call")],
          reason: "provider output limit",
          finishReason: "max_tokens",
        },
      ],
    });

    const state = await runAgentLoop(harness.dependencies);

    expect(state.decision).toEqual({
      kind: "incomplete",
      reason: "truncated",
    });
    expect(harness.toolCalls).toBe(0);
    expect(
      harness.session.inputFacts.some(
        (fact) =>
          fact.type === "tool.call_observed" ||
          fact.type === "tool.dispatch_recorded",
      ),
    ).toBe(false);
    expect(findModelSettlement(harness.session.inputFacts)).toMatchObject({
      status: "truncated",
      hasToolCalls: true,
      finishReason: "max_tokens",
      response: {
        kind: "inline",
        value: {
          message: "partial assistant response",
          truncationReason: "provider output limit",
        },
      },
    });
  });

  test("model-stage terminal decision prevents every requested tool side effect", async () => {
    const harness = createHarness({
      model: [modelSuccess("must stop", [toolCall("must-not-run")])],
      decide(facts) {
        const observed = facts.some(
          (fact) => fact.type === "tool.call_observed",
        );
        const cancelled = facts.some(
          (fact) => fact.type === "tool.settled" && fact.status === "cancelled",
        );
        if (observed || cancelled) {
          return { kind: "completed", reason: "budget-exhausted" };
        }
        return { kind: "continue" };
      },
    });

    const state = await runAgentLoop(harness.dependencies);

    expect(state.decision).toEqual({
      kind: "completed",
      reason: "budget-exhausted",
    });
    expect(harness.toolCalls).toBe(0);
    expect(harness.session.inputFacts.map((fact) => fact.type)).toEqual([
      "model.dispatch_recorded",
      "model.settled",
      "tool.call_observed",
      "tool.settled",
    ]);
    expect(findToolSettlements(harness.session.inputFacts)).toEqual([
      expect.objectContaining({ callId: "must-not-run", status: "cancelled" }),
    ]);
    const responseBatch = harness.session.appendBatches.find(
      (batch) => batch[0]?.type === "model.settled",
    );
    expect(responseBatch?.map((fact) => fact.type)).toEqual([
      "model.settled",
      "tool.call_observed",
    ]);
    expect(responseBatch?.[0]).toMatchObject({
      type: "model.settled",
      response: {
        kind: "inline",
        value: {
          message: "must stop",
          toolCalls: [{ id: "must-not-run", name: "test_tool" }],
        },
      },
    });
  });

  test("L06 thrown model call becomes unknown after its dispatch intent", async () => {
    const harness = createHarness({ model: [new Error("socket vanished")] });

    await runAgentLoop(harness.dependencies);

    expect(findModelSettlement(harness.session.inputFacts)).toMatchObject({
      status: "unknown",
    });
    expect(
      findModelSettlement(harness.session.inputFacts)?.errorCode,
    ).toBeUndefined();
    expect(harness.session.inputFacts[0]?.type).toBe("model.dispatch_recorded");
  });

  test("abort during model produces one decision over settlement plus abort", async () => {
    const controller = new AbortController();
    const harness = createHarness({
      model: [
        async () => {
          controller.abort("cancel model");
          return { status: "cancelled", reason: "cancel model" };
        },
      ],
      decide(facts) {
        const latest = facts.at(-1);
        if (latest?.type === "abort.requested") {
          return { kind: "aborted", reason: "abort-wins" };
        }
        if (latest?.type === "model.settled") {
          return { kind: "completed", reason: "must-not-be-persisted" };
        }
        return { kind: "continue" };
      },
    });

    const state = await runAgentLoop(harness.dependencies, {
      signal: controller.signal,
    });

    expect(state.decision).toEqual({ kind: "aborted", reason: "abort-wins" });
    expect(
      harness.session.derivedDecisions.map((decision) => decision.action.kind),
    ).toEqual(["continue", "abort"]);
    expect(harness.session.derivedDecisions.at(-1)).toMatchObject({
      inputThroughSeq: 4,
      action: { kind: "abort" },
    });
    expect(harness.reducerInputs).toHaveLength(2);
    expect(harness.reducerInputs.at(-1)?.at(-1)?.type).toBe("abort.requested");
  });

  test("L07 denied tool is a settlement interpreted by the reducer", async () => {
    const harness = createHarness({
      model: [modelSuccess("needs permission", [toolCall("denied")])],
      async executeTools() {
        return [{ status: "denied", callId: "denied", reason: "user denied" }];
      },
    });

    const state = await runAgentLoop(harness.dependencies);

    expect(state.decision.kind).toBe("await_user");
    expect(findToolSettlements(harness.session.inputFacts)).toEqual([
      expect.objectContaining({ callId: "denied", status: "rejected" }),
    ]);
  });

  test("mixed denied, cancelled, unknown, and failed settlements commit once in source order", async () => {
    const calls = [
      toolCall("denied"),
      toolCall("cancelled"),
      toolCall("unknown"),
      toolCall("failed"),
    ];
    let executorInputIds: string[] = [];
    const harness = createHarness({
      model: [modelSuccess("mixed tool outcomes", calls)],
      decide(facts) {
        return facts.filter((fact) => fact.type === "tool.settled").length === 4
          ? { kind: "completed", reason: "batch-accounted" }
          : { kind: "continue" };
      },
      async executeTools(executorCalls) {
        executorInputIds = executorCalls.map((call) => call.id);
        return [
          {
            status: "failed",
            callId: "failed",
            error: { name: "ToolError", message: "failed safely" },
            evidence: "failed-after-writing-output",
          },
          { status: "unknown", callId: "unknown", reason: "not proven" },
          {
            status: "cancelled",
            callId: "cancelled",
            reason: "cancelled before effect",
          },
          {
            status: "denied",
            callId: "denied",
            reason: "approval denied",
            evidence: "approval-context",
          },
        ];
      },
    });

    const state = await runAgentLoop(harness.dependencies);

    expect(state.decision).toEqual({
      kind: "completed",
      reason: "batch-accounted",
    });
    expect(executorInputIds).toEqual([
      "denied",
      "cancelled",
      "unknown",
      "failed",
    ]);
    expect(
      findToolSettlements(harness.session.inputFacts).map((fact) => [
        fact.callId,
        fact.status,
      ]),
    ).toEqual([
      ["denied", "rejected"],
      ["cancelled", "cancelled"],
      ["unknown", "unknown"],
      ["failed", "failed"],
    ]);
    const settlementBatches = harness.session.appendBatches.filter((batch) =>
      batch.some((fact) => fact.type === "tool.settled"),
    );
    expect(settlementBatches).toHaveLength(1);
    expect(settlementBatches[0]).toHaveLength(4);
    expect(settlementBatches[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          callId: "denied",
          status: "rejected",
          result: "approval-context",
        }),
        expect.objectContaining({
          callId: "failed",
          status: "failed",
          result: "failed-after-writing-output",
        }),
      ]),
    );
  });

  test("L08 executor throw gives every call an unknown settlement in source order", async () => {
    const harness = createHarness({
      model: [modelSuccess("tools", [toolCall("first"), toolCall("second")])],
      async executeTools() {
        throw new Error("batch crashed");
      },
    });

    await runAgentLoop(harness.dependencies);

    expect(
      findToolSettlements(harness.session.inputFacts).map((fact) => [
        fact.callId,
        fact.status,
      ]),
    ).toEqual([
      ["first", "unknown"],
      ["second", "unknown"],
    ]);
  });

  test("L08b duplicate, missing, and unrelated tool results fail closed", async () => {
    const harness = createHarness({
      model: [
        modelSuccess("tools", [toolCall("duplicate"), toolCall("missing")]),
      ],
      async executeTools() {
        return [
          { status: "success", callId: "duplicate", result: "one" },
          {
            status: "failed",
            callId: "duplicate",
            error: { name: "Conflict", message: "two" },
          },
          { status: "success", callId: "unrelated", result: "ghost" },
        ];
      },
    });

    await runAgentLoop(harness.dependencies);

    expect(
      findToolSettlements(harness.session.inputFacts).map((fact) => [
        fact.callId,
        fact.status,
      ]),
    ).toEqual([
      ["duplicate", "unknown"],
      ["missing", "unknown"],
    ]);
  });

  test("two valid tool results plus one extra call ID makes the whole batch unknown", async () => {
    const harness = createHarness({
      model: [modelSuccess("tools", [toolCall("first"), toolCall("second")])],
      async executeTools() {
        return [
          { status: "success", callId: "first", result: "first-ok" },
          { status: "success", callId: "second", result: "second-ok" },
          { status: "success", callId: "ghost", result: "ghost-result" },
        ];
      },
    });

    await runAgentLoop(harness.dependencies);

    expect(
      findToolSettlements(harness.session.inputFacts).map((fact) => [
        fact.callId,
        fact.status,
      ]),
    ).toEqual([
      ["first", "unknown"],
      ["second", "unknown"],
    ]);
  });

  test("L09 pre-aborted run records abort and never calls the model", async () => {
    const controller = new AbortController();
    controller.abort("stop now");
    const harness = createHarness({ model: [modelSuccess("unused")] });

    const state = await runAgentLoop(harness.dependencies, {
      signal: controller.signal,
    });

    expect(state.decision.kind).toBe("aborted");
    expect(harness.modelCalls).toBe(0);
    expect(harness.session.inputFacts).toEqual([
      { type: "abort.requested", source: "signal", reason: "stop now" },
    ]);
  });

  test("L10 abort during tools settles the batch before reducing abort", async () => {
    const controller = new AbortController();
    const harness = createHarness({
      model: [modelSuccess("tool", [toolCall("slow")])],
      async executeTools(_calls, signal) {
        controller.abort("cancel tool");
        expect(signal.aborted).toBe(true);
        return [{ status: "cancelled", callId: "slow", reason: "cancel tool" }];
      },
      decide(facts) {
        const latest = facts.at(-1);
        if (latest?.type === "abort.requested") {
          return { kind: "aborted", reason: "abort-wins" };
        }
        if (latest?.type === "model.settled" && latest.hasToolCalls) {
          return { kind: "continue" };
        }
        if (latest?.type === "tool.settled") {
          return { kind: "completed", reason: "must-not-be-persisted" };
        }
        return { kind: "continue" };
      },
    });

    const state = await runAgentLoop(harness.dependencies, {
      signal: controller.signal,
    });

    expect(state.decision.kind).toBe("aborted");
    expect(harness.session.inputFacts.map((fact) => fact.type)).toEqual([
      "model.dispatch_recorded",
      "model.settled",
      "tool.call_observed",
      "tool.dispatch_recorded",
      "tool.settled",
      "abort.requested",
    ]);
    expect(
      harness.session.derivedDecisions.map((decision) => ({
        inputThroughSeq: decision.inputThroughSeq,
        action: decision.action.kind,
      })),
    ).toEqual([
      { inputThroughSeq: 0, action: "continue" },
      { inputThroughSeq: 4, action: "continue" },
      { inputThroughSeq: 8, action: "abort" },
    ]);
    expect(harness.reducerInputs).toHaveLength(3);
    expect(harness.reducerInputs.at(-1)?.at(-1)?.type).toBe("abort.requested");
  });

  test("L11 context receives promoted content only from the canonical snapshot", async () => {
    const harness = createHarness({
      promoted: [["input-1"]],
      model: [modelSuccess("done")],
    });
    await harness.session.appendInputFacts([
      {
        type: "input.promoted",
        inputId: "input-1",
        delivery: "initial",
        content: "canonical direction",
        contentHash: "content-1",
      },
    ]);

    await runAgentLoop(harness.dependencies);

    expect(harness.requests).toHaveLength(1);
    expect(JSON.stringify(harness.requests[0])).toContain(
      "canonical direction",
    );
    expect(JSON.stringify(harness.requests[0])).not.toContain(
      "promoted direction payload",
    );
  });

  test("Context receives one complete Session snapshot without DerivedDecision", async () => {
    const harness = createHarness({ model: [modelSuccess("done")] });
    await harness.session.appendInputFacts([
      {
        type: "model.dispatch_recorded",
        modelCallId: "historical-model",
        turn: 1,
        requestHash: "historical-request",
      },
      {
        type: "model.settled",
        modelCallId: "historical-model",
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
            toolCalls: [
              {
                callId: "historical-call",
                name: "read_file",
                rawArguments: '{"path":"src/a.ts"}',
                args: { path: "src/a.ts" },
                sourceIndex: 0,
                argumentsValid: true,
              },
            ],
          },
          hash: "historical-response",
        },
      },
      {
        type: "tool.call_observed",
        callId: "historical-call",
        modelCallId: "historical-model",
        turn: 1,
        tool: "read_file",
        args: { path: "src/a.ts" },
        order: 0,
      },
      {
        type: "tool.dispatch_recorded",
        callId: "historical-call",
        turn: 1,
        sourceIndex: 0,
        batchId: "historical-batch",
        mode: "serial",
      },
      {
        type: "tool.permission_resolved",
        turn: 1,
        sourceIndex: 0,
        callId: "historical-call",
        tool: "read_file",
        policyVersion: "permission-v1",
        resolution: "allow_once",
        source: "base_policy",
      },
      {
        type: "tool.settled",
        callId: "historical-call",
        status: "completed",
        result: { content: "historical result" },
        resultHash: "historical-result",
      },
    ]);
    await harness.session.commitDerivedDecision(6, {
      type: "control.decided",
      reducerVersion: "test-v1",
      inputThroughSeq: 6,
      stateHash: hashTestState({
        canonicalFactCount: 6,
        decision: { kind: "continue" },
      }),
      action: { kind: "continue", reasonCode: "continue" },
    });
    const snapshots: TestRequest[] = [];
    const originalRead = harness.session.readInputSnapshot.bind(
      harness.session,
    );
    harness.session.readInputSnapshot = async () => {
      const snapshot = await originalRead();
      snapshots.push(snapshot);
      return snapshot;
    };
    let received: TestRequest | undefined;
    harness.dependencies.context.build = async (snapshot) => {
      received = snapshot;
      return snapshot;
    };

    await runAgentLoop(harness.dependencies);

    expect(received).toBe(snapshots[1]);
    expect(received?.entries.map((entry) => entry.fact.type)).toEqual([
      "model.dispatch_recorded",
      "model.settled",
      "tool.call_observed",
      "tool.dispatch_recorded",
      "tool.permission_resolved",
      "tool.settled",
    ]);
    expect(JSON.stringify(received)).toContain("historical-response");
    expect(JSON.stringify(received)).toContain("historical-call");
    expect(JSON.stringify(received)).toContain('"path":"src/a.ts"');
    expect(JSON.stringify(received)).toContain("historical result");
    expect(JSON.stringify(received)).toContain("permission-v1");
    expect(JSON.stringify(received)).not.toContain("control.decided");
  });

  test("L12 safe boundary is after all tool settlements and before next model intent", async () => {
    const harness = createHarness({
      model: [
        modelSuccess("tools", [toolCall("a"), toolCall("b")]),
        modelSuccess("done"),
      ],
    });

    await runAgentLoop(harness.dependencies);

    const boundary = harness.trace.indexOf("boundary:after_tool_batch_settled");
    expect(boundary).toBeGreaterThan(
      harness.trace.indexOf("append:tool.settled:b:completed"),
    );
    expect(boundary).toBeLessThan(
      harness.trace.indexOf("append:model.dispatch_recorded:2"),
    );
  });

  test("L13 returned terminal state is the exact state produced by the sole reducer", async () => {
    const produced: TestState[] = [];
    const harness = createHarness({
      model: [modelSuccess("done")],
      decide() {
        return { kind: "completed", reason: "reducer-owned" };
      },
    });
    const originalReduce = harness.dependencies.reducer.reduce;
    harness.dependencies.reducer.reduce = (facts, config) => {
      const state = originalReduce(facts, config);
      produced.push(state);
      return state;
    };

    const returned = await runAgentLoop(harness.dependencies);

    expect(produced).toHaveLength(1);
    const firstProduced = produced[0];
    if (!firstProduced) throw new Error("Reducer did not produce a state");
    expect(returned).toBe(firstProduced);
    expect(returned.decision).toEqual({
      kind: "completed",
      reason: "reducer-owned",
    });
  });

  test("L14 derived decisions are never fed back as reducer input facts", async () => {
    const harness = createHarness({
      model: [modelSuccess("one"), modelSuccess("two")],
      decide(facts) {
        return facts.filter((fact) => fact.type === "model.settled").length < 2
          ? { kind: "continue" }
          : { kind: "completed", reason: "done" };
      },
    });

    await runAgentLoop(harness.dependencies);

    expect(harness.session.derivedDecisions).toHaveLength(3);
    expect(
      harness.session.derivedDecisions.map(
        (decision) => decision.inputThroughSeq,
      ),
    ).toEqual([0, 3, 6]);
    expect(harness.reducerInputs).toHaveLength(3);
    expect(harness.reducerInputs.at(-1)).toHaveLength(4);
    expect(JSON.stringify(harness.reducerInputs)).not.toContain(
      "control.decided",
    );
  });

  test("CAS conflict re-reads an inserted abort and never commits stale completed", async () => {
    const harness = createHarness({ model: [modelSuccess("done")] });
    harness.session.beforeCommit = async () => {
      harness.session.beforeCommit = undefined;
      await harness.session.appendInputFacts([
        { type: "abort.requested", source: "host", reason: "raced abort" },
      ]);
    };

    const state = await runAgentLoop(harness.dependencies);

    expect(state.decision).toEqual({ kind: "aborted", reason: "raced abort" });
    expect(harness.session.derivedDecisions).toHaveLength(1);
    expect(harness.session.derivedDecisions[0]).toMatchObject({
      inputThroughSeq: 1,
      action: { kind: "abort", reasonCode: "raced abort" },
    });
    expect(
      harness.trace.some((entry) => entry.startsWith("derived-conflict:")),
    ).toBe(true);
  });

  test("continue and tool intents commit atomically or abort wins with zero execution", async () => {
    const harness = createHarness({
      model: [modelSuccess("tool", [toolCall("must-not-run")])],
      decide(facts) {
        const abortFact = facts.find((fact) => fact.type === "abort.requested");
        return abortFact
          ? { kind: "aborted", reason: abortFact.reason ?? "aborted" }
          : { kind: "continue" };
      },
    });
    harness.session.beforeDecisionAndInputCommit = async () => {
      harness.session.beforeDecisionAndInputCommit = undefined;
      await harness.session.appendInputFacts([
        { type: "abort.requested", source: "host", reason: "atomic race" },
      ]);
    };

    const state = await runAgentLoop(harness.dependencies);

    expect(state.decision).toEqual({ kind: "aborted", reason: "atomic race" });
    expect(harness.toolCalls).toBe(0);
    expect(
      harness.session.inputFacts.some(
        (fact) => fact.type === "tool.dispatch_recorded",
      ),
    ).toBe(false);
    expect(findToolSettlements(harness.session.inputFacts)).toEqual([
      expect.objectContaining({ callId: "must-not-run", status: "cancelled" }),
    ]);
    expect(harness.session.derivedDecisions).toEqual([
      expect.objectContaining({
        inputThroughSeq: 0,
        action: { kind: "continue", reasonCode: "continue" },
      }),
      expect.objectContaining({
        inputThroughSeq: 6,
        action: { kind: "abort", reasonCode: "atomic race" },
      }),
    ]);
    expect(
      harness.trace.some((entry) =>
        entry.startsWith("decision-input-conflict:"),
      ),
    ).toBe(true);
  });

  test("abort after atomic authorization settles every call without invoking tools", async () => {
    const controller = new AbortController();
    const harness = createHarness({
      model: [
        modelSuccess("authorized batch", [
          toolCall("first"),
          toolCall("second"),
        ]),
      ],
      decide(facts) {
        const abortFact = facts.find((fact) => fact.type === "abort.requested");
        return abortFact
          ? { kind: "aborted", reason: abortFact.reason ?? "aborted" }
          : { kind: "continue" };
      },
    });
    harness.session.beforeDecisionAndInputCommit = () => {
      harness.session.beforeDecisionAndInputCommit = undefined;
      controller.abort("abort after authorization");
    };

    const state = await runAgentLoop(harness.dependencies, {
      signal: controller.signal,
    });

    expect(state.decision).toEqual({
      kind: "aborted",
      reason: "abort after authorization",
    });
    expect(harness.toolCalls).toBe(0);
    expect(
      harness.session.inputFacts
        .filter((fact) => fact.type === "tool.dispatch_recorded")
        .map((fact) => fact.callId),
    ).toEqual(["first", "second"]);
    expect(
      findToolSettlements(harness.session.inputFacts).map((fact) => [
        fact.callId,
        fact.status,
      ]),
    ).toEqual([
      ["first", "cancelled"],
      ["second", "cancelled"],
    ]);
    expect(
      harness.session.derivedDecisions.map((decision) => decision.action.kind),
    ).toEqual(["continue", "continue", "abort"]);
  });

  test("unpersisted promoted input ID becomes runtime.failed and never reaches Context", async () => {
    const harness = createHarness({
      promoted: [["missing-input"]],
      model: [modelSuccess("unused")],
    });

    const state = await runAgentLoop(harness.dependencies);

    expect(state.decision.kind).toBe("failed");
    expect(harness.requests).toHaveLength(0);
    expect(harness.modelCalls).toBe(0);
    expect(harness.session.inputFacts).toEqual([
      expect.objectContaining({
        type: "runtime.failed",
        area: "input",
        errorCode: "Error",
      }),
    ]);
  });

  test("non-abort Context error becomes runtime.failed and goes through reducer", async () => {
    const harness = createHarness({ model: [modelSuccess("unused")] });
    harness.dependencies.context.build = async () => {
      throw new Error("context projection broke");
    };

    const state = await runAgentLoop(harness.dependencies);

    expect(state.decision).toEqual({ kind: "failed", reason: "Error" });
    expect(harness.modelCalls).toBe(0);
    expect(harness.session.inputFacts[0]).toMatchObject({
      type: "runtime.failed",
      area: "context",
      message: "context projection broke",
    });
  });

  test("non-abort boundary and input-consume errors become runtime.failed", async () => {
    for (const stage of ["boundary", "consume"] as const) {
      const harness = createHarness({ model: [modelSuccess("unused")] });
      if (stage === "boundary") {
        harness.dependencies.input.reportSafeBoundary = async () => {
          throw new Error("boundary failed");
        };
      } else {
        harness.dependencies.input.consumePromotedInputIds = async () => {
          throw new Error("consume failed");
        };
      }

      const state = await runAgentLoop(harness.dependencies);

      expect(state.decision).toEqual({ kind: "failed", reason: "Error" });
      expect(harness.modelCalls).toBe(0);
      expect(harness.session.inputFacts).toEqual([
        expect.objectContaining({ type: "runtime.failed", area: "input" }),
      ]);
    }
  });

  test("abort during boundary, input consume, or Context always records abort", async () => {
    for (const stage of ["boundary", "consume", "context"] as const) {
      const controller = new AbortController();
      const harness = createHarness({ model: [modelSuccess("unused")] });
      if (stage === "boundary") {
        harness.dependencies.input.reportSafeBoundary = async () => {
          controller.abort("boundary abort");
          throw new Error("boundary stopped");
        };
      } else if (stage === "consume") {
        harness.dependencies.input.consumePromotedInputIds = async () => {
          controller.abort("consume abort");
          throw new Error("consume stopped");
        };
      } else {
        harness.dependencies.context.build = async () => {
          controller.abort("context abort");
          throw new Error("context stopped");
        };
      }

      const state = await runAgentLoop(harness.dependencies, {
        signal: controller.signal,
      });

      expect(state.decision.kind).toBe("aborted");
      expect(harness.modelCalls).toBe(0);
      expect(harness.session.inputFacts.map((fact) => fact.type)).toEqual([
        "abort.requested",
      ]);
    }
  });

  test("blank or duplicate native tool identities fail closed before dispatch", async () => {
    const invalidBatches = [
      [toolCall(" ")],
      [toolCall("same"), toolCall("same")],
      [{ ...toolCall("valid-id"), name: " " }],
    ];

    for (const calls of invalidBatches) {
      const harness = createHarness({
        model: [modelSuccess("invalid tools", calls)],
      });

      const state = await runAgentLoop(harness.dependencies);

      expect(state.decision.kind).toBe("failed");
      expect(harness.toolCalls).toBe(0);
      expect(
        harness.session.inputFacts.some(
          (fact) =>
            fact.type === "tool.call_observed" ||
            fact.type === "tool.dispatch_recorded",
        ),
      ).toBe(false);
      expect(harness.session.inputFacts.at(-1)?.type).toBe("runtime.failed");
    }
  });

  test("adapter-invalid native tool arguments fail closed before dispatch", async () => {
    const invalidCall: TestToolCall = {
      ...toolCall("valid-native-id"),
      argumentsValid: false,
    };
    const harness = createHarness({
      model: [modelSuccess("invalid arguments", [invalidCall])],
    });

    const state = await runAgentLoop(harness.dependencies);

    expect(state.decision.kind).toBe("failed");
    expect(harness.toolCalls).toBe(0);
    expect(findModelSettlement(harness.session.inputFacts)).toMatchObject({
      status: "completed",
      hasToolCalls: true,
      response: {
        kind: "inline",
        value: {
          toolCalls: [
            expect.objectContaining({
              id: "valid-native-id",
              name: "test_tool",
              argumentsValid: false,
            }),
          ],
        },
      },
    });
    expect(
      harness.session.inputFacts.some(
        (fact) =>
          fact.type === "tool.call_observed" ||
          fact.type === "tool.dispatch_recorded",
      ),
    ).toBe(false);
    expect(harness.session.inputFacts.at(-1)).toMatchObject({
      type: "runtime.failed",
      errorCode: "InvalidToolArguments",
    });
  });

  test("mismatched derived cursor or action is rejected before CAS commit", async () => {
    const cursorHarness = createHarness({ model: [modelSuccess("done")] });
    const originalCursorMapper =
      cursorHarness.dependencies.facts.derivedDecision;
    cursorHarness.dependencies.facts.derivedDecision = (input) => ({
      ...originalCursorMapper(input),
      inputThroughSeq: input.inputThroughSeq - 1,
    });

    await expect(runAgentLoop(cursorHarness.dependencies)).rejects.toThrow(
      "inputThroughSeq",
    );
    expect(cursorHarness.session.derivedDecisions).toHaveLength(0);

    const actionHarness = createHarness({ model: [modelSuccess("done")] });
    const originalActionMapper =
      actionHarness.dependencies.facts.derivedDecision;
    actionHarness.dependencies.facts.derivedDecision = (input) => ({
      ...originalActionMapper(input),
      action: { kind: "abort", reasonCode: "wrong-action" },
    });

    await expect(runAgentLoop(actionHarness.dependencies)).rejects.toThrow(
      "action",
    );
    expect(actionHarness.session.derivedDecisions).toHaveLength(0);
  });

  test("mapper cannot change model lifecycle identity", async () => {
    const harness = createHarness({ model: [modelSuccess("done")] });
    const original = harness.dependencies.facts.modelSettled;
    harness.dependencies.facts.modelSettled = (input) => ({
      ...original(input),
      modelCallId: "wrong-model-call",
    });

    await expect(runAgentLoop(harness.dependencies)).rejects.toThrow(
      "Model settlement identity",
    );
    expect(harness.session.derivedDecisions).toHaveLength(1);
  });

  test("mapper cannot dispatch a different call ID than the observed call", async () => {
    const harness = createHarness({
      model: [modelSuccess("tool", [toolCall("observed")])],
    });
    const original = harness.dependencies.facts.toolDispatchIntent;
    harness.dependencies.facts.toolDispatchIntent = (input) => ({
      ...original(input),
      callId: "ghost-dispatch",
    });

    await expect(runAgentLoop(harness.dependencies)).rejects.toThrow(
      "Tool dispatch identity",
    );
    expect(harness.toolCalls).toBe(0);
    expect(
      harness.session.inputFacts.some(
        (fact) => fact.type === "tool.dispatch_recorded",
      ),
    ).toBe(false);
  });

  test("mapper cannot settle a different call ID than the active call", async () => {
    const harness = createHarness({
      model: [modelSuccess("tool", [toolCall("active")])],
    });
    const original = harness.dependencies.facts.toolSettled;
    harness.dependencies.facts.toolSettled = (input) => ({
      ...original(input),
      callId: "ghost-settlement",
    });

    await expect(runAgentLoop(harness.dependencies)).rejects.toThrow(
      "Tool settlement identity",
    );
    expect(harness.toolCalls).toBe(1);
    expect(findToolSettlements(harness.session.inputFacts)).toHaveLength(0);
  });

  test("duplicate settlements for one valid call become one unknown settlement", async () => {
    const harness = createHarness({
      model: [modelSuccess("tool", [toolCall("only")])],
      async executeTools() {
        return [
          { status: "success", callId: "only", result: "first" },
          { status: "success", callId: "only", result: "second" },
        ];
      },
    });

    await runAgentLoop(harness.dependencies);

    expect(findToolSettlements(harness.session.inputFacts)).toEqual([
      expect.objectContaining({ callId: "only", status: "unknown" }),
    ]);
  });

  test("the committed stateHash is verified against the injected canonical hasher", async () => {
    const harness = createHarness({ model: [modelSuccess("done")] });
    const original = harness.dependencies.facts.derivedDecision;
    harness.dependencies.facts.derivedDecision = (input) => ({
      ...original(input),
      stateHash: "tampered-state-hash",
    });

    await expect(runAgentLoop(harness.dependencies)).rejects.toThrow(
      "stateHash",
    );
    expect(harness.session.derivedDecisions).toHaveLength(0);
  });

  test("L15 model is not called when its dispatch intent cannot be appended", async () => {
    const harness = createHarness({ model: [modelSuccess("unused")] });
    harness.session.failInputAppend = (facts) =>
      facts.some((fact) => fact.type === "model.dispatch_recorded")
        ? new Error("journal unavailable")
        : undefined;

    await expect(runAgentLoop(harness.dependencies)).rejects.toThrow(
      "journal unavailable",
    );
    expect(harness.modelCalls).toBe(0);
  });

  test("L16 tools are not called when dispatch intents cannot be appended", async () => {
    const harness = createHarness({
      model: [modelSuccess("tool", [toolCall("blocked")])],
    });
    harness.session.failInputAppend = (facts) =>
      facts.some((fact) => fact.type === "tool.dispatch_recorded")
        ? new Error("cannot record tool intent")
        : undefined;

    await expect(runAgentLoop(harness.dependencies)).rejects.toThrow(
      "cannot record tool intent",
    );
    expect(harness.toolCalls).toBe(0);
    expect(harness.session.derivedDecisions).toHaveLength(1);
  });

  test("a multi-call authorization batch never exposes partial dispatch intents", async () => {
    const harness = createHarness({
      model: [
        modelSuccess("batch", [
          toolCall("first"),
          toolCall("second"),
          toolCall("third"),
        ]),
      ],
    });
    harness.session.failInputAppend = (facts) =>
      facts.some((fact) => fact.type === "tool.dispatch_recorded")
        ? new Error("authorization journal failed")
        : undefined;

    await expect(runAgentLoop(harness.dependencies)).rejects.toThrow(
      "authorization journal failed",
    );

    expect(harness.toolCalls).toBe(0);
    expect(
      harness.session.inputFacts.filter(
        (fact) => fact.type === "tool.call_observed",
      ),
    ).toHaveLength(3);
    expect(
      harness.session.inputFacts.filter(
        (fact) => fact.type === "tool.dispatch_recorded",
      ),
    ).toHaveLength(0);
    expect(harness.session.derivedDecisions).toHaveLength(1);
  });
});

function modelSuccess(
  message: string,
  toolCalls: readonly TestToolCall[] = [],
): TestModelSettlement {
  return { status: "success", message, toolCalls };
}

function toolCall(id: string): TestToolCall {
  return { id, name: "test_tool", args: { id } };
}

function decisionAfterLatestFact(
  facts: readonly InputFactV1[],
): ControlDecision {
  const latest = facts.at(-1);
  if (latest?.type === "abort.requested") {
    return { kind: "aborted", reason: latest.reason ?? "aborted" };
  }
  if (latest?.type === "runtime.failed") {
    return { kind: "failed", reason: latest.errorCode };
  }
  if (latest?.type === "model.settled") {
    if (latest.status === "completed" && !latest.hasToolCalls) {
      return { kind: "completed", reason: "natural-stop" };
    }
    if (latest.status !== "completed") {
      return { kind: "incomplete", reason: latest.status };
    }
  }
  if (latest?.type === "tool.settled") {
    if (latest.status === "rejected") {
      return { kind: "await_user", reason: "tool-denied" };
    }
    if (latest.status === "unknown") {
      return { kind: "incomplete", reason: "tool-unknown" };
    }
  }
  return { kind: "continue" };
}

function createFactMapper(): AgentLoopFactMapper<
  TestConfig,
  TestRequest,
  string,
  TestToolCall,
  string,
  TestState
> {
  return {
    modelRequestIntent({ turn }) {
      return {
        type: "model.dispatch_recorded",
        modelCallId: `model-${turn}`,
        turn,
        requestHash: `request-${turn}`,
      };
    },
    modelSettled({ turn, settlement }) {
      if (
        settlement.status === "success" ||
        settlement.status === "truncated"
      ) {
        return {
          type: "model.settled",
          modelCallId: `model-${turn}`,
          turn,
          status: settlement.status === "success" ? "completed" : "truncated",
          hasToolCalls: settlement.toolCalls.length > 0,
          hasVisibleOutput: settlement.message.length > 0,
          response: {
            kind: "inline",
            value: {
              message: settlement.message,
              toolCalls: settlement.toolCalls.map((call) => ({
                id: call.id,
                name: call.name,
                args: call.args,
                ...(call.argumentsValid === undefined
                  ? {}
                  : { argumentsValid: call.argumentsValid }),
              })),
              ...(settlement.status === "truncated"
                ? { truncationReason: settlement.reason }
                : {}),
            },
            hash: `response-${turn}`,
          },
          finishReason:
            settlement.status === "truncated"
              ? settlement.finishReason
              : settlement.toolCalls.length > 0
                ? "tool_calls"
                : "stop",
        };
      }
      if (settlement.status === "failed") {
        return {
          type: "model.settled",
          modelCallId: `model-${turn}`,
          turn,
          status: "failed",
          hasToolCalls: false,
          hasVisibleOutput: false,
          errorCode: settlement.error.name,
        };
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
      if (settlement.status === "success") {
        return {
          type: "tool.settled",
          callId: settlement.callId,
          status: "completed",
          result: settlement.result,
          resultHash: `result-${settlement.callId}`,
        };
      }
      if (settlement.status === "failed") {
        return {
          type: "tool.settled",
          callId: settlement.callId,
          status: "failed",
          errorCode: settlement.error.name,
          ...(settlement.evidence === undefined
            ? {}
            : {
                result: settlement.evidence,
                resultHash: `evidence-${settlement.callId}`,
              }),
        };
      }
      if (settlement.status === "denied") {
        return {
          type: "tool.settled",
          callId: settlement.callId,
          status: "rejected",
          errorCode: "permission_denied",
          ...(settlement.evidence === undefined
            ? {}
            : {
                result: settlement.evidence,
                resultHash: `evidence-${settlement.callId}`,
              }),
        };
      }
      return {
        type: "tool.settled",
        callId: settlement.callId,
        status: settlement.status,
        ...(settlement.evidence === undefined
          ? {}
          : {
              result: settlement.evidence,
              resultHash: `evidence-${settlement.callId}`,
            }),
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

function hashTestState(state: TestState): string {
  return JSON.stringify({
    canonicalFactCount: state.canonicalFactCount,
    decision: state.decision,
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

function findModelSettlement(facts: readonly InputFactV1[]) {
  return facts.find((fact) => fact.type === "model.settled");
}

function findToolSettlements(facts: readonly InputFactV1[]) {
  return facts.filter((fact) => fact.type === "tool.settled");
}
