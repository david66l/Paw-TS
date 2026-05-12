import { type PlanItem, PlanItemStatus, createPlanItem } from "./plan-item.js";
import { Plan } from "./plan.js";

/**
 * Input shape for `createPlan` — mirrors Python `tasks: list[dict]` (`id`, `depends_on`).
 */
export type PlanTaskInput = {
  readonly id?: string;
  readonly depends_on?: readonly string[];
};

/**
 * Plan creation / updates (V2 §8.4). Parity: `paw.agent.planner.TaskPlanner`.
 */
export class TaskPlanner {
  private _plan: Plan | null = null;

  createPlan(workflowId: string, tasks: readonly PlanTaskInput[]): Plan {
    const items: PlanItem[] = [];
    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      if (task === undefined) {
        continue;
      }
      const taskId =
        typeof task.id === "string" && task.id
          ? task.id
          : `task-${String(i).padStart(3, "0")}`;
      const dependsOn = Array.isArray(task.depends_on)
        ? task.depends_on.filter((x): x is string => typeof x === "string")
        : [];
      items.push(
        createPlanItem({
          id: `plan-${String(i).padStart(3, "0")}`,
          task_id: taskId,
          status: PlanItemStatus.PENDING,
          depends_on: dependsOn,
        }),
      );
    }
    const plan = new Plan(workflowId, items);
    this._plan = plan;
    return plan;
  }

  /**
   * Apply a PlanUpdateAction. Completed items are annotated; deprecating FAILED
   * items without resolution throws (Python parity).
   */
  applyUpdate(
    newItems: readonly PlanItem[],
    deprecatedIds: readonly string[],
    reason: string,
  ): Plan {
    if (this._plan === null) {
      throw new Error("No plan exists");
    }

    for (const itemId of deprecatedIds) {
      const item = this._plan.items.find((i) => i.id === itemId);
      if (item?.status === PlanItemStatus.COMPLETED) {
        item.note = `Deprecated: ${reason}`;
      } else if (item?.status === PlanItemStatus.FAILED) {
        throw new Error(
          `Cannot deprecate failed plan item ${itemId} without resolution`,
        );
      }
    }

    this._plan.items.push(
      ...newItems.map((i) => ({ ...i, depends_on: [...i.depends_on] })),
    );
    this._plan.revision += 1;
    return this._plan;
  }

  get plan(): Plan | null {
    return this._plan;
  }
}
