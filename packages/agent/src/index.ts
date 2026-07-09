/**
 * @paw/agent 包入口。
 *
 * 导出 AgentOrchestrator、动作解析、子 Agent、压缩、会话与一次性运行。
 * 长期记忆请使用 @paw/memory MemoryRuntime（在线路径已统一为 db）。
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
