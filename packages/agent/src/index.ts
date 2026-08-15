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
  candidateReviewInput,
  candidateSummaryFingerprint,
  extractCandidateDeliberation,
  ModelCandidateReviewer,
  parseCandidateReview,
  SubAgentCandidateReviewer,
  type CandidateReviewInput,
  type CandidateReviewResult,
  type CandidateReviewer,
  type CandidateReviewVerdict,
  type CandidateVerificationEvidence,
  type ModelCandidateReviewerOptions,
  type ReportGroundingVerdict,
  type SubAgentCandidateReviewerOptions,
} from "./candidate-review.js";
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
  resolveCollaborationMode,
  CODING_ROOT_IDENTITY,
  CODING_LIFECYCLE_BUDGET,
  type CollaborationMode,
  type ResolvedCollaboration,
} from "./collaboration-mode.js";
export {
  runStubRun,
  formatDoctorOutput,
  formatFsListOutput,
  formatFsReadOutput,
  type StubRunOptions,
  type StubRunSession,
} from "./stub-run.js";
export {
  bindConversationMemoryTask,
  getConversationMemoryTask,
  takeConversationMemoryTask,
  clearConversationMemoryBindings,
  finalizeConversationMemory,
  listWorkspaceMemories,
} from "./conversation-memory-bind.js";
export {
  extractPlanStepsFromGoal,
  planItemsFromStepTexts,
  planItemsToEventSnapshot,
  markPlanItemsCompleted,
} from "./plan-bootstrap.js";

// Agent 规范 / 注册表 / 工厂
export {
  type AgentSpec,
  type AgentSummary,
  type CreateAgentInput,
  type AgentValidationResult,
  AgentRegistry,
  loadAgentRegistry,
  loadAgentRegistryReadonly,
  createAgentInRegistry,
  agentsDir,
  loadAgentsFromDirectory,
  parseAgentMarkdown,
  createInputToMarkdown,
  writeAgentFile,
  validateAgentSpec,
  validateCreateInput,
  materializeAgent,
  allowedToolsForSpec,
  DEFAULT_AGENT_SEEDS,
  AGENT_ROSTER_ORDER,
} from "./agents/index.js";

export {
  createAutonomyProfile,
  type AutonomyLevel,
  type AutonomyProfile,
  type AutonomyProfileOptions,
} from "./autonomy/index.js";
export type {
  ToolEffectPolicy,
  ToolEffectPolicyDecision,
  ToolEffectPolicyInput,
  ToolExecutionPolicy,
  ToolExecutionPolicyDecision,
  ToolExecutionPolicyInput,
} from "./execution-policy.js";
export {
  decideCompletion,
  checkVerification,
  evaluateFinalAnswer,
  evaluateBudgetExhaustion,
  collectToolRecoveryMessage,
  resolveLifecycleBudget,
  createBudgetAbort,
  DEFAULT_LIFECYCLE_BUDGET,
  HEADLESS_LIFECYCLE_BUDGET,
  REQUIRE_MUTATION_MARKER,
  goalRequiresMutation,
  type CompletionDecision,
  type VerificationDecision,
  type VerificationPolicy,
  type LifecycleBudget,
} from "./lifecycle/index.js";
export {
  advanceCodingPhase,
  codingPhaseBlockReason,
  EMPTY_CODING_PHASE_STATE,
  CODING_PHASE_BUDGET_MARKER,
  goalUsesCodingPhaseBudget,
  isCodingVerificationCall,
  type CodingPhaseState,
} from "./lifecycle/coding-phase.js";
export {
  advanceRepeatToolReminder,
  type RepeatToolReminderResult,
  type RepeatToolState,
} from "./lifecycle/repeat-tool-reminder.js";
export {
  LOOP_AUTHORITY_SCHEMA_V1,
  resolveLoopAuthorityPolicyV1,
  type LoopAuthorityPolicyV1,
} from "./loop-authority.js";

export * from "./loop-v2/index.js";
