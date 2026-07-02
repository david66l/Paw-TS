/**
 * @paw/agent 包入口。
 *
 * 导出 AgentOrchestrator（核心 ReAct 循环）、动作解析器、
 * 子 Agent 启动器、压缩 Agent、记忆提取、会话管理、一次性运行入口。
 */

export type {
  AgentOrchestratorOptions,
  AskUserResolveInput,
  ToolApprovalInput,
} from "./orchestrator.js";
export { AgentOrchestrator } from "./orchestrator.js";
export { resolvePlanSnapshotMaxItems } from "./resolve-plan-snapshot-max-items.js";
export {
  parseAgentActionFromModelText,
  parseAgentActionsFromModelText,
} from "./parse-agent-action.js";
export type { McpServerConfig, McpToolRef, McpCallResult } from "@paw/harness";
export {
  DefaultSubAgentLauncher,
  type DefaultSubAgentLauncherOptions,
} from "./sub-agent-launcher.js";
export {
  runCompressionAgent,
  type CompressionAgentResult,
} from "./compression-agent.js";
export {
  extractMemories,
  type MemoryExtractionResult,
} from "./memory-extraction-agent.js";

// 会话 & 装配 & 一次性运行 — 从 cli-core 移入
export {
  createPersistentSession,
  type PersistentSession,
  type PersistentSessionOptions,
  createRunSessionController,
  type RunSessionController,
} from "./session.js";
export {
  createRunOrchestrator,
  type RunOrchestrator,
  type RunOrchestratorOptions,
} from "./orchestrator-factory.js";
export {
  runStubRun,
  formatDoctorOutput,
  formatFsListOutput,
  formatFsReadOutput,
  type StubRunOptions,
  type StubRunSession,
} from "./stub-run.js";
