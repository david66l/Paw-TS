import { describe, expect, test } from "bun:test";

import { PlanItemStatus } from "../src/plan-item.js";
import { planItemsFromUnknown } from "../src/plan-items-json.js";

describe("planItemsFromUnknown", () => {
  test("parses snake_case and camelCase", () => {
    const items = planItemsFromUnknown([
      {
        id: "plan-001",
        task_id: "t1",
        status: "pending",
        depends_on: ["plan-000"],
      },
      { id: "plan-002", taskId: "t2", dependsOn: [] },
      "skip",
      { id: "" },
    ]);
    expect(items).toHaveLength(2);
    expect(items[0]?.id).toBe("plan-001");
    expect(items[0]?.task_id).toBe("t1");
    expect(items[0]?.depends_on).toEqual(["plan-000"]);
    expect(items[1]?.task_id).toBe("t2");
  });

  test("defaults invalid status to pending", () => {
    const [one] = planItemsFromUnknown([
      { id: "p", task_id: "t", status: "not-a-real-status" },
    ]);
    expect(one?.status).toBe(PlanItemStatus.PENDING);
  });
});
