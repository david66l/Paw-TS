/**
 * AgentOrchestrator：多轮 model ↔ tool 循环（ReAct 模式）
 * ========================================================
 *
 * 这是整个 paw-ts 的核心调度器。一个 Run 从用户输入开始，进入"模型调用 → 解析动作 →
 * 执行工具 → 反馈结果 → 再调用模型"的循环，直到模型返回 final 动作或达到 maxSteps。
 *
 * 架构要点：
 * ----------
 * 1. **状态机驱动**：executeTurn() 每轮返回 TurnState（continue/complete/failed），
 *    run() 中的 for 循环根据状态决定继续还是终止。
 *
 * 2. **上下文压缩三层体系**：
 *    - L1 Prune：裁剪旧的工具输出，纯规则驱动（context-pruner.ts）
 *    - L2 Compact：用辅助模型压缩中间历史（maybeCompactHistory → compression-agent.ts）
 *    - L3 Protect：保护 system prompt + 最近几轮 + 注入的记忆不被压缩
 *
 * 3. **原生 Function Calling + 文本解析双通道**：
 *    优先使用模型的原生 tool_use（NativeToolCall），不支持时回退到从文本中
 *    正则提取 <tool_call> XML 标签。
 *
 * 4. **熔断器 + 重试策略**：
 *    每个模型 label 一个 CircuitBreaker 实例，连续失败触发熔断；可重试错误
 *    （限流/服务端错误/网络）使用指数退避自动重试，最多 3 次。
 *
 * 5. **子 Agent 管理**：
 *    通过 AgentGroup 管理子 Agent 的启动、事件转发和取消。
 *
 * 6. **记忆提取**：
 *    运行完成后可选地从对话中提取记忆（memoryExtraction: background/await/off）。
 *
 * 原始文件从 1300 行单体重构为现在的状态机架构，action 处理拆分到
 * orchestrator/action-handlers.ts，类型定义拆分到 orchestrator/types.ts。
 *
 * 面试要点：
 * ----------
 * - ReAct 循环的核心流程：model → parse → tool → feedback → model
 * - 为什么需要上下文压缩？LLM 上下文窗口有限，长对话必须压缩中间历史
 * - 熔断器的价值：防止连续失败浪费 token 和资源
 * - 双通道工具调用：兼容不支持原生 function calling 的模型
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

// ─────────────────────────────────────────────────────────────
// @paw/core：平台基础层 — 上下文管理、记忆系统、事件、token 估算
// ─────────────────────────────────────────────────────────────
import {
  type AgentToolCallAction,
  type AppState,
  type AppStateStore,
  ArtifactRegistry,
  CONTEXT_SUMMARY_PREFIX,
  CalibratedEstimator,
  type ContextBudgetSnapshot,
  ContextCompactor,
  ContextManager,
  ContextMonitor,
  type CostTracker,
  DEFAULT_KEEP_RECENT_TOOLS,
  type EvalHooks,
  MAX_COMPRESSION_SAVINGS_RATIO,
  MIN_COMPRESSION_SAVINGS_RATIO,
  type ModelTokenUsage,
  type RunEvent,
  type RunEventEnvelope,
  type RunResult,
  type RunSpec,
  type SessionStore,
  SkillRegistry,
  type SkillRegistry as SkillRegistryType,
  type TodoStore,
  type TokenEstimator,
  type UserReplyInboxEventV1,
  type WaitingUserInteractionV1,
  allocateContextBudget,
  atomicWrite,
  buildSystemPromptWithBudget,
  compressionSavingsRatio,
  computeCompactThreshold,
  costAdjustedCompactThreshold,
  detectDuplicateAccess,
  evaluateTrigger,
  findPawRoot,
  formatTodosForPrompt,
  getToolResultsDir,
  isContextSummaryMessage,
  isProtectedUserConstraint,
  isToolResultMessage,
  listCheckpoints,
  loadSkillsFromDirectory,
  measureContextBudget,
  prewarmEncoding,
  resolveEstimatorForModel,
  restoreCheckpoint,
  saveCompactionCommit,
  shouldCompactHistory,
  skillsFromProjectMemory,
  stripContextSummaryMessages,
  validateCompressionSummary,
} from "@paw/core";
import {
  checkpointLoopControlV1,
  resetLoopControlForRewindV1,
  restoreLoopControlFlagsV1,
} from "./loop-control-state.js";
import {
  type ControlReductionV1,
  type LoopKernelVersion,
  type LoopV2LegacyTerminalV1,
  type LoopV2LiveCandidateAssessmentV1,
  LoopV2LiveReviewRuntimeV1,
  type LoopV2ShadowObserver,
  type LoopV2ShadowReport,
  type LoopV2ShadowToolCommitPortInput,
  type VerificationRecordV2,
  buildLoopV2LiveCandidateArtifactV1,
  buildLoopV2ProjectionCheckpointV1,
  canonicalJson,
  createLoopV2ShadowObserver,
  createProviderTerminalStateV2,
  formatRepairObligationV1,
  loopV2LiveArtifactPath,
  loopV2ProjectionCheckpointPath,
  loopV2ReadinessProgressKeyV1,
  normalizeProviderResponseV2,
  parseLoopV2LiveCandidateArtifactV1,
  parseLoopV2ProjectionCheckpointV1,
  resolveLoopKernelVersion,
  restoreLoopV2ProjectionObserver,
  runVerificationProbeOnceV2,
  serializeLoopV2ProjectionCheckpointV1,
} from "./loop-v2/index.js";

// ─────────────────────────────────────────────────────────────
// @paw/harness：执行层 — MCP 客户端、工具定义、Shell 沙箱
// ─────────────────────────────────────────────────────────────
import {
  McpClientManager,
  type McpServerConfig,
  type SubAgentLauncher,
  runShellInWorkspace,
  toolDefinitions,
  toolNameReverseMap,
} from "@paw/harness";

// ─────────────────────────────────────────────────────────────
// @paw/models：LLM 适配层 — 模型抽象、消息类型、流式解析
// ─────────────────────────────────────────────────────────────
import {
  AnthropicCompatibleModel,
  type ChatMessage,
  type LanguageModel,
  type NativeToolCall,
  OpenAICompatibleModel,
  createDefaultLanguageModel,
  extractThinkBlocks,
} from "@paw/models";

// ─────────────────────────────────────────────────────────────
// @paw/store：计划/任务持久化
// ─────────────────────────────────────────────────────────────
import { type PlanItem, TaskPlanner, planToSnapshotPayload } from "@paw/store";

// ─────────────────────────────────────────────────────────────
// orchestrator 内部模块 — 从单体拆分出的职责单元
// ─────────────────────────────────────────────────────────────

import {
  type CodeContextBlock,
  type WorkspaceWatcher,
  discoverContext,
  extractAtMentions,
  gitStatus,
  loadPawMd,
  resolveMentions,
  selectCodeContext,
} from "@paw/workspace";

import {
  type MemoryRuntime,
  SessionMemoryStore,
  buildConversationAwareQuery,
  createMemoryRuntime,
  extractCleanMemoryQuery,
  loadProjectMemory,
} from "@paw/memory";
import { loadMemoryConfigSync } from "@paw/memory/longterm";
import type { CandidateReviewer } from "./candidate-review.js";
import {
  CapabilityExposureShadowV1,
  capabilityPhaseToolsV1,
} from "./capability-exposure.js";
import {
  type CapabilitySetV1,
  resolveCapabilitySetV1,
} from "./capability-set.js";
import { buildChildSystemPrompt } from "./child-system-prompt.js";
import { runCompressionAgent } from "./compression-agent.js";
import { runConstraintReconcile } from "./constraint-reconcile.js";
import {
  type EphemeralControlV1,
  type HostStateV1,
  assembleModelContextV1,
  selectEphemeralControlV1,
  stripLegacyContextProjectionsV1,
} from "./context-assembler.js";
import {
  appendReplyToInboxV1,
  appendUserReplyV1,
  parseInteractionInboxV1,
  parseWaitingUserInteractionV1,
  prepareInteractionResumeV1,
} from "./durable-interaction.js";
import type {
  ToolEffectPolicy,
  ToolExecutionPolicy,
} from "./execution-policy.js";
import {
  decideCompletion,
  decideIncomplete,
} from "./lifecycle/completion-policy.js";
import {
  type ProgressBaselineV1,
  computeProgressBaselineV1,
  evaluateInvestigationStallV1,
} from "./lifecycle/investigation-stall.js";
import { memoryOutcomeFromDecision } from "./lifecycle/memory-outcome.js";
import {
  type VerificationPolicy,
  goalAllowsSkipVerification,
  goalRequiresMutation,
} from "./lifecycle/verification-gate.js";
import type { TestMapV1 } from "./loop-v2/test-map.js";
import { buildTestMapV1, findImpactedTests } from "./loop-v2/test-map.js";
import {
  preFlightTestInfrastructure,
  verifyImpactedTests,
} from "./loop-v2/test-warden.js";
import { ManagedJobControllerV1 } from "./managed-job-controller.js";
import {
  type MemoryHintCheckpointV1,
  createMemoryHintCheckpointV1,
  migrateLegacyMemoryProjectionsV1,
  parseMemoryHintCheckpointV1,
  renderRelevantMemoryV1,
} from "./memory-host-state.js";
import { observationProvenanceForToolV1 } from "./observation-provenance.js";
import { handleAction } from "./orchestrator/action-handlers.js";
import type { NativeToolError } from "./orchestrator/action-handlers.js";
import { AgentGroup } from "./orchestrator/agent-group.js";
import { CONTEXT_PACKAGE_PREFIX } from "./orchestrator/constants.js";
import { fixMalformedToolArguments } from "./orchestrator/fix-malformed-args.js";
import {
  annotateUntrustedShellExitSummary,
  annotateVerificationFailureRecords,
  commitToolExecutionResult,
} from "./orchestrator/tool-runner.js";
import {
  type PayloadDeduper,
  createPayloadDeduper,
} from "./orchestrator/truncate-payload.js";

/**
 * 约束生命周期：任务转向触发信号（仅决定"该问 LLM 调和了"，
 * 不做语义判定——判定全部由 constraint-reconcile 的 LLM 负责）。
 */
const CONSTRAINT_TASK_PIVOT_PATTERN =
  /^(?:new task|next task|now (?:do|work on|handle|fix)|新任务|接下来(?:做|处理|修复)|下一步(?:做|处理|修复)|换个任务)/i;

/** 系统注入的 user 消息（约束调和候选必须排除——不是用户意图） */
const CONSTRAINT_SYSTEM_INJECTED_PREFIXES = [
  "[Context Package]",
  "[Status Snapshot v1]",
  "[Context Summary]",
  "[Previous session context]",
  "[You stopped",
  "[Max steps",
  "[MAX_STEPS",
  "[model produced only reasoning]",
  "[Task]",
  "[Memory refresh]",
  "[Context guard]",
  "[Loop reminder]",
  "[Convergence checkpoint]",
  "[ProviderProtocol:",
  "[LoopControl:",
  "[LoopV2Readiness:",
  "[LoopV2SemanticReview:",
  "[ProgressAdvice:",
  "[TestWarden]",
  "[ImpactedTests]",
  "[Managed jobs are unfinished:",
  "[Managed job recovery v1]",
  "[Continue from where you were cut off",
  "Plan updated:",
  "Current plan:",
  "Note:",
];

function loopV2LegacyTerminalFromRunResult(
  result: RunResult,
): LoopV2LegacyTerminalV1 {
  if (
    result.status !== "completed" &&
    result.status !== "incomplete" &&
    result.status !== "failed" &&
    result.status !== "aborted"
  ) {
    throw new Error(`Unsupported loop v2 terminal status: ${result.status}`);
  }
  return {
    status: result.status,
    ...(result.outcome ? { outcome: result.outcome } : {}),
    ...(result.completionReason ? { reasonCode: result.completionReason } : {}),
  };
}

function providerProtocolRecoveryMessageV2(
  issue: "empty_response" | "truncated_response" | "missing_tool_calls",
): string {
  if (issue === "truncated_response") {
    return "[ProviderProtocol:truncated_response] The previous response was discarded before any tool execution because it was truncated. Retry the complete tool call or candidate response once; do not continue partial JSON.";
  }
  if (issue === "missing_tool_calls") {
    return "[ProviderProtocol:missing_tool_calls] The provider declared tool calls but supplied none. Emit the complete structured calls once, or return a visible candidate response.";
  }
  return "[ProviderProtocol:empty_response] The provider returned no visible text or executable action. Retry once with complete tool calls, an explicit control action, or a visible candidate response.";
}

function providerTurnBoundaryMessageV2(reduction: ControlReductionV1): string {
  if (
    reduction.effects[0]?.type === "call_model" &&
    reduction.effects[0].reason === "repair_required" &&
    reduction.state.openRepairObligation
  ) {
    const obligation = reduction.state.openRepairObligation;
    return `[LoopControl:repair_required id=${obligation.id}] The durable ${obligation.kind} obligation remains open. Execute the matching tool action now. Prose, repeated reads, unrelated successful tools, and another final_answer do not satisfy it.`;
  }
  return "[LoopControl:turn_boundary] Your previous natural-language response ended the provider turn but did not submit a completion candidate. Continue with the next required tool/action. If the task is actually ready, submit the structured final_answer action explicitly.";
}

function isControlOnlyCandidateExtension(
  candidateReport: LoopV2ShadowReport,
  restoredReport: LoopV2ShadowReport,
): boolean {
  if (candidateReport.reportHash === restoredReport.reportHash) return true;
  const candidateEvents = candidateReport.projectedEvents;
  const restoredEvents = restoredReport.projectedEvents;
  if (restoredEvents.length <= candidateEvents.length) return false;
  for (let index = 0; index < candidateEvents.length; index += 1) {
    if (
      canonicalJson(candidateEvents[index]) !==
      canonicalJson(restoredEvents[index])
    ) {
      return false;
    }
  }
  return restoredEvents
    .slice(candidateEvents.length)
    .every((envelope) => envelope.event.type === "readiness.evaluated");
}
import { ExecutionEnvironmentRegistryV1 } from "./execution-environment.js";
import {
  type LoopGuidanceCandidateV1,
  applyLoopGuidanceReceiptV1,
  deriveLoopGuidanceCandidatesV1,
} from "./lifecycle/loop-guidance.js";
import type {
  PhaseContext,
  SharedContext,
  TurnFlags,
  TurnState,
} from "./orchestrator/types.js";
import {
  type ParseDiagnosis,
  diagnoseParseFailure,
  parseAgentActionFromModelText,
  parseAgentActionsFromModelText,
} from "./parse-agent-action.js";
import {
  CircuitBreaker,
  CircuitBreakerOpenError,
} from "./resilience/circuit-breaker.js";
import { resolveMaxSteps } from "./resolve-max-steps.js";
import { resolveShellSandboxConfig } from "./resolve-shell-sandbox.js";
import {
  RunStatusTelemetryV1,
  formatStatusSnapshotV1,
} from "./status-snapshot.js";
import {
  TaskStateManager,
  formatTaskProgressForContext,
} from "./task-state.js";

// ═════════════════════════════════════════════════════════════
// 公开接口
// ═════════════════════════════════════════════════════════════

/** 模型发出 ask_user 动作时，传递给外部审批回调的参数 */
export interface AskUserResolveInput {
  readonly question: string;
  /** 超时时间（秒），null 表示无超时 */
  readonly timeoutSec: number | null;
}

/** 工具审批回调的输入：工具名 + 参数 */
export interface ToolApprovalInput {
  readonly tool: string;
  readonly args: unknown;
}

/**
 * AgentOrchestrator 构造选项。
 *
 * 设计思路：所有外部依赖通过选项注入（依赖反转），方便测试和隔离。
 * 一个 orchestrator 实例可以多次调用 run() 执行不同的 Run。
 */
export interface AgentOrchestratorOptions {
  /** 主模型（可选，不传则从工作区配置自动选择默认模型） */
  readonly model?: LanguageModel;
  /** 事件回调：每产生一个 RunEvent 就触发，用于 TUI/CLI 实时展示 */
  readonly onEvent?: (envelope: RunEventEnvelope) => void;
  /** 计划快照的最大条目数 */
  readonly planSnapshotMaxItems?: number;
  /** ask_user 审批回调：模型向用户提问时调用，返回用户的回答文本 */
  readonly resolveAskUser?: (input: AskUserResolveInput) => Promise<string>;
  /** 工具审批回调：执行工具前调用，返回 true 表示批准执行 */
  readonly resolveToolApproval?: (input: ToolApprovalInput) => Promise<boolean>;
  /** 工具审批策略：传入工具名，返回 true/false/undefined（undefined 表示需询问用户） */
  readonly approvalPolicy?: (tool: string) => boolean | undefined;
  /** MCP（Model Context Protocol）服务器配置列表 */
  readonly mcpServers?: readonly McpServerConfig[];
  /** 会话持久化存储 */
  readonly sessionStore?: SessionStore;
  /** Todo 列表存储 */
  readonly todoStore?: TodoStore;
  /** 上下文管理器（可注入自定义实现） */
  readonly contextManager?: ContextManager;
  /** 子 Agent 启动器：用于探索、压缩、记忆提取等子任务 */
  readonly subAgentLauncher?: SubAgentLauncher;
  /** 并行子 Agent 的文件锁（仅子 Agent orchestrator 注入；root 不传） */
  readonly fileLock?: import("@paw/harness").FileLockLike;
  /** 应用状态存储：用于断点续跑（resume） */
  readonly appStateStore?: AppStateStore;
  /** Skill 注册表 */
  readonly skillRegistry?: SkillRegistryType;
  /** Skill 文件目录路径 */
  readonly skillsDir?: string;
  /** 成本追踪器 */
  readonly costTracker?: CostTracker;
  /** 文件系统监听器：检测外部文件变更 */
  readonly watcher?: WorkspaceWatcher;
  /**
   * 子 Agent 策略：
   * - "read_only"：子 Agent 禁止执行修改性工具
   * - "read_write"：子 Agent 拥有全部权限
   */
  readonly childPolicy?: "read_only" | "read_write";
  /**
   * 运行模式：
   * - "full"：完整的 Agent（默认），构建完整 system prompt
   * - "child"：子 Agent 模式，使用精简的 child system prompt
   */
  readonly runMode?: "full" | "child";
  /** 子 Agent 模式下，父 Agent 传递的上下文 */
  readonly sharedContext?: SharedContext;
  /** 辅助模型：用于压缩和记忆提取（默认复用主模型以节省配置） */
  readonly auxiliaryModel?: LanguageModel;
  /** 测试注入：覆盖重试等待函数，默认 setTimeout */
  readonly retrySleep?: (ms: number) => Promise<void>;
  /** 测试/运行时覆盖单次模型请求超时；默认 120 秒。 */
  readonly modelRequestTimeoutMs?: number;
  /**
   * 运行后记忆提取策略：
   * - "background"：后台异步提取，不阻塞响应（默认）
   * - "await"：同步等待提取完成
   * - "off"：关闭记忆提取
   */
  readonly memoryExtraction?: "background" | "await" | "off";
  /**
   * v2 记忆 LLM 接线策略：
   * - "agent"：蒸馏/精排用主模型（fake 模型自动跳过，避免污染预设响应），裁决用 settings 强模型（默认）
   * - "settings"：全部由 v2 runtime 按 settings.local.json 解析（无配置则降级）
   * - "off"：不接任何 LLM（蒸馏降级 append-only / 裁决直 ADD）
   */
  readonly memoryLlm?: "agent" | "settings" | "off";
  /** 评估钩子：非侵入式收集 trace 数据，不影响正常流程 */
  readonly evalHooks?: EvalHooks;
  /**
   * 模型工具配置（完整名，如 workspace.read_file）。
   * undefined/null = 低层兼容全量；数组 = 精确集合。生产 coding 工厂
   * 必须显式传入核心集合，低层类不暗中选择部署策略。
   * 同一配置会在 run 初始化时解析为 CapabilitySet，同时约束 schema、
   * 文本动作解析和执行器。
   */
  readonly allowedTools?: readonly string[] | null;
  /** 注入 system prompt 的 Agent 花名册文本（狸花调度用） */
  readonly agentCatalogText?: string;
  /** 身份/人设附加段（如狸花 body） */
  readonly agentIdentityText?: string;
  /** create_agent 工具实现（写盘 + registry） */
  readonly createAgent?: import("@paw/harness").HarnessContext["createAgent"];
  /** P5.1 侧信道 monitor 配置（采样率/冷却/预算软启动，测试可注入） */
  readonly monitorOptions?: import("@paw/core").ContextMonitorOptions;
  /** Trusted, task-scoped policy checked before tool side effects. */
  readonly toolExecutionPolicy?: ToolExecutionPolicy;
  /** Trusted before/after audit for filesystem or process effects. */
  readonly toolEffectPolicy?: ToolEffectPolicy;
  /** Trusted completion authority; defaults to local verification. */
  readonly verificationPolicy?: VerificationPolicy;
  /** Trusted execution environment override; workspace settings are the fallback. */
  readonly shellSandbox?: import("@paw/harness").ShellSandboxConfig;
  /** Independent semantic review before completing a mutated task. */
  readonly candidateReviewer?: CandidateReviewer;
  /** Independent one-call review model used only by explicit loop v2. */
  readonly loopV2SemanticReviewModel?: LanguageModel;
  /**
   * Adversarial verification-probe model (fresh context, host-executed
   * boundary probes before certification). Absent disables the probe gate.
   */
  readonly loopV2VerificationProbeModel?: LanguageModel;
  /** Loop kernel selection; defaults to PAW_LOOP_KERNEL_VERSION, then v1. */
  readonly loopKernelVersion?: LoopKernelVersion;
  /** Terminal v2-shadow diagnostics. Observer failures never affect the run. */
  readonly onLoopV2ShadowReport?: (report: LoopV2ShadowReport) => void;
  /** Strict derived candidate facts for explicit v2; callback failures are diagnostic-only. */
  readonly onLoopV2CandidateAssessment?: (
    assessment: LoopV2LiveCandidateAssessmentV1,
  ) => void;
}

// ═════════════════════════════════════════════════════════════
// AgentOrchestrator：核心调度器
// ═════════════════════════════════════════════════════════════

export class AgentOrchestrator {
  // ── 静态常量 ──

  /** 压缩冷却轮数：一次压缩后至少等 N 轮才允许再次压缩，避免频繁压缩影响体验 */
  private static readonly COMPACT_COOLDOWN_TURNS = 5;
  /** Side-channel compaction must not become a failure point on tiny histories. */
  private static readonly MONITOR_COMPACT_MIN_HISTORY_RATIO = 0.2;
  private static readonly COMPRESSION_MODEL_TIMEOUT_MS = 45_000;

  /** 外部文件变更检测时忽略的目录（这些目录的变更不提示用户） */
  private static readonly STALE_IGNORE_DIRS = new Set([
    "node_modules",
    ".git",
    ".paw",
    ".next",
    "dist",
    ".turbo",
    "__pycache__",
  ]);

  /** 外部文件变更提示的最大文件数（超过则截断并显示 "... and N more"） */
  private static readonly MAX_STALE_FILES = 30;

  /** 模型调用超时（毫秒）：2 分钟，防止单次调用无限等待 */
  private static readonly DEFAULT_MODEL_TIMEOUT_MS = 120_000;

  // ── 实例属性 ──

  private readonly overrideModel?: LanguageModel;
  private readonly onEvent?: (envelope: RunEventEnvelope) => void;
  private readonly planSnapshotMaxItems?: number;
  private readonly resolveAskUser?: AgentOrchestratorOptions["resolveAskUser"];
  private readonly resolveToolApproval?: AgentOrchestratorOptions["resolveToolApproval"];
  private readonly approvalPolicy?: AgentOrchestratorOptions["approvalPolicy"];
  private readonly fileLock?: AgentOrchestratorOptions["fileLock"];
  /** 会话级工具输出去重器（P1 入口闸） */
  private readonly _payloadDeduper?: PayloadDeduper;
  private readonly mcpServers?: readonly McpServerConfig[];
  private readonly sessionStore?: SessionStore;
  private readonly todoStore?: TodoStore;
  private readonly contextManager?: ContextManager;
  private readonly subAgentLauncher?: SubAgentLauncher;
  private readonly appStateStore?: AppStateStore;
  private readonly skillRegistry: SkillRegistryType;
  private readonly costTracker?: CostTracker;
  private readonly watcher?: WorkspaceWatcher;
  private readonly childPolicy?: "read_only" | "read_write";
  private readonly runMode: "full" | "child";
  private readonly sharedContext?: SharedContext;
  private readonly auxiliaryModel?: LanguageModel;
  /** 压缩冷却剩余轮数：每轮递减，>0 时禁止压缩 */
  private compactCooldownTurns = 0;
  /** P4.4 压缩版本化：提交序号（orchestrator 生命周期内单调递增） */
  private _compactionCommitSeq = 0;
  /** P4.3 逐块账本去重键：块账本无变化时不重复发事件 */
  private _lastBlocksKey: string | null = null;
  /** 上下文预算去重键：避免连续两轮发出完全相同的 budget 事件（实例级，跨 run 不共享） */
  private _lastBudgetKey: string | null = null;
  /** P1.4 估算统一：usage 回填校准器（每 run 一个，跟随模型） */
  private _calibratedEstimator: CalibratedEstimator | null = null;
  /** P5.1 侧信道 monitor：压缩主动化调度（采样 + 冷却 + 预算软启动） */
  private readonly monitor: ContextMonitor;
  /** P5.2 成本记账：累计 prompt/cached（cache 命中率 → 阈值微调） */
  private _promptTokensAcc = 0;
  private _cachedPromptTokensAcc = 0;
  /** P2.7 行为闭环：压缩后重复获取监控（快照 + 窗口 + 报告去重） */
  private _qualityWindowTurn = -1;
  private _qualityCompactTurn = -1;
  private _qualityFiles = new Set<string>();
  private _qualityCommands = new Set<string>();
  private _qualityReported = false;

  /** 压缩后重复获取监控窗口（轮数） */
  private static readonly COMPACTION_QUALITY_WINDOW_TURNS = 5;
  /** 约束生命周期：上次扫描的用户消息数（检测新增） */
  private _lastConstraintScanCount = 0;
  /** 约束生命周期：上次调和轮次（15 轮强制） */
  private _lastConstraintReconcileTurn = -100;
  /** 约束生命周期：调和冷却剩余轮数（调和后 3 轮内不重复） */
  private _constraintReconcileCooldown = 0;

  // 记忆 Runtime（Postgres）
  private _memoryRuntime: MemoryRuntime | null = null;
  private _memoryTaskId: string | null = null;
  private _memoryContextSection = "";
  private _memoryLatestHint: MemoryHintCheckpointV1 | undefined;
  private _coldResumeMemoryContext:
    | { readonly task: string; readonly state: string }
    | undefined;
  private _lastDynamicMemoryGoal = "";
  /** 多轮会话：本 run 结束时跳过 completeTask */
  private _deferMemoryComplete = false;
  private _conversationId: string | null = null;
  private _interactionState: WaitingUserInteractionV1 | undefined;
  private _interactionInbox: readonly UserReplyInboxEventV1[] = [];
  private _executionEnvironment: ExecutionEnvironmentRegistryV1 | undefined;
  private _managedJobs: ManagedJobControllerV1 | undefined;
  private _contextPackageCode: readonly CodeContextBlock[] = [];
  /** 流式恢复文件路径：模型输出时实时写盘，崩了可用于恢复 */
  private _streamRecoveryPath?: string;
  private readonly retrySleep: (ms: number) => Promise<void>;
  private readonly modelRequestTimeoutMs: number;
  /** @deprecated 长期记忆写入已由 MemoryRuntime.completeTask 接管 */
  private readonly memoryExtraction: "background" | "await" | "off";
  /** v2 记忆 LLM 接线策略（"agent" | "settings" | "off"） */
  private readonly memoryLlm: "agent" | "settings" | "off";
  /** 熔断器映射：key = model.label，每个模型独立熔断 */
  private readonly circuitBreakers = new Map<string, CircuitBreaker>();
  private readonly evalHooks?: EvalHooks;
  private readonly allowedTools?: readonly string[] | null;
  private readonly agentCatalogText?: string;
  private readonly agentIdentityText?: string;
  private readonly createAgent?: AgentOrchestratorOptions["createAgent"];
  private readonly toolExecutionPolicy?: AgentOrchestratorOptions["toolExecutionPolicy"];
  private readonly toolEffectPolicy?: AgentOrchestratorOptions["toolEffectPolicy"];
  private readonly verificationPolicy?: AgentOrchestratorOptions["verificationPolicy"];
  private readonly shellSandbox?: AgentOrchestratorOptions["shellSandbox"];
  private readonly candidateReviewer?: CandidateReviewer;
  private readonly loopV2SemanticReviewModel?: LanguageModel;
  private readonly loopV2VerificationProbeModel?: LanguageModel;
  private readonly loopKernelVersion: LoopKernelVersion;
  private readonly onLoopV2ShadowReport?: (report: LoopV2ShadowReport) => void;
  private readonly onLoopV2CandidateAssessment?: (
    assessment: LoopV2LiveCandidateAssessmentV1,
  ) => void;
  private _lastLoopV2ShadowReport?: LoopV2ShadowReport;
  private _lastLoopV2CandidateAssessment?: LoopV2LiveCandidateAssessmentV1;
  private _lastLoopV2ReadinessProgressKey?: string;
  private _lastLoopV2ReadinessVerificationRecords?: readonly VerificationRecordV2[];

  constructor(opts?: AgentOrchestratorOptions) {
    this.overrideModel = opts?.model;
    this.onEvent = opts?.onEvent;
    this.planSnapshotMaxItems = opts?.planSnapshotMaxItems;
    this.resolveAskUser = opts?.resolveAskUser;
    this.resolveToolApproval = opts?.resolveToolApproval;
    this.approvalPolicy = opts?.approvalPolicy;
    this.toolExecutionPolicy = opts?.toolExecutionPolicy;
    this.toolEffectPolicy = opts?.toolEffectPolicy;
    this.verificationPolicy = opts?.verificationPolicy;
    this.shellSandbox = opts?.shellSandbox;
    this.candidateReviewer = opts?.candidateReviewer;
    this.loopV2SemanticReviewModel = opts?.loopV2SemanticReviewModel;
    this.loopV2VerificationProbeModel = opts?.loopV2VerificationProbeModel;
    this.loopKernelVersion =
      opts?.loopKernelVersion ?? resolveLoopKernelVersion();
    this.onLoopV2ShadowReport = opts?.onLoopV2ShadowReport;
    this.onLoopV2CandidateAssessment = opts?.onLoopV2CandidateAssessment;
    this.fileLock = opts?.fileLock;
    // P1 入口闸：会话级去重器（仅 root orchestrator；子 Agent 不重复去重）
    this._payloadDeduper = opts?.fileLock ? undefined : createPayloadDeduper();
    this.mcpServers = opts?.mcpServers;
    this.sessionStore = opts?.sessionStore;
    this.todoStore = opts?.todoStore;
    this.contextManager = opts?.contextManager;
    this.subAgentLauncher = opts?.subAgentLauncher;
    this.appStateStore = opts?.appStateStore;
    // Skill 注册表如果未提供则创建空实例
    this.skillRegistry = opts?.skillRegistry ?? new SkillRegistry();
    this.costTracker = opts?.costTracker;
    this.watcher = opts?.watcher;
    this.childPolicy = opts?.childPolicy;
    this.runMode = opts?.runMode ?? "full";
    this.sharedContext = opts?.sharedContext;
    this.auxiliaryModel = opts?.auxiliaryModel;
    // 重试等待函数：默认用 setTimeout，测试时可注入 fake timer
    this.retrySleep =
      opts?.retrySleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.modelRequestTimeoutMs = Math.max(
      1,
      Math.floor(
        opts?.modelRequestTimeoutMs ??
          AgentOrchestrator.DEFAULT_MODEL_TIMEOUT_MS,
      ),
    );
    this.memoryExtraction = opts?.memoryExtraction ?? "background";
    void this.memoryExtraction; // kept for API compat; writes go through Runtime
    this.memoryLlm = opts?.memoryLlm ?? "agent";
    this.evalHooks = opts?.evalHooks;
    this.allowedTools = opts?.allowedTools;
    this.agentCatalogText = opts?.agentCatalogText;
    this.agentIdentityText = opts?.agentIdentityText;
    this.createAgent = opts?.createAgent;
    this.monitor = new ContextMonitor(opts?.monitorOptions);
    // 如果传入了 skillsDir，从目录批量加载 skill 并注册
    if (opts?.skillsDir) {
      const skills = loadSkillsFromDirectory(opts.skillsDir);
      for (const skill of skills) {
        this.skillRegistry.register(skill);
      }
    }
  }

  /** Most recent shadow snapshot, exposed without changing RunResult. */
  getLastLoopV2ShadowReport(): LoopV2ShadowReport | undefined {
    return this._lastLoopV2ShadowReport;
  }

  /** Most recent strict candidate projection for explicit v2. */
  getLastLoopV2CandidateAssessment():
    | LoopV2LiveCandidateAssessmentV1
    | undefined {
    return this._lastLoopV2CandidateAssessment;
  }

  /** 描述信息：用于日志和调试 */
  describe(): string {
    return "AgentOrchestrator (TS): model + harness tool loop + run events.";
  }

  // ─────────────────────────────────────────────────────────
  // resumeRun：断点续跑
  // ─────────────────────────────────────────────────────────

  async submitUserReply(input: {
    readonly runId: string;
    readonly requestId: string;
    readonly reply: string;
  }): Promise<{ readonly replyId: string; readonly appended: boolean }> {
    if (!this.appStateStore) {
      throw new Error("Cannot submit reply: no appStateStore configured");
    }
    const loaded = await Promise.resolve(this.appStateStore.load(input.runId));
    if (!loaded) {
      throw new Error(
        `Cannot submit reply: run "${input.runId}" was not found`,
      );
    }
    const before = loaded.interactionInbox?.length ?? 0;
    const updated = appendUserReplyV1(loaded, input);
    await Promise.resolve(this.appStateStore.save(updated));
    const event = updated.interactionInbox?.find(
      (item) => item.requestId === input.requestId,
    );
    if (!event) throw new Error("Submitted reply was not persisted");
    return {
      replyId: event.replyId,
      appended: (updated.interactionInbox?.length ?? 0) > before,
    };
  }

  /**
   * 从之前保存的状态恢复运行。
   *
   * 流程：
   * 1. 从 AppStateStore 加载保存的 AppState
   * 2. 如果指定了 fromTurn，恢复到该轮的代码快照（checkpoint）
   * 3. 复用 run() 方法，传入 resumeFromState
   *
   * 这是实现"中断后继续"的关键入口——用户在 TUI 中按 Ctrl+C 后可以选择
   * 从断点恢复，而不是从头开始。
   */
  async resumeRun(opts: {
    readonly runId: string;
    readonly workspaceRoot?: string;
    /** 从第几轮恢复（0-based），不传则从保存的轮次恢复 */
    readonly fromTurn?: number;
    readonly abortSignal?: AbortSignal;
  }): Promise<RunResult> {
    // 没有 AppStateStore 就无法恢复
    if (!this.appStateStore) {
      return {
        runId: opts.runId,
        status: "failed",
        message: "Cannot resume: no appStateStore configured",
      };
    }

    const loaded = await Promise.resolve(this.appStateStore.load(opts.runId));
    if (!loaded) {
      return {
        runId: opts.runId,
        status: "failed",
        message: `Cannot resume: no saved state found for run "${opts.runId}"`,
      };
    }

    const interactionResume = prepareInteractionResumeV1(loaded);
    if (interactionResume.kind === "waiting_user") {
      return {
        runId: opts.runId,
        status: "incomplete",
        message: `[Ask user] ${interactionResume.interaction.question}`,
        outcome: "incomplete",
        completionReason: "user_input_required",
      };
    }
    if (interactionResume.state !== loaded) {
      await Promise.resolve(this.appStateStore.save(interactionResume.state));
    }
    const preparedState = interactionResume.state;

    const workspaceRoot = opts.workspaceRoot?.trim()
      ? path.resolve(opts.workspaceRoot)
      : preparedState.workspaceRoot;

    // 清理上一次崩溃遗留的流式恢复文件
    const streamsDir = path.join(workspaceRoot, ".paw", "streams", opts.runId);
    try {
      const leftover = await fsp.readdir(streamsDir);
      if (leftover.length > 0) {
        // ponytail: 只清不读，恢复文件的存在本身就是"上次崩了"的信号
        await Promise.all(
          leftover.map((f) =>
            fsp.unlink(path.join(streamsDir, f)).catch(() => {}),
          ),
        );
      }
    } catch {
      // 目录不存在 → 正常，没有崩溃遗留
    }

    // 如果指定了 fromTurn，恢复文件系统的 checkpoints（代码快照）
    let resumeState = preparedState;
    if (opts.fromTurn !== undefined && opts.fromTurn >= 0) {
      restoreCheckpoint(workspaceRoot, opts.runId, opts.fromTurn, {
        backup: true,
      });
      // A rewind invalidates later provider cursors, recovery budgets and
      // pending controls. Recreate loop control from the requested boundary.
      resumeState = {
        ...preparedState,
        turn: opts.fromTurn,
        loopControl: resetLoopControlForRewindV1(opts.runId, opts.fromTurn),
        memoryHint: undefined,
      };
    }

    return this.run({
      runId: opts.runId,
      goal: resumeState.goal,
      workspaceRoot,
      maxSteps: resumeState.maxSteps,
      abortSignal: opts.abortSignal,
      resumeFromState: resumeState,
      ...(resumeState.memoryTaskId
        ? { resumeMemoryTaskId: resumeState.memoryTaskId }
        : {}),
    });
  }

  // ─────────────────────────────────────────────────────────
  // run：主入口 —— ReAct 循环
  // ─────────────────────────────────────────────────────────

  /**
   * 执行一个完整的 Agent Run。
   *
   * 这是整个 orchestrator 的核心方法。每个 Run 包含以下阶段：
   *
   * 1. initializeRun()：初始化上下文、模型、工具定义、记忆检索等
   * 2. 主循环（for turn = startTurn; turn < maxSteps; turn++）：
   *    a. 检查 abort 信号
   *    b. executeTurn()：一轮完整的 model → parse → action → feedback
   *    c. 根据 TurnState 决定 continue / 返回结果 / 失败退出
   * 3. 循环耗尽 maxSteps 仍未得到 final → 返回 failed
   *
   * 关键设计决策：
   * - 循环体不在 run() 中内联，而是委托给 executeTurn()，保持 run() 简洁
   * - 异常安全：finally 块确保 MCP 连接一定被释放
   * - try/catch 中即使初始化完成前崩溃，也能返回合理的错误信息
   */
  async run(spec: RunSpec): Promise<RunResult> {
    let init: Awaited<ReturnType<typeof this.initializeRun>> | undefined;
    let agentGroup: AgentGroup | undefined;
    let emitRunMetrics: (() => void) | undefined;
    let persistLoopV2Terminal: ((result: RunResult) => void) | undefined;
    let activeTurnFlags: TurnFlags | undefined;
    let activeTurnCursor: number | undefined;

    try {
      // 阶段 1：初始化（记忆检索、system prompt 构建、MCP 连接等）
      init = await this.initializeRun(spec);
      const {
        runId,
        workspaceRoot,
        maxSteps,
        startTurn,
        model,
        mcp,
        toolDefs,
        toolNameMap,
        capabilitySet,
        ctxMgr,
        planner,
        sessionMemoryStore,
        compactor,
        emit,
        emitRunMetrics: _emitRunMetrics,
        checkpointSeq,
        shellSandbox,
        taskState,
        statusTelemetry,
        executionEnvironment,
        managedJobs,
        capabilityExposure,
      } = init;
      emitRunMetrics = _emitRunMetrics;
      persistLoopV2Terminal = (result) => {
        try {
          init?.persistLoopV2Terminal?.(result);
        } catch {
          // Dual calculation remains diagnostic until the authority cutover.
        }
      };
      const signal = spec.abortSignal;

      // 创建 AgentGroup 用于管理子 Agent
      // AgentGroup 负责：转发事件到父 Agent、限制子 Agent 深度、批量取消
      if (this.subAgentLauncher) {
        agentGroup = new AgentGroup({
          parentRunId: runId,
          parentOnEvent: (envelope) => {
            this.onEvent?.(envelope);
            this.sessionStore?.saveEvent(runId, envelope);
          },
          parentWatcher: this.watcher,
          launcher: this.subAgentLauncher,
          depth: 0,
        });
      }

      // TurnFlags 在每轮之间传递状态：
      // - autoContinueNudges: 连续自动继续次数（防止死循环）
      // - lastTurnHadToolCall: 上一轮是否执行了工具
      // - hasEverUsedTools: 是否使用过工具
      const restoredLoopControl = spec.resumeFromState
        ? restoreLoopControlFlagsV1({
            runId,
            startTurn,
            value: spec.resumeFromState.loopControl,
            legacyMessages: spec.resumeFromState.messages,
            legacyCandidateReview: taskState.snapshot().candidateReview,
            allowLegacyReadiness: this.loopKernelVersion === "v2",
          })
        : {};
      let flags: TurnFlags = {
        autoContinueNudges: 0,
        lastTurnHadToolCall: false,
        hasEverUsedTools: false,
        ...restoredLoopControl,
        ...(this.loopKernelVersion === "v2"
          ? restoredLoopControl.providerTerminal
            ? {}
            : {
                providerTerminal: {
                  ...createProviderTerminalStateV2(runId),
                  lastTurn: startTurn,
                },
              }
          : {}),
      };
      activeTurnFlags = flags;
      activeTurnCursor = startTurn;

      // 捕获到闭包中，供 executeTurn 使用
      const turnCompactor = compactor;
      const turnSessionMemoryStore = sessionMemoryStore;

      // Fresh run only: resume has already restored the exact durable plan and
      // revision in initializeRun. Re-bootstrap here would overwrite it.
      if (!spec.resumeFromState?.plan) {
        const { extractPlanStepsFromGoal, planItemsToEventSnapshot } =
          await import("./plan-bootstrap.js");
        const goalForPlan = extractCleanMemoryQuery(spec.goal) || spec.goal;
        const stepTexts = extractPlanStepsFromGoal(goalForPlan);
        if (stepTexts.length >= 2) {
          planner.createPlan(
            runId,
            stepTexts.map((s) => ({ id: s.slice(0, 200) })),
          );
          const p = planner.plan;
          if (p) {
            taskState.setPlan(p.items);
            emit({
              type: "plan.updated",
              revision: p.revision,
              itemCount: p.items.length,
              reason: "bootstrap_from_goal",
              items: planItemsToEventSnapshot(p.items),
            });
          }
        } else {
          planner.createPlan(runId, []);
        }
      }

      // ═══ 主循环：ReAct 循环的核心 ═══
      // 每轮 = 一次完整的 model → parse → action → feedback 周期
      let progressBaseline: ProgressBaselineV1 | undefined;
      // 测试守卫：惰性构建的代码-测试依赖图 + 上次验证的 revision
      let testWardenMap: TestMapV1 | undefined;
      let lastVerifiedRevision = -1;
      let preflightControl: EphemeralControlV1 | undefined;
      // Layer 1：开工安检（基线验证测试基础设施可执行）
      if (this.loopKernelVersion === "v2") {
        try {
          const preFlight = preFlightTestInfrastructure({
            workspaceRoot,
            ...(this.shellSandbox ? { shellSandbox: this.shellSandbox } : {}),
          });
          if (preFlight.note) {
            preflightControl = {
              kind: "test_warden",
              text: preFlight.note,
            };
          }
          if (preFlight.runnerExecutable) {
            testWardenMap = buildTestMapV1(workspaceRoot);
          }
        } catch {
          // 测试守卫 best-effort；构建失败不阻塞运行。
        }
      }
      for (let turn = startTurn; turn < maxSteps; turn++) {
        let progressControl: EphemeralControlV1 | undefined;
        let testWardenControl: EphemeralControlV1 | undefined;
        // Loop v2.1 §8.3 停滞阶梯：无产品级进展的回合差达到版本化阈值时注入
        // 事实建议（含可并行派发只读调查员的接口事实）。advice-only，不拦截。
        if (this.loopKernelVersion === "v2") {
          const stall = evaluateInvestigationStallV1({
            state: taskState.snapshot(),
            baseline:
              progressBaseline ??
              computeProgressBaselineV1(taskState.snapshot(), turn),
            turn,
            canDelegate: capabilitySet.executableToolNames.includes(
              "workspace.run_agent",
            ),
          });
          progressBaseline = stall.baseline;
          if (stall.message) {
            progressControl = { kind: "progress", text: stall.message };
          }
        }
        // 测试守卫 Layer 2：mutation revision 增长时确定性执行受影响测试
        if (this.loopKernelVersion === "v2" && testWardenMap) {
          const snap = taskState.snapshot();
          const currentRevision = snap.mutationRevision ?? 0;
          if (currentRevision > lastVerifiedRevision) {
            const changed = snap.filesChanged;
            if (changed.length > 0) {
              const wardenResult = verifyImpactedTests({
                workspaceRoot,
                changedFiles: changed,
                ...(this.shellSandbox
                  ? { shellSandbox: this.shellSandbox }
                  : {}),
                testMap: testWardenMap,
              });
              testWardenControl = {
                kind: wardenResult.allPassed ? "status" : "test_warden",
                text: wardenResult.renderedSummary,
              };
            }
            lastVerifiedRevision = currentRevision;
          }
        }
        const jobRecoveryNotices = managedJobs.takeRecoveryNotices();
        if (jobRecoveryNotices.length > 0) {
          ctxMgr.addUser(
            [
              "[Managed job recovery v1]",
              "A previous Paw process ended with background work whose terminal effects were not durably committed. Old PIDs were not reattached because PID identity can be reused. Treat every listed outcome as unknown; inspect the workspace and rerun required verification.",
              ...jobRecoveryNotices.map((notice) => `- ${notice}`),
            ].join("\n"),
          );
          emit({
            type: "job.recovery",
            issue: "managed_job_interrupted_orphaned",
            notices: jobRecoveryNotices,
          });
        }
        // Async producers never mutate loop state from their Promise callback.
        // Pull terminal results into the canonical stream at this exact turn
        // boundary before status/context/completion can observe the run.
        // 后台 shell 结算同样内联 untrusted 退出码标注，保持 journal、
        // job.settled 事件与模型可见消息一致。
        const jobSettlements = managedJobs
          .takeSettlements()
          .map((settlement) => ({
            ...settlement,
            result: annotateVerificationFailureRecords(
              settlement.call,
              annotateUntrustedShellExitSummary(
                settlement.call,
                settlement.result,
              ),
              taskState.snapshot().filesChanged,
            ),
          }));
        if (jobSettlements.length > 0) {
          for (const [sourceIndex, settlement] of jobSettlements.entries()) {
            commitToolExecutionResult(
              settlement.call,
              settlement.result,
              100_000 + sourceIndex,
              {
                emit,
                runId,
                workspaceRoot,
                turn,
                taskState,
                executionEnvironment,
                ...(init.observeLoopV2ToolCommit
                  ? {
                      observeLoopV2ToolCommit: init.observeLoopV2ToolCommit,
                    }
                  : {}),
              },
              {
                concurrentMutation: false,
                mutationCapture: {
                  status: "gap",
                  reason: "unbounded_mutation_surface",
                },
              },
            );
            emit({
              type: "job.settled",
              jobId: settlement.jobId,
              turnStarted: settlement.turn,
              turnCommitted: turn,
              ok: settlement.result.ok,
              summary: settlement.result.summary,
            });
            await this._memoryRuntime
              ?.onToolResult({
                taskId: this._memoryTaskId ?? runId,
                toolName: settlement.call.tool,
                args: settlement.call.args,
                ok: settlement.result.ok,
                summary: settlement.result.summary,
                rawPayload: settlement.result.payload,
                idempotencyKey: `${runId}-job-${settlement.jobId}-settled`,
              })
              .catch(() => undefined);
          }
          ctxMgr.addToolResults(
            jobSettlements.map((settlement) => ({
              tool: settlement.call.tool,
              ok: settlement.result.ok,
              summary: settlement.result.summary,
              payload: settlement.result.payload,
              provenance: observationProvenanceForToolV1(settlement.call.tool),
            })),
          );
          statusTelemetry.observeToolBatch(
            jobSettlements.map((settlement) => settlement.call),
            jobSettlements.map((settlement) => settlement.result),
            0,
          );
          managedJobs.acknowledgeSettlements(
            jobSettlements.map((settlement) => settlement.jobId),
          );
          this.saveState(
            runId,
            spec.goal,
            workspaceRoot,
            turn,
            maxSteps,
            ctxMgr,
            planner,
            taskState,
            undefined,
            flags,
          );
        }
        if (
          flags.pendingControl?.kind === "completion_gate" &&
          flags.pendingControl.gate === "managed_jobs" &&
          !managedJobs.readiness().blocksCompletion
        ) {
          const { pendingControl: _settledJobControl, ...settledFlags } = flags;
          flags = settledFlags;
          activeTurnFlags = flags;
          this.saveState(
            runId,
            spec.goal,
            workspaceRoot,
            turn,
            maxSteps,
            ctxMgr,
            planner,
            taskState,
            undefined,
            flags,
          );
        }

        // 检查外部 abort 信号（用户中断、超时等）
        if (signal?.aborted) {
          await agentGroup?.cancelAll();
          const message = "Run aborted.";
          this.saveState(
            runId,
            spec.goal,
            workspaceRoot,
            turn,
            maxSteps,
            ctxMgr,
            planner,
            taskState,
            {
              status: "aborted",
              message,
            },
            flags,
          );
          const runResult = { runId, status: "aborted", message } as const;
          persistLoopV2Terminal(runResult);
          emit({ type: "run.completed", status: "aborted", message });
          emitRunMetrics();
          return runResult;
        }

        // 构造当前轮次的上下文对象（PhaseContext）
        // PhaseContext 包含这一轮需要的所有信息，传递给 executeTurn
        const phaseCtx: PhaseContext = {
          runId,
          loopKernelVersion: this.loopKernelVersion,
          workspaceRoot,
          turn,
          maxSteps,
          signal,
          model,
          mcp,
          toolDefs,
          toolNameMap,
          capabilitySet,
          ctxMgr,
          planner,
          taskState,
          statusTelemetry,
          executionEnvironment,
          managedJobs,
          capabilityExposure,
          emit,
          checkpointSeq,
          specGoal: spec.goal,
          shellSandbox,
          ...(this._payloadDeduper
            ? { payloadDeduper: this._payloadDeduper }
            : {}),
          ...(init.artifactRegistry
            ? { artifactRegistry: init.artifactRegistry }
            : {}),
          ...(this._memoryRuntime
            ? { memoryRuntime: this._memoryRuntime }
            : {}),
          ...(this._memoryTaskId ? { memoryTaskId: this._memoryTaskId } : {}),
          ...(this.verificationPolicy
            ? { verificationPolicy: this.verificationPolicy }
            : {}),
          ...(this.candidateReviewer
            ? { candidateReviewer: this.candidateReviewer }
            : {}),
          ...(this.loopKernelVersion === "v2"
            ? {
                getLoopV2CandidateAssessment: () =>
                  this._lastLoopV2CandidateAssessment,
                getLoopV2ReadinessProgressKey: () =>
                  this._lastLoopV2ReadinessProgressKey,
                getLoopV2ReadinessVerificationRecords: () =>
                  this._lastLoopV2ReadinessVerificationRecords,
                ...(init.getLoopV2ControlReduction
                  ? {
                      getLoopV2ControlReduction: init.getLoopV2ControlReduction,
                    }
                  : {}),
              }
            : {}),
          ...(init.reviewLoopV2Candidate
            ? { reviewLoopV2Candidate: init.reviewLoopV2Candidate }
            : {}),
          ...(init.probeLoopV2Candidate
            ? { probeLoopV2Candidate: init.probeLoopV2Candidate }
            : {}),
          ...(init.observeLoopV2ToolCommit
            ? { observeLoopV2ToolCommit: init.observeLoopV2ToolCommit }
            : {}),
        };

        const turnControl = selectEphemeralControlV1([
          flags.pendingControl,
          testWardenControl,
          preflightControl,
          progressControl,
        ]);
        preflightControl = undefined;

        // 执行一轮
        const state = await this.executeTurn(
          phaseCtx,
          flags,
          agentGroup,
          turnCompactor,
          turnSessionMemoryStore,
          (checkpointedFlags) => {
            activeTurnFlags = checkpointedFlags;
            activeTurnCursor = phaseCtx.turn + 1;
          },
          turnControl,
        );
        activeTurnCursor = turn + 1;

        // 状态机判断：
        // - "continue"：模型返回了工具调用，继续下一轮
        // - "decided"：CompletionPolicy 已给出唯一终局裁决
        if (state.type === "continue") {
          flags = state.nextFlags;
          activeTurnFlags = flags;
          continue;
        }

        if (state.type === "decided") {
          flags = state.nextFlags ?? flags;
          activeTurnFlags = flags;
          const terminalStatus = state.decision.status;
          const terminalMessage = state.decision.message;
          const waitingUser = state.decision.reason === "user_input_required";
          // 保存断点续跑状态
          const appStatus =
            terminalStatus === "aborted" ? ("failed" as const) : terminalStatus;
          this.saveState(
            runId,
            spec.goal,
            workspaceRoot,
            turn + 1,
            maxSteps,
            ctxMgr,
            planner,
            taskState,
            waitingUser
              ? undefined
              : {
                  status: appStatus,
                  message: terminalMessage,
                },
            flags,
          );
          const { runResultFromDecision } = await import(
            "./lifecycle/task-lifecycle.js"
          );
          const runResult = runResultFromDecision(runId, state.decision);

          if (!waitingUser) persistLoopV2Terminal(runResult);
          if (waitingUser && this._interactionState) {
            emit({
              type: "run.paused",
              reason: "waiting_user",
              requestId: this._interactionState.requestId,
              question: this._interactionState.question,
            });
            // A pause ends this execution segment even though it does not end
            // the logical run. Emit the segment metrics so latency/cost are not
            // silently lost across a durable resume boundary.
            emitRunMetrics();
          } else {
            emit({
              type: "run.completed",
              status: runResult.status,
              message: runResult.message,
            });
            emitRunMetrics();
          }

          if (
            this._memoryRuntime &&
            this._memoryTaskId &&
            !this._deferMemoryComplete &&
            !waitingUser
          ) {
            try {
              const writeResult = await this._memoryRuntime.completeTask({
                taskId: this._memoryTaskId,
                status:
                  runResult.status === "completed" ? "completed" : "failed",
                finalMessage: runResult.message,
                outcome: memoryOutcomeFromDecision(
                  state.decision,
                  taskState.snapshot(),
                ),
              });
              emit({
                type: "memory.extracted",
                runId,
                entries: writeResult.candidates,
                rejected: writeResult.rejected + writeResult.pendingReview,
              });
            } catch {
              /* best-effort */
            }
          }
          return runResult;
        }
      }

      // 循环耗尽：maxSteps 轮后仍未得到 final 动作 → incomplete（禁止 soft-complete 造假）
      const lastAssistant = [...ctxMgr.buildMessages()]
        .reverse()
        .find((m) => m.role === "assistant" && m.content.trim().length > 0);
      const openRepair =
        this.loopKernelVersion === "v2"
          ? init.getLoopV2ControlReduction?.()?.state.openRepairObligation
          : undefined;
      const softMessage = openRepair
        ? `${formatRepairObligationV1(openRepair)}\nThe run exhausted its model-turn budget before satisfying this obligation.`
        : lastAssistant?.content.trim() ||
          "internal: model loop exhausted without return";
      const { evaluateBudgetExhaustion, runResultFromDecision } = await import(
        "./lifecycle/task-lifecycle.js"
      );
      const decision = evaluateBudgetExhaustion(
        softMessage,
        taskState.snapshot(),
        "budget_exhausted",
      );
      const runResult = runResultFromDecision(runId, decision);
      this.saveState(
        runId,
        spec.goal,
        workspaceRoot,
        maxSteps,
        maxSteps,
        ctxMgr,
        planner,
        taskState,
        { status: "incomplete", message: runResult.message },
        flags,
      );
      persistLoopV2Terminal(runResult);
      emit({
        type: "run.completed",
        status: "incomplete",
        message: runResult.message,
      });
      emitRunMetrics?.();
      if (
        this._memoryRuntime &&
        this._memoryTaskId &&
        !this._deferMemoryComplete
      ) {
        try {
          const writeResult = await this._memoryRuntime.completeTask({
            taskId: this._memoryTaskId,
            status: "failed",
            finalMessage: runResult.message,
            outcome: memoryOutcomeFromDecision(decision, taskState.snapshot()),
          });
          emit({
            type: "memory.extracted",
            runId,
            entries: writeResult.candidates,
            rejected: writeResult.rejected + writeResult.pendingReview,
          });
        } catch {
          /* best-effort */
        }
      }
      return runResult;
    } catch (e) {
      // 异常安全：即使初始化未完成（init 为 undefined），也返回合理的错误
      const aborted = e instanceof Error && e.name === "AbortError";
      const message =
        e instanceof Error ? (aborted ? "Run aborted." : e.message) : String(e);
      const status = aborted ? "aborted" : "failed";
      if (init) {
        const {
          runId,
          workspaceRoot,
          maxSteps,
          startTurn,
          ctxMgr,
          planner,
          taskState,
          emit,
        } = init;
        this.saveState(
          runId,
          spec.goal,
          workspaceRoot,
          activeTurnCursor ??
            activeTurnFlags?.providerTerminal?.lastTurn ??
            startTurn,
          maxSteps,
          ctxMgr,
          planner,
          taskState,
          {
            status,
            message,
          },
          activeTurnFlags,
        );
        const decision = decideCompletion({
          intent: aborted ? "abort" : "error",
          message,
          taskState: taskState.snapshot(),
          hasEverUsedTools: taskState.snapshot().commandsRun.length > 0,
        });
        const { runResultFromDecision } = await import(
          "./lifecycle/task-lifecycle.js"
        );
        const runResult = runResultFromDecision(runId, decision);
        persistLoopV2Terminal?.(runResult);
        if (!aborted) {
          emit({ type: "run.failed", message });
        }
        emit({ type: "run.completed", status, message });
        emitRunMetrics?.();
        if (
          this._memoryRuntime &&
          this._memoryTaskId &&
          !this._deferMemoryComplete
        ) {
          try {
            const writeResult = await this._memoryRuntime.completeTask({
              taskId: this._memoryTaskId,
              status: "failed",
              finalMessage: runResult.message,
              outcome: memoryOutcomeFromDecision(
                decision,
                taskState.snapshot(),
              ),
            });
            emit({
              type: "memory.extracted",
              runId,
              entries: writeResult.candidates,
              rejected: writeResult.rejected + writeResult.pendingReview,
            });
          } catch {
            /* best-effort */
          }
        }
        return runResult;
      }
      return { runId: spec.runId, status, message };
    } finally {
      // Run ownership is the lifetime boundary for all background processes.
      // close() requests full-tree termination and bounds noncompliant work.
      const managedJobs = this._managedJobs;
      this._managedJobs = undefined;
      await managedJobs?.close().catch(() => {});
      // 无论如何都要断开 MCP 连接（避免资源泄漏）
      await init?.mcp?.disconnectAll();
      // A run owns one scoped MemoryRuntime reference. Always release it;
      // otherwise temporary workspaces accumulate independent DB workers.
      const memoryRuntime = this._memoryRuntime;
      this._memoryRuntime = null;
      this._memoryTaskId = null;
      await memoryRuntime?.shutdown().catch(() => {});
    }
  }

  // ─────────────────────────────────────────────────────────
  // 每轮辅助方法
  // ─────────────────────────────────────────────────────────

  /**
   * 报告自上一轮以来被外部修改的文件。
   *
   * 为什么需要这个？
   * Agent 可能在操作文件时，用户用其他编辑器修改了同一文件。
   * 如果不告知 Agent，它可能基于过时的文件内容做出错误判断。
   *
   * 过滤逻辑：忽略 node_modules、.git 等目录的变更（这些都是噪音）。
   */
  private maybeReportStaleFiles(ctx: PhaseContext): void {
    const { ctxMgr } = ctx;
    const staleFiles = (this.watcher?.takeExternallyModified() ?? []).filter(
      (f) =>
        ![...AgentOrchestrator.STALE_IGNORE_DIRS].some(
          (ign) =>
            f.includes(`/${ign}/`) || f.startsWith(`${ign}/`) || f === ign,
        ),
    );
    if (staleFiles.length === 0) return;

    const shown = staleFiles.slice(0, AgentOrchestrator.MAX_STALE_FILES);
    const suffix =
      staleFiles.length > AgentOrchestrator.MAX_STALE_FILES
        ? `\n... and ${staleFiles.length - AgentOrchestrator.MAX_STALE_FILES} more`
        : "";
    // 以 user 消息的形式注入到上下文中，模型会像看到用户提示一样处理
    ctxMgr.addUser(
      `Note: the following file(s) were modified externally since the last turn and may be stale:\n${shown.map((f) => `- ${f}`).join("\n")}${suffix}`,
    );
  }

  /**
   * 调用模型并解析返回的工具调用。
   *
   * 双通道策略：
   * 1. 原生 Function Calling（NativeToolCall）：模型直接返回结构化的工具调用
   * 2. 文本解析回退：从模型输出的文本中提取 <tool_call> XML 标签
   *
   * 为什么需要回退？
   * - 一些模型（如通过 Ollama 运行的本地模型）不支持原生 function calling
   * - 即使支持，某些场景下模型可能混合使用文本和原生调用
   *
   * 文本 fallback 保持解析器自己的去重；原生调用按 provider call id 保留。
   */
  private async callModelAndParseActions(
    ctx: PhaseContext,
    toolDefs: readonly import("@paw/models").ToolDefinition[],
    toolNameMap: Map<string, string>,
    hostState: HostStateV1,
    control?: EphemeralControlV1,
  ): Promise<{
    text: string;
    thinking: string | undefined;
    toolCalls: AgentToolCallAction[];
    singleAction: import("@paw/core").AgentAction | null;
    reasoningText: string;
    /** Provider-visible assistant text for a native tool-call turn. */
    nativeAssistantContent?: string;
    /** Complete provider-native call batch, retained separately from actions. */
    nativeToolTurn?: {
      readonly assistantContent: string;
      readonly reasoningPassback?: string;
      readonly calls: readonly import("@paw/core").NativeToolTurnCallV1[];
    };
    finishReason?: string;
    /** 解析诊断：无 action 时描述「为什么无法解析」（供格式反馈回灌） */
    diagnosis: ParseDiagnosis;
    /** 原生通道解析失败的调用（拒绝执行，需回灌给模型） */
    nativeToolErrors?: readonly NativeToolError[];
  }> {
    const { model, ctxMgr, signal, emit } = ctx;

    // Assemble exactly once: eval capture and the provider must observe the
    // same request. Later P0.3 slices add typed host/control projections here.
    const requestMessages = assembleModelContextV1({
      durable: { messages: ctxMgr.buildMessages() },
      hostState,
      ...(control ? { control } : {}),
    });

    // 评估钩子：模型调用前记录 messages（用于训练数据收集）
    this.evalHooks?.beforeModelCall?.({
      messages: requestMessages,
      contextManager: ctxMgr,
    });
    const modelCallStart = Date.now();

    // 核心：调用模型（带熔断和重试）
    const {
      text,
      thinking,
      reasoningPassback,
      nativeToolCalls,
      nativeToolErrors: invokeNativeErrors,
      nativeAssistantContent,
      finishReason,
    } = await this.invokeModel(
      model,
      requestMessages,
      signal,
      emit,
      toolDefs,
      toolNameMap,
      ctx.loopKernelVersion !== "v2",
    );

    emit({ type: "phase", name: "parse" });

    // 单一 capability authority：只接受模型实际可见/可执行工具的
    // sanitized/original 名称。内部工具即使通过文本 JSON 猜出也不会进入动作。
    const knownTools = ctx.capabilitySet.knownToolNames;

    let toolCalls: AgentToolCallAction[];
    let reasoningText: string;
    let nativeErrors: NativeToolError[] | undefined;
    let nativeTurnCalls:
      | readonly import("@paw/core").NativeToolTurnCallV1[]
      | undefined;

    // 通道 1：原生 tool_use → 直接映射为 AgentToolCallAction
    if (
      (nativeToolCalls && nativeToolCalls.length > 0) ||
      (invokeNativeErrors && invokeNativeErrors.length > 0)
    ) {
      const mapped: AgentToolCallAction[] = [];
      const errors: NativeToolError[] = [];
      const entries = [
        ...(nativeToolCalls ?? []).map((call, fallbackIndex) => ({
          sourceIndex: call.sourceIndex ?? fallbackIndex,
          call,
        })),
        ...(invokeNativeErrors ?? []).map((error, fallbackIndex) => ({
          sourceIndex:
            error.sourceIndex ?? (nativeToolCalls?.length ?? 0) + fallbackIndex,
          error,
        })),
      ].sort((left, right) => left.sourceIndex - right.sourceIndex);
      const rawTurnCalls = entries.map((entry) =>
        "call" in entry
          ? {
              callId: entry.call.id,
              providerName: entry.call.name,
              rawArguments:
                entry.call.rawArguments ?? JSON.stringify(entry.call.arguments),
            }
          : {
              callId: entry.error.id,
              providerName: entry.error.name,
              rawArguments: entry.error.raw,
            },
      );
      const uniqueIds = new Set(rawTurnCalls.map((call) => call.callId));
      const nativeIdentityValid =
        rawTurnCalls.every(
          (call) =>
            call.callId.trim().length > 0 &&
            call.providerName.trim().length > 0,
        ) && uniqueIds.size === rawTurnCalls.length;
      if (nativeIdentityValid) {
        nativeTurnCalls = rawTurnCalls;
      }
      for (const entry of entries) {
        if ("error" in entry) {
          errors.push(entry.error);
          continue;
        }
        const tc = entry.call;
        // 将 sanitized 工具名还原为原始名（如 "Bash" → "Bash(git *)"）
        const originalName = toolNameMap.get(tc.name) ?? tc.name;
        if (!tc.id) {
          errors.push({
            id: tc.id,
            name: originalName,
            raw: tc.rawArguments ?? JSON.stringify(tc.arguments),
            sourceIndex: entry.sourceIndex,
            reason: "invalid_call_id",
          });
          continue;
        }
        if (tc.argumentsValid === false) {
          errors.push({
            id: tc.id,
            name: originalName,
            raw: tc.rawArguments ?? "",
            sourceIndex: entry.sourceIndex,
            reason: "malformed_arguments",
          });
          continue;
        }
        if (!knownTools.has(originalName)) {
          // 未知工具名：原生调用不是文本误匹配，静默丢弃会让模型重复犯错
          // → 拒绝执行并回灌「工具不存在 + 可用列表」（参考 OpenHands 做法）
          errors.push({
            id: tc.id,
            name: originalName,
            raw: tc.rawArguments ?? JSON.stringify(tc.arguments),
            sourceIndex: entry.sourceIndex,
            reason: "unknown_tool",
          });
          continue;
        }
        mapped.push({
          type: "tool_call" as const,
          tool: originalName,
          // 字段级畸形修复：JSON 字符串编码的数组/对象按 schema 解码（GLM 等）
          args: fixMalformedToolArguments(tc.arguments, originalName, toolDefs),
        });
      }
      // Native call ids are protocol identities. Do not collapse parallel
      // calls merely because their tool name and arguments are identical.
      if (!nativeIdentityValid) {
        nativeErrors = rawTurnCalls.map((call, sourceIndex) => ({
          id: call.callId,
          name: call.providerName,
          raw: call.rawArguments,
          sourceIndex,
          reason: "invalid_call_id" as const,
        }));
        toolCalls = [];
      } else if (errors.length > 0) {
        const errorsById = new Map(errors.map((error) => [error.id, error]));
        nativeErrors = rawTurnCalls.map(
          (call, sourceIndex) =>
            errorsById.get(call.callId) ?? {
              id: call.callId,
              name: call.providerName,
              raw: call.rawArguments,
              sourceIndex,
              reason: "batch_rejected" as const,
            },
        );
        toolCalls = [];
      } else {
        toolCalls = mapped;
      }
      reasoningText = nativeAssistantContent ?? text;
    } else {
      // 通道 2：文本解析 → 从模型输出中提取工具调用
      const parsed = parseAgentActionsFromModelText(text, { knownTools });
      // 文本通道的 args 同样可能携带 GLM 式畸形（数组被编码成字符串）
      toolCalls = parsed.actions.map((c) => ({
        ...c,
        args: fixMalformedToolArguments(c.args, c.tool, toolDefs),
      }));
      reasoningText = parsed.text;
    }

    // 如果没有提取到工具调用，尝试解析单个 action（可能是 final/ask_user/abort）
    const parsedSingleAction =
      toolCalls.length === 0
        ? parseAgentActionFromModelText(text, { knownTools })
        : null;
    const singleAction =
      parsedSingleAction &&
      parsedSingleAction.type !== "tool_call" &&
      ctx.capabilitySet.modelActions.includes(
        `action.${parsedSingleAction.type}`,
      )
        ? parsedSingleAction
        : null;

    // 解析诊断：无任何 action 时，描述「为什么解析失败」供格式反馈使用
    const diagnosis: ParseDiagnosis =
      toolCalls.length === 0 && !singleAction
        ? diagnoseParseFailure(text, { knownTools })
        : { kind: "ok" };

    // 评估钩子：模型调用后记录响应（延迟、工具调用等）
    this.evalHooks?.afterModelCall?.({
      turnIndex: ctx.turn,
      responseText: text,
      thinking,
      toolCalls:
        toolCalls.length > 0
          ? toolCalls.map((tc) => ({ tool: tc.tool, args: tc.args }))
          : undefined,
      usage: undefined,
      latencyMs: Date.now() - modelCallStart,
    });

    return {
      text,
      thinking,
      toolCalls,
      singleAction,
      reasoningText,
      diagnosis,
      ...(nativeAssistantContent !== undefined
        ? { nativeAssistantContent }
        : {}),
      ...(model.runtimeProfile?.protocol === "openai-compatible" &&
      nativeTurnCalls &&
      nativeTurnCalls.length > 0
        ? {
            nativeToolTurn: {
              assistantContent: nativeAssistantContent ?? "",
              ...(reasoningPassback !== undefined ? { reasoningPassback } : {}),
              calls: nativeTurnCalls,
            },
          }
        : {}),
      ...(finishReason !== undefined ? { finishReason } : {}),
      ...(nativeErrors ? { nativeToolErrors: nativeErrors } : {}),
    };
  }

  /**
   * L2 上下文压缩：自动压缩历史对话。
   *
   * 触发条件（全部满足）：
   * 1. shouldCompactHistory() 判断历史 token 超过阈值
   * 2. 不在压缩冷却期（compactCooldownTurns === 0）
   * 3. 压缩器未被禁用
   * 4. 压缩器未处于 thrashing 状态（频繁压缩但收益低）
   *
   * 压缩流程：
   * 1. determineBoundaries()：确定 head（保留）/ middle（压缩）/ tail（保留）
   * 2. 用辅助模型对 middle 段生成摘要
   * 3. validateCompressionSummary()：验证摘要质量
   * 4. 收益检查：节省需在 20-80% 区间（<20% 历史已紧凑→退避；>80% 摘要丢失过多→熔断计数）
   * 5. 替换历史消息：head + summary + tail
   *
   * 面试要点：这是解决 LLM 长对话上下文爆炸的核心机制。
   * 三层压缩中，L2 是唯一需要 LLM 参与的，也是最关键的一层。
   */
  private async maybeCompactHistory(
    ctx: PhaseContext,
    compactor: ContextCompactor,
    sessionMemoryStore: SessionMemoryStore,
    budgetSnapshot: ContextBudgetSnapshot,
    force = false,
  ): Promise<void> {
    const { runId, workspaceRoot, signal, model, ctxMgr, emit } = ctx;
    const historyTokensBeforeCompact = budgetSnapshot.historyUsed;
    const auxModel = this.auxiliaryModel ?? model;

    // 低收益退避对 force（P5.1 侧信道）同样生效：退避意味着"刚试过、
    // 历史已紧凑没啥可压"，强制触发只会再烧一次辅助模型调用
    if (compactor.shouldBackoffForLowSavings(budgetSnapshot.historyUsed)) {
      return;
    }

    // 检查是否应该跳过压缩（force = P5.1 侧信道触发，跳过预算阈值）
    if (
      !force &&
      (!shouldCompactHistory(budgetSnapshot) ||
        this.compactCooldownTurns > 0 ||
        compactor.isDisabled)
    ) {
      return;
    }

    emit({
      type: "compression.auto_compact.started",
      beforeTokens: historyTokensBeforeCompact,
    });

    try {
      const messages = ctxMgr.buildMessages();
      // 确定三段边界：head（开头保留）、middle（待压缩）、tail（结尾保留）
      const boundaries = compactor.determineBoundaries(messages);

      // 剥离已有的摘要前缀，避免摘要套摘要
      const headMessages = stripContextSummaryMessages(
        messages.slice(0, boundaries.headEnd + 1),
      );
      // v3 P2.2：pinned 消息按原文保留在摘要前（内容驱动保护，
      // 约束/需求变更/关键决策绝不进 middle 摘要）
      const pinnedMessages = boundaries.pinned
        .map((i) => messages[i])
        .filter((m): m is NonNullable<typeof m> => m !== undefined);
      const middleMessages = stripContextSummaryMessages(
        messages.slice(boundaries.headEnd + 1, boundaries.tailStart),
      ).filter(
        (_m, i) => !boundaries.pinned.includes(boundaries.headEnd + 1 + i),
      );
      const tailMessages = stripContextSummaryMessages(
        messages.slice(boundaries.tailStart),
      );

      // 没有中间段就不需要压缩
      if (middleMessages.length === 0) {
        emit({
          type: "compression.skipped",
          reason: "no middle segment to compact",
          beforeTokens: historyTokensBeforeCompact,
          afterTokens: historyTokensBeforeCompact,
        });
        return;
      }

      // 加载已有的会话记忆作为压缩的上下文参考
      const existing = sessionMemoryStore.load(runId);
      const prompt = compactor.buildSummaryPrompt(
        middleMessages,
        existing ? sessionMemoryStore.toMarkdown(existing) : null,
      );

      // 调用辅助模型生成压缩摘要
      const compressionTimeout = AbortSignal.timeout(
        AgentOrchestrator.COMPRESSION_MODEL_TIMEOUT_MS,
      );
      const compressionSignal = signal
        ? AbortSignal.any([signal, compressionTimeout])
        : compressionTimeout;
      const { summary, sessionMemory } = await runCompressionAgent(
        auxModel,
        prompt,
        runId,
        compressionSignal,
      );

      // 验证摘要质量（v3 三层门控：规则层 + 实体层）
      // 约束生命周期：只要求「当前有效（active）且位于 middle」的约束逐字存活——
      // head/tail 里的约束原文保留，不依赖摘要承载（e2e 实测修复：
      // 之前要求全部 active 约束进摘要，goal 顶部的格式指令会卡死压缩）；
      // 被反转/撤销/过期的约束不参与校验
      const middleText = middleMessages.map((m) => m.content).join("\n");
      const requiredConstraints = ctx.taskState
        .activeConstraints()
        .filter((c) => c.text.length > 0 && middleText.includes(c.text))
        .map((c) => c.text);
      const quality = validateCompressionSummary(summary, {
        originalMessages: middleMessages,
        ...(requiredConstraints.length > 0 ? { requiredConstraints } : {}),
      });
      if (!quality.ok) {
        compactor.recordFailure("quality");
        emit({
          type: "compression.skipped",
          reason: `summary quality: ${quality.reason}`,
        });
        return;
      }

      // 构建新的消息列表：head + 摘要 + tail
      const summaryMsg: ChatMessage = {
        role: "user",
        content: `${CONTEXT_SUMMARY_PREFIX}\n${summary}`,
      };
      const newMessages = [
        ...headMessages,
        ...pinnedMessages,
        summaryMsg,
        ...tailMessages,
      ];
      const newHistory = newMessages.filter((m) => m.role !== "system");
      const afterHistoryTokens = ctxMgr.estimator.countMessages(newHistory);

      // 检查压缩收益：节省需在 20-80% 区间
      // <20%：历史已紧凑（良性）→ 低收益退避，不累计熔断
      // >80%：摘要丢失过多（质量故障）→ 累计熔断
      const savingsRatio = compressionSavingsRatio(
        historyTokensBeforeCompact,
        afterHistoryTokens,
      );
      if (
        savingsRatio < MIN_COMPRESSION_SAVINGS_RATIO ||
        savingsRatio > MAX_COMPRESSION_SAVINGS_RATIO
      ) {
        const pct = (savingsRatio * 100).toFixed(1);
        if (savingsRatio < MIN_COMPRESSION_SAVINGS_RATIO) {
          compactor.recordLowSavings(historyTokensBeforeCompact);
          emit({
            type: "compression.skipped",
            reason: `savings too low (${pct}%, min 20%) — history already compact`,
            beforeTokens: historyTokensBeforeCompact,
            afterTokens: afterHistoryTokens,
          });
        } else {
          compactor.recordFailure("over_compression");
          emit({
            type: "compression.skipped",
            reason: `savings too high (${pct}%, max 80%) — summary dropped too much`,
            beforeTokens: historyTokensBeforeCompact,
            afterTokens: afterHistoryTokens,
          });
        }
        return;
      }

      // 应用压缩结果
      ctxMgr.replaceHistory(newMessages);
      const memoryToSave = {
        ...sessionMemory,
        project: path.basename(workspaceRoot),
      };
      sessionMemoryStore.save(runId, memoryToSave);
      // P4.4 压缩版本化：每次压缩 = 一次 commit（快照落盘，可回滚）
      try {
        this._compactionCommitSeq += 1;
        const snapshotPath = saveCompactionCommit({
          workspaceRoot,
          runId,
          commit: {
            n: this._compactionCommitSeq,
            ts: Date.now(),
            reason: "auto_compact",
            beforeMessages: messages.filter((m) => m.role !== "system"),
            afterMessages: newHistory,
            summary,
            beforeTokens: historyTokensBeforeCompact,
            afterTokens: afterHistoryTokens,
          },
        });
        emit({
          type: "compression.commit",
          commit: this._compactionCommitSeq,
          snapshotPath,
          beforeTokens: historyTokensBeforeCompact,
          afterTokens: afterHistoryTokens,
        });
      } catch {
        /* best-effort：快照失败不影响压缩本身 */
      }
      emit({
        type: "compression.auto_compact.done",
        afterTokens: ctxMgr.historyEstimatedTokens,
        summaryTokens: Math.ceil(summary.length / 4),
      });
      compactor.recordSuccess();

      // T3 post_compact（v2）：压缩后触发语义检索注入（spec §6.1）
      // 复用 SessionMemory 的 Key Decisions/constraints 做去重提示
      if (this._memoryRuntime && this._memoryTaskId) {
        try {
          const injected = await this._memoryRuntime.retrievePostCompact?.({
            taskId: this._memoryTaskId,
            summaryHead: summary.split("\n")[0] ?? "",
            goal: ctx.specGoal,
            existingContextHints: [
              ...(sessionMemory.keyDecisions ?? []),
              ...(sessionMemory.constraints ?? []),
            ],
          });
          if (this._memoryLatestHint?.kind !== "action_failed") {
            this._memoryLatestHint = injected?.injected
              ? createMemoryHintCheckpointV1("post_compact", injected.injected)
              : undefined;
          }
        } catch {
          /* best-effort：T3 检索失败不影响压缩结果 */
        }
      }

      // P2.7 行为闭环：记录压缩时已读文件/已跑命令快照，
      // 之后 5 轮内重复获取 → 摘要质量低信号
      const snap = ctx.taskState.snapshot();
      this._qualityWindowTurn =
        ctx.turn + AgentOrchestrator.COMPACTION_QUALITY_WINDOW_TURNS;
      this._qualityCompactTurn = ctx.turn;
      this._qualityFiles = new Set(snap.filesRead);
      this._qualityCommands = new Set(snap.commandsRun.map((c) => c.command));
      this._qualityReported = false;

      // 设置冷却期：避免连续压缩
      this.compactCooldownTurns = AgentOrchestrator.COMPACT_COOLDOWN_TURNS;
    } catch (err) {
      compactor.recordFailure("error");
      emit({
        type: "compression.skipped",
        reason: `compaction failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  /**
   * 恢复时专用 L2 压缩：与 maybeCompactHistory 共享核心逻辑，
   * 但去掉冷却期和 thrashing 检查——恢复是一次性的，不需要这些保护。
   *
   * 流程：确定三段边界 → 剥离已有摘要 → 辅助模型生成摘要 →
   * 验证质量 → 检查收益 → 替换历史 + 提取亮点到永久记忆。
   */
  private async compactHistoryOnResume(
    ctxMgr: ContextManager,
    compactor: ContextCompactor,
    sessionMemoryStore: SessionMemoryStore,
    workspaceRoot: string,
    runId: string,
    signal: AbortSignal | undefined,
    emit: (event: RunEvent) => void,
  ): Promise<void> {
    const beforeTokens = ctxMgr.historyEstimatedTokens;

    emit({
      type: "compression.auto_compact.started",
      beforeTokens,
    });

    try {
      const messages = ctxMgr.buildMessages();
      const boundaries = compactor.determineBoundaries(messages);
      const headMessages = stripContextSummaryMessages(
        messages.slice(0, boundaries.headEnd + 1),
      );
      // v3 P2.2：pinned 消息按原文保留（恢复路径同样适用）
      const pinnedMessages = boundaries.pinned
        .map((i) => messages[i])
        .filter((m): m is NonNullable<typeof m> => m !== undefined);
      const middleMessages = stripContextSummaryMessages(
        messages.slice(boundaries.headEnd + 1, boundaries.tailStart),
      ).filter(
        (_m, i) => !boundaries.pinned.includes(boundaries.headEnd + 1 + i),
      );
      const tailMessages = stripContextSummaryMessages(
        messages.slice(boundaries.tailStart),
      );

      if (middleMessages.length === 0) {
        emit({
          type: "compression.skipped",
          reason: "no middle segment to compact after prune",
        });
        return;
      }

      const auxModel = this.auxiliaryModel!;
      const existing = sessionMemoryStore.load(runId);
      const prompt = compactor.buildSummaryPrompt(
        middleMessages,
        existing ? sessionMemoryStore.toMarkdown(existing) : null,
      );

      const { summary, sessionMemory } = await runCompressionAgent(
        auxModel,
        prompt,
        runId,
        signal,
      );

      const quality = validateCompressionSummary(summary);
      if (!quality.ok) {
        emit({
          type: "compression.skipped",
          reason: `summary quality: ${quality.reason}`,
        });
        return;
      }

      const remainingWork = sessionMemory.relevantContext
        ? `\n\n[Remaining Work]\n${sessionMemory.relevantContext}`
        : "";
      const summaryMsg: ChatMessage = {
        role: "user",
        content: `${CONTEXT_SUMMARY_PREFIX}\n${summary}${remainingWork}`,
      };
      const newMessages = [
        ...headMessages,
        ...pinnedMessages,
        summaryMsg,
        ...tailMessages,
      ];
      const afterTokens = ctxMgr.estimator.countMessages(
        newMessages.filter((m) => m.role !== "system"),
      );

      // 收益检查：与主路径同一口径（20-80% 区间，低收益退避 / 过度压缩熔断）
      const savingsRatio = compressionSavingsRatio(beforeTokens, afterTokens);
      if (
        savingsRatio < MIN_COMPRESSION_SAVINGS_RATIO ||
        savingsRatio > MAX_COMPRESSION_SAVINGS_RATIO
      ) {
        const pct = (savingsRatio * 100).toFixed(1);
        if (savingsRatio < MIN_COMPRESSION_SAVINGS_RATIO) {
          compactor.recordLowSavings(beforeTokens);
          emit({
            type: "compression.skipped",
            reason: `savings too low (${pct}%, min 20%) — history already compact`,
          });
        } else {
          compactor.recordFailure("over_compression");
          emit({
            type: "compression.skipped",
            reason: `savings too high (${pct}%, max 80%) — summary dropped too much`,
          });
        }
        return;
      }

      ctxMgr.replaceHistory(newMessages);
      sessionMemoryStore.save(runId, {
        ...sessionMemory,
        project: path.basename(workspaceRoot),
      });

      // P4.4 压缩版本化：恢复路径同样产生 commit
      try {
        this._compactionCommitSeq += 1;
        const snapshotPath = saveCompactionCommit({
          workspaceRoot,
          runId,
          commit: {
            n: this._compactionCommitSeq,
            ts: Date.now(),
            reason: "resume",
            beforeMessages: messages.filter((m) => m.role !== "system"),
            afterMessages: newMessages.filter((m) => m.role !== "system"),
            summary,
            beforeTokens,
            afterTokens,
          },
        });
        emit({
          type: "compression.commit",
          commit: this._compactionCommitSeq,
          snapshotPath,
          beforeTokens,
          afterTokens,
        });
      } catch {
        /* best-effort */
      }

      emit({
        type: "compression.auto_compact.done",
        afterTokens: ctxMgr.historyEstimatedTokens,
        summaryTokens: Math.ceil(summary.length / 4),
      });
      compactor.recordSuccess();

      // T3 post_compact（v2）：恢复路径同样触发语义检索注入
      if (this._memoryRuntime && this._memoryTaskId) {
        try {
          const injected = await this._memoryRuntime.retrievePostCompact?.({
            taskId: this._memoryTaskId,
            summaryHead: summary.split("\n")[0] ?? "",
            goal: this._lastDynamicMemoryGoal || "",
            existingContextHints: [
              ...(sessionMemory.keyDecisions ?? []),
              ...(sessionMemory.constraints ?? []),
            ],
          });
          if (this._memoryLatestHint?.kind !== "action_failed") {
            this._memoryLatestHint = injected?.injected
              ? createMemoryHintCheckpointV1("post_compact", injected.injected)
              : undefined;
          }
        } catch {
          /* best-effort：T3 检索失败不影响压缩结果 */
        }
      }
    } catch (err) {
      compactor.recordFailure("error");
      emit({
        type: "compression.skipped",
        reason: `compact failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // ─────────────────────────────────────────────────────────
  // executeTurn：单轮执行（状态机驱动）
  // ─────────────────────────────────────────────────────────

  /**
   * 执行一轮完整的 ReAct 循环。
   *
   * 每轮的流程：
   * 1. 报告外部文件变更（maybeReportStaleFiles）
   * 2. L1 裁剪（prune）：持久化超大的工具输出，驱逐旧轮次
   * 3. 上下文预算检查 → 可能触发 L2 压缩（maybeCompactHistory）
   * 4. 注入 max-steps 警告（剩余 3 轮时提示模型加快速度）
   * 5. 调用模型 + 解析动作（callModelAndParseActions）
   * 6. 分发动作（handleAction）：根据动作类型执行对应的处理器
   *
   * 返回值 TurnState：
   * - { type: "continue", nextFlags }：继续下一轮
   * - { type: "decided", decision }：CompletionPolicy 给出的唯一终局裁决
   */
  private async executeTurn(
    ctx: PhaseContext,
    flags: TurnFlags,
    agentGroup: AgentGroup | undefined,
    compactor: ContextCompactor,
    sessionMemoryStore: SessionMemoryStore,
    checkpointActiveFlags: (flags: TurnFlags) => void,
    control?: EphemeralControlV1,
  ): Promise<TurnState> {
    const {
      runId,
      workspaceRoot,
      maxSteps,
      model,
      toolDefs,
      toolNameMap,
      ctxMgr,
      planner,
      emit,
      specGoal,
    } = ctx;

    // 递减压缩冷却计数器
    if (this.compactCooldownTurns > 0) {
      this.compactCooldownTurns--;
    }

    // P3：每轮重置 context.recall 取回预算（每步 ≤2 次、每轮 ≤16K 字符）
    ctx.artifactRegistry?.startTurn(ctx.turn);

    let hostStateForRequest = this.buildHostState(ctx);
    const requestProjectionMessages = assembleModelContextV1({
      durable: { messages: [] },
      hostState: hostStateForRequest,
      ...(control ? { control } : {}),
    });
    const requestProjectionTokens = ctxMgr.estimator.countMessages(
      requestProjectionMessages,
    );

    // 步骤 1：报告自上轮以来被外部修改的文件
    this.maybeReportStaleFiles(ctx);

    // 步骤 2：L1 裁剪（prune）
    // 将超大的工具输出持久化到磁盘，只保留最近 N 个工具结果在内存中
    // P3：顺带执行引用桩目录有界化（最旧非 Cited 桩移出上下文）
    const contextWindow = model.capabilities?.contextWindow ?? 128_000;
    const pruneResult = ctxMgr.prune({
      toolResultsDir: getToolResultsDir(workspaceRoot, runId),
      keepRecentTools: DEFAULT_KEEP_RECENT_TOOLS,
      ...(ctx.artifactRegistry
        ? { artifactRegistry: ctx.artifactRegistry }
        : {}),
    });
    if (pruneResult.pruned) {
      emit({
        type: "compression.prune.done",
        freedTokens: pruneResult.freedTokens,
        remainingTokens: ctxMgr.estimatedTokens,
      });
    }

    // 计算上下文预算快照（system / tools / history 各用了多少 token）
    // P5.2 成本记账：用累计 cache 命中率微调压缩阈值（保护宝贵前缀）
    const cacheHitRate =
      this._promptTokensAcc > 0
        ? this._cachedPromptTokensAcc / this._promptTokensAcc
        : 0;
    const budgetSnapshot = AgentOrchestrator.measureBudget(
      ctxMgr,
      toolDefs,
      contextWindow,
      cacheHitRate,
    );
    let requestBudgetSnapshot = AgentOrchestrator.reserveRequestProjection(
      budgetSnapshot,
      requestProjectionTokens,
    );
    ctxMgr.setHistoryTokenBudget(
      requestBudgetSnapshot.allocation.historyBudget,
    );
    this.emitContextBudget(emit, contextWindow, requestBudgetSnapshot);
    // P4.3 逐块账本 dashboard（VISTA）：块粒度 id/token/轮龄/状态
    this.emitContextBlocks(ctx, budgetSnapshot);

    // 步骤 3：L2 自动压缩（history pool 超过阈值时触发）
    await this.maybeCompactHistory(
      ctx,
      compactor,
      sessionMemoryStore,
      requestBudgetSnapshot,
    );

    // P5.1 侧信道触发：monitor 采样（10% + 5 步冷却 + 预算软启动），
    // 命中 subtask_end / low_density / critical_issue → 强制压缩（跳过阈值）
    const historyBudget = requestBudgetSnapshot.allocation.historyBudget;
    const remainingRatio =
      historyBudget > 0
        ? 1 - requestBudgetSnapshot.historyUsed / historyBudget
        : 1;
    const historyUsageRatio =
      historyBudget > 0 ? requestBudgetSnapshot.historyUsed / historyBudget : 0;
    if (this.monitor.shouldEvaluate(ctx.turn, remainingRatio)) {
      const decision = evaluateTrigger(ctx.ctxMgr.buildMessages());
      const budgetCritical = decision.reason === "budget_critical";
      const enoughHistoryToBenefit =
        historyUsageRatio >=
        AgentOrchestrator.MONITOR_COMPACT_MIN_HISTORY_RATIO;
      const shouldForceCompact =
        decision.triggered && (budgetCritical || enoughHistoryToBenefit);
      this.monitor.noteEvaluated(shouldForceCompact);
      if (shouldForceCompact && !compactor.isDisabled) {
        emit({
          type: "compression.monitor.trigger",
          reason: decision.reason ?? "subtask_end",
          force: true,
        });
        await this.maybeCompactHistory(
          ctx,
          compactor,
          sessionMemoryStore,
          requestBudgetSnapshot,
          true,
        );
      }
    }

    // 约束生命周期：检测意图变化 → LLM 调和约束集合
    // （覆盖/反转/撤销/过期判定归 LLM；这里只决定"该不该问"）
    await this.maybeReconcileConstraints(ctx);

    // ── goal 变化时刷新记忆上下文 ──
    if (this._memoryRuntime && this._memoryTaskId) {
      const goalChanged = specGoal !== this._lastDynamicMemoryGoal;
      if (goalChanged && ctx.turn > 0) {
        this._lastDynamicMemoryGoal = specGoal;
        try {
          const section = await this._memoryRuntime.buildContextSection({
            taskId: this._memoryTaskId,
            query:
              buildConversationAwareQuery(specGoal) ||
              extractCleanMemoryQuery(specGoal) ||
              specGoal,
            tokenBudget: 1500,
            currentUserRequest: extractCleanMemoryQuery(specGoal) || specGoal,
            limit: 5,
          });
          this._memoryContextSection =
            section.promptSection?.slice(0, 6000) ?? "";
          if (section.promptSection) {
            emit({
              type: "memory.turn.inject",
              recordCount: section.items.length,
              tokens: section.tokens,
            });
          }
        } catch {
          /* best-effort */
        }
      }
    }

    const taskSnapshot = ctx.taskState.snapshot();
    // Rebuild after reconciliation, memory refresh, and compaction. Late-loop
    // guidance competes at the typed control seam and only earns a receipt
    // after a successful provider response.
    hostStateForRequest = this.buildHostState(ctx);
    const postCompactBudgetSnapshot = AgentOrchestrator.measureBudget(
      ctxMgr,
      toolDefs,
      contextWindow,
      cacheHitRate,
    );
    const provisionalProjectionTokens = ctxMgr.estimator.countMessages(
      assembleModelContextV1({
        durable: { messages: [] },
        hostState: hostStateForRequest,
        ...(control ? { control } : {}),
      }),
    );
    const provisionalRequestBudget = AgentOrchestrator.reserveRequestProjection(
      postCompactBudgetSnapshot,
      provisionalProjectionTokens,
    );
    const guidanceCandidates = deriveLoopGuidanceCandidatesV1({
      state: taskSnapshot,
      flags,
      turn: ctx.turn,
      maxSteps,
      historyUsed: postCompactBudgetSnapshot.historyUsed,
      historyBudget: provisionalRequestBudget.allocation.historyBudget,
      ...(ctx.verificationPolicy
        ? { verificationPolicy: ctx.verificationPolicy }
        : {}),
    });
    const requestControl = selectEphemeralControlV1([
      control,
      ...guidanceCandidates.map((candidate) => candidate.control),
    ]);
    const selectedGuidance: LoopGuidanceCandidateV1 | undefined =
      guidanceCandidates.find(
        (candidate) => candidate.control === requestControl,
      );
    const finalRequestProjectionTokens = ctxMgr.estimator.countMessages(
      assembleModelContextV1({
        durable: { messages: [] },
        hostState: hostStateForRequest,
        ...(requestControl ? { control: requestControl } : {}),
      }),
    );
    requestBudgetSnapshot = AgentOrchestrator.reserveRequestProjection(
      postCompactBudgetSnapshot,
      finalRequestProjectionTokens,
    );
    ctxMgr.setHistoryTokenBudget(
      requestBudgetSnapshot.allocation.historyBudget,
    );
    if (
      ctxMgr.historyEstimatedTokens >
      requestBudgetSnapshot.allocation.historyBudget
    ) {
      ctxMgr.truncateNow();
    }
    this.emitContextBudget(emit, contextWindow, requestBudgetSnapshot);

    const finalRequestProjectionMessages = assembleModelContextV1({
      durable: { messages: [] },
      hostState: hostStateForRequest,
      ...(requestControl ? { control: requestControl } : {}),
    });
    emit({
      type: "loop.tick",
      turn: ctx.turn + 1,
      maxSteps,
      estimatedTokens:
        ctxMgr.estimatedTokens +
        finalRequestProjectionTokens +
        AgentOrchestrator.estimateToolTokens(toolDefs, ctxMgr.estimator),
    });
    emit({ type: "phase", name: "model" });
    emit({
      type: "model.request",
      label: model.label,
      messageCount: ctxMgr.length + finalRequestProjectionMessages.length,
    });

    // 步骤 5：调用模型 + 解析返回的工具调用/动作
    // 设置流式恢复路径——模型输出时实时写盘，崩了不丢
    this._streamRecoveryPath = path.join(
      workspaceRoot,
      ".paw",
      "streams",
      runId,
      `turn-${ctx.turn}.tmp`,
    );
    let modelResult: Awaited<ReturnType<typeof this.callModelAndParseActions>>;
    try {
      modelResult = await this.callModelAndParseActions(
        ctx,
        toolDefs,
        toolNameMap,
        hostStateForRequest,
        requestControl,
      );
    } finally {
      this._streamRecoveryPath = undefined;
    }
    // This response consumed the advisory hint that was in its request.
    // A failed tool later in the turn may replace it with a new checkpoint.
    this._memoryLatestHint = undefined;
    const {
      text,
      thinking,
      toolCalls,
      singleAction,
      reasoningText,
      diagnosis,
      nativeToolErrors,
      nativeToolTurn,
      finishReason,
    } = modelResult;
    emit({
      type: "capability.selection",
      ...ctx.capabilityExposure.observe(
        ctx.turn,
        specGoal,
        toolCalls.map((call) => call.tool),
        capabilityPhaseToolsV1(taskSnapshot),
      ),
    });

    let dispatchedAction = singleAction;
    const { pendingControl: _consumedControl, ...unmarkedFlags } = flags;
    const flagsAfterControl = selectedGuidance
      ? applyLoopGuidanceReceiptV1(
          unmarkedFlags as TurnFlags,
          selectedGuidance.receipt,
        )
      : (unmarkedFlags as TurnFlags);
    if (selectedGuidance?.receipt.kind === "context_guard") {
      emit({
        type: "context.guard",
        historyUsed: postCompactBudgetSnapshot.historyUsed,
        historyBudget: provisionalRequestBudget.allocation.historyBudget,
        reason: "budget_exhausted",
      });
    }
    let dispatchedFlags: TurnFlags = flagsAfterControl;
    const controlAction = nativeToolErrors?.length
      ? ("native_tool_errors" as const)
      : singleAction &&
          singleAction.type !== "final_answer" &&
          singleAction.type !== "tool_call"
        ? singleAction.type
        : diagnosis.kind !== "ok"
          ? ("parse_recovery" as const)
          : undefined;
    const normalizedFinishReason = finishReason?.trim().toLowerCase();
    if (
      ctx.loopKernelVersion !== "v1" &&
      toolCalls.length === 0 &&
      controlAction === undefined &&
      singleAction?.type !== "final_answer" &&
      (normalizedFinishReason === undefined ||
        normalizedFinishReason === "stop")
    ) {
      emit({
        type: "provider.turn_stopped",
        turn: ctx.turn + 1,
        empty: !(reasoningText || text).trim(),
      });
    }
    if (ctx.loopKernelVersion === "v2") {
      const priorProviderState =
        flags.providerTerminal ??
        ({
          ...createProviderTerminalStateV2(runId),
          lastTurn: ctx.turn,
        } as const);
      const terminal = normalizeProviderResponseV2(priorProviderState, {
        runId,
        turn: ctx.turn + 1,
        ...(finishReason !== undefined ? { finishReason } : {}),
        visibleText: reasoningText || text,
        toolCalls: toolCalls.map((call, sourceIndex) => ({
          callId: `model:${runId}:turn:${ctx.turn}:call:${sourceIndex}`,
          tool: call.tool,
          args: call.args,
        })),
        ...(controlAction !== undefined ? { controlAction } : {}),
        ...(singleAction?.type === "final_answer"
          ? { legacyFinalAnswer: { summary: singleAction.summary } }
          : {}),
      });
      dispatchedFlags = {
        ...flagsAfterControl,
        providerTerminal: terminal.state,
      };

      if (terminal.decision.kind === "recover_protocol") {
        if (ctx.turn + 1 >= ctx.maxSteps) {
          const message = `Provider protocol recovery could not run before max steps: ${terminal.decision.issue}`;
          return {
            type: "decided",
            decision: decideIncomplete({
              reason: `provider_protocol_${terminal.decision.issue}_recovery_budget_exhausted`,
              message,
              taskState: ctx.taskState.snapshot(),
            }),
            nextFlags: dispatchedFlags,
          };
        }
        dispatchedFlags = {
          ...dispatchedFlags,
          pendingControl: {
            kind: "protocol_recovery",
            text: providerProtocolRecoveryMessageV2(terminal.decision.issue),
          },
        };
        ctx.ctxMgr.addAssistant(text, thinking);
        this.saveState(
          runId,
          specGoal,
          workspaceRoot,
          ctx.turn + 1,
          maxSteps,
          ctxMgr,
          planner,
          ctx.taskState,
          undefined,
          dispatchedFlags,
        );
        return { type: "continue", nextFlags: dispatchedFlags };
      }
      if (terminal.decision.kind === "incomplete") {
        if (text.trim() || thinking?.trim()) {
          ctx.ctxMgr.addAssistant(text, thinking);
        }
        return {
          type: "decided",
          decision: decideIncomplete({
            reason: `provider_protocol_${terminal.decision.reasonCode}`,
            message: `[ProviderProtocol:${terminal.decision.reasonCode}] ${terminal.decision.detail}`,
            taskState: ctx.taskState.snapshot(),
          }),
          nextFlags: dispatchedFlags,
        };
      }
      if (terminal.decision.kind === "turn_boundary") {
        const reduction = ctx.getLoopV2ControlReduction?.();
        if (
          reduction?.state.turn !== ctx.turn + 1 ||
          reduction.effects.length !== 1 ||
          reduction.effects[0]?.type !== "call_model"
        ) {
          throw new Error(
            "Loop v2 provider turn boundary is missing its reducer decision",
          );
        }
        dispatchedFlags = {
          ...dispatchedFlags,
          pendingControl: {
            kind: "protocol_recovery",
            text: providerTurnBoundaryMessageV2(reduction),
          },
        };
        ctx.ctxMgr.addAssistant(text, thinking);
        this.saveState(
          runId,
          specGoal,
          workspaceRoot,
          ctx.turn + 1,
          maxSteps,
          ctxMgr,
          planner,
          ctx.taskState,
          undefined,
          dispatchedFlags,
        );
        return {
          type: "continue",
          nextFlags: { ...dispatchedFlags, lastTurnHadToolCall: false },
        };
      }
      if (terminal.decision.kind === "candidate_proposed") {
        dispatchedAction = {
          type: "final_answer",
          summary: terminal.decision.visibleText,
        };
      }
    }

    // The provider consumed the selected request control. Advance the
    // run-scope crash checkpoint before any action handler can throw.
    checkpointActiveFlags(dispatchedFlags);

    // 步骤 6：通过 action 处理器分发执行
    // handleAction 在 orchestrator/action-handlers.ts 中实现，
    // 根据动作类型处理：tool_call / final / ask_user / plan / abort / run_agent
    const actionResult = await handleAction(
      dispatchedAction ? [dispatchedAction] : [],
      toolCalls,
      ctx,
      dispatchedFlags,
      reasoningText || text,
      thinking,
      {
        resolveAskUser: this.resolveAskUser,
        resolveToolApproval: this.resolveToolApproval,
        approvalPolicy: this.approvalPolicy,
        fileLock: this.fileLock,
        todoStore: this.todoStore,
        planner,
        planSnapshotMaxItems: this.planSnapshotMaxItems,
        saveStateFn: (flagsOverride) => {
          const checkpointedFlags = flagsOverride ?? dispatchedFlags;
          checkpointActiveFlags(checkpointedFlags);
          this.saveState(
            runId,
            specGoal,
            workspaceRoot,
            ctx.turn + 1,
            maxSteps,
            ctxMgr,
            planner,
            ctx.taskState,
            undefined,
            checkpointedFlags,
          );
        },
        saveWaitingStateFn: (state, flagsOverride) => {
          checkpointActiveFlags(flagsOverride);
          this._interactionState = state;
          this.saveState(
            runId,
            specGoal,
            workspaceRoot,
            ctx.turn + 1,
            maxSteps,
            ctxMgr,
            planner,
            ctx.taskState,
            undefined,
            flagsOverride,
          );
        },
        consumeWaitingStateFn: (state, reply, flagsOverride) => {
          checkpointActiveFlags(flagsOverride);
          const appended = appendReplyToInboxV1(this._interactionInbox, state, {
            requestId: state.requestId,
            reply,
          });
          this._interactionInbox = appended.inbox;
          this._interactionState = {
            ...state,
            status: "consumed",
            consumedReplyId: appended.event.replyId,
          };
          this.saveState(
            runId,
            specGoal,
            workspaceRoot,
            ctx.turn + 1,
            maxSteps,
            ctxMgr,
            planner,
            ctx.taskState,
            undefined,
            flagsOverride,
          );
        },
        agentGroup,
        childPolicy: this.childPolicy,
        subAgentLauncher: this.subAgentLauncher,
        skillRegistry: this.skillRegistry,
        watcher: this.watcher,
        evalHooks: this.evalHooks,
        memoryRuntime: this._memoryRuntime ?? undefined,
        memoryTaskId: this._memoryTaskId ?? undefined,
        publishMemoryHint: (content) => {
          this._memoryLatestHint = content
            ? createMemoryHintCheckpointV1("action_failed", content)
            : undefined;
        },
        createAgent: this.createAgent,
        toolExecutionPolicy: this.toolExecutionPolicy,
        toolEffectPolicy: this.toolEffectPolicy,
      },
      {
        diagnosis,
        ...(nativeToolErrors ? { nativeToolErrors } : {}),
        ...(nativeToolTurn ? { nativeToolTurn } : {}),
      },
    );
    // 子 Agent 摘要 → WorkingMemory
    if (
      actionResult.subResults &&
      actionResult.subResults.length > 0 &&
      this._memoryRuntime &&
      this._memoryTaskId
    ) {
      for (const sr of actionResult.subResults) {
        if (!sr.summary || sr.summary.length < 20) continue;
        await this._memoryRuntime
          .patchWorkingMemory({
            taskId: this._memoryTaskId,
            patch: {
              nextStep: `Sub-agent result: ${sr.summary.slice(0, 200)}`,
            },
          })
          .catch(() => {});
      }
    }

    // P2.7 行为闭环：压缩后 5 轮内检测重复获取（摘要质量低信号）
    if (
      !this._qualityReported &&
      ctx.turn <= this._qualityWindowTurn &&
      this._qualityFiles.size > 0
    ) {
      const snap = ctx.taskState.snapshot();
      const newFiles = snap.filesRead.filter((f) => !this._qualityFiles.has(f));
      const newCommands = snap.commandsRun
        .map((c) => c.command)
        .filter((c) => !this._qualityCommands.has(c));
      const { duplicates, quality } = detectDuplicateAccess({
        filesReadAtCompact: [...this._qualityFiles],
        commandsAtCompact: [...this._qualityCommands],
        newFilesRead: newFiles,
        newCommands,
      });
      if (quality === "low") {
        this._qualityReported = true;
        emit({
          type: "compression.quality.low",
          repeated: duplicates.map((d) => `${d.kind}:${d.value}`),
          compactTurn: this._qualityCompactTurn,
        });
      }
    }
    return actionResult.state.type === "decided"
      ? { ...actionResult.state, nextFlags: actionResult.flags }
      : actionResult.state;
  }

  /**
   * 约束生命周期调和：检测用户意图变化 → LLM 维护"当前有效约束集合"。
   *
   * 触发（harness 规则，仅决定何时问；语义判定全部由 LLM 负责）：
   * 1. 有新增用户消息（非工具结果/系统注入，且非最小回复）→ 冷却到期则调和
   * 2. 距上次调和 > 15 轮 → 强制调和（处理过期约束）
   * 3. 最近用户消息命中任务转向信号（next task / 新任务…）→ 调和
   *
   * 降级安全：LLM 失败时 keep 全部 + 规则追加，绝不丢约束。
   */
  private async maybeReconcileConstraints(ctx: PhaseContext): Promise<void> {
    // 子 Agent 不调和：约束来自父级 sharedContext，不维护自己的生命周期
    if (this.runMode === "child") return;
    const auxModel = this.auxiliaryModel ?? ctx.model;
    const existing = ctx.taskState.activeConstraints();
    // 扫描全部用户消息（排除工具结果与系统注入——系统注入不是用户意图）
    const userMessages = ctx.ctxMgr
      .buildMessages()
      .filter((m) => m.role === "user")
      .map((m) => m.content)
      .filter(
        (c) =>
          !isToolResultMessage(c) &&
          !CONSTRAINT_SYSTEM_INJECTED_PREFIXES.some((p) => c.startsWith(p)),
      );
    if (userMessages.length === 0) return;

    const newMessages = userMessages.slice(this._lastConstraintScanCount);
    // 多轮会话：goal 变更（用户新请求）也是意图变化候选
    const goalChanged = ctx.specGoal !== ctx.taskState.snapshot().goal;
    const candidates =
      newMessages.length > 0 ? newMessages : goalChanged ? [ctx.specGoal] : [];
    const taskPivot = candidates.some((m) =>
      CONSTRAINT_TASK_PIVOT_PATTERN.test(m.trim()),
    );
    // 15 轮强制：仅当已有约束需要过期判定，且不在初始轮（init 刚提取，无过期可言）
    const forced =
      existing.length > 0 &&
      ctx.turn > 0 &&
      ctx.turn - this._lastConstraintReconcileTurn > 15;
    // 最小回复过滤（纯长度/结构规则，无词表）："继续"“ok”这类不值得调和
    const meaningfulNew = candidates.filter(
      (m) => m.length >= 10 || /[,.。:：/\\]/.test(m),
    );
    const shouldReconcile =
      taskPivot ||
      forced ||
      (meaningfulNew.length > 0 && this._constraintReconcileCooldown <= 0);

    this._lastConstraintScanCount = userMessages.length;
    if (!shouldReconcile) return;

    const result = await runConstraintReconcile({
      model: auxModel,
      existing,
      newUserMessages: candidates.slice(-5),
      currentTurn: ctx.turn,
      signal: ctx.signal,
    });
    ctx.taskState.updateConstraints(result, ctx.turn);
    if (goalChanged) ctx.taskState.updateGoal(ctx.specGoal);
    this._lastConstraintReconcileTurn = ctx.turn;
    this._constraintReconcileCooldown = 3;
    ctx.emit({
      type: "task.constraints.updated",
      active: ctx.taskState.activeConstraints().map((c) => c.text),
      superseded: ctx.taskState
        .snapshot()
        .constraints.filter((c) => c.status !== "active")
        .map((c) => c.text),
      ok: result.ok,
    });
    // HostState 在同一轮模型请求前从最新约束集重新派生。
  }

  private buildHostState(ctx: PhaseContext): HostStateV1 {
    const taskSnap = ctx.taskState.snapshot();
    const activeConstraints = ctx.taskState.activeConstraints();
    // Do not echo a verbatim constraint that is already visible in durable
    // user/history text. If compaction later removes the verbatim text, the
    // same typed HostState projection restores it for that request.
    const visibleDurableUserMessages = assembleModelContextV1({
      durable: { messages: ctx.ctxMgr.buildMessages() },
    })
      .filter((message) => message.role === "user")
      .map((message) => message.content);
    const status = ctx.statusTelemetry.snapshot(
      ctx.turn,
      ctx.maxSteps,
      taskSnap,
    );
    const plan = ctx.planner.plan;
    const planSnapshot = plan
      ? planToSnapshotPayload(
          plan,
          this.planSnapshotMaxItems !== undefined
            ? { maxItems: this.planSnapshotMaxItems }
            : undefined,
        )
      : undefined;
    const parallelismAvailable = Boolean(
      planSnapshot &&
        planSnapshot.items.filter((item) => item.status === "pending").length >
          1 &&
        ctx.capabilitySet.executableToolNames.includes("workspace.run_agent"),
    );
    const relevantMemory = this.buildRelevantMemoryProjection();
    return {
      ...(taskSnap.nextStep
        ? { taskBrief: { currentObjective: taskSnap.nextStep } }
        : {}),
      constraints: activeConstraints
        .filter(
          (constraint) =>
            !visibleDurableUserMessages.some((content) =>
              content.includes(constraint.text),
            ),
        )
        .map(
          (constraint) =>
            `${constraint.text} (stated at turn ${constraint.sourceTurn})`,
        ),
      taskProgress: formatTaskProgressForContext(taskSnap),
      ...(planSnapshot
        ? {
            planSnapshot: {
              json: JSON.stringify(planSnapshot),
              ...(parallelismAvailable
                ? { parallelismAvailable: true as const }
                : {}),
            },
          }
        : {}),
      ...(relevantMemory ? { relevantMemory } : {}),
      ...(this._contextPackageCode.length > 0
        ? { relevantCode: this._contextPackageCode.slice(0, 5) }
        : {}),
      status: formatStatusSnapshotV1(status),
    };
  }

  /**
   * Compose fixed, bounded memory channels for one request. The renderer adds
   * observation provenance; retrieved text never becomes system policy or a
   * durable user turn.
   */
  private buildRelevantMemoryProjection(): string | undefined {
    return renderRelevantMemoryV1({
      ...(this._memoryContextSection
        ? { primary: this._memoryContextSection }
        : {}),
      ...(this._memoryLatestHint ? { latestHint: this._memoryLatestHint } : {}),
      ...(this._coldResumeMemoryContext
        ? { coldResume: this._coldResumeMemoryContext }
        : {}),
    });
  }

  // ─────────────────────────────────────────────────────────
  // 工具方法
  // ─────────────────────────────────────────────────────────

  /**
   * 解析用户输入中的 @mention。
   *
   * @mention 是用户引用文件/图片的方式，例如：
   * - @file:src/index.ts → 读取文件内容注入到消息中
   * - @image:screenshot.png → 将图片作为附件传递给模型
   *
   * 返回解析后的文本内容（文件内容被内联）、未找到的引用列表、以及图片附件。
   */
  private static resolveUserMentions(
    workspaceRoot: string,
    text: string,
  ): {
    content: string;
    notFound: readonly string[];
    imageAttachments?: readonly {
      readonly type: "image" | "file";
      readonly name: string;
      readonly content: string;
      readonly mimeType?: string;
    }[];
  } {
    const { strippedText, attachments, notFound } = resolveMentions(
      workspaceRoot,
      text,
    );
    if (attachments.length === 0) return { content: text, notFound };
    const imageAttachments = attachments.filter((a) => a.type === "image");
    const fileAttachments = attachments.filter((a) => a.type === "file");
    const fileBlocks = fileAttachments
      .map(
        (a) =>
          `<file path="${a.name}" source="workspace" trust="workspace_untrusted_data" instruction_authority="none" permission_authority="none">\n${a.content}\n</file>`,
      )
      .join("\n\n");
    let content = strippedText;
    if (fileAttachments.length > 0) {
      content = `<files>\n${fileBlocks}\n</files>\n\n${strippedText}`;
    }
    return {
      content,
      notFound,
      ...(imageAttachments.length > 0 ? { imageAttachments } : {}),
    };
  }

  /**
   * 保存断点续跑状态。
   *
   * 每次 Run 完成后（无论成功或失败），将当前的 Goal、Turn、Messages、Plan、
   * Todos 等信息序列化到 AppStateStore，以便通过 resumeRun() 恢复。
   *
   * goal 清理逻辑：去除从之前会话注入的上下文前缀，只保留用户的实际请求。
   */
  private saveState(
    runId: string,
    goal: string,
    workspaceRoot: string,
    turn: number,
    maxSteps: number,
    ctxMgr: ContextManager,
    planner: TaskPlanner,
    taskState: TaskStateManager,
    outcome?: {
      status: "completed" | "failed" | "aborted" | "incomplete";
      message: string;
    },
    turnFlags?: TurnFlags,
  ): void {
    if (!this.appStateStore) return;
    // 清理 goal 中的历史会话前缀，只保留当前请求文本
    const cleanGoal =
      goal
        .replace(
          /^\[Context from previous session\][\s\S]*?\[Current user request\]\n/s,
          "",
        )
        .replace(
          /^\[Previous work session\][\s\S]*?\[Current user request\]\n/s,
          "",
        )
        .trim() || goal.trim();
    const plan = planner.plan;
    const loopControl = checkpointLoopControlV1(turnFlags);
    const state: AppState = {
      runId,
      goal: cleanGoal,
      workspaceRoot,
      turn,
      maxSteps,
      messages: stripLegacyContextProjectionsV1(ctxMgr.buildMessages()),
      ...(plan
        ? { plan: { revision: plan.revision, items: plan.items as unknown[] } }
        : {}),
      ...(this.todoStore ? { todos: this.todoStore.items } : {}),
      taskState: taskState.snapshot(),
      ...(this._memoryTaskId ? { memoryTaskId: this._memoryTaskId } : {}),
      ...(this._memoryLatestHint ? { memoryHint: this._memoryLatestHint } : {}),
      ...(this._interactionState
        ? { interaction: this._interactionState }
        : {}),
      ...(this._interactionInbox.length > 0
        ? { interactionInbox: this._interactionInbox }
        : {}),
      ...(this._executionEnvironment
        ? { executionEnvironment: this._executionEnvironment.snapshot() }
        : {}),
      ...(this._managedJobs
        ? { managedJobs: this._managedJobs.projection() }
        : {}),
      ...(loopControl ? { loopControl } : {}),
      ...(outcome ? { outcome } : {}),
      savedAt: Date.now(),
    };
    this.appStateStore.save(state);
  }

  /**
   * 合并两次模型调用的 token 用量。
   *
   * 使用场景：invokeModel() 中，当模型输出被截断时，会发起一次续写调用，
   * 两次调用的 token 需要合并统计。
   */
  private mergeUsage(
    a?: ModelTokenUsage,
    b?: ModelTokenUsage,
  ): ModelTokenUsage | undefined {
    if (!a && !b) return undefined;
    const pt = a?.promptTokens !== undefined || b?.promptTokens !== undefined;
    const ct =
      a?.completionTokens !== undefined || b?.completionTokens !== undefined;
    const tt = a?.totalTokens !== undefined || b?.totalTokens !== undefined;
    const cpt =
      a?.cachedPromptTokens !== undefined ||
      b?.cachedPromptTokens !== undefined;
    if (!pt && !ct && !tt && !cpt) return undefined;
    return {
      ...(pt
        ? { promptTokens: (a?.promptTokens ?? 0) + (b?.promptTokens ?? 0) }
        : {}),
      ...(ct
        ? {
            completionTokens:
              (a?.completionTokens ?? 0) + (b?.completionTokens ?? 0),
          }
        : {}),
      ...(tt
        ? { totalTokens: (a?.totalTokens ?? 0) + (b?.totalTokens ?? 0) }
        : {}),
      ...(cpt
        ? {
            cachedPromptTokens:
              (a?.cachedPromptTokens ?? 0) + (b?.cachedPromptTokens ?? 0),
          }
        : {}),
    };
  }

  /**
   * 标准化模型输出中的工具调用格式。
   *
   * 处理多种可能的格式：
   * - <overview> / <thinking> / <think> 标签 → 移除
   * - sanitized 工具名 → 还原为原始名
   * - <tool_call>{"tool": "...", "args": {...}}</tool_call> → 纯 JSON
   * - <tool>name</tool><args>{...}</args> → JSON
   * - ```json {...} ``` → 纯 JSON
   *
   * 这是兼容性层——不同模型/不同版本可能输出不同的工具调用格式。
   */
  private static normalizeToolCalls(
    text: string,
    nameMap?: Map<string, string>,
  ): string {
    let out = text
      // 移除 <overview> 标签（部分模型的元输出）
      .replace(/<overview>[\s\S]*?<\/overview>/gi, "")
      // 移除 thinking 标签（推理模型的思考过程）
      .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
      .replace(/<think>[\s\S]*?<\/think>/gi, "");
    // 还原 sanitized 工具名（如 "Bash" → "Bash(git *)"）
    if (nameMap && nameMap.size > 0) {
      for (const [sanitized, original] of nameMap) {
        out = out.split(`"${sanitized}"`).join(`"${original}"`);
      }
    }
    // 标准化 <tool_call> XML 标签为纯 JSON
    out = out.replace(
      /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/gi,
      (_, json) => `\n${json.trim()}\n`,
    );
    // 标准化 <tool>/<args> XML 标签
    const toolXmlRegex =
      /<tool>([^<]+)<\/tool>\s*(?:<args>(\{[\s\S]*?\})<\/args>)?/gi;
    out = out.replace(toolXmlRegex, (_m, name, argsJson) => {
      let args: unknown = {};
      if (argsJson) {
        try {
          args = JSON.parse(argsJson);
        } catch {
          /* ignore：解析失败则用空对象 */
        }
      }
      return `\n${JSON.stringify({ tool: name.trim(), args })}\n`;
    });
    // 剥离 markdown 代码块标记
    out = out.replace(
      /```json\s*(\{[\s\S]*?\})\s*```/g,
      (_, json) => `\n${json.trim()}\n`,
    );
    return out.trim();
  }

  // ─────────────────────────────────────────────────────────
  // 模型调用
  // ─────────────────────────────────────────────────────────

  /**
   * 单次模型调用（不含重试逻辑）。
   *
   * 支持两种调用模式：
   * 1. 流式（completeStream）：逐 chunk 返回，实时推送给 TUI
   * 2. 非流式（complete）：一次性返回完整结果
   *
   * 特殊处理：
   * - Qwen 模型通过 vLLM ≤0.22 时不发 tool_use 流式 chunk → 强制非流式
   * - 推理模型的 <think> 标签：提取为 thinking 字段
   * - 原生 tool_use：既收集为结构化对象，也转为文本追加到 text 中（兼容 TUI 显示）
   */
  private async invokeModelOnce(
    model: LanguageModel,
    messages: readonly ChatMessage[],
    signal: AbortSignal | undefined,
    emit: (event: RunEvent) => void,
    tools?: readonly import("@paw/models").ToolDefinition[],
    toolNameMap?: Map<string, string>,
  ): Promise<{
    text: string;
    rawText: string;
    usage?: ModelTokenUsage;
    thinking?: string;
    reasoningPassback?: string;
    finishReason?: string;
    /** 原生结构化工具调用（当 provider 支持 function calling 时） */
    nativeToolCalls?: readonly NativeToolCall[];
    /** 原生通道参数解析失败的调用（拒绝执行，需回灌给模型） */
    nativeToolErrors?: readonly NativeToolError[];
    nativeAssistantContent?: string;
  }> {
    // 内部请求超时必须与父级取消区分：前者可重试，后者应立即停 run。
    const timeout = AbortSignal.timeout(this.modelRequestTimeoutMs);
    const combinedSignal = signal
      ? AbortSignal.any([signal, timeout])
      : timeout;
    const streamFn = model.completeStream;
    const modelOpts = {
      signal: combinedSignal,
      ...(tools && tools.length > 0 ? { tools } : {}),
    };

    // Qwen3 通过 vLLM ≤0.22 不发出 tool_use 流式 chunk — 强制使用非流式
    const isQwen =
      model.label.toLowerCase().includes("qwen") ||
      model.label.toLowerCase().includes("/qwen");
    const useStreaming = typeof streamFn === "function" && !isQwen;

    try {
      if (useStreaming) {
        // ═══ 流式调用 ═══
        let acc = "";
        let assistantContentAcc = "";
        let thinkingAcc = "";
        let reasoningPassbackAcc = "";
        let usage: ModelTokenUsage | undefined;
        let finishReason: string | undefined;
        const nativeToolCalls: NativeToolCall[] = [];
        const malformedToolErrors: NativeToolError[] = [];
        let nativeSourceIndex = 0;

        // 流式恢复：边收 chunk 边写盘，崩了不丢输出
        let recoveryStream: fs.WriteStream | undefined;
        if (this._streamRecoveryPath) {
          await fsp.mkdir(path.dirname(this._streamRecoveryPath), {
            recursive: true,
          });
          recoveryStream = fs.createWriteStream(this._streamRecoveryPath);
          recoveryStream.on("error", () => {
            // best-effort crash recovery; stream failures must not fail the run.
          });
        }

        for await (const chunk of streamFn.call(model, messages, modelOpts)) {
          if (chunk.type === "text") {
            acc += chunk.delta;
            assistantContentAcc += chunk.delta;
            recoveryStream?.write(chunk.delta);
            emit({ type: "model.chunk", text: acc });
          } else if (chunk.type === "thinking") {
            thinkingAcc += chunk.delta;
            recoveryStream?.write(`\n[thinking] ${chunk.delta}\n`);
            emit({ type: "model.thinking", text: thinkingAcc });
          } else if (chunk.type === "reasoning_passback") {
            reasoningPassbackAcc += chunk.delta;
          } else if (chunk.type === "tool_use") {
            // 原生 tool_use：收集为结构化对象，同时转为文本用于 TUI 显示
            // 参数 JSON 解析失败 → 拒绝执行（绝不带空参数执行），
            // 记录原始输入供下一轮回灌给模型自纠
            let parsedArgs: Record<string, unknown> | null = null;
            try {
              const raw = JSON.parse(chunk.input);
              parsedArgs =
                raw !== null && typeof raw === "object" && !Array.isArray(raw)
                  ? (raw as Record<string, unknown>)
                  : null;
            } catch {
              parsedArgs = null;
            }
            if (parsedArgs === null) {
              malformedToolErrors.push({
                id: chunk.id,
                name: chunk.name,
                raw: chunk.input,
                sourceIndex: nativeSourceIndex,
                reason: "malformed_arguments",
              });
              nativeSourceIndex += 1;
              const display = JSON.stringify({
                tool: chunk.name,
                args: "[unparseable]",
              });
              acc += (acc ? "\n" : "") + display;
              recoveryStream?.write((acc ? "\n" : "") + display);
              emit({ type: "model.chunk", text: acc });
              continue;
            }
            nativeToolCalls.push({
              id: chunk.id,
              name: chunk.name,
              arguments: parsedArgs,
              rawArguments: chunk.input,
              sourceIndex: nativeSourceIndex,
              argumentsValid: true,
            });
            nativeSourceIndex += 1;
            const display = JSON.stringify({
              tool: chunk.name,
              args: parsedArgs,
            });
            acc += (acc ? "\n" : "") + display;
            recoveryStream?.write((acc ? "\n" : "") + display);
            emit({ type: "model.chunk", text: acc });
          } else if (chunk.type === "done") {
            usage = chunk.usage;
            finishReason = chunk.finishReason;
          }
        }

        // 流正常结束：关流、删恢复文件（acc 里有全文，不需要它了）
        if (recoveryStream) {
          const closePromise = new Promise<void>((resolve) => {
            recoveryStream!.once("close", resolve);
          });
          recoveryStream.end();
          await closePromise;
          fsp.unlink(this._streamRecoveryPath!).catch(() => {});
        }

        // 记录 token 用量和成本
        if (usage) {
          this.costTracker?.record(model.label, usage);
          // P1.4 usage 回填校准：真实 prompt_tokens vs 估算（收敛 <10%，基线偏差 37%）
          if (usage.promptTokens !== undefined) {
            this._calibratedEstimator?.recordActual(
              usage.promptTokens,
              this._calibratedEstimator.estimateRawMessages(messages),
            );
            // P5.2 成本记账：累计命中率（阈值微调输入）
            this._promptTokensAcc += usage.promptTokens;
            this._cachedPromptTokensAcc += usage.cachedPromptTokens ?? 0;
          }
          const snap = this.costTracker?.snapshot();
          if (snap)
            emit({
              type: "cost.update",
              ...snap,
              turnPromptTokens: usage.promptTokens,
              turnCompletionTokens: usage.completionTokens,
              ...(usage.cachedPromptTokens !== undefined
                ? { cachedPromptTokens: usage.cachedPromptTokens }
                : {}),
            });
        }

        // 安全网：有些推理模型在 text delta 中嵌入 <think> 标签，
        // 而不是通过独立的 thinking 流发出。这里做兜底提取。
        const finalExtracted = extractThinkBlocks(acc);
        const finalText = finalExtracted.text || acc;
        const assistantExtracted = extractThinkBlocks(assistantContentAcc);
        const nativeAssistantContent =
          assistantExtracted.text || assistantContentAcc;
        const finalThinking =
          [thinkingAcc, finalExtracted.thinking].filter(Boolean).join("\n\n") ||
          undefined;

        // 标准化工具调用格式
        const normalized = AgentOrchestrator.normalizeToolCalls(
          finalText,
          toolNameMap,
        );
        return {
          text: normalized,
          rawText: acc,
          thinking: finalThinking,
          ...(reasoningPassbackAcc
            ? { reasoningPassback: reasoningPassbackAcc }
            : {}),
          usage,
          finishReason,
          ...(nativeToolCalls.length > 0 || malformedToolErrors.length > 0
            ? { nativeAssistantContent }
            : {}),
          ...(nativeToolCalls.length > 0 ? { nativeToolCalls } : {}),
          ...(malformedToolErrors.length > 0
            ? { nativeToolErrors: malformedToolErrors }
            : {}),
        };
      }

      // ═══ 非流式调用 ═══
      const result = await model.complete(messages, modelOpts);
      const normalizedResult = AgentOrchestrator.normalizeToolCalls(
        result.text,
        toolNameMap,
      );
      emit({ type: "model.chunk", text: normalizedResult });

      if (result.usage) {
        this.costTracker?.record(model.label, result.usage);
        // P1.4 usage 回填校准（非流式路径）
        if (result.usage.promptTokens !== undefined) {
          this._calibratedEstimator?.recordActual(
            result.usage.promptTokens,
            this._calibratedEstimator.estimateRawMessages(messages),
          );
          // P5.2 成本记账：累计命中率
          this._promptTokensAcc += result.usage.promptTokens;
          this._cachedPromptTokensAcc += result.usage.cachedPromptTokens ?? 0;
        }
        const snap = this.costTracker?.snapshot();
        if (snap)
          emit({
            type: "cost.update",
            ...snap,
            turnPromptTokens: result.usage.promptTokens,
            turnCompletionTokens: result.usage.completionTokens,
            ...(result.usage.cachedPromptTokens !== undefined
              ? { cachedPromptTokens: result.usage.cachedPromptTokens }
              : {}),
          });
      }
      return {
        text: normalizedResult,
        rawText: result.text,
        thinking: result.thinking,
        ...(result.reasoningPassback !== undefined
          ? { reasoningPassback: result.reasoningPassback }
          : {}),
        usage: result.usage,
        finishReason: result.finishReason,
        ...(result.toolCalls && result.toolCalls.length > 0
          ? { nativeToolCalls: result.toolCalls }
          : {}),
        ...(result.nativeAssistantContent !== undefined
          ? { nativeAssistantContent: result.nativeAssistantContent }
          : {}),
      };
    } catch (error) {
      if (timeout.aborted && !signal?.aborted) {
        throw new ModelRequestTimeoutError(this.modelRequestTimeoutMs, error);
      }
      throw error;
    }
  }

  /**
   * 模型调用（带截断续写处理）。
   *
   * 当模型输出因 token 限制被截断时（finishReason === "length" 或 "max_tokens"），
   * 自动发起续写请求：将已有输出作为 assistant 消息追加，然后发一条
   * "[Continue from where you were cut off...]" 的 user 消息让模型接着输出。
   *
   * 两次调用的结果会合并（文本拼接 + token 用量累加）。
   */
  private async invokeModel(
    model: LanguageModel,
    messages: readonly ChatMessage[],
    signal: AbortSignal | undefined,
    emit: (event: RunEvent) => void,
    tools?: readonly import("@paw/models").ToolDefinition[],
    toolNameMap?: Map<string, string>,
    autoContinueTruncation = true,
  ): Promise<{
    text: string;
    usage?: ModelTokenUsage;
    thinking?: string;
    reasoningPassback?: string;
    finishReason?: string;
    nativeToolCalls?: readonly NativeToolCall[];
    nativeToolErrors?: readonly NativeToolError[];
    nativeAssistantContent?: string;
  }> {
    // 第一次调用（带熔断和重试）
    const result = await this.callModelWithRetry(
      model,
      messages,
      signal,
      emit,
      tools,
      toolNameMap,
    );

    const hasNativeProtocolState =
      (result.nativeToolCalls?.length ?? 0) > 0 ||
      (result.nativeToolErrors?.length ?? 0) > 0;
    if (
      autoContinueTruncation &&
      (result.finishReason === "length" ||
        result.finishReason === "max_tokens") &&
      hasNativeProtocolState
    ) {
      emit({ type: "model.truncated", finishReason: result.finishReason });
      emit({
        type: "model.done",
        text: result.text,
        ...(result.thinking ? { thinking: result.thinking } : {}),
        ...(result.usage !== undefined ? { usage: result.usage } : {}),
      });
      throw new Error(
        "Model output was truncated inside a native tool-call turn; refusing to execute or replay a partial provider protocol turn",
      );
    }

    // 检测截断：需要续写
    if (
      autoContinueTruncation &&
      (result.finishReason === "length" || result.finishReason === "max_tokens")
    ) {
      emit({ type: "model.truncated", finishReason: result.finishReason });

      // 构造续写消息：前文 + assistant 输出 + 续写指令
      const continueMessages = [
        ...messages,
        { role: "assistant" as const, content: result.text },
        {
          role: "user" as const,
          content:
            "[Continue from where you were cut off. Do not repeat any content — pick up exactly where the previous message stopped.]",
        },
      ];

      // 第二次调用
      const continued = await this.callModelWithRetry(
        model,
        continueMessages,
        signal,
        emit,
        tools,
        toolNameMap,
      );
      if (
        (continued.nativeToolCalls?.length ?? 0) > 0 ||
        (continued.nativeToolErrors?.length ?? 0) > 0
      ) {
        const auditText = AgentOrchestrator.normalizeToolCalls(
          result.rawText + continued.rawText,
          toolNameMap,
        );
        const auditThinking =
          [result.thinking, continued.thinking].filter(Boolean).join("") ||
          undefined;
        const auditUsage = this.mergeUsage(result.usage, continued.usage);
        emit({
          type: "model.done",
          text: auditText,
          ...(auditThinking ? { thinking: auditThinking } : {}),
          ...(auditUsage !== undefined ? { usage: auditUsage } : {}),
        });
        throw new Error(
          "A text auto-continuation produced a native tool-call turn; refusing to collapse two provider turns into one invalid replay envelope",
        );
      }

      // 合并两次调用的结果
      const combinedRawText = result.rawText + continued.rawText;
      const combinedText = AgentOrchestrator.normalizeToolCalls(
        combinedRawText,
        toolNameMap,
      );
      const combinedUsage = this.mergeUsage(result.usage, continued.usage);
      const combinedThinking =
        [result.thinking, continued.thinking].filter(Boolean).join("") ||
        undefined;
      const combinedReasoningPassback = continued.reasoningPassback;
      const combinedNativeAssistantContent =
        [result.nativeAssistantContent, continued.nativeAssistantContent]
          .filter((value): value is string => value !== undefined)
          .join("") || undefined;

      emit({
        type: "model.done",
        text: combinedText,
        ...(combinedThinking ? { thinking: combinedThinking } : {}),
        ...(combinedUsage !== undefined ? { usage: combinedUsage } : {}),
      });
      return {
        text: combinedText,
        thinking: combinedThinking,
        ...(combinedReasoningPassback !== undefined
          ? { reasoningPassback: combinedReasoningPassback }
          : {}),
        usage: combinedUsage,
        ...(continued.finishReason !== undefined
          ? { finishReason: continued.finishReason }
          : {}),
        // 合并 tool calls：第一次调用可能在截断前已完成部分工具调用
        nativeToolCalls: [
          ...(result.nativeToolCalls ?? []),
          ...(continued.nativeToolCalls ?? []),
        ],
        ...(combinedNativeAssistantContent !== undefined
          ? { nativeAssistantContent: combinedNativeAssistantContent }
          : {}),
        // 合并解析失败调用：两次调用的错误都要回灌
        nativeToolErrors: [
          ...(result.nativeToolErrors ?? []),
          ...(continued.nativeToolErrors ?? []),
        ],
      };
    }

    // 未被截断：直接返回
    emit({
      type: "model.done",
      text: result.text,
      ...(result.thinking ? { thinking: result.thinking } : {}),
      ...(result.usage !== undefined ? { usage: result.usage } : {}),
    });
    return result;
  }

  // ─────────────────────────────────────────────────────────
  // 熔断器 + 重试
  // ─────────────────────────────────────────────────────────

  /**
   * 获取或创建指定 label 的熔断器。
   *
   * 每个模型 label 一个独立的熔断器实例，这样即使模型 A 挂了，
   * 模型 B 的调用不受影响。
   */
  private getOrCreateBreaker(label: string): CircuitBreaker {
    let b = this.circuitBreakers.get(label);
    if (!b) {
      b = new CircuitBreaker(label);
      this.circuitBreakers.set(label, b);
    }
    return b;
  }

  /** 发送熔断器状态变更事件 */
  private emitCircuitBreakerEvent(
    breaker: CircuitBreaker,
    emit: (event: RunEvent) => void,
  ): void {
    const snap = breaker.snapshot();
    if (snap.state === "open") {
      emit({
        type: "model.circuit_breaker.open",
        label: breaker.label,
        failures: snap.failures,
      });
    }
  }

  /**
   * 带熔断器 + 智能重试的模型调用。
   *
   * 防护机制：
   * 1. **熔断器（Circuit Breaker）**：
   *    - 连续失败 N 次后熔断器打开 → 直接拒绝调用，不再浪费请求
   *    - 成功一次后熔断器关闭 → 恢复正常
   *    - 熔断状态的调用抛出 CircuitBreakerOpenError（不可重试）
   *
   * 2. **智能重试**：
   *    - 可重试错误：限流(429)、服务端错误(5xx)、超时、网络问题
   *    - 不可重试错误：认证失败(4xx)、熔断器打开、其他未知错误
   *    - 最多重试 3 次
   *    - 重试延迟：限流用 Retry-After 或固定阶梯，其他用指数退避（1s→2s→4s...）
   *
   * 面试要点：这是生产级 LLM 调用的关键保障——LLM API 不可靠，
   * 需要同时处理瞬时故障（重试）和持续故障（熔断）。
   */
  private async callModelWithRetry(
    model: LanguageModel,
    messages: readonly ChatMessage[],
    signal: AbortSignal | undefined,
    emit: (event: RunEvent) => void,
    tools?: readonly import("@paw/models").ToolDefinition[],
    toolNameMap?: Map<string, string>,
    breakerArg?: CircuitBreaker,
    attempt = 1,
  ): Promise<{
    text: string;
    rawText: string;
    usage?: ModelTokenUsage;
    thinking?: string;
    reasoningPassback?: string;
    finishReason?: string;
    nativeToolCalls?: readonly NativeToolCall[];
    nativeToolErrors?: readonly NativeToolError[];
    nativeAssistantContent?: string;
  }> {
    const breaker = breakerArg ?? this.getOrCreateBreaker(model.label);
    // 熔断器守卫：如果已经熔断，直接抛异常（不可重试）
    breaker.guard();

    try {
      const result = await this.invokeModelOnce(
        model,
        messages,
        signal,
        emit,
        tools,
        toolNameMap,
      );
      // 成功 → 记录到熔断器（可能从半开→关闭）
      const prevState = breaker.snapshot().state;
      breaker.recordSuccess();
      const newState = breaker.snapshot().state;
      if (prevState !== newState && newState === "closed") {
        emit({
          type: "model.circuit_breaker.closed",
          label: breaker.label,
        });
      }
      return result;
    } catch (err) {
      // 失败 → 记录到熔断器
      const prevState = breaker.snapshot().state;
      breaker.recordFailure();
      const newState = breaker.snapshot().state;
      if (prevState !== newState && newState === "open") {
        this.emitCircuitBreakerEvent(breaker, emit);
      }

      // 熔断器打开导致的异常不重试
      if (err instanceof CircuitBreakerOpenError) throw err;

      // 智能重试判断
      const classification = classifyError(err);
      if (!isRetryable(classification) || attempt >= 3) throw err;

      const delay = computeRetryDelay(attempt, classification);
      const msg = err instanceof Error ? err.message : String(err);
      emit({
        type: "model.retry.waiting",
        attempt,
        delayMs: Math.round(delay),
        error: msg,
        errorType: classification.type,
      });
      await this.retrySleep(delay);

      // 递归重试（attempt + 1）
      return this.callModelWithRetry(
        model,
        messages,
        signal,
        emit,
        tools,
        toolNameMap,
        breaker,
        attempt + 1,
      );
    }
  }

  // ═════════════════════════════════════════════════════════
  // initializeRun：运行初始化
  // ═════════════════════════════════════════════════════════

  /**
   * 初始化一次 Run 所需的所有上下文。
   *
   * 这是 run() 之前最重的准备工作，包括：
   *
   * 1. **工作区设置**：确定 workspaceRoot、maxSteps
   * 2. **模型选择**：用注入的 model 或从配置自动选择默认模型
   * 3. **MCP 连接**：连接所有配置的 MCP 服务器，获取工具列表
   * 4. **子 Agent 模式**（runMode === "child"）：使用精简的 child system prompt
   * 5. **完整 Agent 模式**（runMode === "full"）：
   *    - 加载 Skills
   *    - 记忆检索（Retrieve）：从项目记忆 + 会话记忆中搜索相关内容
   *    - 构建 System Prompt（含预算裁剪）
   *    - Git 状态、PAW.md 项目指令
   *    - @mention 解析 + 自动上下文发现
   * 6. **断点恢复**：如果传入了 resumeFromState，恢复历史消息和计划
   *
   * 返回值的每个字段都是 run() 主循环需要的依赖。
   */
  private async initializeRun(spec: RunSpec): Promise<{
    runId: string;
    workspaceRoot: string;
    maxSteps: number;
    startTurn: number;
    model: LanguageModel;
    mcp?: McpClientManager;
    toolDefs: readonly import("@paw/models").ToolDefinition[];
    toolNameMap: Map<string, string>;
    capabilitySet: CapabilitySetV1;
    ctxMgr: ContextManager;
    planner: TaskPlanner;
    taskState: TaskStateManager;
    statusTelemetry: RunStatusTelemetryV1;
    executionEnvironment: ExecutionEnvironmentRegistryV1;
    managedJobs: ManagedJobControllerV1;
    capabilityExposure: CapabilityExposureShadowV1;
    sessionMemoryStore: SessionMemoryStore;
    compactor: ContextCompactor;
    artifactRegistry: ArtifactRegistry;
    emit: (event: RunEvent) => void;
    observeLoopV2ToolCommit?: (input: LoopV2ShadowToolCommitPortInput) => void;
    getLoopV2ControlReduction?: NonNullable<
      PhaseContext["getLoopV2ControlReduction"]
    >;
    reviewLoopV2Candidate?: NonNullable<PhaseContext["reviewLoopV2Candidate"]>;
    probeLoopV2Candidate?: NonNullable<PhaseContext["probeLoopV2Candidate"]>;
    persistLoopV2Terminal?: (result: RunResult) => void;
    emitRunMetrics: () => void;
    seq: { n: number };
    checkpointSeq: { n: number };
    shellSandbox: import("@paw/harness").ShellSandboxConfig;
  }> {
    const runId = spec.runId;
    this._interactionState = parseWaitingUserInteractionV1(
      spec.resumeFromState?.interaction,
    );
    this._interactionInbox = parseInteractionInboxV1(
      spec.resumeFromState?.interactionInbox,
    );
    // P4.3/P4.4 每 run 重置：块账本/预算事件去重、压缩提交序号
    this._lastBlocksKey = null;
    this._lastBudgetKey = null;
    this._compactionCommitSeq = 0;
    const workspaceRoot = (() => {
      // 显式传入 workspaceRoot → 原样信任（调用方说了算）；
      // 只有未传参（CLI 当前目录模式）才向上找 .paw 锚定项目根——
      // 否则 home 下无 .paw 的新目录会被静默重定向到 home（home 有全局 .paw）
      if (spec.workspaceRoot?.trim()) {
        return path.resolve(spec.workspaceRoot);
      }
      const cwd = path.resolve(".");
      return findPawRoot(cwd) ?? cwd;
    })();
    const maxSteps = resolveMaxSteps(workspaceRoot, spec.maxSteps);
    const loopV2LiveReviewRuntime =
      this.loopKernelVersion === "v2"
        ? new LoopV2LiveReviewRuntimeV1({
            workspaceRoot,
            runId,
            ...(this.loopV2SemanticReviewModel
              ? { model: this.loopV2SemanticReviewModel }
              : {}),
            ...(spec.abortSignal ? { signal: spec.abortSignal } : {}),
            onUsage: (modelLabel, usage) =>
              this.costTracker?.record(modelLabel, usage),
          })
        : undefined;

    const seq = { n: 0 };
    const checkpointSeq = { n: 0 };
    let loopV2Projection: LoopV2ShadowObserver | undefined;
    this._lastLoopV2ShadowReport = undefined;
    this._lastLoopV2CandidateAssessment = undefined;
    this._lastLoopV2ReadinessProgressKey = undefined;
    this._lastLoopV2ReadinessVerificationRecords = undefined;
    if (spec.resumeFromState) {
      // A resumed run appends to the same durable event/checkpoint streams.
      // Restarting either counter at zero creates duplicate event identities
      // and can overwrite rollback snapshots from the pre-crash trajectory.
      try {
        const persisted = this.sessionStore?.loadRun(runId) ?? [];
        seq.n = persisted.reduce(
          (max, envelope) => Math.max(max, envelope.seq),
          0,
        );
      } catch {
        // A damaged optional event log must not make the saved AppState
        // unusable. The resumed run still proceeds, starting a fresh segment.
      }
      try {
        checkpointSeq.n = listCheckpoints(workspaceRoot, runId).reduce(
          (max, checkpoint) => Math.max(max, checkpoint.seq),
          0,
        );
      } catch {
        // Checkpoint discovery is best-effort; tool execution remains usable
        // even when old rollback metadata is unreadable.
      }
    }
    if (
      this.loopKernelVersion === "v2-shadow" ||
      this.loopKernelVersion === "v2"
    ) {
      const liveArtifactPath = loopV2LiveArtifactPath(workspaceRoot, runId);
      const projectionCheckpointPath = loopV2ProjectionCheckpointPath(
        workspaceRoot,
        runId,
      );
      if (this.loopKernelVersion === "v2" && spec.resumeFromState) {
        const candidateArtifact = fs.existsSync(liveArtifactPath)
          ? parseLoopV2LiveCandidateArtifactV1(
              fs.readFileSync(liveArtifactPath, "utf8"),
            )
          : undefined;
        const projectionCheckpoint = fs.existsSync(projectionCheckpointPath)
          ? parseLoopV2ProjectionCheckpointV1(
              fs.readFileSync(projectionCheckpointPath, "utf8"),
            )
          : undefined;
        const reports = [
          candidateArtifact?.report,
          projectionCheckpoint?.report,
        ].filter(
          (report): report is LoopV2ShadowReport => report !== undefined,
        );
        for (const report of reports) {
          if (report.runId !== runId) {
            throw new Error("Loop v2 resume artifact runId mismatch");
          }
          if (report.sourceThroughSeq > seq.n) {
            throw new Error(
              `Loop v2 resume artifact is ahead of legacy events: ${report.sourceThroughSeq} > ${seq.n}`,
            );
          }
        }
        if (
          candidateArtifact &&
          projectionCheckpoint &&
          candidateArtifact.report.sourceThroughSeq ===
            projectionCheckpoint.report.sourceThroughSeq &&
          candidateArtifact.report.reportHash !==
            projectionCheckpoint.report.reportHash
        ) {
          throw new Error(
            "Loop v2 resume artifacts conflict at the same source seq",
          );
        }
        const restoredReport = reports.sort(
          (left, right) => right.sourceThroughSeq - left.sourceThroughSeq,
        )[0];
        loopV2Projection = restoredReport
          ? restoreLoopV2ProjectionObserver(restoredReport)
          : createLoopV2ShadowObserver(runId);
        if (
          restoredReport &&
          candidateArtifact &&
          isControlOnlyCandidateExtension(
            candidateArtifact.report,
            restoredReport,
          )
        ) {
          this._lastLoopV2CandidateAssessment = candidateArtifact.assessment;
          loopV2LiveReviewRuntime?.restoreCandidate(candidateArtifact);
        }
      } else {
        loopV2Projection = createLoopV2ShadowObserver(runId);
      }
    }

    // ── 运行指标累加器 ──
    // 通过解析 emit 的事件流来累积指标，避免额外增加埋点代码
    const metrics = {
      modelLatencyMs: 0,
      modelCalls: 0,
      toolCalls: 0,
      toolSuccesses: 0,
      totalTokens: 0,
      estimatedCost: 0,
      costCurrency: "USD" as "CNY" | "USD",
      steps: 0,
      truncationCount: 0,
    };
    let modelCallStartTime = 0;
    let runStartTime = 0;

    const persistLoopV2ProjectionCheckpoint = () => {
      if (!loopV2Projection || this.loopKernelVersion !== "v2") return;
      const checkpoint = buildLoopV2ProjectionCheckpointV1(
        loopV2Projection.snapshot(),
      );
      const checkpointPath = loopV2ProjectionCheckpointPath(
        workspaceRoot,
        runId,
      );
      atomicWrite(
        checkpointPath,
        serializeLoopV2ProjectionCheckpointV1(checkpoint),
      );
      parseLoopV2ProjectionCheckpointV1(
        fs.readFileSync(checkpointPath, "utf8"),
      );
    };

    /**
     * 核心事件发射器。
     *
     * emit 是 orchestrator 与外部（TUI/CLI/测试）唯一的通信渠道。
     * 每产生一个事件，emit 会：
     * 1. 从事件中累积指标（延迟、token 用量、工具调用次数等）
     * 2. 递增序列号
     * 3. 包装为 RunEventEnvelope 发送给 onEvent 回调
     * 4. 保存到 SessionStore 用于持久化和回放
     */
    const emit = (event: RunEvent) => {
      // 从事件流中累积指标
      if (event.type === "model.request") {
        metrics.modelCalls++;
        modelCallStartTime = Date.now();
      }
      if (event.type === "model.done") {
        metrics.modelLatencyMs += Date.now() - modelCallStartTime;
        if (event.usage) {
          metrics.totalTokens +=
            (event.usage.promptTokens ?? 0) +
            (event.usage.completionTokens ?? 0);
        }
      }
      if (event.type === "model.truncated") {
        metrics.truncationCount++;
      }
      if (event.type === "tool.result") {
        metrics.toolCalls++;
        if (event.ok) metrics.toolSuccesses++;
      }
      if (event.type === "loop.tick") {
        metrics.steps = Math.max(metrics.steps, event.turn);
      }
      if (event.type === "cost.update") {
        metrics.estimatedCost = event.estimatedCostUsd ?? 0;
        metrics.costCurrency = event.costCurrency ?? "USD";
      }

      seq.n += 1;
      const envelope: RunEventEnvelope = {
        runId,
        seq: seq.n,
        ts: Date.now(),
        event,
      };
      this.onEvent?.(envelope);
      // Streaming chunk events contain the full accumulated text, not a delta.
      // Persisting every token therefore grows a session quadratically (a
      // modest long reasoning turn produced a 188 MB JSONL file). The final
      // model.done event is complete, while the separate recovery stream
      // protects an in-flight response, so partial snapshots stay live-only.
      if (event.type !== "model.chunk" && event.type !== "model.thinking") {
        this.sessionStore?.saveEvent(runId, envelope);
      }
      // Projection happens after the legacy delivery/persistence path. Shadow
      // remains fail-open; explicit v2 treats projection integrity as runtime
      // authority and therefore fails closed before continuing the loop.
      if (loopV2Projection) {
        try {
          loopV2Projection.observe(envelope);
          if (
            event.type === "provider.turn_stopped" ||
            event.type === "candidate.readiness" ||
            (event.type === "candidate.review" && event.candidateId)
          ) {
            persistLoopV2ProjectionCheckpoint();
          }
          if (
            this.loopKernelVersion === "v2" &&
            event.type === "agent.action" &&
            event.action.type === "final_answer"
          ) {
            const reduction = loopV2Projection.latestControlReduction();
            const requestedReadiness = reduction?.effects.some(
              (effect) => effect.type === "request_readiness",
            );
            if (!requestedReadiness) {
              if (
                !reduction?.effects.some(
                  (effect) =>
                    effect.type === "call_model" &&
                    effect.reason === "repair_required",
                )
              ) {
                throw new Error(
                  "Loop v2 candidate submission is missing its reducer decision",
                );
              }
              return;
            }
            const report = loopV2Projection.snapshot();
            this._lastLoopV2ReadinessProgressKey = loopV2ReadinessProgressKeyV1(
              report.state,
            );
            this._lastLoopV2ReadinessVerificationRecords = Object.values(
              report.state.verification,
            )
              .filter(
                (verification) =>
                  verification.mutationRevision ===
                  report.state.currentMutationRevision,
              )
              .sort((left, right) => left.id.localeCompare(right.id));
            const requireProductMutation =
              this.verificationPolicy?.requireMutation ??
              goalRequiresMutation(spec.goal);
            const trustedSkipAllowed = goalAllowsSkipVerification(spec.goal);
            const requiresVerification =
              requireProductMutation ||
              report.state.currentMutationRevision > 0;
            const policy = {
              requireProductMutation,
              verificationAuthority:
                requiresVerification && !trustedSkipAllowed
                  ? (this.verificationPolicy?.authority ?? "local")
                  : "not_required",
            } as const;
            const artifact = buildLoopV2LiveCandidateArtifactV1(report, policy);
            if (!loopV2LiveReviewRuntime) {
              throw new Error(
                "Loop v2 live review runtime was not initialized",
              );
            }
            const persisted =
              loopV2LiveReviewRuntime.persistCandidate(artifact);
            this._lastLoopV2CandidateAssessment = persisted.assessment;
            try {
              this.onLoopV2CandidateAssessment?.(persisted.assessment);
            } catch {
              // A consumer callback is not completion authority.
            }
          }
          if (
            this.loopKernelVersion === "v2-shadow" &&
            (event.type === "run.completed" || event.type === "run.failed")
          ) {
            this._lastLoopV2ShadowReport = loopV2Projection.snapshot();
            try {
              this.onLoopV2ShadowReport?.(this._lastLoopV2ShadowReport);
            } catch {
              // A diagnostic sink is not execution authority.
            }
          }
        } catch (error) {
          if (this.loopKernelVersion === "v2") throw error;
          // Shadow migration must remain fail-open while v1 is authoritative.
        }
      }
    };

    /** 运行结束时发出汇总指标事件 */
    const emitRunMetrics = () => {
      emit({
        type: "run.metrics",
        durationMs: Date.now() - runStartTime,
        modelLatencyMs: metrics.modelLatencyMs,
        modelCalls: metrics.modelCalls,
        toolCalls: metrics.toolCalls,
        toolSuccesses: metrics.toolSuccesses,
        totalTokens: metrics.totalTokens,
        estimatedCost: metrics.estimatedCost,
        costCurrency: metrics.costCurrency,
        steps: metrics.steps,
        truncationCount: metrics.truncationCount,
      });
    };

    const observeLoopV2ToolCommit = loopV2Projection
      ? (input: LoopV2ShadowToolCommitPortInput) => {
          try {
            loopV2Projection.observeToolCommit({ ...input, sourceSeq: seq.n });
            persistLoopV2ProjectionCheckpoint();
          } catch (error) {
            if (this.loopKernelVersion === "v2") throw error;
            // Rich shadow capture is diagnostic-only while v1 is authoritative.
          }
        }
      : undefined;
    const getLoopV2ControlReduction = loopV2Projection
      ? () => loopV2Projection.latestControlReduction()
      : undefined;

    const reviewLoopV2Candidate = loopV2LiveReviewRuntime?.canReview
      ? async () => {
          const result = await loopV2LiveReviewRuntime.reviewCandidate();
          const assessment = this._lastLoopV2CandidateAssessment;
          if (!assessment) {
            throw new Error(
              "Loop v2 semantic review completed without a candidate assessment",
            );
          }

          const summary = result.review.findings.length
            ? result.review.findings
                .slice(0, 8)
                .map(
                  (finding) =>
                    `${finding.severity}: ${finding.observedChange} Risk: ${finding.risk}`,
                )
                .join("\n")
                .slice(0, 8_000)
            : `Loop v2 semantic review ${result.review.verdict}.`;
          emit({
            type: "candidate.review",
            candidateId: assessment.candidateId,
            mutationRevision: result.review.mutationRevision,
            reviewKey: result.reviewKey,
            verdict: result.review.verdict,
            externalVerification:
              assessment.policy.verificationAuthority === "external"
                ? "pending"
                : "not_configured",
            summary,
            modelCalls: result.modelCalls,
            ...(result.usage ? { usage: result.usage } : {}),
          });
          return result;
        }
      : undefined;
    const persistLoopV2Terminal = loopV2LiveReviewRuntime
      ? (result: RunResult) => {
          const terminal = loopV2LiveReviewRuntime.persistTerminal(
            loopV2LegacyTerminalFromRunResult(result),
          );
          loopV2LiveReviewRuntime.persistRunResultShadow(result, terminal);
        }
      : undefined;

    runStartTime = Date.now();
    emit({ type: "run.started", goal: spec.goal });

    // ── 模型选择 ──
    const model =
      this.overrideModel ?? createDefaultLanguageModel(workspaceRoot);
    // P1.4 估算统一：按模型 label 选 tokenizer，包一层 usage 回填校准
    this._calibratedEstimator = new CalibratedEstimator(
      resolveEstimatorForModel(model.label),
    );
    // o200k 编码首次加载 ~20s：后台预热，避免首次估算卡住
    const modelLabel = model.label.toLowerCase();
    if (
      /\b(qwen|glm|minimax|yi|kimi|moonshot|ernie|baichuan)(?![a-z])/.test(
        modelLabel,
      )
    ) {
      prewarmEncoding("o200k_base");
    }
    const ctxMgr =
      this.contextManager ??
      new ContextManager({ estimator: this._calibratedEstimator });
    const planner = new TaskPlanner();
    const taskState = new TaskStateManager(
      spec.goal,
      spec.resumeFromState?.taskState,
    );
    taskState.registerAcceptanceCriteria(
      spec.initialAcceptanceCriteria ?? [],
      0,
    );
    this._contextPackageCode = [];
    let startTurn = 0;
    const sessionMemoryStore = new SessionMemoryStore({ workspaceRoot });
    const compactor = new ContextCompactor({}, ctxMgr.estimator);
    // P3 冷库：会话级可寻址归档（截断/驱逐的工具输出全文 + context.recall）
    const artifactRegistry = new ArtifactRegistry();

    // 对抗式验证探针：认证前由 host 执行的新鲜上下文边界测试。
    // 只在配置了探针模型且存在候选时生效；结果按 candidateInputHash
    // at-most-once 持久化，失败走修复反馈，不拥有终局。
    const probeLoopV2Candidate =
      this.loopKernelVersion === "v2" && this.loopV2VerificationProbeModel
        ? async () => {
            const assessment = this._lastLoopV2CandidateAssessment;
            if (!assessment) {
              throw new Error(
                "Loop v2 verification probe requires a candidate assessment",
              );
            }
            const diffShell = runShellInWorkspace(
              workspaceRoot,
              "git --no-pager diff HEAD",
              {
                timeoutMs: 30_000,
                ...(this.shellSandbox
                  ? { shellSandbox: this.shellSandbox }
                  : {}),
                skipApprovalGate: true,
              },
            );
            const diff =
              typeof diffShell.stdout === "string" ? diffShell.stdout : "";
            // Layer 3：探针地图增强——受影响测试清单喂入对抗探针
            // （闭包内就地构建；文件扫描 <1s，与主循环的实例独立）
            const changedFilesForProbe = taskState.snapshot().filesChanged;
            const probeTestMap = buildTestMapV1(workspaceRoot);
            const impactedForProbe = findImpactedTests(
              probeTestMap,
              changedFilesForProbe,
            ).map((t) => t.testFile);
            const result = await runVerificationProbeOnceV2({
              model: this.loopV2VerificationProbeModel!,
              runId,
              workspaceRoot,
              goal: spec.goal,
              diff,
              changedFiles: changedFilesForProbe,
              ...(impactedForProbe ? { impactedTests: impactedForProbe } : {}),
              candidateInputHash: assessment.candidateInputHash,
              mutationRevision: assessment.mutationRevision,
              ...(this.shellSandbox ? { shellSandbox: this.shellSandbox } : {}),
              ...(spec.abortSignal ? { signal: spec.abortSignal } : {}),
              onUsage: (modelLabel, usage) =>
                this.costTracker?.record(modelLabel, usage),
            });
            const summary = result.probes.length
              ? result.probes
                  .map(
                    (probe) =>
                      `${probe.status.toUpperCase()} exit=${probe.exitCode ?? "?"} ${probe.command.slice(0, 200)}`,
                  )
                  .join("\n")
                  .slice(0, 4_000)
              : (result.note ?? "no probes");
            emit({
              type: "candidate.probe",
              candidateId: assessment.candidateId,
              mutationRevision: assessment.mutationRevision,
              probeKey: `probe:${assessment.candidateInputHash}`,
              verdict: result.verdict,
              summary,
              modelCalls: result.modelCalls,
              ...(result.usage ? { usage: result.usage } : {}),
            });
            return result;
          }
        : undefined;

    // ── MCP 连接 ──
    // MCP（Model Context Protocol）允许模型通过标准协议访问外部工具和数据源
    const mcp =
      this.mcpServers && this.mcpServers.length > 0
        ? new McpClientManager()
        : undefined;
    let mcpConnectedCount = 0;
    if (mcp) {
      for (const cfg of this.mcpServers!) {
        try {
          await mcp.connect(cfg);
          mcpConnectedCount++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          emit({ type: "mcp.connection_failed", server: cfg.name, error: msg });
        }
      }
    }

    const shellSandbox =
      this.shellSandbox ?? resolveShellSandboxConfig(workspaceRoot);
    const managedJobs = new ManagedJobControllerV1({
      ownerId: runId,
      workspaceRoot,
      shellSandbox,
      ...(this.toolExecutionPolicy
        ? { toolExecutionPolicy: this.toolExecutionPolicy }
        : {}),
      ...(this.toolEffectPolicy
        ? { toolEffectPolicy: this.toolEffectPolicy }
        : {}),
      ...(spec.resumeFromState?.managedJobs !== undefined
        ? { resumeProjection: spec.resumeFromState.managedJobs }
        : {}),
    });
    this._managedJobs = managedJobs;
    const executionEnvironment = new ExecutionEnvironmentRegistryV1({
      runId,
      workspaceRoot,
      shellSandbox,
      resumeSnapshot: spec.resumeFromState?.executionEnvironment,
      backgroundJobs: () => managedJobs.readiness(),
      additionalRecoveryIssues: managedJobs.recoveryIssues(),
    });
    this._executionEnvironment = executionEnvironment;
    const environmentRecovery = executionEnvironment.snapshot().recovery;
    if (!environmentRecovery.compatible) {
      taskState.recordExecutionEnvironmentChange(environmentRecovery.issues);
    }
    const statusTelemetry = new RunStatusTelemetryV1({
      runId,
      workspaceRoot,
      executionEnvironment,
    });
    // Tool descriptions must reflect the actual execution world, not merely
    // the host OS (for example Windows hosting a Linux instance image).
    const toolNameMap = toolNameReverseMap(mcp);
    const capabilitySet = resolveCapabilitySetV1({
      definitions: toolDefinitions(mcp, { shellSandbox }),
      toolNameMap,
      configuredTools: this.allowedTools ?? null,
    });
    const toolDefs = capabilitySet.modelToolDefinitions;
    const capabilityExposure = new CapabilityExposureShadowV1({
      definitions: toolDefs,
      toolNameMap,
      countTokens: (definitions) =>
        AgentOrchestrator.estimateToolTokens(definitions, ctxMgr.estimator),
    });
    emit({
      type: "capability.inventory",
      capabilitySetSchemaVersion: capabilitySet.schemaVersion,
      modelActions: capabilitySet.modelActions,
      executableTools: capabilitySet.executableToolNames,
      internalToolCount: capabilitySet.internalToolNames.length,
      ...capabilityExposure.snapshot(
        spec.goal,
        capabilityPhaseToolsV1(taskState.snapshot()),
      ),
    });

    const contextWindow = model.capabilities?.contextWindow ?? 128_000;

    // ═══ 子 Agent 模式（child）═══
    // 子 Agent 使用精简的 system prompt，不加载记忆/skills/git状态
    if (this.runMode === "child" && this.sharedContext) {
      // 子 Agent 工具目录只列允许的工具
      const childCatalog = toolDefs
        .map((d) => {
          const orig = toolNameMap.get(d.function.name) ?? d.function.name;
          return `- ${orig}: ${d.function.description ?? ""}`;
        })
        .join("\n");
      const systemContent = buildChildSystemPrompt({
        sharedContext: this.sharedContext,
        toolCatalog: childCatalog,
        workspaceRoot,
      });

      if (spec.resumeFromState) {
        // 从断点恢复子 Agent
        const s = spec.resumeFromState;
        startTurn = s.turn;
        ctxMgr.setSystem(systemContent);
        const history = stripLegacyContextProjectionsV1(s.messages).filter(
          (m) => m.role !== "system",
        );
        if (history.length > 0) ctxMgr.replaceHistory(history);
        if (s.todos && this.todoStore) this.todoStore.set(s.todos);
      } else {
        ctxMgr.setSystem(systemContent);
        ctxMgr.addUser(spec.goal);
      }

      const initBudget = AgentOrchestrator.measureBudget(
        ctxMgr,
        toolDefs,
        contextWindow,
      );
      ctxMgr.setHistoryTokenBudget(initBudget.allocation.historyBudget);
      this.emitContextBudget(emit, contextWindow, initBudget);

      return {
        runId,
        workspaceRoot,
        maxSteps,
        startTurn,
        model,
        mcp,
        toolDefs,
        toolNameMap,
        capabilitySet,
        ctxMgr,
        planner,
        taskState,
        statusTelemetry,
        executionEnvironment,
        managedJobs,
        capabilityExposure,
        sessionMemoryStore,
        compactor,
        artifactRegistry,
        emit,
        emitRunMetrics,
        seq,
        checkpointSeq,
        shellSandbox,
      };
    }

    // ═══ 完整 Agent 模式（full）═══
    // 加载 Skills、项目记忆、Todo 等，构建完整的 system prompt

    // Skills 目录文本
    const skillsText =
      this.skillRegistry.list().length > 0
        ? this.skillRegistry.catalogText()
        : undefined;
    // Todo 列表文本
    const todosText =
      this.todoStore && this.todoStore.items.length > 0
        ? formatTodosForPrompt(this.todoStore.items)
        : undefined;

    // 加载项目记忆（.paw/CLAUDE.md + 全局 ~/.claude/CLAUDE.md）
    const projectMemory = loadProjectMemory(workspaceRoot);

    // 从项目记忆中提取 Skills 并注册
    for (const skill of skillsFromProjectMemory(
      projectMemory.committed,
      projectMemory.local,
    )) {
      if (!this.skillRegistry.has(skill.id)) {
        this.skillRegistry.register(skill);
      }
    }

    // ── 记忆 Runtime（唯一在线路径）──
    // clean：当前用户请求；aware：当前请求 + 多轮 history 中的路径/偏好信号
    const cleanMemoryQuery = extractCleanMemoryQuery(spec.goal);
    const retrievalQuery =
      buildConversationAwareQuery(spec.goal) || cleanMemoryQuery || spec.goal;
    let selectedForEvent: {
      id: string;
      title: string;
      source: string;
      summary: string;
      relatedFiles: readonly string[];
      type?: string;
      score?: number;
    }[] = [];

    this._memoryRuntime = null;
    this._memoryTaskId = null;
    this._memoryContextSection = "";
    this._memoryLatestHint = undefined;
    this._coldResumeMemoryContext = undefined;
    this._lastDynamicMemoryGoal = "";
    this._deferMemoryComplete = spec.deferMemoryComplete === true;
    this._conversationId =
      typeof spec.conversationId === "string" && spec.conversationId.trim()
        ? spec.conversationId.trim()
        : null;

    try {
      // memory.enable=false（.paw/memory-config.json）：零调用语义——不构造运行时
      if (!loadMemoryConfigSync(workspaceRoot).enable) {
        emit({
          type: "memory.retrieve.done",
          query: retrievalQuery,
          totalCandidates: 0,
          selectedCount: 0,
          scores: [],
          injectedTokens: 0,
          selectedMemories: [],
          retrievalMode: "keyword",
        });
      } else {
        const runtime = await createMemoryRuntime({
          workspaceRoot,
          emit,
          ...buildMemoryLlmOptions(this.memoryLlm, model),
        });
        // Own the runtime immediately so init failures are released by run's
        // finally block instead of leaking a scoped outbox worker.
        this._memoryRuntime = runtime;
        const ok = await runtime.ping();
        if (!ok) {
          await runtime.shutdown().catch(() => {});
          this._memoryRuntime = null;
          emit({
            type: "memory.retrieve.done",
            query: retrievalQuery,
            totalCandidates: 0,
            selectedCount: 0,
            scores: [],
            injectedTokens: 0,
            selectedMemories: [],
            retrievalMode: "keyword",
          });
        } else {
          const begun = await runtime.beginTask({
            runId,
            goal: cleanMemoryQuery || spec.goal,
            title: (cleanMemoryQuery || spec.goal).slice(0, 120),
            ...(spec.resumeMemoryTaskId
              ? { resumeTaskId: spec.resumeMemoryTaskId }
              : {}),
          });
          this._memoryTaskId = begun.taskId;
          this._lastDynamicMemoryGoal = spec.goal;
          if (this._conversationId && begun.taskId) {
            const { bindConversationMemoryTask } = await import(
              "./conversation-memory-bind.js"
            );
            bindConversationMemoryTask(this._conversationId, begun.taskId);
          }
          // 续任务时刷新 WM goal 为当前请求摘要（不含整段 history）
          if (begun.resumed && cleanMemoryQuery) {
            await runtime
              .patchWorkingMemory({
                taskId: begun.taskId,
                patch: { goal: cleanMemoryQuery.slice(0, 500) },
              })
              .catch(() => {
                /* best-effort */
              });
          }

          const section = await runtime.buildContextSection({
            taskId: begun.taskId,
            query: retrievalQuery,
            tokenBudget: 1500,
            currentUserRequest: cleanMemoryQuery || spec.goal,
            limit: 8,
          });
          this._memoryContextSection =
            section.promptSection?.slice(0, 6000) ?? "";
          selectedForEvent = section.items.map((item) => ({
            id: item.id,
            title: item.title,
            source: "auto",
            summary: item.summary?.trim() || item.title,
            relatedFiles: item.relatedFiles ? [...item.relatedFiles] : [],
            ...(item.type ? { type: item.type } : {}),
            score: item.score,
          }));
          emit({
            type: "memory.retrieve.done",
            query: retrievalQuery,
            totalCandidates: section.items.length,
            selectedCount: section.items.length,
            scores: section.items.map((i) => i.score),
            injectedTokens: section.tokens,
            retrievalMode: "keyword",
            selectedMemories: selectedForEvent,
          });
        }
      }
    } catch {
      emit({
        type: "memory.retrieve.done",
        query: retrievalQuery,
        totalCandidates: 0,
        selectedCount: 0,
        scores: [],
        injectedTokens: 0,
        selectedMemories: [],
      });
    }

    // ── Git 状态 ──
    // 获取当前分支、ahead/behind、暂存/修改/未跟踪文件数
    let gitStatusLine: string | undefined;
    try {
      const git = gitStatus(workspaceRoot);
      if (!git.error && git.branch) {
        const parts: string[] = [`Git branch: ${git.branch}`];
        if (git.ahead) parts.push(`ahead ${git.ahead}`);
        if (git.behind) parts.push(`behind ${git.behind}`);
        if (git.staged?.length) parts.push(`${git.staged.length} staged`);
        if (git.modified?.length) parts.push(`${git.modified.length} modified`);
        if (git.untracked?.length)
          parts.push(`${git.untracked.length} untracked`);
        if (parts.length > 1) gitStatusLine = parts.join(", ");
      }
    } catch {
      /* ignore：git 状态获取失败不影响主流程 */
    }

    // ── PAW.md 项目指令 ──
    // 类似 Claude Code 的 CLAUDE.md，项目级的自定义指令
    let pawMdContent: string | undefined;
    try {
      const pawMd = loadPawMd(workspaceRoot);
      if (pawMd.content) pawMdContent = pawMd.content;
    } catch {
      /* ignore */
    }

    // ── 构建 System Prompt（含预算裁剪）──
    // allocateContextBudget：按比例分配 system / tools / history 的 token 预算
    // buildSystemPromptWithBudget：根据预算裁剪 system prompt 各部分
    const systemBudget = allocateContextBudget(contextWindow).systemBudget;
    const rootToolCatalog = toolDefs
      .map((d) => {
        const orig = toolNameMap.get(d.function.name) ?? d.function.name;
        return `- ${orig}: ${d.function.description ?? ""}`;
      })
      .join("\n");
    const promptBuild = buildSystemPromptWithBudget(
      {
        workspaceRoot,
        toolCatalog: rootToolCatalog,
        modelToolNames: capabilitySet.modelToolNames,
        modelActions: capabilitySet.modelActions,
        skills: skillsText,
        gitStatus: gitStatusLine,
        pawMd: pawMdContent,
        projectMemory,
        todos: todosText,
        modelLabel: model.label,
        modelId: model.label,
        // Runtime 记忆：不再注入旧 file 目录路径 / MEMORY.md 长说明
        memoryDir: "",
        hasAutoMemory: true,
      },
      systemBudget,
      (text) => ctxMgr.estimator.count(text),
    );
    // 狸花身份 + Agent 花名册挂在 system 尾部（预算后追加，保持调度可见）
    const agentExtras = [
      this.agentIdentityText
        ? `\n\n# Agent identity\n${this.agentIdentityText.trim()}`
        : "",
      this.agentCatalogText
        ? `\n\n# Agent roster\n${this.agentCatalogText.trim()}`
        : "",
    ]
      .filter(Boolean)
      .join("");
    const systemContent = promptBuild.content + agentExtras;

    // 报告被裁剪的 system prompt 章节
    if (promptBuild.trimmed.length > 0) {
      emit({
        type: "context.budget.trimmed",
        sections: promptBuild.trimmed.map((t) => t.section),
        freedTokens: promptBuild.trimmed.reduce(
          (sum, t) => sum + t.freedTokens,
          0,
        ),
      });
    }

    // ── 断点恢复 or 全新启动 ──
    const mentionedPaths = extractAtMentions(spec.goal);
    this._contextPackageCode = selectCodeContext(
      workspaceRoot,
      spec.goal,
      mentionedPaths,
    );
    if (spec.resumeFromState) {
      // 断点恢复：重建 system prompt，恢复历史消息和计划
      const s = spec.resumeFromState;
      startTurn = s.turn;
      ctxMgr.setSystem(systemContent);
      const legacyMemory = migrateLegacyMemoryProjectionsV1(s.messages);
      const restoredMemoryHint = parseMemoryHintCheckpointV1(s.memoryHint);
      this._memoryLatestHint = restoredMemoryHint ?? legacyMemory.latestHint;
      this._coldResumeMemoryContext = legacyMemory.coldResume;
      const history = stripLegacyContextProjectionsV1(
        legacyMemory.messages,
      ).filter((m) => m.role !== "system");

      if (history.length > 0) {
        // Step 1: 先不做硬截断——把完整历史放进去
        ctxMgr.setHistoryRaw(history);

        // Step 2: L1 prune — 把超大的工具输出落盘，上下文中只留指针
        const toolResultsDir = getToolResultsDir(workspaceRoot, runId);
        const pruneResult = ctxMgr.prune({
          toolResultsDir,
          keepRecentTools: DEFAULT_KEEP_RECENT_TOOLS,
          artifactRegistry,
        });
        if (pruneResult.pruned) {
          emit({
            type: "compression.prune.done",
            freedTokens: pruneResult.freedTokens,
            remainingTokens: ctxMgr.estimatedTokens,
          });
        }

        // Step 3: L2 compact — 如果历史依然太大，用辅助模型把中间段压成摘要
        // 阈值与主路径同一口径（budget.ts 唯一事实来源：0.8 × historyBudget
        // − 10K buffer，纯百分比无封顶）；恢复场景不再用更激进的 0.4 × 窗口
        const historyTokensAfterPrune = ctxMgr.historyEstimatedTokens;
        const resumeCompactThreshold = Math.max(
          0,
          computeCompactThreshold(
            allocateContextBudget(contextWindow).historyBudget,
          ) - 10_000,
        );
        if (
          this.auxiliaryModel &&
          historyTokensAfterPrune > resumeCompactThreshold
        ) {
          await this.compactHistoryOnResume(
            ctxMgr,
            compactor,
            sessionMemoryStore,
            workspaceRoot,
            runId,
            spec.abortSignal ?? undefined,
            emit,
          );
        }

        // Step 4: 最后的安全网——硬截断兜底
        ctxMgr.truncateNow();
      }

      if (s.plan) {
        try {
          planner.restorePlan(
            runId,
            s.plan.items as readonly PlanItem[],
            s.plan.revision,
          );
          taskState.setPlan(s.plan.items);
        } catch {
          /* ignore plan restore errors */
        }
      }
      if (s.todos && this.todoStore) this.todoStore.set(s.todos);

      // 冷恢复（历史 ≤ 1 条）：注入会话记忆摘要帮助模型回忆上下文
      const prevMemory = sessionMemoryStore.load(runId);
      if (prevMemory?.task && history.length <= 1) {
        this._coldResumeMemoryContext = {
          task: prevMemory.task,
          state: prevMemory.currentState ?? "unknown",
        };
      }
      emit({ type: "run.started", goal: spec.goal });
    } else {
      // 全新启动
      ctxMgr.setSystem(systemContent);
      // 解析 @mention（文件引用、图片引用）
      const goalMentions = AgentOrchestrator.resolveUserMentions(
        workspaceRoot,
        spec.goal,
      );
      // 自动上下文发现：根据 goal 中的关键词和文件路径搜索相关代码上下文
      const autoCtx = discoverContext(workspaceRoot, spec.goal, mentionedPaths);
      let userContent = goalMentions.content;
      if (autoCtx.content)
        userContent = `${autoCtx.content}\n\n${goalMentions.content}`;
      ctxMgr.addUser(userContent, goalMentions.imageAttachments);
    }

    // 约束生命周期：初始用户消息不算"新增"（init 已提取约束），
    // 只有 init 之后追加的用户消息才触发 LLM 调和
    this._lastConstraintScanCount = ctxMgr
      .buildMessages()
      .filter(
        (m) => m.role === "user" && !isToolResultMessage(m.content),
      ).length;

    // 计算初始上下文预算
    const initBudget = AgentOrchestrator.measureBudget(
      ctxMgr,
      toolDefs,
      contextWindow,
    );
    ctxMgr.setHistoryTokenBudget(initBudget.allocation.historyBudget);
    this.emitContextBudget(emit, contextWindow, initBudget);

    return {
      runId,
      workspaceRoot,
      maxSteps,
      startTurn,
      model,
      mcp,
      toolDefs,
      toolNameMap,
      capabilitySet,
      ctxMgr,
      planner,
      taskState,
      statusTelemetry,
      executionEnvironment,
      managedJobs,
      capabilityExposure,
      sessionMemoryStore,
      compactor,
      artifactRegistry,
      emit,
      ...(observeLoopV2ToolCommit ? { observeLoopV2ToolCommit } : {}),
      ...(getLoopV2ControlReduction ? { getLoopV2ControlReduction } : {}),
      ...(reviewLoopV2Candidate ? { reviewLoopV2Candidate } : {}),
      ...(probeLoopV2Candidate ? { probeLoopV2Candidate } : {}),
      ...(persistLoopV2Terminal ? { persistLoopV2Terminal } : {}),
      emitRunMetrics,
      seq,
      checkpointSeq,
      shellSandbox,
    };
  }

  private static estimateToolTokens(
    tools: readonly import("@paw/models").ToolDefinition[],
    estimator: TokenEstimator,
  ): number {
    if (tools.length === 0) return 0;
    return estimator.count(JSON.stringify(tools));
  }

  /**
   * 测量当前上下文窗口的使用情况和预算分配。
   *
   * 返回 ContextBudgetSnapshot 包含：
   * - systemUsed / systemBudget：system prompt 的 token 用量和预算
   * - toolsUsed / toolsBudget：工具定义的 token 用量和预算
   * - historyUsed / historyBudget：历史消息的 token 用量和预算
   * - compactThreshold：触发 L2 压缩的阈值
   */
  private static measureBudget(
    ctxMgr: ContextManager,
    toolDefs: readonly import("@paw/models").ToolDefinition[],
    contextWindow: number,
    cacheHitRate = 0,
  ): ContextBudgetSnapshot {
    const snapshot = measureContextBudget({
      contextWindow,
      systemTokens: ctxMgr.systemEstimatedTokens,
      toolsTokens: AgentOrchestrator.estimateToolTokens(
        toolDefs,
        ctxMgr.estimator,
      ),
      historyTokens: ctxMgr.historyEstimatedTokens,
    });
    // P5.2 成本记账软指导：缓存命中率高 → 前缀宝贵 → 放宽压缩阈值
    // （少破坏缓存 = 省钱；TokenPilot 定价 output 60× cache-hit）
    if (cacheHitRate > 0) {
      return {
        ...snapshot,
        compactThreshold: costAdjustedCompactThreshold(
          snapshot.compactThreshold,
          cacheHitRate,
        ),
      };
    }
    return snapshot;
  }

  /** Reserve request-only HostState/control space outside durable history. */
  private static reserveRequestProjection(
    snapshot: ContextBudgetSnapshot,
    projectionTokens: number,
  ): ContextBudgetSnapshot {
    const reserved = Math.max(0, Math.ceil(projectionTokens));
    if (reserved === 0) return snapshot;
    const historyBudget = Math.max(
      0,
      snapshot.allocation.historyBudget - reserved,
    );
    const originalBaseThreshold = Math.max(
      0,
      computeCompactThreshold(snapshot.allocation.historyBudget) - 10_000,
    );
    const adjustedFactor =
      originalBaseThreshold > 0
        ? snapshot.compactThreshold / originalBaseThreshold
        : 1;
    const compactThreshold = Math.max(
      0,
      Math.floor(
        Math.max(0, computeCompactThreshold(historyBudget) - 10_000) *
          adjustedFactor,
      ),
    );
    return {
      ...snapshot,
      allocation: { ...snapshot.allocation, historyBudget },
      historyOverBudget: snapshot.historyUsed > historyBudget,
      compactThreshold,
    };
  }

  /**
   * P4.3 逐块账本（VISTA dashboard）：按块粒度输出 context.blocks 事件。
   * 块 = system / 摘要 / pinned / 工具结果 / 对话回合，附 token、轮龄、状态。
   * 与 context.budget 同源（同一 ctxMgr），保证 dashboard 数字 = 记账数字。
   */
  private emitContextBlocks(
    ctx: PhaseContext,
    _snapshot: ContextBudgetSnapshot,
  ): void {
    const messages = ctx.ctxMgr.buildMessages();
    const blocks: {
      readonly id: string;
      readonly type:
        | "system"
        | "summary"
        | "pinned"
        | "tool"
        | "conversation"
        | "recall";
      readonly tokens: number;
      readonly ageTurns: number;
      readonly status: "pinned" | "visible" | "archived";
    }[] = [];
    const counter = { pinned: 0, tool: 0, conv: 0 };
    const turn = ctx.turn;
    // 每回合约 2 条消息，用索引近似消息轮龄
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]!;
      const tokens = ctx.ctxMgr.estimator.countMessages([msg]);
      const ageTurns = Math.max(0, turn - Math.floor(i / 2));
      let type: (typeof blocks)[number]["type"] = "conversation";
      let status: (typeof blocks)[number]["status"] = "visible";
      let id = `C${++counter.conv}`;
      if (msg.role === "system") {
        type = "system";
        status = "pinned";
        id = "S1";
      } else if (isContextSummaryMessage(msg)) {
        type = "summary";
        id = "SUM";
      } else if (
        msg.content.includes("persisted-output") ||
        msg.content.includes("[archived id=")
      ) {
        type = "tool";
        status = "archived";
        id = `T${++counter.tool}`;
      } else if (
        isProtectedUserConstraint(msg) ||
        msg.content.startsWith(CONTEXT_PACKAGE_PREFIX)
      ) {
        type = "pinned";
        status = "pinned";
        id = `P${++counter.pinned}`;
      } else if (msg.content.startsWith("[Tool ")) {
        type = "tool";
        id = `T${++counter.tool}`;
      }
      blocks.push({ id, type, tokens, ageTurns, status });
    }
    // 去重：块账本无变化时不重复发
    const key = JSON.stringify(blocks);
    if (key === this._lastBlocksKey) return;
    this._lastBlocksKey = key;
    ctx.emit({ type: "context.blocks", blocks });
  }

  /**
   * 发出上下文预算事件。
   *
   * 包含去重逻辑：如果连续两轮的预算值完全相同，跳过发射，
   * 避免在 TUI 中刷屏相同的信息。
   */
  private emitContextBudget(
    emit: (event: RunEvent) => void,
    contextWindow: number,
    snapshot: ContextBudgetSnapshot,
  ): void {
    // 去重：值没变就不发
    const key = `${snapshot.systemUsed}/${snapshot.allocation.systemBudget}/${snapshot.historyUsed}/${snapshot.allocation.historyBudget}`;
    if (key === this._lastBudgetKey) return;
    this._lastBudgetKey = key;

    emit({
      type: "context.budget",
      contextWindow,
      systemUsed: snapshot.systemUsed,
      systemBudget: snapshot.allocation.systemBudget,
      toolsUsed: snapshot.toolsUsed,
      toolsBudget: snapshot.allocation.toolsBudget,
      historyUsed: snapshot.historyUsed,
      historyBudget: snapshot.allocation.historyBudget,
      historyOverBudget: snapshot.historyOverBudget,
      systemOverBudget: snapshot.systemOverBudget,
      compactThreshold: snapshot.compactThreshold,
    });
  }
}

// ═════════════════════════════════════════════════════════════
// 错误分类 & 重试策略
// ═════════════════════════════════════════════════════════════

/**
 * 可重试错误类型：
 * - rate_limit：429 限流 → 等 Retry-After 或固定阶梯
 * - server_error：5xx 服务端错误 → 指数退避
 * - timeout：请求超时 → 指数退避
 * - network：网络层故障（DNS/连接重置等）→ 指数退避
 * - transient：其他瞬时错误 → 指数退避
 * - non_retryable：不可重试（4xx 认证/参数错误、熔断器打开、未知错误）
 */
type RetryableErrorType =
  | "rate_limit"
  | "server_error"
  | "timeout"
  | "network"
  | "transient"
  | "non_retryable";

class ModelRequestTimeoutError extends Error {
  constructor(timeoutMs: number, options?: unknown) {
    super(`Model request timeout after ${timeoutMs}ms`, {
      ...(options === undefined ? {} : { cause: options }),
    });
    this.name = "ModelRequestTimeoutError";
  }
}

interface ErrorClassification {
  readonly type: RetryableErrorType;
  /** 限流响应中的 Retry-After 时间（毫秒） */
  readonly retryAfterMs?: number;
}

/**
 * 分类错误以决定重试策略。
 *
 * 采用白名单策略：只对明确的瞬时性错误类型启用重试，
 * 未知错误默认不可重试（安全第一，避免对持久性错误反复重试浪费资源）。
 */
function classifyError(err: unknown): ErrorClassification {
  if (!(err instanceof Error)) {
    // 非 Error 类型的 throw（如 throw "string"）默认不可重试
    return { type: "non_retryable" };
  }
  const msg = err.message;

  if (err instanceof ModelRequestTimeoutError) return { type: "timeout" };

  // 429 限流 — 尝试提取 Retry-After 头
  if (/\b429\b/.test(msg)) {
    const retryAfterMatch = msg.match(/retry[_-]?after[\s:]*(\d+)/i);
    if (retryAfterMatch) {
      const seconds = Number.parseInt(retryAfterMatch[1]!, 10);
      if (Number.isFinite(seconds) && seconds > 0) {
        return { type: "rate_limit", retryAfterMs: seconds * 1000 };
      }
    }
    return { type: "rate_limit" };
  }

  // 5xx 服务端错误（可重试）
  if (/\b5\d\d\b/.test(msg)) return { type: "server_error" };

  // 4xx 客户端错误（不可重试：认证失败、参数错误等）
  if (/\b4\d\d\b/.test(msg)) return { type: "non_retryable" };

  // 超时
  if (/\btimeout\b|ETIMEDOUT/i.test(msg)) return { type: "timeout" };

  // 网络层故障
  if (/fetch|network|ECONN|ENOTFOUND|DNS|ECONNRESET/i.test(msg)) {
    return { type: "network" };
  }

  // 默认：未知错误不重试（白名单策略）
  return { type: "non_retryable" };
}

/** 判断错误是否可以重试 */
function isRetryable(classification: ErrorClassification): boolean {
  return classification.type !== "non_retryable";
}

/**
 * 计算重试延迟。
 *
 * 策略：
 * - 限流（rate_limit）：
 *   - 有 Retry-After → 按指示等待 + 随机抖动
 *   - 无 Retry-After → 固定阶梯：5s → 10s → 20s
 * - 其他可重试错误（server_error/timeout/network/transient）：
 *   - 指数退避：1s → 2s → 4s...，上限 30s
 *   - 每次叠加 0.5x–1.0x 随机抖动，避免惊群效应
 *
 * 为什么要加抖动（jitter）？
 * 多个并发请求同时失败后，如果都在同一个时间点重试，
 * 可能导致服务端再次过载。随机抖动让重试分散在不同的时间点。
 */
function computeRetryDelay(
  attempt: number,
  classification: ErrorClassification,
): number {
  const jitter = 0.5 + Math.random() * 0.5; // 0.5x – 1.0x 随机因子

  if (classification.type === "rate_limit") {
    if (classification.retryAfterMs) {
      return classification.retryAfterMs * jitter;
    }
    // 固定阶梯：第1次 5s，第2次 10s，第3次+ 20s
    const fixed = [5_000, 10_000, 20_000];
    return (fixed[attempt - 1] ?? 20_000) * jitter;
  }

  // 指数退避：base = 1000 * 2^(attempt-1)，上限 30s
  const base = 1_000 * 2 ** (attempt - 1);
  return Math.min(base * jitter, 30_000);
}

// ── 记忆 LLM 接线辅助（v2）──

/**
 * v2 记忆 LLM 接线：
 * - "agent"：蒸馏/精排用主模型（label === "fake" 时跳过——FakeLanguageModel 按序消费预设
 *   响应，背景蒸馏会污染测试的预设序列）；裁决由 v2 runtime 按 settings 解析强模型
 * - "settings"：不传 llm（v2 runtime 内部解析 settings；无配置则降级）
 * - "off"：llm: null 禁用全部 LLM（含 settings 解析，蒸馏降级 append-only / 裁决直 ADD）
 */
function buildMemoryLlmOptions(
  mode: "agent" | "settings" | "off",
  model: LanguageModel,
): {
  llm?: {
    distill: (p: string) => Promise<string>;
    rerank: (p: string) => Promise<string>;
  } | null;
} {
  if (mode === "off") return { llm: null };
  if (mode === "agent" && isRealAdapterModel(model)) {
    const complete = (prompt: string) =>
      model
        .complete([{ role: "user", content: prompt }] satisfies ChatMessage[])
        .then((r) => r.text);
    return { llm: { distill: complete, rerank: complete } };
  }
  // settings / 测试替身模型：由 v2 runtime 自行解析 settings 强模型；解析不到则降级
  return {};
}

/**
 * 是否真实适配器模型（OpenAI/Anthropic 兼容类）。
 * 测试替身（FakeLanguageModel / 内联 stub）不是实例——跳过接线：
 * 背景蒸馏/改写会吞掉测试模型的预设响应序列，且跨进程残留事件会污染后续测试。
 */
function isRealAdapterModel(model: LanguageModel): boolean {
  return (
    model instanceof OpenAICompatibleModel ||
    model instanceof AnthropicCompatibleModel
  );
}
