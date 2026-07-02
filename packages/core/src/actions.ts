/**
 * 模型 ↔ 编排器之间的结构化动作契约（架构 v2 §8.5）。
 *
 * 【模块职责】
 * 定义模型（LLM）可以发出的所有动作类型，以及编排器（orchestrator）如何解析和路由这些动作。
 * 这是整个系统中最核心的类型定义之一：模型输出的不是自由文本，而是结构化的动作指令，
 * 编排器根据动作类型决定下一步行为——调用工具、返回最终答案、向用户提问、更新计划或中止执行。
 *
 * 【为什么存在】
 * - 类型安全的路由：通过可辨识联合类型（discriminated union），TypeScript 编译器可以在
 *   switch-case 中对每个 `type` 做穷尽检查，防止遗漏未处理的动作类型。
 * - 跨语言对齐：与 Python 端 `paw.agent.actions` 保持结构一致（`ToolCallAction` →
 *   `AgentToolCallAction` 等），确保同一套协议在前后端都能正确序列化/反序列化。
 * - 工具调用 JSON 中同时支持 `tool`（harness 内部 id）和 `name`（Python dataclass 名），
 *   兼顾两端习惯。
 *
 * 【关键设计决策】
 * - 所有接口的字段使用 `readonly`，确保动作对象创建后不可变，避免意外修改导致的 bug。
 * - `type` 字段使用字符串字面量类型（如 `"tool_call"`），而非枚举，以减少运行时代码体积
 *   并保持与 JSON 序列化的直接对应。
 * - `AgentAskUserAction` 的 `timeoutSec` 可以为 null，表示无限等待；这比用 -1 语义更清晰。
 * - `AgentAbortAction` 包含 `canResume`，允许区分"永久中止"和"可恢复中止"，给编排器
 *   更多决策空间。
 */

/** 模型可发出的所有动作类型的联合类型 */
export type AgentAction =
  | AgentToolCallAction
  | AgentFinalAnswerAction
  | AgentAskUserAction
  | AgentPlanUpdateAction
  | AgentAbortAction;

/** 工具调用动作 —— 模型请求编排器执行某个工具 */
export interface AgentToolCallAction {
  readonly type: "tool_call";
  /** Harness 工具 id（如 `workspace.list_dir`） */
  readonly tool: string;
  /** 传递给工具的参数 */
  readonly args: Record<string, unknown>;
}

/** 最终答案动作 —— 模型认为任务已完成，返回总结 */
export interface AgentFinalAnswerAction {
  readonly type: "final_answer";
  /** 任务完成后的总结文本 */
  readonly summary: string;
}

/** 向用户提问动作 —— 模型需要用户澄清或提供更多信息 */
export interface AgentAskUserAction {
  readonly type: "ask_user";
  /** 向用户提出的问题 */
  readonly question: string;
  /** 问题的附加上下文信息 */
  readonly context: Record<string, unknown>;
  /** 等待用户回复的超时秒数，null 表示无限等待 */
  readonly timeoutSec: number | null;
}

/** 计划更新动作 —— 模型在执行过程中动态调整任务计划 */
export interface AgentPlanUpdateAction {
  readonly type: "plan_update";
  /** 新增的计划条目 */
  readonly newItems: readonly unknown[];
  /** 被废弃/移除的计划条目 ID 列表 */
  readonly deprecatedItems: readonly string[];
  /** 计划变更的原因说明 */
  readonly reason: string;
}

/** 中止动作 —— 模型判断无法继续执行，请求终止 */
export interface AgentAbortAction {
  readonly type: "abort";
  /** 中止的原因 */
  readonly reason: string;
  /** 是否允许恢复执行（true = 可以稍后从中止点继续） */
  readonly canResume: boolean;
}
