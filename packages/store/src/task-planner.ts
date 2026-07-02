/**
 * 任务计划器 — 创建/更新执行计划（与 Python 版本等价 V2 §8.4）。
 * ==============================================================
 *
 * 模型可以通过 plan_update action 动态管理计划：
 * - createPlan()：初始化计划（含依赖关系）
 * - applyUpdate()：添加新项 + 废弃旧项
 *
 * 安全约束：不能废弃状态为 FAILED 的项（必须先解决失败原因）。
 */

import { type PlanItem, PlanItemStatus, createPlanItem } from "./plan-item.js";
import { Plan } from "./plan.js";

/** createPlan 的输入形状 — 与 Python 的 tasks: list[dict] 一致 */
export type PlanTaskInput = {
  readonly id?: string;
  readonly depends_on?: readonly string[];
};

/** 计划创建/更新（与 Python paw.agent.planner.TaskPlanner 等价） */
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
