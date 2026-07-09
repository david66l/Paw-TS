/**
 * Orchestrator 常量：多 Agent 限制、事件过滤器、上下文预算。
 * ==========================================================
 *
 * 这些常量控制多 Agent 系统的并发、嵌套和资源使用。
 *
 * 关键设计决策：
 * - maxChildrenPerTurn = 3：防止单轮启动过多子 Agent 导致超时
 * - maxChildDepth = 1：只允许一层嵌套（父→子），防止无限递归
 * - maxChildSteps = 5：子 Agent 的默认步数上限，足够完成简单探索任务
 * - maxSharedContextTokens = 2000：传给子 Agent 的上下文摘要上限
 */

import type { AgentToolCallAction } from "@paw/core";

/** 多 Agent 并发限制 */
export const MULTI_AGENT_LIMITS = {
  /** 单轮最多启动的子 Agent 数 */
  maxChildrenPerTurn: 3,
  /** 最大嵌套深度（0 = 父 Agent，1 = 子 Agent） */
  maxChildDepth: 1,
  /** 每个子 Agent 的最大步数 */
  maxChildSteps: 5,
} as const;

/** 子 Agent 文件访问策略 */
export const CHILD_AGENT_POLICIES = {
  /** v1 默认：子 Agent 只读，避免并发文件冲突 */
  default: "read_only" as const,
  /** 子 Agent 单次操作最大写入字节数 */
  maxWriteSize: 100_000,
} as const;

/** SharedContext（父 Agent 传给子 Agent 的摘要）硬性 token 预算 */
export const SHARED_CONTEXT_BUDGET = {
  /** 传给子 Agent 的结构化摘要总 token 上限（约 2000 token） */
  maxSharedContextTokens: 2_000,
  /** 每个制品的最大字节数 */
  maxArtifactBytes: 50_000,
  /** 最多携带的制品数 */
  maxArtifacts: 10,
  /** 最多携带的事实数 */
  maxFacts: 20,
  /** 最多携带的约束数 */
  maxConstraints: 10,
} as const;

/**
 * 从子 Agent 转发到父 Agent 事件流的事件白名单。
 * 高频事件（model.chunk、loop.tick）被过滤掉，避免刷屏。
 */
export const PARENT_FORWARD_EVENTS = new Set([
  "child.started",
  "child.phase_changed",
  "child.tool_call",
  "child.tool_result",
  "child.completed",
  "child.failed",
  "child.cancelled",
]);

/** 启动子 Agent 的规范工具名 */
export const SUB_AGENT_TOOL_NAME = "workspace.run_agent" as const;

/** 集中化的判断函数：该工具调用是否为子 Agent 启动？ */
export function isSubAgentCall(call: AgentToolCallAction): boolean {
  return call.tool === SUB_AGENT_TOOL_NAME;
}

/** Context package user-message prefix (upsert key). */
export const CONTEXT_PACKAGE_PREFIX = "[Context Package]";
