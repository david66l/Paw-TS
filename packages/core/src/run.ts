/**
 * Run 边界类型。
 * =============
 *
 * Run 是单次 Agent 执行的最小单元。
 *
 * RunSpec：orchestrator.run() 的输入。
 * - runId：唯一标识
 * - goal：用户可见的目标描述
 * - workspaceRoot：工作区根目录
 * - maxSteps：最多 model↔tool 轮数（可选，默认从 settings 读取）
 * - abortSignal：外部中断信号
 * - resumeFromState：从保存的 AppState 恢复（断点续跑）
 *
 * RunResult：orchestrator.run() 的输出。
 * - status：completed | failed | pending | running | unimplemented
 * - message：人类可读的结果摘要
 */

export type RunStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "unimplemented";

export interface RunSpec {
  readonly runId: string;
  /** 用户可见的本次 Run 目标。 */
  readonly goal: string;
  /** 工作区根目录的绝对或相对路径；由 harness 解析。 */
  readonly workspaceRoot?: string;
  /**
   * 最大 model→(可选 tool) 轮数。省略时，orchestrator 读取
   * `.paw/settings.local.json` 中的 `max_steps`（如果存在），否则使用默认值（32）。
   */
  readonly maxSteps?: number;
  /** 中断信号：abort 后，模型 HTTP 和循环在轮次之间停止。 */
  readonly abortSignal?: AbortSignal;
  /** 提供此状态时，orchestrator 从保存的状态恢复而非全新启动。 */
  readonly resumeFromState?: import("./app-state.js").AppState;
}

export interface RunResult {
  readonly runId: string;
  readonly status: RunStatus;
  readonly message: string;
}
