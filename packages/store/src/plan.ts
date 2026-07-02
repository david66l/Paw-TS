/**
 * Plan 类 —— 带有依赖关系的有序任务集合（架构 v2 §8.3.2）。
 *
 * ## 背景
 * Paw 的 AI orchestrator 在规划阶段生成一个 Plan 对象，
 * 将用户目标拆解为多个 PlanItem，按依赖关系组织。
 * 执行引擎按拓扑顺序调度：只有当所有前置依赖完成，后续任务才能开始。
 *
 * ## 与 Python 端的对应关系
 * 本类是 `paw.agent.planner.Plan` 的 TypeScript 镜像。
 * 字段命名和语义完全一致，确保跨端序列化无缝对接。
 *
 * ## 核心设计决策
 * 1. **revision 自增机制**：每次 `addItem` 或 `updateItemStatus` 都会使 revision+1。
 *    调用方可通过 revision 判断 plan 是否被修改过（类似乐观锁）。
 * 2. **`nextPending()` 拓扑查找**：遍历所有 PENDING 项，检查其所有依赖是否都已完成。
 *    返回找到的第一个"就绪"项（FIFO 顺序）。
 * 3. **`allComplete` getter**：判断依据是每项 status 要么 COMPLETED 要么 SKIPPED。
 *    FAILED/BLOCKED/RUNNING 均视为"未完成"。
 */

import {
  type PlanItem,
  type PlanItemStatus,
  PlanItemStatus as S,
} from "./plan-item.js";

/**
 * 工作流计划 —— 有序任务集合，支持依赖关系管理。
 *
 * 特性：
 * - 按插入顺序维护任务列表
 * - 自动追踪修改版本号
 * - 支持依赖感知的"下一待执行"查询
 * - 提供整体完成判断
 */
export class Plan {
  workflow_id: string;
  items: PlanItem[];
  revision: number;
  last_updated_at: string;

  constructor(
    workflow_id: string,
    items: PlanItem[] = [],
    revision = 0,
    last_updated_at = "",
  ) {
    this.workflow_id = workflow_id;
    this.items = items;
    this.revision = revision;
    this.last_updated_at = last_updated_at;
  }

  /**
   * 添加新的计划条目并递增版本号。
   *
   * @param item - 要添加的计划条目
   */
  addItem(item: PlanItem): void {
    this.items.push(item);
    this.revision += 1;
  }

  /**
   * 更新指定条目的状态并递增版本号。
   *
   * @param itemId - 目标条目的 id
   * @param status - 新状态
   */
  updateItemStatus(itemId: string, status: PlanItemStatus): void {
    for (const item of this.items) {
      if (item.id === itemId) {
        item.status = status;
        this.revision += 1;
        return;
      }
    }
  }

  /**
   * 查找下一个可执行的 PENDING 项（其所有依赖均已 COMPLETED）。
   *
   * 算法：
   * 1. 收集所有 COMPLETED 项的 id 到 Set
   * 2. 遍历所有 PENDING 项
   * 3. 返回第一个 whose every depends_on item 在 completed set 中
   *
   * @returns 找到的下一个待执行项，无则返回 undefined
   */
  nextPending(): PlanItem | undefined {
    const completed = new Set(
      this.items.filter((i) => i.status === S.COMPLETED).map((i) => i.id),
    );
    for (const item of this.items) {
      if (item.status === S.PENDING) {
        if (item.depends_on.every((dep) => completed.has(dep))) {
          return item;
        }
      }
    }
    return undefined;
  }

  /**
   * 是否所有任务均已完成或被跳过。
   *
   * 注意：FAILED 或 BLOCKED 的项会导致返回 false。
   */
  get allComplete(): boolean {
    return this.items.every(
      (i) => i.status === S.COMPLETED || i.status === S.SKIPPED,
    );
  }
}
