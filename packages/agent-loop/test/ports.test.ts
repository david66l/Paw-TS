import { describe, expect, test } from "bun:test";
import type {
  Context,
  ControlReducer,
  LoopInputPort,
  LoopPolicy,
  Model,
  Session,
  ToolExecutor,
} from "../src/index.js";

type Fact = { readonly kind: "fact"; readonly value: string };
type Decision = { readonly inputCount: number };

const signal = new AbortController().signal;

describe("agent-loop ports", () => {
  test("六个核心端口可以由独立适配器组合", async () => {
    const streamed: string[] = [];
    const model: Model<string, string, { readonly text: string }> = {
      async execute(request, options) {
        await options.onStreamEvent("chunk");
        return { text: request };
      },
    };
    const sessionFacts: Fact[] = [];
    const sessionDecisions: Decision[] = [];
    const session: Session<Fact, Decision> = {
      async readInputSnapshot() {
        return {
          entries: sessionFacts.map((fact, index) => ({
            seq: index + 1,
            fact,
          })),
          tailSeq: sessionFacts.length,
          latestInputSeq: sessionFacts.length,
        };
      },
      async appendInputFacts(facts) {
        sessionFacts.push(...facts);
      },
      async commitInputFacts(_expectedTailSeq, facts) {
        sessionFacts.push(...facts);
        return "committed";
      },
      async commitDerivedDecision(_expectedTailSeq, decision) {
        sessionDecisions.push(decision);
        return "committed";
      },
      async commitDecisionAndInputFacts(_expectedTailSeq, decision, facts) {
        sessionDecisions.push(decision);
        sessionFacts.push(...facts);
        return "committed";
      },
    };
    const context: Context<readonly Fact[], string> = {
      async build(facts) {
        return facts.map((fact) => fact.value).join(" ");
      },
    };
    const tools: ToolExecutor<string, string> = {
      async executeSettled(calls) {
        return calls.map((call) => `settled:${call}`);
      },
    };
    const policy: LoopPolicy<Fact, { readonly mode: "interactive" }> = {
      async observe(newFacts) {
        return newFacts;
      },
    };
    const reducer: ControlReducer<
      Fact,
      { readonly mode: "interactive" },
      Decision
    > = {
      reduce(facts) {
        return { inputCount: facts.length };
      },
    };

    const initial: Fact = { kind: "fact", value: "hello" };
    await session.appendInputFacts([initial]);
    const facts = (await session.readInputSnapshot()).entries.map(
      (entry) => entry.fact,
    );
    const request = await context.build(facts, { signal });
    const modelResult = await model.execute(request, {
      signal,
      onStreamEvent(event) {
        streamed.push(event);
      },
    });
    const toolResults = await tools.executeSettled(["read"], {
      signal,
      turn: 1,
    });
    const policyFacts = await policy.observe(facts, {
      signal,
      runConfig: { mode: "interactive" },
    });
    const decision = reducer.reduce(policyFacts, { mode: "interactive" });
    await session.commitDerivedDecision(facts.length, decision);

    expect(modelResult).toEqual({ text: "hello" });
    expect(streamed).toEqual(["chunk"]);
    expect(toolResults).toEqual(["settled:read"]);
    expect(sessionDecisions).toEqual([{ inputCount: 1 }]);
  });

  test("输入端口只报告安全边界并消费已提升输入", async () => {
    const boundaries: string[] = [];
    const promoted: string[] = ["new direction"];
    const inputPort: LoopInputPort = {
      async reportSafeBoundary(boundary) {
        boundaries.push(boundary);
      },
      async consumePromotedInputIds() {
        return promoted.splice(0);
      },
    };

    await inputPort.reportSafeBoundary("after_tool_batch_settled");
    const firstRead = await inputPort.consumePromotedInputIds();
    const secondRead = await inputPort.consumePromotedInputIds();

    expect(boundaries).toEqual(["after_tool_batch_settled"]);
    expect(firstRead).toEqual(["new direction"]);
    expect(secondRead).toEqual([]);
    expect(Object.keys(inputPort).sort()).toEqual([
      "consumePromotedInputIds",
      "reportSafeBoundary",
    ]);
  });

  test("Context capability only receives a read-only snapshot and cancellation signal", async () => {
    const snapshot = {
      entries: [{ seq: 1, fact: { kind: "fact" as const, value: "input" } }],
      tailSeq: 2,
      latestInputSeq: 1,
    };
    let receivedSnapshot: typeof snapshot | undefined;
    let receivedOptionKeys: string[] = [];
    const context: Context<typeof snapshot, string> = {
      async build(input, options) {
        receivedSnapshot = input;
        receivedOptionKeys = Object.keys(options).sort();
        return input.entries[0]?.fact.value ?? "";
      },
    };

    const result = await context.build(snapshot, { signal });

    expect(result).toBe("input");
    expect(receivedSnapshot).toBe(snapshot);
    expect(receivedOptionKeys).toEqual(["signal"]);
    expect(Object.keys(context)).toEqual(["build"]);
  });

  test("派生决定与输入事实保持为两个不同类型参数", async () => {
    const decisions: Decision[] = [];
    const session: Session<Fact, Decision> = {
      async readInputSnapshot() {
        return {
          entries: [{ seq: 7, fact: { kind: "fact", value: "input" } }],
          tailSeq: 7,
          latestInputSeq: 7,
        };
      },
      async appendInputFacts() {},
      async commitInputFacts() {
        return "committed";
      },
      async commitDerivedDecision(_expectedTailSeq, decision) {
        decisions.push(decision);
        return "committed";
      },
      async commitDecisionAndInputFacts(_expectedTailSeq, decision) {
        decisions.push(decision);
        return "committed";
      },
    };

    await session.commitDerivedDecision(7, { inputCount: 1 });

    expect(
      (await session.readInputSnapshot()).entries.map((entry) => entry.fact),
    ).toEqual([{ kind: "fact", value: "input" }]);
    expect(decisions).toEqual([{ inputCount: 1 }]);
  });
});
