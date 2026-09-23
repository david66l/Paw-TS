/**
 * AgentOrchestrator 的公开构造选项与审批回调入参。
 *
 * 从 `orchestrator.ts` 抽出，让「运行环境如何注入」有一处可读的定义；
 * `orchestrator.ts` 会把这三个名字原样再导出，导入路径保持不变。
 */

import type {
  AppStateStore,
  ContextManager,
  CostTracker,
  EvalHooks,
  RunEventEnvelope,
  SessionStore,
  SkillRegistry as SkillRegistryType,
  TodoStore,
} from "@paw/core";
import type { LanguageModel } from "@paw/models";
import type { McpServerConfig, SubAgentLauncher } from "@paw/tools";
import type { WorkspaceWatcher } from "@paw/workspace";
import type { CandidateReviewer } from "../candidate-review.js";
import type { ToolEffectPolicy, ToolExecutionPolicy } from "../execution-policy.js";
import type { VerificationPolicy } from "../lifecycle/verification-gate.js";
import type {
  LoopKernelVersion,
  LoopV2LiveCandidateAssessmentV1,
  LoopV2ShadowReport,
} from "../loop-v2/index.js";
import type { MeaAuditorConfig } from "../mea/index.js";
import type { SharedContext } from "./types.js";

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
  /** MEA 独立审计配置（off/shadow/enforce）；仅顶层运行启用，子运行不继承。 */
  readonly meaAuditor?: MeaAuditorConfig;
  /** 并行子 Agent 的文件锁（仅子 Agent orchestrator 注入；root 不传） */
  readonly fileLock?: import("@paw/tools").FileLockLike;
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
  readonly createAgent?: import("@paw/tools").HarnessContext["createAgent"];
  /** P5.1 侧信道 monitor 配置（采样率/冷却/预算软启动，测试可注入） */
  readonly monitorOptions?: import("@paw/core").ContextMonitorOptions;
  /** Trusted, task-scoped policy checked before tool side effects. */
  readonly toolExecutionPolicy?: ToolExecutionPolicy;
  /** Trusted before/after audit for filesystem or process effects. */
  readonly toolEffectPolicy?: ToolEffectPolicy;
  /** Trusted completion authority; defaults to local verification. */
  readonly verificationPolicy?: VerificationPolicy;
  /** Trusted execution environment override; workspace settings are the fallback. */
  readonly shellSandbox?: import("@paw/tools").ShellSandboxConfig;
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
  readonly onLoopV2CandidateAssessment?: (assessment: LoopV2LiveCandidateAssessmentV1) => void;
}
