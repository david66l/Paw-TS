import { describe, expect, test } from "bun:test";

import { PlanItemStatus, createPlanItem } from "../src/plan-item.js";
import { planToSnapshotPayload } from "../src/plan-snapshot.js";
import { Plan } from "../src/plan.js";

describe("planToSnapshotPayload", () => {
  test("includes items, next_pending, all_complete", () => {
    const plan = new Plan("wf-1", [
      createPlanItem({
        id: "plan-000",
        task_id: "a",
      }),
      createPlanItem({
        id: "plan-001",
        task_id: "b",
        depends_on: ["plan-000"],
      }),
    ]);
    const s = planToSnapshotPayload(plan);
    expect(s.workflow_id).toBe("wf-1");
    expect(s.revision).toBe(0);
    expect(s.items).toHaveLength(2);
    expect(s.items_total).toBe(2);
    expect(s.truncated).toBe(false);
    expect(s.next_pending?.id).toBe("plan-000");
    expect(s.all_complete).toBe(false);
  });

  test("truncates items when over maxItems", () => {
    const rows = Array.from({ length: 70 }, (_, i) =>
      createPlanItem({
        id: `plan-${String(i).padStart(3, "0")}`,
        task_id: `t-${i}`,
      }),
    );
    const plan = new Plan("wf-big", rows);
    const s = planToSnapshotPayload(plan);
    expect(s.items_total).toBe(70);
    expect(s.truncated).toBe(true);
    expect(s.items).toHaveLength(64);
    expect(s.items[0]?.id).toBe("plan-000");
    const unlimited = planToSnapshotPayload(plan, { maxItems: 0 });
    expect(unlimited.truncated).toBe(false);
    expect(unlimited.items).toHaveLength(70);
  });

  test("all_complete when every item completed or skipped", () => {
    const plan = new Plan("wf", [
      createPlanItem({
        id: "p0",
        task_id: "t",
        status: PlanItemStatus.COMPLETED,
      }),
    ]);
    expect(planToSnapshotPayload(plan).all_complete).toBe(true);
    expect(planToSnapshotPayload(plan).next_pending).toBeNull();
  });
});
