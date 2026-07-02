/**
 * 计划条目的数据模型 —— 工作流计划中单行任务的状态与依赖定义。
 *
 * ## 背景
 * 与 Python 端 `paw.store.schemas.PlanItem` / `PlanItemStatus` 保持一致（架构 v2 §8.3）。
 * Paw 的 orchestrator 将用户目标拆解为多个 PlanItem，
 * 每个 PlanItem 有独立的状态、依赖关系和可选的执行代理绑定。
 *
 * ## 核心设计决策
 * 1. **const object + type 双重导出**：`PlanItemStatus` 既是运行时常量对象（可做值比较），
 *    又通过 `typeof` 推导出联合类型，IDE 可自动补全。
 * 2. **`createPlanItem()` 工厂函数**：为所有可选字段提供默认值（PENDING 状态、空依赖数组等），
 *    避免调用方逐字段填充。
 * 3. **snake_case 字段命名**：与 Python 后端保持一致（`task_id`、`depends_on`），
 *    跨端序列化无需转换。
 */

/** 计划条目的六种状态常量对象。 */
export const PlanItemStatus = {
  PENDING: "pending",
  RUNNING: "running",
  COMPLETED: "completed",
  BLOCKED: "blocked",
  SKIPPED: "skipped",
  FAILED: "failed",
} as const;

/** 计划条目状态联合类型（从常量对象推导）。 */
export type PlanItemStatus =
  (typeof PlanItemStatus)[keyof typeof PlanItemStatus];

/**
 * 工作流计划中的一行任务。
 *
 * - `id`：计划行的唯一标识
 * - `task_id`：关联到具体工作单元
 * - `status`：当前执行状态
 * - `depends_on`：前置依赖的 id 列表
 * - `assigned_run_id`：被分配到的执行代理 id
 * - `note`：附加说明或错误信息
 */
export type PlanItem = {
  id: string;
  task_id: string;
  status: PlanItemStatus;
  depends_on: string[];
  assigned_run_id: string | null;
  note: string | null;
};

/**
 * 创建 PlanItem 的工厂函数。
 *
 * 自动为未提供的可选字段填充安全默认值：
 * - status 默认 PENDING
 * - depends_on 默认空数组
 * - assigned_run_id 默认 null
 * - note 默认 null
 *
 * @param partial - 必须提供 id 和 task_id，其余字段可选
 * @returns 完整的 PlanItem 对象
 */
export function createPlanItem(partial: {
  readonly id: string;
  readonly task_id: string;
  readonly status?: PlanItemStatus;
  readonly depends_on?: readonly string[];
  readonly assigned_run_id?: string | null;
  readonly note?: string | null;
}): PlanItem {
  return {
    id: partial.id,
    task_id: partial.task_id,
    status: partial.status ?? PlanItemStatus.PENDING,
    // 复制依赖数组以避免外部修改污染内部状态
    depends_on: partial.depends_on ? [...partial.depends_on] : [],
    assigned_run_id: partial.assigned_run_id ?? null,
    note: partial.note ?? null,
  };
}
