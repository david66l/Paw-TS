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
  test("deduplicated verification repair cannot suppress either closeout window", () => {
    const facts: InputFactV1[] = [];
    addToolTurn(facts, 1, "write", "workspace_write_file", { path: "a.js" });
    for (let turn = 2; turn <= 9; turn++)
      addToolTurn(facts, turn, `check-${turn}`, "workspace_run_shell", {
        command: `npm test | tail -${turn}`,
      });
    const advice = projectProgressAdviceTimelineV1(snapshot(facts), {
      maxModelTurns: 10,
      maxTotalModelTurns: 10,
    });
    expect(advice.filter((a) => a.kind === "verification_repair")).toHaveLength(1);
    expect(advice.filter((a) => a.kind === "convergence_checkpoint")).toHaveLength(2);
  });
  test("a shell write, including a failed shell, invalidates an earlier passing check", () => {
    for (const changed of [true, "unknown"] as const) {
      const facts: InputFactV1[] = [];
      addToolTurn(facts, 1, "write", "workspace_write_file", { path: "a.js" });
      addToolTurn(facts, 2, "test", "workspace_run_shell", {
        command: "npm test",
      });
      addToolTurn(
        facts,
        3,
        "shell-write",
        "workspace_run_shell",
        { command: "node mutate.js" },
        true,
        { workspaceEffect: { changed, paths: ["a.js"] } },
      );
      for (let turn = 4; turn <= 6; turn++)
        addToolTurn(facts, turn, `read-${turn}`, "workspace_read_file", {
          path: "a.js",
        });
      const advice = projectProgressAdviceV1(snapshot(facts), {
        maxModelTurns: 10,
        maxTotalModelTurns: 10,
      });
      expect(advice?.kind).toBe("convergence_checkpoint");
      expect(advice?.message).toContain("current revision");
      expect(advice?.message).not.toContain("latest check passed");
    }
  });
  test("untrusted verification guides a direct rerun once per evidence baseline", () => {
    const facts: InputFactV1[] = [];
    addToolTurn(facts, 1, "write", "workspace_write_file", { path: "a.js" });
    addToolTurn(facts, 2, "masked", "workspace_run_shell", {
      command: "npm test | tail -10",
    });
    const first = projectProgressAdviceTimelineV1(snapshot(facts));
    expect(first[0]?.kind).toBe("verification_repair");
    expect(first[0]?.message).toContain("direct command");
    addToolTurn(facts, 3, "masked-again", "workspace_run_shell", {
      command: "npm test | grep failed",
    });
    expect(projectProgressAdviceTimelineV1(snapshot(facts))).toEqual(first);
    addToolTurn(facts, 4, "direct", "workspace_run_shell", { command: "npm test" }, true);
    addToolTurn(facts, 5, "masked-new", "workspace_run_shell", {
      command: "npm test | tail -5",
    });
    expect(
      projectProgressAdviceTimelineV1(snapshot(facts)).filter(
        (item) => item.kind === "verification_repair",
      ),
    ).toHaveLength(2);
    addToolTurn(facts, 6, "direct-pass", "workspace_run_shell", {
      command: "npm test",
    });
    expect(projectProgressAdviceV1(snapshot(facts))).toBeUndefined();
  });

  test("closeout uses remaining frozen budget and fresh evidence without declaring success", () => {
    const facts: InputFactV1[] = [];
    const budget = { maxModelTurns: 10, maxTotalModelTurns: 10 };
    for (let turn = 1; turn <= 6; turn++)
      addToolTurn(facts, turn, `write-${turn}`, "workspace_write_file", {
        path: "a.js",
      });
    const atWindow = projectProgressAdviceTimelineV1(snapshot(facts), budget);
    expect(atWindow.at(-1)?.kind).toBe("convergence_checkpoint");
    expect(atWindow.at(-1)?.message).toContain("4 model calls remain");
    expect(atWindow.at(-1)?.message).toContain("declared test command");
    addToolTurn(facts, 7, "check", "workspace_run_shell", {
      command: "npm test",
    });
    addToolTurn(facts, 8, "diff", "workspace_read_file", { path: "a.js" });
    const later = projectProgressAdviceTimelineV1(snapshot(facts), budget);
    expect(later.slice(0, atWindow.length)).toEqual([...atWindow]);
    expect(later.at(-1)?.message).toContain("2 model calls remain");
    expect(later.at(-1)?.message).toContain("passing subset is not full completion");
    expect(projectProgressAdviceTimelineV1(snapshot(facts))).not.toContainEqual(later.at(-1));
  });

  test("late background checks do not supply fresh closeout evidence", () => {
    const facts: InputFactV1[] = [];
    addToolTurn(facts, 1, "start", "workspace_job_start", { command: "npm test" }, false, {
      jobId: "job",
    });
    for (let turn = 2; turn <= 3; turn++)
      addToolTurn(facts, turn, `write-${turn}`, "workspace_write_file", {
        path: "a.js",
      });
    addToolTurn(facts, 4, "wait", "workspace_job_wait", { id: "job" }, false, {
      snapshot: { status: "completed", detail: "exit code: 0" },
    });
    const projected = projectProgressAdviceV1(snapshot(facts), {
      maxModelTurns: 8,
      maxTotalModelTurns: 8,
    });
    expect(projected?.kind).toBe("convergence_checkpoint");
    expect(projected?.message).toContain("current revision");
    expect(projected?.message).not.toContain("latest check passed");
  });
  test("continuous successful writes retain an independent validation cadence", () => {
    const facts: InputFactV1[] = [];
    for (let turn = 1; turn <= 4; turn += 1) {
      addToolTurn(facts, turn, `write-${turn}`, "workspace_write_file", {
        path: `src/${turn}.ts`,
      });
    }
    expect(projectProgressAdviceV1(snapshot(facts))).toMatchObject({
      kind: "verification_due",
      modelTurnsWithoutProgress: 0,
      unverifiedMutationTurns: 4,
    });
    const first = projectProgressAdviceTimelineV1(snapshot(facts));
    expect(first).toHaveLength(1);
    for (let turn = 5; turn <= 8; turn += 1) {
      addToolTurn(facts, turn, `write-${turn}`, "workspace_write_file", {
        path: `src/${turn}.ts`,
      });
    }
    const later = projectProgressAdviceTimelineV1(snapshot(facts));
    expect(later).toHaveLength(2);
    expect(later[0]).toEqual(first[0]);
    expect(later[1]?.unverifiedMutationTurns).toBe(8);
    addToolTurn(facts, 9, "read", "workspace_read_file", { path: "src/8.ts" });
    expect(projectProgressAdviceTimelineV1(snapshot(facts))).toEqual(later);
  });

  test("a failed check supplies feedback but further unverified edits trigger again", () => {
    const facts: InputFactV1[] = [];
    for (let turn = 1; turn <= 4; turn += 1) {
      addToolTurn(facts, turn, `write-${turn}`, "workspace_write_file", {
        path: `src/${turn}.ts`,
      });
    }
    addToolTurn(facts, 5, "test", "workspace_run_shell", { command: "npm test" }, true);
    for (let turn = 6; turn <= 8; turn += 1) {
      addToolTurn(facts, turn, `fix-${turn}`, "workspace_edit_file", {
        path: `src/${turn}.ts`,
      });
    }
    expect(projectProgressAdviceV1(snapshot(facts))).toBeUndefined();
    addToolTurn(facts, 9, "fix-9", "workspace_edit_file", { path: "src/9.ts" });
    expect(projectProgressAdviceV1(snapshot(facts))).toMatchObject({
      kind: "verification_due",
      unverifiedMutationTurns: 4,
    });
  });

  test("masked checks and failed file writes do not reset the validation cadence", () => {
    const facts: InputFactV1[] = [];
    for (let turn = 1; turn <= 3; turn += 1) {
      addToolTurn(facts, turn, `write-${turn}`, "workspace.write_file", {
        path: `src/${turn}.ts`,
      });
    }
    addToolTurn(facts, 4, "failed-write", "workspace.write_file", { path: "missing/a.ts" }, true);
    expect(projectProgressAdviceV1(snapshot(facts))).toBeUndefined();
    addToolTurn(facts, 5, "masked", "workspace.run_shell", {
      command: "npm test; echo done",
    });
    addToolTurn(facts, 6, "write-6", "workspace.write_file", {
      path: "src/6.ts",
    });
    expect(projectProgressAdviceV1(snapshot(facts))).toMatchObject({
      kind: "verification_due",
      unverifiedMutationTurns: 4,
    });
  });

  test("late background verification cannot cover edits made after the job started", () => {
    const facts: InputFactV1[] = [];
    addToolTurn(facts, 1, "job", "workspace_job_start", { command: "npm test" }, false, {
      jobId: "test-job",
    });
    for (let turn = 2; turn <= 4; turn += 1) {
      addToolTurn(facts, turn, `write-${turn}`, "workspace_write_file", {
        path: `src/${turn}.ts`,
      });
    }
    addToolTurn(facts, 5, "wait", "workspace_job_wait", { id: "test-job" }, false, {
      snapshot: { status: "completed" },
    });
    addToolTurn(facts, 6, "write-6", "workspace_write_file", {
      path: "src/6.ts",
    });
    expect(projectProgressAdviceV1(snapshot(facts))).toMatchObject({
      kind: "verification_due",
      unverifiedMutationTurns: 4,
    });
    addToolTurn(facts, 7, "fresh-check", "workspace_run_shell", {
      command: "npm test",
    });
    addToolTurn(facts, 8, "write-8", "workspace_write_file", {
      path: "src/8.ts",
    });
    expect(projectProgressAdviceV1(snapshot(facts))).toBeUndefined();
  });

  test("multiple file tools in one model turn count once", () => {
    const facts: InputFactV1[] = [];
    for (let index = 1; index <= 4; index += 1) {
      addToolTurn(facts, 1, `write-${index}`, "workspace_write_file", {
        path: `src/${index}.ts`,
      });
    }
    expect(projectProgressAdviceV1(snapshot(facts))).toBeUndefined();
  });

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
      kind: "verification_repair",
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
    expect(projectProgressAdviceTimelineV1(structuredClone(snapshot(facts)))).toEqual(
      afterProgress,
    );
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
        addToolTurn(facts, turn, `cycle-${cycle}-read-${read}`, "workspace_read_file", {
          path: `src/cycle-${cycle}-${read}.ts`,
        });
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
          messages.reduce((total, message) => total + message.content.length, 0),
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
          messages.reduce((total, message) => total + message.content.length, 0),
      },
      hardInputLimitTokens: 20_000,
    });

    const request = await context.build(snapshot(facts), {
      signal: new AbortController().signal,
    });
    const rendered = materializeModelRequestMessagesV1(request);
    expect(rendered[1]?.content).toContain("recommendedAction=main_owned_replan");
    expect(rendered[1]?.content).toContain("make the best-supported source change");
    expect(rendered[1]?.content).toContain("explicitly select an appropriate agent_id");
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
    expect(materializeModelRequestMessagesV1(released)[1]?.content).not.toContain(
      "recommendedAction=main_owned_replan",
    );
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
          const turns = current.entries.filter(({ fact }) => fact.type === "model.settled").length;
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
          messages.reduce((total, message) => total + message.content.length, 0),
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
    expect(first.messages.at(-1)?.content).not.toBe(second.messages.at(-1)?.content);
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
  payload?: JsonValue,
): void {
  // Existing scenarios use read-only shell checks unless effects are explicit.
  let effectivePayload = payload;
  if (/(?:run_shell|job_start|job_wait)$/.test(tool))
    effectivePayload = {
      workspaceEffect: { changed: false, paths: [] },
      ...(payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {}),
    };
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
        ...(effectivePayload === undefined
          ? {}
          : {
              payload: {
                kind: "inline" as const,
                value: effectivePayload,
                hash: "fixture-inline",
              },
            }),
      },
    },
  );
}

function snapshot(facts: readonly InputFactV1[]): SessionInputSnapshot<InputFactV1> {
  return {
    entries: facts.map((fact, index) => ({ seq: index + 1, fact })),
    latestInputSeq: facts.length,
    tailSeq: facts.length,
  };
}
