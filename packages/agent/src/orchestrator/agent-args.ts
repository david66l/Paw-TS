/**
 * 子 Agent 工具调用参数的解析和 SharedContext 构建。
 * =================================================
 *
 * 处理 workspace.run_agent 工具的参数解析：
 * - agent_type：子 Agent 类型（simple/research/coding/planning/relay）
 * - child_policy：子 Agent 文件权限（read_only/read_write）
 * - max_steps：子 Agent 最大步数
 *
 * 以及在没有父 ContextManager 时的最小 SharedContext 构建。
 */

import type { SharedContext } from "./types.js";

/** 子 Agent 类型。
 *  - simple：通用单任务 Agent
 *  - research：研究型，收集信息并返回结构化发现
 *  - coding：编码型，编写/编辑/调试代码
 *  - planning：规划型，拆解任务为步骤
 *  - relay：接力型，从父 Agent 中断处继续
 */
export type AgentType = "simple" | "research" | "coding" | "planning" | "relay";

const AGENT_TYPES = new Set<AgentType>([
  "simple",
  "research",
  "coding",
  "planning",
  "relay",
]);

/** 根据 agent 类型生成 role 描述。 */
export function buildRole(agentType: AgentType): string {
  switch (agentType) {
    case "simple":
      return "You are a focused sub-agent. Complete the single task given to you.";
    case "research":
      return "You are a research sub-agent. Gather information and return structured findings.";
    case "coding":
      return "You are a coding sub-agent. Write, edit, or debug code. Return the changed files and a summary.";
    case "planning":
      return "You are a planning sub-agent. Break down the task into steps and report the plan.";
    case "relay":
      return "You are a relay sub-agent. Continue the parent task from where it left off.";
    default:
      return "You are a specialized sub-agent.";
  }
}

/** 根据 agent 类型生成期望的输出格式说明。 */
export function buildOutputFormat(agentType: AgentType): string {
  switch (agentType) {
    case "simple":
      return "Return a concise summary of what you did.";
    case "research":
      return "Return a structured report with findings, sources, and confidence levels.";
    case "coding":
      return "Return the list of changed files, any errors encountered, and a brief summary.";
    case "planning":
      return "Return a step-by-step plan with dependencies and estimated effort.";
    case "relay":
      return "Return your progress, what remains, and any blockers.";
    default:
      return "Return a clear summary of your work.";
  }
}

/**
 * 解析 `workspace.run_agent` 调用参数中的 agent 类型。
 *
 * @param args 工具调用参数
 */
export function parseAgentType(
  args: Record<string, unknown> | undefined,
): AgentType {
  const raw =
    args?.agent_type ?? args?.agentType ?? args?.type ?? args?.kind;
  if (typeof raw === "string" && AGENT_TYPES.has(raw as AgentType)) {
    return raw as AgentType;
  }
  return "simple";
}

/**
 * 解析子 Agent 的 child policy。
 *
 * @param args 工具调用参数
 */
export function parseChildPolicy(
  args: Record<string, unknown> | undefined,
): SharedContext["childPolicy"] | undefined {
  const raw = args?.child_policy ?? args?.childPolicy ?? args?.policy;
  if (raw === "read_only" || raw === "read_write") {
    return raw;
  }
  return undefined;
}

/**
 * 解析子 Agent 允许的最大步数。
 *
 * @param args 工具调用参数
 */
export function parseRunAgentMaxSteps(
  args: Record<string, unknown> | undefined,
): number | undefined {
  const raw = args?.max_steps ?? args?.maxSteps;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }
  if (typeof raw === "string" && /^\d+$/.test(raw.trim())) {
    return Number.parseInt(raw.trim(), 10);
  }
  return undefined;
}

/**
 * 当没有父级 ContextManager 时，构造一个最小化的 SharedContext。
 *
 * @param goal 子任务目标
 * @param args 可选的工具调用参数
 */
export function buildMinimalSharedContext(
  goal: string,
  args?: Record<string, unknown>,
): SharedContext {
  const agentType = parseAgentType(args);
  const childPolicy = parseChildPolicy(args) ?? "read_only";
  return {
    role: buildRole(agentType),
    task: goal,
    facts: [],
    constraints: [
      "Do not modify files outside the workspace.",
      "Do not execute destructive shell commands.",
    ],
    artifacts: [],
    state: { completed: [], pending: [goal] },
    outputFormat: buildOutputFormat(agentType),
    childPolicy,
  };
}
