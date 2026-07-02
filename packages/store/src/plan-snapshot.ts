/**
 * 计划快照 —— 将 Plan 转换为适合模型输入/UI 展示的序列化视图。
 *
 * ## 为什么需要这个模块
 * 完整的 Plan 对象在 orchestrator 的每一轮都会发送给 LLM 作为上下文。
 * 随着任务增多，plan 行数可能膨胀到数百行，占用大量 token 预算。
 * 本模块提供"可配置截断"的快照，既保留关键信息（下一待执行任务、完成状态），
 * 又能通过 maxItems 控制上下文大小。
 *
 * ## 核心设计决策
 * 1. **可配置上限 `PlanSnapshotOptions.maxItems`**：
 *    - undefined → 使用默认值 64（`DEFAULT_PLAN_SNAPSHOT_MAX_ITEMS`）
 *    - 0 → 无限制（返回全部行）
 *    - 正整数 → 只取前 N 行
 * 2. **`truncated` 标记**：调用方（LLM/UI）可据此判断"这是全部计划还是只显示了开头"。
 * 3. **`next_pending` 快速定位**：即便快照被截断，仍然标明下一个可执行的任务，
 *    确保 orchestrator 不会因截断而"忘记"该做什么。
 * 4. **快照行 flatten**：`PlanSnapshotRow` 去掉了 `assigned_run_id` 等运行时字段，
 *    只保留 LLM 做决策需要的信息。
 */

import type { Plan } from "./plan.js";

/**
 * PlanSnapshot 中 plan items 数量的默认上限。
 * 限制 prompt 增长，防止超出模型的上下文窗口。
 */
export const DEFAULT_PLAN_SNAPSHOT_MAX_ITEMS = 64;

/** 快照生成选项。 */
export type PlanSnapshotOptions = {
  /**
   * `items` 中包含的最大计划行数。
   * - `undefined`：使用默认值 {@link DEFAULT_PLAN_SNAPSHOT_MAX_ITEMS}
   * - `0`：无限制（包含全部行）
   */
  readonly maxItems?: number;
};

/** 快照中的单行计划数据（扁平化，去掉运行时字段）。 */
type PlanSnapshotRow = {
  readonly id: string;
  readonly task_id: string;
  readonly status: string;
  readonly depends_on: readonly string[];
  readonly note: string | null;
};

/**
 * 计划的序列化视图，用于 orchestrator 的用户轮次中传递给模型/UI。
 *
 * 包含计划概览、截断标记、下一个待执行项、全局完成状态等关键信息。
 */
export type PlanSnapshotPayload = {
  readonly workflow_id: string;
  readonly revision: number;
  readonly items: ReadonlyArray<PlanSnapshotRow>;
  /** 计划中的总行数（在截断时可能大于 items.length） */
  readonly items_total: number;
  /** items 仅为计划前缀时为 true */
  readonly truncated: boolean;
  /** 按依赖顺序下一个可执行的行，无则为 null */
  readonly next_pending: {
    readonly id: string;
    readonly task_id: string;
  } | null;
  /** 所有行均已完成或已跳过时为 true */
  readonly all_complete: boolean;
};

/**
 * 解析最终的 maxItems 数值。
 *
 * - 0 → Infinity（无限制）
 * - 合法正整数 → 该值
 * - undefined/非法值 → 默认 64
 */
function resolveMaxItems(options?: PlanSnapshotOptions): number {
  if (options?.maxItems === 0) {
    return Number.POSITIVE_INFINITY;
  }
  if (
    typeof options?.maxItems === "number" &&
    options.maxItems > 0 &&
    Number.isFinite(options.maxItems)
  ) {
    return options.maxItems;
  }
  return DEFAULT_PLAN_SNAPSHOT_MAX_ITEMS;
}

/**
 * 将 Plan 对象转换为快照载荷（可序列化视图）。
 *
 * 转换过程：
 * 1. 解析截断上限
 * 2. 查找下一个待执行的计划项
 * 3. 将所有 PlanItem 映射为 PlanSnapshotRow（扁平化）
 * 4. 根据上限决定是否截断
 * 5. 计算完成状态
 *
 * @param plan - 源 Plan 对象
 * @param options - 可选配置（maxItems 控制截断）
 * @returns 快照载荷对象
 */
export function planToSnapshotPayload(
  plan: Plan,
  options?: PlanSnapshotOptions,
): PlanSnapshotPayload {
  const maxItems = resolveMaxItems(options);
  // 计算下一个可执行的任务
  const next = plan.nextPending();
  // 将所有 PlanItem 映射为扁平快照行
  const mapped: PlanSnapshotRow[] = plan.items.map((i) => ({
    id: i.id,
    task_id: i.task_id,
    status: i.status,
    depends_on: i.depends_on,
    note: i.note,
  }));
  const items_total = mapped.length;
  // 是否需要截断
  const truncated =
    Number.isFinite(maxItems) && items_total > maxItems && maxItems >= 1;
  const items =
    truncated && Number.isFinite(maxItems)
      ? mapped.slice(0, Math.floor(maxItems))
      : mapped;

  return {
    workflow_id: plan.workflow_id,
    revision: plan.revision,
    items,
    items_total,
    truncated,
    next_pending: next ? { id: next.id, task_id: next.task_id } : null,
    all_complete: plan.allComplete,
  };
}
