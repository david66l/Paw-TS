import { describe, expect, test } from "bun:test";

import { PlanItemStatus, createPlanItem } from "../src/plan-item.js";
import { TaskPlanner } from "../src/task-planner.js";

describe("TaskPlanner", () => {
  test("createPlan builds stable ids and stores plan", () => {
    const tp = new TaskPlanner();
    const plan = tp.createPlan("wf-x", [
      {},
      { id: "custom", depends_on: ["plan-000"] },
    ]);
    expect(plan.workflow_id).toBe("wf-x");
    expect(plan.items[0]?.id).toBe("plan-000");
    expect(plan.items[0]?.task_id).toBe("task-000");
    expect(plan.items[1]?.task_id).toBe("custom");
    expect(plan.items[1]?.depends_on).toEqual(["plan-000"]);
    expect(tp.plan).toBe(plan);
  });

  test("applyUpdate extends items", () => {
    const tp = new TaskPlanner();
    tp.createPlan("wf", [{ id: "t0" }]);
    const extra = createPlanItem({
      id: "plan-099",
      task_id: "extra",
    });
    const p = tp.applyUpdate([extra], [], "more work");
    expect(p.items).toHaveLength(2);
    expect(p.items[1]?.task_id).toBe("extra");
  });

  test("applyUpdate annotates completed deprecated items", () => {
    const tp = new TaskPlanner();
    const plan = tp.createPlan("wf", [{ id: "a" }]);
    plan.updateItemStatus("plan-000", PlanItemStatus.COMPLETED);
    tp.applyUpdate([], ["plan-000"], "obsolete");
    const item = tp.plan?.items.find((i) => i.id === "plan-000");
    expect(item?.note).toContain("Deprecated:");
  });

  test("applyUpdate rejects deprecating failed item", () => {
    const tp = new TaskPlanner();
    const plan = tp.createPlan("wf", [{ id: "a" }]);
    plan.updateItemStatus("plan-000", PlanItemStatus.FAILED);
    expect(() => tp.applyUpdate([], ["plan-000"], "x")).toThrow(
      /without resolution/,
    );
  });

  test("applyUpdate without createPlan throws", () => {
    const tp = new TaskPlanner();
    expect(() => tp.applyUpdate([], [], "x")).toThrow(/No plan exists/);
  });

  test("applyUpdate can advance an existing item instead of duplicating it", () => {
    const tp = new TaskPlanner();
    tp.createPlan("wf", [{ id: "step-a" }]);
    const current = tp.plan!.items[0]!;
    const done = createPlanItem({
      id: current.id,
      task_id: current.task_id,
      status: PlanItemStatus.COMPLETED,
    });
    const p = tp.applyUpdate([done], [], "implemented and verified");
    expect(p.items).toHaveLength(1);
    expect(p.items[0]?.status).toBe(PlanItemStatus.COMPLETED);
    expect(p.allComplete).toBe(true);
  });

  test("restores the exact durable revision without manufacturing an update", () => {
    const source = new TaskPlanner();
    const current = source.createPlan("wf", [{ id: "step-a" }]).items[0];
    expect(current).toBeDefined();
    if (!current) throw new Error("expected seeded plan item");
    source.applyUpdate(
      [
        createPlanItem({
          id: current.id,
          task_id: current.task_id,
          status: PlanItemStatus.COMPLETED,
        }),
      ],
      [],
      "done",
    );
    const revised = source.applyUpdate([], [], "checkpoint");

    const restored = new TaskPlanner().restorePlan(
      revised.workflow_id,
      revised.items,
      revised.revision,
    );
    expect(restored.revision).toBe(2);
    expect(restored.items).toEqual(revised.items);
    expect(restored.items).not.toBe(revised.items);
  });

  test("rejects malformed durable plan snapshots", () => {
    const planner = new TaskPlanner();
    expect(() => planner.restorePlan("wf", [], -1)).toThrow(/plan revision/);
    expect(() =>
      planner.restorePlan(
        "wf",
        [
          createPlanItem({ id: "same", task_id: "one" }),
          createPlanItem({ id: "same", task_id: "two" }),
        ],
        2,
      ),
    ).toThrow(/plan item/);
  });
});
