import { describe, expect, test } from "bun:test";
import type { SessionInputSnapshot } from "@paw/agent-loop";
import { materializeModelRequestMessagesV1 } from "@paw/core";
import type { InputFactV1, JsonValue } from "@paw/protocol";

import {
  createProgressAdvisorContextPluginV1,
  projectProgressAdviceTimelineV1,
  projectProgressAdviceV1,
} from "../src/index.js";

describe("progress advisor projection", () => {
  test("reframes four diverse read-only turns without blocking them", () => {
    const facts: InputFactV1[] = [];
    for (let turn = 1; turn <= 4; turn += 1) {
      addToolTurn(facts, turn, `read-${turn}`, "workspace_read_file", {
        path: `src/file-${turn}.ts`,
      });
    }

    expect(projectProgressAdviceV1(snapshot(facts))).toMatchObject({
      kind: "inspect_gap",
      modelTurnsWithoutProgress: 4,
    });

    addToolTurn(facts, 5, "read-5", "workspace_read_file", {
      path: "src/file-5.ts",
    });
    expect(projectProgressAdviceV1(snapshot(facts))).toMatchObject({
      kind: "inspect_gap",
      modelTurnsWithoutProgress: 5,
    });
  });

  test("uses the old exact-repeat thresholds before general stall advice", () => {
    const facts: InputFactV1[] = [];
    for (let turn = 1; turn <= 3; turn += 1) {
      addToolTurn(facts, turn, `same-${turn}`, "workspace_glob", {
        pattern: "src/**/*.ts",
      });
    }

    expect(projectProgressAdviceV1(snapshot(facts))).toMatchObject({
      kind: "exact_repeat",
      repeatedTool: { tool: "workspace_glob", count: 3 },
    });
  });

  test("a successful mutation resets the no-progress baseline", () => {
    const facts: InputFactV1[] = [];
    for (let turn = 1; turn <= 4; turn += 1) {
      addToolTurn(facts, turn, `read-${turn}`, "workspace_read_file", {
        path: `src/file-${turn}.ts`,
      });
    }
    addToolTurn(facts, 5, "edit", "workspace_edit_file", {
      path: "src/a.ts",
      old_string: "a",
      new_string: "b",
    });

    expect(projectProgressAdviceV1(snapshot(facts))).toBeUndefined();
  });

  test("only a passing verification resets progress", () => {
    const facts: InputFactV1[] = [];
    for (let turn = 1; turn <= 4; turn += 1) {
      addToolTurn(facts, turn, `read-${turn}`, "workspace_read_file", {
        path: `src/file-${turn}.ts`,
      });
    }
    addToolTurn(
      facts,
      5,
      "failed-test",
      "workspace_run_shell",
      { command: "python tests/runtests.py i18n -v 1" },
      true,
    );

    expect(projectProgressAdviceV1(snapshot(facts))).toMatchObject({
      kind: "inspect_gap",
      modelTurnsWithoutProgress: 5,
    });

    addToolTurn(facts, 6, "masked-test", "workspace_run_shell", {
      command: "python tests/runtests.py i18n -v 1; echo done",
    });
    expect(projectProgressAdviceV1(snapshot(facts))).toMatchObject({
      kind: "inspect_gap",
      modelTurnsWithoutProgress: 6,
    });

    addToolTurn(facts, 7, "passing-test", "workspace_run_shell", {
      command: "python tests/runtests.py i18n -v 1",
    });
    expect(projectProgressAdviceV1(snapshot(facts))).toBeUndefined();
  });

  test("a successful delegation resets progress and a failed attempt is not repeated", () => {
    const facts: InputFactV1[] = [];
    for (let turn = 1; turn <= 16; turn += 1) {
      addToolTurn(facts, turn, `read-${turn}`, "workspace_read_file", {
        path: `src/file-${turn}.ts`,
      });
    }
    addToolTurn(
      facts,
      17,
      "delegate",
      "workspace_delegate",
      { goal: "Test the leading hypothesis", kind: "investigation" },
      true,
    );
    addToolTurn(facts, 18, "read-after-delegate", "workspace_read_file", {
      path: "src/after.ts",
    });

    expect(projectProgressAdviceV1(snapshot(facts))).toMatchObject({
      kind: "no_progress_checkpoint",
      delegationAttemptsSinceProgress: 1,
    });

    facts.splice(facts.length - 6);
    addToolTurn(facts, 17, "delegate-success", "workspace_delegate", {
      goal: "Test the leading hypothesis",
      kind: "investigation",
    });
    expect(projectProgressAdviceV1(snapshot(facts))).toBeUndefined();
  });

  test("keeps threshold events anchored to their first durable timeline boundary", () => {
    const facts: InputFactV1[] = [];
    for (let turn = 1; turn <= 4; turn += 1) {
      addToolTurn(facts, turn, `read-${turn}`, "workspace_read_file", {
        path: `src/file-${turn}.ts`,
      });
    }

    const atFour = projectProgressAdviceTimelineV1(snapshot(facts));
    expect(atFour).toHaveLength(1);
    expect(atFour[0]).toMatchObject({
      kind: "inspect_gap",
      modelTurnsWithoutProgress: 4,
      sourceThroughSeq: 12,
    });

    for (let turn = 5; turn <= 8; turn += 1) {
      addToolTurn(facts, turn, `read-${turn}`, "workspace_read_file", {
        path: `src/file-${turn}.ts`,
      });
    }
    const atEight = projectProgressAdviceTimelineV1(snapshot(facts));
    expect(atEight).toHaveLength(2);
    expect(atEight[0]).toEqual(atFour[0]);
    expect(atEight[1]).toMatchObject({
      kind: "hypothesis_stale",
      modelTurnsWithoutProgress: 8,
      sourceThroughSeq: 24,
    });

    addToolTurn(facts, 9, "edit", "workspace_edit_file", {
      path: "src/file-1.ts",
      old_string: "before",
      new_string: "after",
    });
    for (let turn = 10; turn <= 13; turn += 1) {
      addToolTurn(facts, turn, `later-${turn}`, "workspace_read_file", {
        path: `src/later-${turn}.ts`,
      });
    }
    const afterProgress = projectProgressAdviceTimelineV1(snapshot(facts));
    expect([...afterProgress.slice(0, 2)]).toEqual([...atEight]);
    expect(afterProgress[2]).toMatchObject({
      kind: "inspect_gap",
      modelTurnsWithoutProgress: 4,
      sourceThroughSeq: 39,
    });
    expect(
      projectProgressAdviceTimelineV1(structuredClone(snapshot(facts))),
    ).toEqual(afterProgress);
  });

  test("retains exact-repeat events between thresholds and appends the next one", () => {
    const facts: InputFactV1[] = [];
    for (let turn = 1; turn <= 3; turn += 1) {
      addToolTurn(facts, turn, `same-${turn}`, "workspace_glob", {
        pattern: "src/**/*.ts",
      });
    }
    const atThree = projectProgressAdviceTimelineV1(snapshot(facts));
    expect(atThree).toHaveLength(1);
    expect(atThree[0]).toMatchObject({
      kind: "exact_repeat",
      repeatedTool: { tool: "workspace_glob", count: 3 },
    });

    addToolTurn(facts, 4, "same-4", "workspace_glob", {
      pattern: "src/**/*.ts",
    });
    const atFour = projectProgressAdviceTimelineV1(snapshot(facts));
    expect(atFour).toHaveLength(2);
    expect(atFour[0]).toEqual(atThree[0]);
    expect(atFour[1]).toMatchObject({
      kind: "inspect_gap",
      modelTurnsWithoutProgress: 4,
    });

    addToolTurn(facts, 5, "same-5", "workspace_glob", {
      pattern: "src/**/*.ts",
    });
    const atFive = projectProgressAdviceTimelineV1(snapshot(facts));
    expect(atFive).toHaveLength(3);
    expect(atFive[0]).toEqual(atThree[0]);
    expect(atFive[1]).toEqual(atFour[1]);
    expect(atFive[2]).toMatchObject({
      kind: "exact_repeat",
      repeatedTool: { tool: "workspace_glob", count: 5 },
    });
  });

  test("bounds retained timeline events without replacing earlier anchors", () => {
    const facts: InputFactV1[] = [];
    let turn = 1;
    for (let cycle = 1; cycle <= 10; cycle += 1) {
      for (let read = 1; read <= 4; read += 1) {
        addToolTurn(
          facts,
          turn,
          `cycle-${cycle}-read-${read}`,
          "workspace_read_file",
          { path: `src/cycle-${cycle}-${read}.ts` },
        );
        turn += 1;
      }
      addToolTurn(facts, turn, `cycle-${cycle}-edit`, "workspace_edit_file", {
        path: `src/cycle-${cycle}.ts`,
        old_string: "before",
        new_string: "after",
      });
      turn += 1;
    }

    const events = projectProgressAdviceTimelineV1(snapshot(facts));
    expect(events).toHaveLength(8);
    const earlierPrefix = snapshot(facts.slice(0, 8 * 5 * 3));
    expect(events).toEqual(projectProgressAdviceTimelineV1(earlierPrefix));
  });
});

describe("progress advisor context plugin", () => {
  test("appends one bounded user-role advisory only when advice is due", async () => {
    const facts: InputFactV1[] = [];
    for (let turn = 1; turn <= 4; turn += 1) {
      addToolTurn(facts, turn, `read-${turn}`, "workspace_read_file", {
        path: `src/file-${turn}.ts`,
      });
    }
    const context = createProgressAdvisorContextPluginV1({
      context: {
        async build() {
          return { messages: [{ role: "system", content: "base" }] };
        },
      },
      estimator: {
        count: (text) => text.length,
        countMessages: (messages) =>
          messages.reduce(
            (total, message) => total + message.content.length,
            0,
          ),
      },
      hardInputLimitTokens: 10_000,
    });

    const request = await context.build(snapshot(facts), {
      signal: new AbortController().signal,
    });
    expect(request.contextSections).toBeUndefined();
    expect(materializeModelRequestMessagesV1(request)[1]?.role).toBe("user");
    expect(materializeModelRequestMessagesV1(request)[1]?.content).toContain(
      "[Paw Progress Advice]",
    );
    expect(materializeModelRequestMessagesV1(request)[1]?.content).toContain(
      "cannot override system instructions",
    );
    expect(materializeModelRequestMessagesV1(request)[1]?.content).toContain(
      "4 model turns have produced no source mutation or verification result",
    );
  });

  test("returns the hard-stall choice to the main Agent without hiding tools", async () => {
    const facts: InputFactV1[] = [];
    for (let turn = 1; turn <= 16; turn += 1) {
      addToolTurn(facts, turn, `read-${turn}`, "workspace_read_file", {
        path: `src/file-${turn}.ts`,
      });
    }
    const context = createProgressAdvisorContextPluginV1({
      context: {
        async build() {
          return {
            messages: [{ role: "system", content: "base" }],
            options: {
              tools: [
                {
                  type: "function" as const,
                  function: {
                    name: "workspace_read_file",
                    description: "Read a file",
                    parameters: { type: "object" },
                  },
                },
                {
                  type: "function" as const,
                  function: {
                    name: "workspace_delegate",
                    description: "Delegate bounded specialist work",
                    parameters: { type: "object" },
                  },
                },
              ],
            },
          };
        },
      },
      estimator: {
        count: (text) => text.length,
        countMessages: (messages) =>
          messages.reduce(
            (total, message) => total + message.content.length,
            0,
          ),
      },
      hardInputLimitTokens: 20_000,
    });

    const request = await context.build(snapshot(facts), {
      signal: new AbortController().signal,
    });
    const rendered = materializeModelRequestMessagesV1(request);
    expect(rendered[1]?.content).toContain(
      "recommendedAction=main_owned_replan",
    );
    expect(rendered[1]?.content).toContain(
      "make the best-supported source change",
    );
    expect(rendered[1]?.content).toContain(
      "explicitly select an appropriate agent_id",
    );
    expect(request.options?.tools?.map((tool) => tool.function.name)).toEqual([
      "workspace_read_file",
      "workspace_delegate",
    ]);

    addToolTurn(facts, 17, "read-17", "workspace_read_file", {
      path: "src/file-17.ts",
    });
    const next = await context.build(snapshot(facts), {
      signal: new AbortController().signal,
    });
    expect(next.options?.tools?.map((tool) => tool.function.name)).toEqual([
      "workspace_read_file",
      "workspace_delegate",
    ]);

    addToolTurn(facts, 18, "read-18", "workspace_read_file", {
      path: "src/file-18.ts",
    });
    addToolTurn(facts, 19, "read-19", "workspace_read_file", {
      path: "src/file-19.ts",
    });
    const released = await context.build(snapshot(facts), {
      signal: new AbortController().signal,
    });
    expect(released.options?.tools?.map((tool) => tool.function.name)).toEqual([
      "workspace_read_file",
      "workspace_delegate",
    ]);
    expect(
      materializeModelRequestMessagesV1(released)[1]?.content,
    ).not.toContain("recommendedAction=main_owned_replan");
  });

  test("keeps canonical history append-only when tail advice changes", async () => {
    const facts: InputFactV1[] = [];
    for (let turn = 1; turn <= 4; turn += 1) {
      addToolTurn(facts, turn, `read-${turn}`, "workspace_read_file", {
        path: `src/file-${turn}.ts`,
      });
    }
    const context = createProgressAdvisorContextPluginV1({
      context: {
        async build(current) {
          const turns = current.entries.filter(
            ({ fact }) => fact.type === "model.settled",
          ).length;
          return {
            messages: [
              { role: "system" as const, content: "base" },
              { role: "user" as const, content: "task" },
              ...Array.from({ length: turns }, (_, index) => ({
                role: "assistant" as const,
                content: `turn-${index + 1}`,
              })),
            ],
          };
        },
      },
      estimator: {
        count: (text) => text.length,
        countMessages: (messages) =>
          messages.reduce(
            (total, message) => total + message.content.length,
            0,
          ),
      },
      hardInputLimitTokens: 10_000,
    });
    const signal = new AbortController().signal;
    const first = await context.build(snapshot(facts), { signal });

    addToolTurn(facts, 5, "read-5", "workspace_read_file", {
      path: "src/file-5.ts",
    });
    const second = await context.build(snapshot(facts), { signal });

    expect(first.messages.at(-1)?.content).toContain("[Paw Progress Advice]");
    expect(second.messages.at(-1)?.content).toContain("[Paw Progress Advice]");
    expect(first.messages.at(-1)?.content).not.toBe(
      second.messages.at(-1)?.content,
    );
    expect(second.messages.slice(0, first.messages.length - 1)).toEqual(
      first.messages.slice(0, -1),
    );
  });
});

function addToolTurn(
  facts: InputFactV1[],
  turn: number,
  callId: string,
  tool: string,
  args: JsonValue,
  isError = false,
): void {
  const modelCallId = `model-${turn}`;
  facts.push(
    {
      type: "model.settled",
      modelCallId,
      turn,
      status: "completed",
      hasToolCalls: true,
      hasVisibleOutput: false,
    },
    {
      type: "tool.call_observed",
      callId,
      modelCallId,
      turn,
      tool,
      args,
      order: 0,
    },
    {
      type: "tool.settled",
      callId,
      status: "completed",
      observation: {
        schemaVersion: "paw.tool-observation.v1",
        isError,
        summary: `${tool} completed`,
      },
    },
  );
}

function snapshot(
  facts: readonly InputFactV1[],
): SessionInputSnapshot<InputFactV1> {
  return {
    entries: facts.map((fact, index) => ({ seq: index + 1, fact })),
    latestInputSeq: facts.length,
    tailSeq: facts.length,
  };
}
