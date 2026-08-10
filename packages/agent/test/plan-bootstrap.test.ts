import { describe, expect, test } from "bun:test";
import {
  extractPlanStepsFromGoal,
  planItemsFromStepTexts,
  markPlanItemsCompleted,
  planItemsToEventSnapshot,
} from "../src/plan-bootstrap.js";

describe("extractPlanStepsFromGoal", () => {
  test("extracts numbered steps", () => {
    const goal =
      "多步骤任务：1) 列出顶层目录；2) 说明 apps 职责；3) 一句话总结。";
    const steps = extractPlanStepsFromGoal(goal);
    expect(steps.length).toBeGreaterThanOrEqual(3);
    expect(steps[0]).toMatch(/目录/);
    expect(steps[1]).toMatch(/apps/);
  });

  test("returns empty for simple goals", () => {
    expect(extractPlanStepsFromGoal("你好")).toEqual([]);
    expect(extractPlanStepsFromGoal("用一句话介绍你自己")).toEqual([]);
  });
});

describe("planItemsFromStepTexts", () => {
  test("builds pending items", () => {
    const items = planItemsFromStepTexts(["A", "B"]);
    expect(items).toHaveLength(2);
    expect(items[0]!.status).toBe("pending");
    expect(items[0]!.task_id).toBe("A");
  });
});

describe("markPlanItemsCompleted + snapshot", () => {
  test("marks pending as completed", () => {
    const items = planItemsFromStepTexts(["A", "B"]);
    const done = markPlanItemsCompleted(items);
    expect(done.every((i) => i.status === "completed")).toBe(true);
    const snap = planItemsToEventSnapshot(done);
    expect(snap[0]!.status).toBe("completed");
    expect(snap[0]!.text).toBe("A");
  });
});
