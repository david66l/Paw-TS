/**
 * @paw/store 包的公共入口。
 *
 * ## 功能概览
 * 本包提供 Paw 工作流的数据模型与持久化抽象：
 * - PlanItem 及其状态管理（plan-item.ts）
 * - 不可信 JSON → PlanItem 的容错解析（plan-items-json.ts）
 * - Plan 类：有序任务集合 + 依赖拓扑（plan.ts）
 * - Plan Snapshot：面向 LLM/UI 的序列化视图（plan-snapshot.ts）
 * - TaskPlanner：AI 驱动的任务规划器（task-planner.ts）
 *
 * ## 架构关系
 * ```
 * PlanItem (单行数据) → Plan (集合 + 依赖) → PlanSnapshot (序列化视图)
 *                                        → TaskPlanner (AI 规划)
 * ```
 */

// 计划条目基础定义
export * from "./plan-item.js";
// 不可信 JSON 解析
export { planItemsFromUnknown } from "./plan-items-json.js";
// 计划快照
export {
  DEFAULT_PLAN_SNAPSHOT_MAX_ITEMS,
  type PlanSnapshotOptions,
  type PlanSnapshotPayload,
  planToSnapshotPayload,
} from "./plan-snapshot.js";
// 计划集合类
export { Plan } from "./plan.js";
// AI 任务规划器
export type { PlanTaskInput } from "./task-planner.js";
export { TaskPlanner } from "./task-planner.js";
