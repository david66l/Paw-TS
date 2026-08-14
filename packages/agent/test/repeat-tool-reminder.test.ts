import { describe, expect, test } from "bun:test";
import type { AgentToolCallAction } from "@paw/core";

import {
  type RepeatToolState,
  advanceRepeatToolReminder,
} from "../src/lifecycle/repeat-tool-reminder.js";

function call(
  tool: string,
  args: Record<string, unknown>,
): AgentToolCallAction {
  return { type: "tool_call", tool, args };
}

function advance(
  state: RepeatToolState | undefined,
  next: AgentToolCallAction,
) {
  return advanceRepeatToolReminder(state, [next]);
}

describe("repeat tool reminder", () => {
  test("advises on the third identical call without blocking it", () => {
    const repeated = call("workspace.grep", { path: "src", pattern: "Parser" });
    const first = advance(undefined, repeated);
    const second = advance(first.state, repeated);
    const third = advance(second.state, repeated);

    expect(first.reminders).toEqual([]);
    expect(second.reminders).toEqual([]);
    expect(third.state?.count).toBe(3);
    expect(third.reminders).toHaveLength(1);
    expect(third.reminders[0]).toContain("exact same tool call");
    expect(third.reminders[0]).toContain("was not blocked");
  });

  test("canonicalizes argument key order but resets for a new read range", () => {
    const first = advance(
      undefined,
      call("workspace.read_file", {
        path: "large.py",
        offset: 1100,
        limit: 60,
      }),
    );
    const reordered = advance(
      first.state,
      call("workspace.read_file", {
        limit: 60,
        offset: 1100,
        path: "large.py",
      }),
    );
    const unseen = advance(
      reordered.state,
      call("workspace.read_file", {
        path: "large.py",
        offset: 1160,
        limit: 60,
      }),
    );

    expect(reordered.state?.count).toBe(2);
    expect(unseen.state?.count).toBe(1);
    expect(unseen.reminders).toEqual([]);
  });

  test("treats bookkeeping calls as transparent and escalates at five", () => {
    const repeated = call("workspace.run_shell", { command: "python -V" });
    let state: RepeatToolState | undefined;
    const reminders: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const result = advanceRepeatToolReminder(state, [
        repeated,
        call("workspace.todo_write", { todos: [] }),
      ]);
      state = result.state;
      reminders.push(...result.reminders);
    }

    expect(state?.count).toBe(5);
    expect(reminders).toHaveLength(2);
    expect(reminders[1]).toContain("repeated 5 consecutive times");
    expect(reminders[1]).toContain("python -V");
  });

  test("caps detailed argument previews while matching on the full value", () => {
    const repeated = call("workspace.write_file", {
      path: "large.txt",
      content: "x".repeat(2_000),
    });
    let state: RepeatToolState | undefined;
    let fifth = "";
    for (let index = 0; index < 5; index += 1) {
      const result = advance(state, repeated);
      state = result.state;
      fifth = result.reminders.at(-1) ?? fifth;
    }

    expect(state?.count).toBe(5);
    expect(fifth).toContain("(+");
    expect(fifth.length).toBeLessThan(900);
  });
});
