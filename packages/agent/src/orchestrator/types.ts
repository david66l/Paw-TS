/**
 * Orchestrator 类型定义：状态机状态、轮次标志、上下文。
 * ======================================================
 *
 * 这个文件定义了 AgentOrchestrator 跨轮次通信所需的所有类型。
 * 从 orchestrator.ts 中抽取出来，避免循环依赖和文件膨胀。
 *
 * 核心类型：
 * - TurnState：单轮执行结果的联合类型（状态机输出）
 * - TurnFlags：跨轮次传递的标志（替代可变的 wrapper 对象）
 * - PhaseContext：每轮执行所需的上下文
 * - SubAgentResult：子 Agent 的结果结构
 * - SharedContext：父子 Agent 之间传递的共享上下文
 */

import type {
  AgentAction,
  AgentToolCallAction,
  ArtifactRegistry,
  ChatMessage,
  ContextManager,
  ModelTokenUsage,
  RunEvent,
  RunEventEnvelope,
} from "@paw/core";
import type { McpClientManager } from "@paw/harness";
import type { MemoryRuntime } from "@paw/memory";
import type { LanguageModel, ToolDefinition } from "@paw/models";
import type { TaskPlanner } from "@paw/store";
import type { CandidateReviewer } from "../candidate-review.js";
import type { CapabilityExposureShadowV1 } from "../capability-exposure.js";
import type { CapabilitySetV1 } from "../capability-set.js";
import type { ExecutionEnvironmentRegistryV1 } from "../execution-environment.js";
import type { CodingPhaseState } from "../lifecycle/coding-phase.js";
import type { CompletionDecision } from "../lifecycle/completion-policy.js";
import type { RepeatToolState } from "../lifecycle/repeat-tool-reminder.js";
import type { VerificationPolicy } from "../lifecycle/verification-gate.js";
import type {
  ControlReductionV1,
  LoopKernelVersion,
  LoopV2LiveCandidateAssessmentV1,
  LoopV2ShadowToolCommitPortInput,
  ProviderTerminalStateV2,
  SemanticReviewOnceResultV2,
  VerificationProbeOnceResultV2,
  VerificationRecordV2,
} from "../loop-v2/index.js";
import type { ManagedJobControllerV1 } from "../managed-job-controller.js";
import type { RunStatusTelemetryV1 } from "../status-snapshot.js";
import type { TaskStateManager } from "../task-state.js";

// ═════════════════════════════════════════════════════════════
// TurnState：单轮状态机
// ═════════════════════════════════════════════════════════════

/**
 * 单个父 Agent 轮次的显式状态。
 *
 * 设计思路：使用联合类型（discriminated union）建模状态机，
 * 每种状态携带不同的数据。TypeScript 会根据 type 字段自动窄化类型。
 *
 * 状态转移：
 * model_calling → action_dispatch | tool_executing | waiting_children | ...
 * action_dispatch → user_waiting | plan_updating | decided | continue
 * tool_executing → continue | decided
 * waiting_children → merging_results → continue | decided
 * continue → model_calling（下一轮循环）
 * decided → 循环终止；status/outcome/reason 由 CompletionPolicy 唯一产生
 */
export type TurnState =
  /** 正在调用模型 */
  | { readonly type: "model_calling" }
  /** 模型返回了结构化 action（非工具调用）*/
  | {
      readonly type: "action_dispatch";
      readonly actions: AgentAction[];
      readonly text: string;
      readonly thinking?: string;
    }
  /** 模型返回了工具调用 */
  | {
      readonly type: "tool_executing";
      readonly calls: AgentToolCallAction[];
      readonly text: string;
      readonly thinking?: string;
    }
  /** 等待子 Agent 完成 */
  | {
      readonly type: "waiting_children";
      readonly childIds: readonly string[];
      readonly text: string;
      readonly thinking?: string;
    }
  /** 正在合并子 Agent 结果 */
  | {
      readonly type: "merging_results";
      readonly results: SubAgentResult[];
      readonly text: string;
      readonly thinking?: string;
    }
  /** 等待用户回复 */
  | {
      readonly type: "user_waiting";
      readonly question: string;
      readonly text: string;
      readonly thinking?: string;
    }
  /** 正在更新计划 */
  | {
      readonly type: "plan_updating";
      readonly items: readonly unknown[];
      readonly text: string;
      readonly thinking?: string;
    }
  /** CompletionPolicy 已作出唯一裁决；外层只能持久化/映射，不得重算。 */
  | { readonly type: "decided"; readonly decision: CompletionDecision }
  /** 继续下一轮（携带更新后的 flags）*/
  | { readonly type: "continue"; readonly nextFlags: TurnFlags };

// ═════════════════════════════════════════════════════════════
// TurnFlags：跨轮次状态
// ═════════════════════════════════════════════════════════════

/**
 * 跨轮次传递的标志。
 *
 * 为什么用 immutable 替换而非 mutable 对象？
 * - 原实现用可变 wrapper（{ value: number }），每次修改是隐式的
 * - 新设计每轮返回新的 flags 对象，状态变化显式可见
 * - 符合 React/Redux 式的 immutable 更新模式，方便调试和测试
 */
export interface TurnFlags {
  /** 自动推动次数（防止死循环） */
  readonly autoContinueNudges: number;
  /** Consecutive model turns with no parseable action after tool use. */
  readonly noActionNudges?: number;
  /** 格式错误反馈次数（输出无法解析时回灌给模型，防止死循环） */
  readonly formatErrorNudges?: number;
  /** VerificationGate nudge 次数 */
  readonly verifyNudges?: number;
  /** AcceptanceGate feedback attempts, independent from plan and verification. */
  readonly acceptanceNudges?: number;
  /** Independent candidate-review feedback attempts for one source revision. */
  readonly candidateReviewNudges?: number;
  /** Revision to which candidateReviewNudges belongs. */
  readonly candidateReviewRevision?: number;
  /** Proposed-summary digest to which report-grounding nudges belong. */
  readonly candidateReviewSummaryFingerprint?: string;
  /** 上一轮是否执行了工具调用 */
  readonly lastTurnHadToolCall: boolean;
  /** 本轮 Run 中是否使用过工具 */
  readonly hasEverUsedTools: boolean;
  /** Idle-fuse：近期失败签名 */
  readonly failureSignatures?: readonly string[];
  /** Idle-fuse 已触发次数 */
  readonly idleFuseTrips?: number;
  /** maxSteps 警告是否已发出（私有字段，_ 前缀表示内部使用） */
  _maxStepsWarned?: boolean;
  /** Last revision-scoped closeout state injected; unchanged states dedupe. */
  _convergenceEvidenceKey?: string;
  /** Mid-run no-mutation checkpoint has been injected. */
  _implementationWarned?: boolean;
  /** [require_mutation] coding tasks: bounded locate/edit/verify phase state. */
  readonly codingPhase?: CodingPhaseState;
  /** Consecutive model turns attempting tools blocked by CodingPhase. */
  readonly codingPhaseViolationTurns?: number;
  /** Advisory chain for consecutive tool calls with identical arguments. */
  readonly repeatTool?: RepeatToolState;
  /** Explicit-v2 provider response cursor and bounded protocol-recovery state. */
  readonly providerTerminal?: ProviderTerminalStateV2;
  /** Stable candidate+gap identity that already received v2 repair feedback. */
  readonly loopV2ReadinessFeedbackKey?: string;
  /** Feedback count for the matching v2 readiness identity (currently 0 or 1). */
  readonly loopV2ReadinessNudges?: number;
}

// ═════════════════════════════════════════════════════════════
// PhaseContext：每轮上下文
// ═════════════════════════════════════════════════════════════

/**
 * 每轮执行时传递给所有阶段处理器的上下文。
 *
 * 包含本轮需要的一切：运行标识、模型实例、工具定义、上下文管理器、
 * 事件发射器、计划器等。所有字段 readonly 保证跨阶段不可变。
 */
export interface PhaseContext {
  readonly runId: string;
  readonly loopKernelVersion?: LoopKernelVersion;
  readonly workspaceRoot: string;
  /** 当前轮次（0-based） */
  readonly turn: number;
  readonly maxSteps: number;
  /** 外部中断信号 */
  readonly signal?: AbortSignal;
  readonly model: LanguageModel;
  /** MCP 客户端管理器（可选，未配置 MCP 时为 undefined） */
  readonly mcp?: McpClientManager;
  readonly toolDefs: readonly ToolDefinition[];
  /** 工具名映射表：sanitized → original */
  readonly toolNameMap: Map<string, string>;
  /** Single authority for model schema, parser acceptance, and execution. */
  readonly capabilitySet: CapabilitySetV1;
  readonly ctxMgr: ContextManager;
  readonly planner: TaskPlanner;
  readonly taskState: TaskStateManager;
  /** Host-owned execution telemetry; advisory and never a completion authority. */
  readonly statusTelemetry: RunStatusTelemetryV1;
  /** Durable host facts for the actual shell execution world. */
  readonly executionEnvironment: ExecutionEnvironmentRegistryV1;
  /** Run-owned background job lifecycle and settlement barrier. */
  readonly managedJobs: ManagedJobControllerV1;
  /** Full-exposure shadow selector; measures a smaller set without applying it. */
  readonly capabilityExposure: CapabilityExposureShadowV1;
  /** 事件发射器 */
  readonly emit: (event: RunEvent) => void;
  /** Checkpoint 序列号（可变引用，用于工具执行前后保存快照） */
  readonly checkpointSeq: { n: number };
  /** 用户的原始目标文本 */
  readonly specGoal: string;
  /** Shell 沙箱配置 */
  readonly shellSandbox?: import("@paw/harness").ShellSandboxConfig;
  /** 会话级工具输出去重器（P1 入口闸，orchestrator 每 run 一个） */
  readonly payloadDeduper?: import("./truncate-payload.js").PayloadDeduper;
  /** P3 冷库：会话级可寻址归档注册表（context.recall 工具 + 截断全文归档） */
  readonly artifactRegistry?: ArtifactRegistry;
  /** 新记忆 Runtime（db 后端）；file 模式为 undefined */
  readonly memoryRuntime?: MemoryRuntime;
  /** 当前 TaskSession id */
  readonly memoryTaskId?: string;
  /** Trusted authority for completion evidence; never derived from model text. */
  readonly verificationPolicy?: VerificationPolicy;
  /** Optional independent semantic reviewer; absent means the gate is disabled. */
  readonly candidateReviewer?: CandidateReviewer;
  /** Strict persisted assessment created before final-answer dispatch. */
  readonly getLoopV2CandidateAssessment?: () =>
    | LoopV2LiveCandidateAssessmentV1
    | undefined;
  /** Live investigation-progress identity for bounded readiness repair. */
  readonly getLoopV2ReadinessProgressKey?: () => string | undefined;
  /** Fresh current-revision verification facts for actionable repair text. */
  readonly getLoopV2ReadinessVerificationRecords?: () =>
    | readonly VerificationRecordV2[]
    | undefined;
  /** Latest pure-reducer result after a control fact was journaled. */
  readonly getLoopV2ControlReduction?: () => ControlReductionV1 | undefined;
  /** Candidate-bound, durable, at-most-once explicit-v2 review transaction. */
  readonly reviewLoopV2Candidate?: () => Promise<
    SemanticReviewOnceResultV2 &
      Readonly<{
        readonly modelCalls: number;
        readonly usage?: ModelTokenUsage;
      }>
  >;
  /**
   * Candidate-bound adversarial verification probe (fresh context, host
   * executed, at-most-once per candidateInputHash). Absent disables the gate.
   */
  readonly probeLoopV2Candidate?: () => Promise<VerificationProbeOnceResultV2>;
  /** Read-only shadow observation after the matching legacy tool.result. */
  readonly observeLoopV2ToolCommit?: (
    input: LoopV2ShadowToolCommitPortInput,
  ) => void;
}

// ═════════════════════════════════════════════════════════════
// SubAgentResult：子 Agent 结果
// ═════════════════════════════════════════════════════════════

/** 子 Agent 产出的制品：文件、代码、测试结果、搜索结果 */
export interface SubAgentArtifact {
  readonly type: "file" | "code" | "test_result" | "search_result";
  readonly path?: string;
  readonly content: string;
  readonly summary: string;
}

/**
 * 子 Agent 的运行结果。
 *
 * 关键设计：result 只向父 Agent 返回精简的摘要（summary），
 * 完整的 trace（messages + events）保留但不注入父 Agent 上下文。
 * 这样父 Agent 上下文不会被子 Agent 的详细对话撑爆。
 */
export interface SubAgentResult {
  readonly status: "completed" | "failed";
  /** 精简摘要：父 Agent 的模型看到的就是这个 */
  readonly summary: string;
  readonly findings?: readonly string[];
  readonly changedFiles?: readonly string[];
  readonly testsRun?: readonly {
    readonly name: string;
    readonly passed: boolean;
  }[];
  readonly errors?: readonly string[];
  readonly artifacts?: readonly SubAgentArtifact[];
  /**
   * 完整追踪数据：用于调试/回放/TUI 展示。
   * 注意：不会被注入到父 Agent 上下文，避免 token 爆炸。
   */
  readonly trace?: {
    readonly messages: readonly ChatMessage[];
    readonly events: readonly RunEventEnvelope[];
    readonly stepsTaken: number;
  };
}

// ═════════════════════════════════════════════════════════════
// SharedContext：父子 Agent 共享上下文
// ═════════════════════════════════════════════════════════════

/** 上下文制品：父 Agent 传递给子 Agent 的参考材料 */
export interface ContextArtifact {
  readonly type: "file" | "code" | "url" | "search_result";
  readonly path?: string;
  readonly content: string;
  /** 相关性等级：critical（关键）> relevant（相关）> reference（参考） */
  readonly relevance: "critical" | "relevant" | "reference";
}

/**
 * 父 Agent 传递给子 Agent 的结构化上下文。
 *
 * 由 ContextSummarizer 从父 Agent 的完整对话历史中压缩生成。
 * 包含：角色描述、任务说明、已知事实、约束条件、相关文件、已完成/待办事项。
 */
export interface SharedContext {
  /** 子 Agent 的角色 */
  readonly role: string;
  /** 具体的任务描述 */
  readonly task: string;
  /** 已知事实 */
  readonly facts: readonly string[];
  /** 约束条件 */
  readonly constraints: readonly string[];
  /** 相关文件/代码/URL */
  readonly artifacts: readonly ContextArtifact[];
  /** 当前状态 */
  readonly state: {
    readonly completed: readonly string[];
    readonly pending: readonly string[];
    readonly risks?: readonly string[];
  };
  /** 期望的输出格式 */
  readonly outputFormat: string;
  /** 父 Agent 已有的结论 */
  readonly parentConclusions?: readonly {
    readonly conclusion: string;
    readonly confidence: "high" | "medium" | "low";
  }[];
  /** 子 Agent 策略：默认 read_only 避免并发文件冲突 */
  readonly childPolicy?: "read_only" | "read_write";
}

// ═════════════════════════════════════════════════════════════
// 子 Agent 状态（用于状态树展示）
// ═════════════════════════════════════════════════════════════

/** 子 Agent 的执行阶段 */
export type ChildPhase =
  | "queued"
  | "model_calling"
  | "action_dispatch"
  | "tool_executing"
  | "completed"
  | "failed"
  | "cancelled";

/** 单个子 Agent 的状态快照 */
export interface ChildAgentState {
  readonly agentId: string;
  readonly goal: string;
  readonly phase: ChildPhase;
  /** 进度百分比（0-100） */
  readonly progress: number;
  /** 当前正在执行的任务 */
  readonly currentTask?: string;
  readonly result?: SubAgentResult;
  readonly error?: string;
}

/** Agent 运行状态树（递归结构，用于 TUI 展示嵌套的子 Agent） */
export interface AgentRunState {
  readonly runId: string;
  readonly phase: string;
  readonly progress: number;
  readonly children?: readonly AgentRunState[];
}
