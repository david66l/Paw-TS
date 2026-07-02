/**
 * 计划条目的 JSON 解析器 —— 从不可信的外部数据中尽最大努力提取 PlanItem 数组。
 *
 * ## 为什么需要这个模块
 * Paw 的 orchestrator 通过 `PlanUpdateAction.new_items` 接收 LLM 生成的 JSON 数据。
 * LLM 输出不稳定：字段可能是 snake_case 也可能是 camelCase，
 * 某些字段可能缺失或类型不正确。
 * 本模块提供"容错解析"——合法的条目被保留，非法的被跳过，绝不因此崩溃。
 *
 * ## 核心设计决策
 * 1. **双命名风格兼容**：同时接受 `task_id`（snake_case）和 `taskId`（camelCase）。
 *    默认优先使用 snake_case（与 Python 后端对齐）。
 * 2. **严格校验 + 静默跳过**：id 和 task_id 缺失的条目直接丢弃；
 *    未知 status 值回退为 PENDING。
 * 3. **Set 校验状态**：将 PlanItemStatus 的合法值放入 Set，O(1) 查找。
 * 4. **最终通过 `createPlanItem` 归一化**：所有解析出的字段通过工厂函数组装，
 *    确保输出对象的完整性（默认值填充）。
 */

import { type PlanItem, PlanItemStatus, createPlanItem } from "./plan-item.js";

/** 合法状态值的集合，用于 O(1) 快速校验。 */
const STATUS_SET = new Set<string>(Object.values(PlanItemStatus));

/**
 * 类型守卫：判断字符串是否为合法的 PlanItem 状态。
 *
 * @param s - 待校验的状态字符串
 * @returns 是合法状态则返回 true
 */
function isPlanItemStatus(s: string): s is PlanItem["status"] {
  return STATUS_SET.has(s);
}

/**
 * 从不可信的 JSON 数组中尽最大努力解析 PlanItem 列表。
 *
 * 处理逻辑：
 * - 跳过非 object 或 null/数组类型的条目
 * - 缺失 id 或 task_id 的条目直接丢弃
 * - 同时识别 snake_case（task_id）和 camelCase（taskId）
 * - 未知/缺失状态 → 默认 PENDING
 * - depends_on 必须为数组，过滤掉非字符串元素
 * - 最终通过 `createPlanItem()` 归一化，确保所有字段有合法值
 *
 * @param items - 原始 JSON 数组（来源：`PlanUpdateAction.new_items`）
 * @returns 成功解析的 PlanItem 列表（非法条目已被过滤）
 */
export function planItemsFromUnknown(items: readonly unknown[]): PlanItem[] {
  const out: PlanItem[] = [];
  for (const raw of items) {
    // 跳过非 object 或数组类型
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      continue;
    }
    const o = raw as Record<string, unknown>;

    // 提取 id（必须为字符串）
    const id = typeof o.id === "string" ? o.id : "";

    // 提取 task_id：优先 snake_case，回退 camelCase
    const taskId =
      typeof o.task_id === "string"
        ? o.task_id
        : typeof o.taskId === "string"
          ? o.taskId
          : "";

    // id 和 task_id 缺一不可
    if (!id || !taskId) {
      continue;
    }

    // 解析状态：只接受已知状态值，否则默认为 PENDING
    const statusRaw = typeof o.status === "string" ? o.status : "";
    const status =
      statusRaw && isPlanItemStatus(statusRaw)
        ? statusRaw
        : PlanItemStatus.PENDING;

    // 解析依赖列表：同时支持 snake_case 和 camelCase，过滤掉非字符串元素
    const dependsRaw = o.depends_on ?? o.dependsOn;
    const depends_on = Array.isArray(dependsRaw)
      ? dependsRaw.filter((x): x is string => typeof x === "string")
      : [];

    // 解析 assigned_run_id：同时支持 snake_case 和 camelCase
    let assigned_run_id: string | null = null;
    if (o.assigned_run_id === null) {
      assigned_run_id = null;
    } else if (typeof o.assigned_run_id === "string") {
      assigned_run_id = o.assigned_run_id;
    } else if (o.assignedRunId === null) {
      assigned_run_id = null;
    } else if (typeof o.assignedRunId === "string") {
      assigned_run_id = o.assignedRunId;
    }

    // 解析 note 字段
    let note: string | null = null;
    if (o.note === null) {
      note = null;
    } else if (typeof o.note === "string") {
      note = o.note;
    }

    // 通过工厂函数创建归一化的 PlanItem
    out.push(
      createPlanItem({
        id,
        task_id: taskId,
        status,
        depends_on,
        assigned_run_id,
        note,
      }),
    );
  }
  return out;
}
