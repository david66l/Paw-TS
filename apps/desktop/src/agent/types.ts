export type UiMessage = {
  readonly id: string;
  readonly role:
    | "user"
    | "assistant"
    | "system"
    | "activity"
    | "toolbatch"
    | "changes";
  readonly content: string;
  /** 模型思考过程（DeepSeek 等 reasoning 通道 / 内嵌 think 标签） */
  readonly thinking?: string;
  /** 流式生成中 */
  readonly streaming?: boolean;
  /** role==="activity" 时指向对应 RunActivity.id（执行摘要卡的锚点） */
  readonly activityId?: string;
  /** role==="toolbatch" 时指向对应 ToolBatch.id（工具执行卡的锚点） */
  readonly toolBatchId?: string;
};

export type RunStatus = "idle" | "running" | "completed" | "failed" | "aborted";

/** 花名册上的 Agent 运行态（绿点 / 灰点） */
export type AgentRunStatus = "idle" | "running" | "done" | "failed";

export type ActivityStatus = "running" | "done" | "failed";

/** 单个子 Agent 的运行态（由 child.* 事件驱动，key = callId = agentId） */
export interface SubAgentInfo {
  id: string;
  /** 展示标签 = 子 Agent 目标（goal） */
  label: string;
  status: ActivityStatus;
  /** child.tool_call 次数 */
  toolCount: number;
  lastTool?: string;
  /** 读到的关键文件路径（去重） */
  files: string[];
  /** 实时工具流（最近 N 条，tool_result 回填 ok/result） */
  tools?: import("./toolCards").AgentToolEvent[];
  /** child.completed 的最终摘要文本 */
  summary?: string;
  /** child.failed 的错误信息 */
  error?: string;
}

/** 一批并行子 Agent（一次 run_agent 批次 = 一张执行卡） */
export interface RunActivity {
  id: string;
  status: ActivityStatus;
  startedAt: number;
  finishedAt?: number;
  agents: SubAgentInfo[];
}

/** 待用户决策的工具审批（渲染在聊天区底部的审批卡） */
export interface PendingApprovalItem {
  approvalId: string;
  tool: string;
  /** 一行摘要（路径 / 命令等），可为空串 */
  summary: string;
  /** pretty JSON 预览（已截断），可为空串 */
  argsPreview: string;
}

/** 待用户回答的模型提问（ask_user 动作） */
export interface PendingAskItem {
  askId: string;
  question: string;
  timeoutSec: number | null;
}

/** 工具执行卡里的单行（一次工具调用） */
export interface ToolRunRow {
  id: string;
  tool: string;
  /** 一行定位摘要（路径 / 命令等），可为空串 */
  summary: string;
  /** 结果摘要（tool.result 的 summary，如 read_file: x.md (40 lines)），到达后替换展示 */
  result?: string;
  status: "running" | "ok" | "fail" | "denied";
  at: number;
  finishedAt?: number;
}

/** 一批连续工具调用（两个模型轮次之间）= 一张工具执行卡 */
export interface ToolBatch {
  id: string;
  rows: ToolRunRow[];
  status: "running" | "done";
  startedAt: number;
  finishedAt?: number;
}

/** 单个被修改文件的变更（Changed files 卡数据源） */
export interface FileChangeItem {
  path: string;
  added: number;
  removed: number;
  diff?: string;
}
