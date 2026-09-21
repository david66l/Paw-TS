/**
 * 工具批次的"逐调用计划"。
 * ========================
 *
 * 背景（docs/CODE-REVIEW.md §A3）：
 * `executeToolCalls` 原先用 7 个**下标对齐的并行数组**串起整个流程 ——
 * `policyBlocks` / `blockedByPolicy` / `effectPolicyApplies` / `lockConflict` /
 * `approvals` / `checkpointNums` / `mutationCaptures`，全部以 `x[i]` 形式读写。
 * 它们之间长度与顺序必须完全一致，却没有任何检查；两种构造风格还混用
 * （`approvals` 靠 4 个分支 `push`，其余靠下标赋值），于是编译器无法证明
 * 它们同步，只能在读取处写 `!`（`policyBlocks[i]!`）。
 *
 * 改成"一条 call 一个记录"之后：
 * - 只剩**一个**数组，长度/顺序一致成为构造出来的事实，不再需要维护；
 * - 所有 `x[i]` 与那处 `!` 一起消失；
 * - 执行函数收 `ToolCallPlan` 而不是 `(call, i)`，索引从签名里彻底退出。
 */

import type { AgentToolCallAction } from "@paw/core";
import type { LoopV2ShadowMutationCapture } from "../loop-v2/index.js";

/** 策略拒绝的原因与消息（`policyBlocks` 的元素类型）。 */
export interface ToolPolicyBlock {
  readonly reason: string;
  readonly message: string;
}

/**
 * 一条工具调用的完整执行计划。
 *
 * `call` / `policyBlock` / `effectPolicyApplies` 在计划阶段就能确定，故为
 * `readonly`；其余三项由后续步骤分阶段写入 —— 文件锁（步骤 1.5）、审批
 * （步骤 2）、checkpoint 序号（步骤 3）、执行后突变捕获（步骤 4）。
 * 保持可变是对现状的如实建模，不是遗漏：把它们一次性算出来需要把
 * `await`（审批回调、文件锁）从流程里抽走，那是另一个改动。
 */
export interface ToolCallPlan {
  readonly call: AgentToolCallAction;
  /** 策略拒绝的详情；`undefined` 表示放行。 */
  readonly policyBlock: ToolPolicyBlock | undefined;
  readonly effectPolicyApplies: boolean;
  /** 文件锁冲突路径；`undefined` 表示无冲突（含未启用文件锁的父 Agent）。 */
  lockConflict: string | undefined;
  /** 审批结果；被策略阻止或用户拒绝时为 `false`。 */
  approval: boolean;
  /** 修改性工具的 checkpoint 序号；无需 checkpoint 时为 `undefined`。 */
  checkpointNum: number | undefined;
  /** 执行后的突变捕获，供 loop v2 影子事实使用。 */
  mutationCapture: LoopV2ShadowMutationCapture | undefined;
}

/**
 * 把下标对齐的并行数组折叠成逐调用记录。
 *
 * 这是唯一构造 `ToolCallPlan[]` 的地方。三条输入都由 `calls.map` 产生，
 * 因此结果长度天然等于 `calls.length`、顺序天然与 `calls` 一致 ——
 * 原先那组"必须长度和顺序完全一致"的隐含不变量，从这里开始不再需要维持。
 */
export function createToolCallPlans(
  calls: readonly AgentToolCallAction[],
  policyBlocks: readonly (ToolPolicyBlock | undefined)[],
  effectPolicyApplies: readonly boolean[],
): ToolCallPlan[] {
  return calls.map((call, index) => ({
    call,
    policyBlock: policyBlocks[index],
    // 越界读原先会得到 `undefined`（`noUncheckedIndexedAccess` 下属于
    // "读到了不该读的格子"）；显式兜底为 false，与"策略不适用"同义。
    effectPolicyApplies: effectPolicyApplies[index] ?? false,
    lockConflict: undefined,
    approval: false,
    checkpointNum: undefined,
    mutationCapture: undefined,
  }));
}
