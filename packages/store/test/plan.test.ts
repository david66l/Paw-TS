import { describe, expect, test } from "bun:test";

import { PlanItemStatus, createPlanItem } from "../src/plan-item.js";
import { Plan } from "../src/plan.js";

describe("Plan", () => {
  test("nextPending respects depends_on order", () => {
    const plan = new Plan("wf-1", [
      createPlanItem({ id: "plan-000", task_id: "t0", depends_on: [] }),
      createPlanItem({
        id: "plan-001",
        task_id: "t1",
        depends_on: ["plan-000"],
      }),
    ]);
    expect(plan.nextPending()?.id).toBe("plan-000");
    plan.updateItemStatus("plan-000", PlanItemStatus.COMPLETED);
    expect(plan.nextPending()?.id).toBe("plan-001");
  });

  test("allComplete when completed or skipped", () => {
    const plan = new Plan("wf", [
      createPlanItem({ id: "a", task_id: "a" }),
      createPlanItem({ id: "b", task_id: "b" }),
    ]);
    expect(plan.allComplete).toBe(false);
    plan.updateItemStatus("a", PlanItemStatus.COMPLETED);
    plan.updateItemStatus("b", PlanItemStatus.SKIPPED);
    expect(plan.allComplete).toBe(true);
  });
});
