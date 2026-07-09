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
  type AppState,
  type AppStateStore,
  type AgentToolCallAction,
  ContextCompactor,
  CONTEXT_SUMMARY_PREFIX,
  ContextManager,
  type CostTracker,
  MAX_STEPS_WARNING,
  type ModelTokenUsage,
  type RunEvent,
  type RunEventEnvelope,
  type RunResult,
  type RunSpec,
  SessionMemoryStore,
  type SessionStore,
  SkillRegistry,
  type SkillRegistry as SkillRegistryType,
  type TodoStore,
  stripContextSummaryMessages,
  buildSystemPromptWithBudget,
  allocateContextBudget,
  extractCleanMemoryQuery,
  findPawRoot,
  formatTodosForPrompt,
  loadProjectMemory,
  loadSkillsFromDirectory,
  skillsFromProjectMemory,
  measureContextBudget,
  meetsCompressionSavingsThreshold,
  shouldCompactHistory,
  validateCompressionSummary,
  getToolResultsDir,
  DEFAULT_KEEP_RECENT_TOOLS,
  restoreCheckpoint,
  type ContextBudgetSnapshot,
  type EvalHooks,
  type TokenEstimator,
} from "@paw/core";

// ─────────────────────────────────────────────────────────────
// @paw/harness：执行层 — MCP 客户端、工具定义、Shell 沙箱
// ─────────────────────────────────────────────────────────────
import {
  McpClientManager,
  type McpServerConfig,
  type SubAgentLauncher,
  toolCatalogText,
  toolDefinitions,
  toolNameReverseMap,
} from "@paw/harness";

// ─────────────────────────────────────────────────────────────
// @paw/models：LLM 适配层 — 模型抽象、消息类型、流式解析
// ─────────────────────────────────────────────────────────────
import {
  type ChatMessage,
  type LanguageModel,
  type NativeToolCall,
  createDefaultLanguageModel,
  extractThinkBlocks,
} from "@paw/models";

// ─────────────────────────────────────────────────────────────
// @paw/store：计划/任务持久化
// ─────────────────────────────────────────────────────────────
import { type PlanItem, TaskPlanner } from "@paw/store";

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

import { runCompressionAgent } from "./compression-agent.js";
import { buildChildSystemPrompt } from "./child-system-prompt.js";
import { CONTEXT_PACKAGE_PREFIX } from "./orchestrator/constants.js";
import { handleAction } from "./orchestrator/action-handlers.js";
import { AgentGroup } from "./orchestrator/agent-group.js";
import type {
  PhaseContext,
  SharedContext,
  TurnFlags,
  TurnState,
} from "./orchestrator/types.js";
import {
  parseAgentActionFromModelText,
  parseAgentActionsFromModelText,
  toolCallDedupKey,
} from "./parse-agent-action.js";
import { resolveMaxSteps } from "./resolve-max-steps.js";
import { resolveShellSandboxConfig } from "./resolve-shell-sandbox.js";
import {
  CircuitBreaker,
  CircuitBreakerOpenError,
} from "./resilience/circuit-breaker.js";
import { TaskStateManager } from "./task-state.js";
import {
  createMemoryRuntime,
  type MemoryRuntime,
} from "@paw/memory";

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
  /**
   * 运行后记忆提取策略：
   * - "background"：后台异步提取，不阻塞响应（默认）
   * - "await"：同步等待提取完成
   * - "off"：关闭记忆提取
   */
  readonly memoryExtraction?: "background" | "await" | "off";
  /** 评估钩子：非侵入式收集 trace 数据，不影响正常流程 */
  readonly evalHooks?: EvalHooks;
}

// ═════════════════════════════════════════════════════════════
// AgentOrchestrator：核心调度器
// ═════════════════════════════════════════════════════════════

export class AgentOrchestrator {
  // ── 静态常量 ──

  /** 压缩冷却轮数：一次压缩后至少等 N 轮才允许再次压缩，避免频繁压缩影响体验 */
  private static readonly COMPACT_COOLDOWN_TURNS = 5;

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
  private static readonly MODEL_TIMEOUT_MS = 120_000;

  /** 上下文预算去重键：避免连续两轮发出完全相同的 budget 事件 */
  private static _lastBudgetKey: string | null = null;

  // ── 实例属性 ──

  private readonly overrideModel?: LanguageModel;
  private readonly onEvent?: (envelope: RunEventEnvelope) => void;
  private readonly planSnapshotMaxItems?: number;
  private readonly resolveAskUser?: AgentOrchestratorOptions["resolveAskUser"];
  private readonly resolveToolApproval?: AgentOrchestratorOptions["resolveToolApproval"];
  private readonly approvalPolicy?: AgentOrchestratorOptions["approvalPolicy"];
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

  // 记忆 Runtime（Postgres）
  private _memoryRuntime: MemoryRuntime | null = null;
  private _memoryTaskId: string | null = null;
  private _memoryContextSection = "";
  private _lastDynamicMemoryGoal = "";
  private _contextPackageCode: readonly CodeContextBlock[] = [];
  /** 流式恢复文件路径：模型输出时实时写盘，崩了可用于恢复 */
  private _streamRecoveryPath?: string;
  private readonly retrySleep: (ms: number) => Promise<void>;
  /** @deprecated 长期记忆写入已由 MemoryRuntime.completeTask 接管 */
  private readonly memoryExtraction: "background" | "await" | "off";
  /** 熔断器映射：key = model.label，每个模型独立熔断 */
  private readonly circuitBreakers = new Map<string, CircuitBreaker>();
  private readonly evalHooks?: EvalHooks;

  constructor(opts?: AgentOrchestratorOptions) {
    this.overrideModel = opts?.model;
    this.onEvent = opts?.onEvent;
    this.planSnapshotMaxItems = opts?.planSnapshotMaxItems;
    this.resolveAskUser = opts?.resolveAskUser;
    this.resolveToolApproval = opts?.resolveToolApproval;
    this.approvalPolicy = opts?.approvalPolicy;
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
    this.memoryExtraction = opts?.memoryExtraction ?? "background";
    void this.memoryExtraction; // kept for API compat; writes go through Runtime
    this.evalHooks = opts?.evalHooks;
    // 如果传入了 skillsDir，从目录批量加载 skill 并注册
    if (opts?.skillsDir) {
      const skills = loadSkillsFromDirectory(opts.skillsDir);
      for (const skill of skills) {
        this.skillRegistry.register(skill);
      }
    }
  }

  /** 描述信息：用于日志和调试 */
  describe(): string {
    return "AgentOrchestrator (TS): model + harness tool loop + run events.";
  }

  // ─────────────────────────────────────────────────────────
  // resumeRun：断点续跑
  // ─────────────────────────────────────────────────────────

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

    const loaded = await Promise.resolve(
      this.appStateStore.load(opts.runId),
    );
    if (!loaded) {
      return {
        runId: opts.runId,
        status: "failed",
        message: `Cannot resume: no saved state found for run "${opts.runId}"`,
      };
    }

    const workspaceRoot =
      opts.workspaceRoot?.trim()
        ? path.resolve(opts.workspaceRoot)
        : loaded.workspaceRoot;

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
    let resumeState = loaded;
    if (opts.fromTurn !== undefined && opts.fromTurn >= 0) {
      restoreCheckpoint(workspaceRoot, opts.runId, opts.fromTurn, {
        backup: true,
      });
      resumeState = { ...loaded, turn: opts.fromTurn };
    }

    return this.run({
      runId: opts.runId,
      goal: resumeState.goal,
      workspaceRoot,
      maxSteps: resumeState.maxSteps,
      abortSignal: opts.abortSignal,
      resumeFromState: resumeState,
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
    let emitRunMetrics:
      | ((status: "completed" | "failed") => void)
      | undefined;

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
        ctxMgr,
        planner,
        sessionMemoryStore,
        compactor,
        emit,
        emitRunMetrics: _emitRunMetrics,
        checkpointSeq,
        shellSandbox,
        taskState,
      } = init;
      emitRunMetrics = _emitRunMetrics;
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
      let flags: TurnFlags = {
        autoContinueNudges: 0,
        lastTurnHadToolCall: false,
        hasEverUsedTools: false,
      };

      // 捕获到闭包中，供 executeTurn 使用
      const turnCompactor = compactor;
      const turnSessionMemoryStore = sessionMemoryStore;

      // 初始化空计划
      planner.createPlan(runId, []);

      // ═══ 主循环：ReAct 循环的核心 ═══
      // 每轮 = 一次完整的 model → parse → action → feedback 周期
      for (let turn = startTurn; turn < maxSteps; turn++) {
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
                status: "failed",
                message,
            },
          );
          emit({ type: "run.completed", status: "failed", message });
          emitRunMetrics("failed");
          return { runId, status: "failed", message };
        }

        // 构造当前轮次的上下文对象（PhaseContext）
        // PhaseContext 包含这一轮需要的所有信息，传递给 executeTurn
        const phaseCtx: PhaseContext = {
          runId,
          workspaceRoot,
          turn,
          maxSteps,
          signal,
          model,
          mcp,
          toolDefs,
          toolNameMap,
          ctxMgr,
          planner,
          taskState,
          emit,
          checkpointSeq,
          specGoal: spec.goal,
          shellSandbox,
          ...(this._memoryRuntime
            ? { memoryRuntime: this._memoryRuntime }
            : {}),
          ...(this._memoryTaskId
            ? { memoryTaskId: this._memoryTaskId }
            : {}),
        };

        // 执行一轮
        const state = await this.executeTurn(
          phaseCtx,
          flags,
          agentGroup,
          turnCompactor,
          turnSessionMemoryStore,
        );

        // 状态机判断：
        // - "continue"：模型返回了工具调用，继续下一轮
        // - "completed"：模型返回了 final 动作，任务完成
        // - "failed"：发生了不可恢复的错误
        if (state.type === "continue") {
          flags = state.nextFlags;
          continue;
        }

        if (state.type === "completed" || state.type === "failed") {
          // 保存断点续跑状态
          this.saveState(
            runId,
            spec.goal,
            workspaceRoot,
            turn + 1,
            maxSteps,
            ctxMgr,
            planner,
            taskState,
            {
              status: state.type,
              message: state.message,
            },
          );
          emit({
            type: "run.completed",
            status: state.type,
            message: state.message,
          });
          emitRunMetrics(state.type);

          if (state.type === "completed" || state.type === "failed") {
            // 唯一长期记忆写入：MemoryRuntime.completeTask
            if (this._memoryRuntime && this._memoryTaskId) {
              try {
                const writeResult = await this._memoryRuntime.completeTask({
                  taskId: this._memoryTaskId,
                  status: state.type === "completed" ? "completed" : "failed",
                  finalMessage: state.message,
                });
                emit({
                  type: "memory.extracted",
                  runId,
                  entries: writeResult.writtenMemoryIds.length,
                  rejected:
                    writeResult.rejected + writeResult.pendingReview,
                });
              } catch {
                /* best-effort */
              }
            }
          }
          return { runId, status: state.type, message: state.message };
        }
      }

      // 循环耗尽：maxSteps 轮后仍未得到 final 动作
      // 若已用过工具且有 assistant 文本，降级为 completed（避免最后一轮 nudge 浪费后整 run 变 failed）
      const lastAssistant = [...ctxMgr.buildMessages()]
        .reverse()
        .find((m) => m.role === "assistant" && m.content.trim().length > 0);
      const softMessage = lastAssistant?.content.trim();
      if (flags.hasEverUsedTools && softMessage) {
        const message = softMessage;
        this.saveState(
          runId,
          spec.goal,
          workspaceRoot,
          maxSteps,
          maxSteps,
          ctxMgr,
          planner,
          taskState,
          { status: "completed", message },
        );
        emit({ type: "run.completed", status: "completed", message });
        emitRunMetrics?.("completed");
        if (this._memoryRuntime && this._memoryTaskId) {
          try {
            const writeResult = await this._memoryRuntime.completeTask({
              taskId: this._memoryTaskId,
              status: "completed",
              finalMessage: message,
            });
            emit({
              type: "memory.extracted",
              runId,
              entries: writeResult.writtenMemoryIds.length,
              rejected: writeResult.rejected + writeResult.pendingReview,
            });
          } catch {
            /* best-effort */
          }
        }
        return { runId, status: "completed", message };
      }

      const exhaustedMessage = "internal: model loop exhausted without return";
      this.saveState(
        runId,
        spec.goal,
        workspaceRoot,
        maxSteps,
        maxSteps,
        ctxMgr,
        planner,
        taskState,
        {
          status: "failed",
          message: exhaustedMessage,
        },
      );
      emitRunMetrics?.("failed");
      return { runId, status: "failed", message: exhaustedMessage };
    } catch (e) {
      // 异常安全：即使初始化未完成（init 为 undefined），也返回合理的错误
      const message =
        e instanceof Error
          ? e.name === "AbortError"
            ? "Run aborted."
            : e.message
          : String(e);
      if (init) {
        const { runId, workspaceRoot, maxSteps, ctxMgr, planner, taskState, emit } = init;
        this.saveState(
          runId,
          spec.goal,
          workspaceRoot,
          maxSteps,
          maxSteps,
          ctxMgr,
          planner,
          taskState,
          {
            status: "failed",
            message,
          },
        );
        emit({ type: "run.failed", message });
        emit({ type: "run.completed", status: "failed", message });
        emitRunMetrics?.("failed");
        return { runId, status: "failed", message };
      }
      return { runId: spec.runId, status: "failed", message };
    } finally {
      // 无论如何都要断开 MCP 连接（避免资源泄漏）
      await init?.mcp?.disconnectAll();
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
   * 去重：多个相同工具+相同参数的调用只保留第一个（toolCallDedupKey）。
   */
  private async callModelAndParseActions(
    ctx: PhaseContext,
    toolDefs: readonly import("@paw/models").ToolDefinition[],
    toolNameMap: Map<string, string>,
  ): Promise<{
    text: string;
    thinking: string | undefined;
    toolCalls: AgentToolCallAction[];
    singleAction: import("@paw/core").AgentAction | null;
    reasoningText: string;
  }> {
    const { model, ctxMgr, signal, emit } = ctx;

    // 评估钩子：模型调用前记录 messages（用于训练数据收集）
    this.evalHooks?.beforeModelCall?.({
      messages: ctxMgr.buildMessages(),
      contextManager: ctxMgr,
    });
    const modelCallStart = Date.now();

    // 核心：调用模型（带熔断和重试）
    const { text, thinking, nativeToolCalls } = await this.invokeModel(
      model,
      ctxMgr.buildMessages(),
      signal,
      emit,
      toolDefs,
      toolNameMap,
    );

    emit({ type: "phase", name: "parse" });

    // 已知工具名集合：同时包含 sanitized 名和原名，用于过滤无效调用
    const knownTools = new Set([
      ...toolNameMap.values(),
      ...toolNameMap.keys(),
    ]);

    let toolCalls: AgentToolCallAction[];
    let reasoningText: string;

    // 通道 1：原生 tool_use → 直接映射为 AgentToolCallAction
    if (nativeToolCalls && nativeToolCalls.length > 0) {
      toolCalls = nativeToolCalls
        .map((tc) => {
          // 将 sanitized 工具名还原为原始名（如 "Bash" → "Bash(git *)"）
          const originalName = toolNameMap.get(tc.name) ?? tc.name;
          return {
            type: "tool_call" as const,
            tool: originalName,
            args: tc.arguments,
          };
        })
        .filter((tc): tc is AgentToolCallAction => knownTools.has(tc.tool));
      // 去重：相同工具+相同参数的调用只保留一个
      const seen = new Set<string>();
      toolCalls = toolCalls.filter((tc) => {
        const key = toolCallDedupKey(tc.tool, tc.args);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      reasoningText = text;
    } else {
      // 通道 2：文本解析 → 从模型输出中提取工具调用
      const parsed = parseAgentActionsFromModelText(text, { knownTools });
      toolCalls = parsed.actions;
      reasoningText = parsed.text;
    }

    // 如果没有提取到工具调用，尝试解析单个 action（可能是 final/ask_user/abort）
    const singleAction =
      toolCalls.length === 0
        ? parseAgentActionFromModelText(text, { knownTools })
        : null;

    // 评估钩子：模型调用后记录响应（延迟、工具调用等）
    this.evalHooks?.afterModelCall?.({
      turnIndex: ctx.turn,
      responseText: text,
      thinking,
      toolCalls: toolCalls.length > 0
        ? toolCalls.map((tc) => ({ tool: tc.tool, args: tc.args }))
        : undefined,
      usage: undefined,
      latencyMs: Date.now() - modelCallStart,
    });

    return { text, thinking, toolCalls, singleAction, reasoningText };
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
   * 4. meetsCompressionSavingsThreshold()：确保节省 ≥ 15%
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
  ): Promise<void> {
    const { runId, workspaceRoot, signal, model, ctxMgr, emit } = ctx;
    const historyTokensBeforeCompact = budgetSnapshot.historyUsed;
    const auxModel = this.auxiliaryModel ?? model;

    // 检查是否应该跳过压缩
    if (
      !shouldCompactHistory(budgetSnapshot) ||
      this.compactCooldownTurns > 0 ||
      compactor.isDisabled ||
      compactor.shouldSkipDueToThrashing()
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
      const middleMessages = stripContextSummaryMessages(
        messages.slice(boundaries.headEnd + 1, boundaries.tailStart),
      );
      const tailMessages = stripContextSummaryMessages(
        messages.slice(boundaries.tailStart),
      );

      // 没有中间段就不需要压缩
      if (middleMessages.length === 0) {
        emit({
          type: "compression.skipped",
          reason: "no middle segment to compact",
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
      const { summary, sessionMemory } = await runCompressionAgent(
        auxModel,
        prompt,
        runId,
        signal,
      );

      // 验证摘要质量：长度合理、包含关键信息、不是胡言乱语
      const quality = validateCompressionSummary(summary);
      if (!quality.ok) {
        compactor.recordResult(
          historyTokensBeforeCompact,
          historyTokensBeforeCompact,
          false,
        );
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
      const newMessages = [...headMessages, summaryMsg, ...tailMessages];
      const newHistory = newMessages.filter((m) => m.role !== "system");
      const afterHistoryTokens = ctxMgr.estimator.countMessages(newHistory);

      // 检查压缩收益：至少节省 15% 的 token 才算值得
      if (
        !meetsCompressionSavingsThreshold(
          historyTokensBeforeCompact,
          afterHistoryTokens,
        )
      ) {
        compactor.recordResult(
          historyTokensBeforeCompact,
          historyTokensBeforeCompact,
          false,
        );
        emit({
          type: "compression.skipped",
          reason: "insufficient compression savings (<15%)",
        });
        return;
      }

      // 应用压缩结果
      ctxMgr.replaceHistory(newMessages);
      const memoryToSave = {
        ...sessionMemory,
        project: path.basename(workspaceRoot),
      };
      sessionMemoryStore.save(runId, memoryToSave);
      emit({
        type: "compression.auto_compact.done",
        afterTokens: ctxMgr.historyEstimatedTokens,
        summaryTokens: Math.ceil(summary.length / 4),
      });
      compactor.recordResult(
        historyTokensBeforeCompact,
        afterHistoryTokens,
        true,
      );

      // 设置冷却期：避免连续压缩
      this.compactCooldownTurns = AgentOrchestrator.COMPACT_COOLDOWN_TURNS;

    } catch (err) {
      compactor.recordResult(
        historyTokensBeforeCompact,
        historyTokensBeforeCompact,
        false,
      );
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
      const middleMessages = stripContextSummaryMessages(
        messages.slice(boundaries.headEnd + 1, boundaries.tailStart),
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

      const summaryMsg: ChatMessage = {
        role: "user",
        content: `${CONTEXT_SUMMARY_PREFIX}\n${summary}`,
      };
      const newMessages = [...headMessages, summaryMsg, ...tailMessages];
      const afterTokens = ctxMgr.estimator.countMessages(
        newMessages.filter((m) => m.role !== "system"),
      );

      if (!meetsCompressionSavingsThreshold(beforeTokens, afterTokens)) {
        compactor.recordResult(beforeTokens, beforeTokens, false);
        emit({
          type: "compression.skipped",
          reason: "insufficient compression savings (<15%)",
        });
        return;
      }

      ctxMgr.replaceHistory(newMessages);
      sessionMemoryStore.save(runId, {
        ...sessionMemory,
        project: path.basename(workspaceRoot),
      });

      emit({
        type: "compression.auto_compact.done",
        afterTokens: ctxMgr.historyEstimatedTokens,
        summaryTokens: Math.ceil(summary.length / 4),
      });
      compactor.recordResult(beforeTokens, afterTokens, true);
    } catch (err) {
      compactor.recordResult(beforeTokens, beforeTokens, false);
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
   * - { type: "completed", message }：任务完成
   * - { type: "failed", message }：任务失败
   */
  private async executeTurn(
    ctx: PhaseContext,
    flags: TurnFlags,
    agentGroup: AgentGroup | undefined,
    compactor: ContextCompactor,
    sessionMemoryStore: SessionMemoryStore,
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

    this.refreshContextPackage(ctx);

    // 发出轮次 tick 事件（TUI 用此更新进度条和 token 计数）
    emit({
      type: "loop.tick",
      turn: ctx.turn + 1,
      maxSteps,
      estimatedTokens:
        ctxMgr.estimatedTokens +
        AgentOrchestrator.estimateToolTokens(toolDefs, ctxMgr.estimator),
    });
    emit({ type: "phase", name: "model" });
    emit({
      type: "model.request",
      label: model.label,
      messageCount: ctxMgr.length,
    });

    // 步骤 1：报告自上轮以来被外部修改的文件
    this.maybeReportStaleFiles(ctx);

    // 步骤 2：L1 裁剪（prune）
    // 将超大的工具输出持久化到磁盘，只保留最近 N 个工具结果在内存中
    const contextWindow = model.capabilities?.contextWindow ?? 128_000;
    const pruneResult = ctxMgr.prune({
      toolResultsDir: getToolResultsDir(workspaceRoot, runId),
      keepRecentTools: DEFAULT_KEEP_RECENT_TOOLS,
    });
    if (pruneResult.pruned) {
      emit({
        type: "compression.prune.done",
        freedTokens: pruneResult.freedTokens,
        remainingTokens: ctxMgr.estimatedTokens,
      });
    }

    // 计算上下文预算快照（system / tools / history 各用了多少 token）
    const budgetSnapshot = AgentOrchestrator.measureBudget(
      ctxMgr,
      toolDefs,
      contextWindow,
    );
    ctxMgr.setHistoryTokenBudget(budgetSnapshot.allocation.historyBudget);
    AgentOrchestrator.emitContextBudget(emit, contextWindow, budgetSnapshot);

    // 步骤 3：L2 自动压缩（history pool 超过阈值时触发）
    await this.maybeCompactHistory(
      ctx,
      compactor,
      sessionMemoryStore,
      budgetSnapshot,
    );

    // ── goal 变化时刷新记忆上下文 ──
    if (this._memoryRuntime && this._memoryTaskId) {
      const goalChanged = specGoal !== this._lastDynamicMemoryGoal;
      if (goalChanged && ctx.turn > 0) {
        this._lastDynamicMemoryGoal = specGoal;
        try {
          const section = await this._memoryRuntime.buildContextSection({
            taskId: this._memoryTaskId,
            query: extractCleanMemoryQuery(specGoal),
            tokenBudget: 1500,
            currentUserRequest: specGoal,
            limit: 5,
          });
          this._memoryContextSection = section.promptSection;
          if (section.promptSection) {
            ctxMgr.addUser(
              `[Memory refresh]\n${section.promptSection.slice(0, 2000)}`,
            );
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

    // 步骤 4：注入 max-steps 警告
    // 当剩余轮数 ≤ 3 且已至少跑了 5 轮时，提示模型加快进度
    const turnsRemaining = maxSteps - ctx.turn;
    if (
      turnsRemaining <= 3 &&
      turnsRemaining > 0 &&
      ctx.turn >= 5 &&
      !flags._maxStepsWarned
    ) {
      ctxMgr.addUser(MAX_STEPS_WARNING);
      flags._maxStepsWarned = true;
    }

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
      modelResult = await this.callModelAndParseActions(ctx, toolDefs, toolNameMap);
    } finally {
      this._streamRecoveryPath = undefined;
    }
    const {
      text,
      thinking,
      toolCalls,
      singleAction,
      reasoningText,
    } = modelResult;

    // 步骤 6：通过 action 处理器分发执行
    // handleAction 在 orchestrator/action-handlers.ts 中实现，
    // 根据动作类型处理：tool_call / final / ask_user / plan / abort / run_agent
    const actionResult = await handleAction(
      singleAction ? [singleAction] : [],
      toolCalls,
      ctx,
      flags,
      reasoningText || text,
      thinking,
      {
        resolveAskUser: this.resolveAskUser,
        resolveToolApproval: this.resolveToolApproval,
        approvalPolicy: this.approvalPolicy,
        todoStore: this.todoStore,
        planner,
        planSnapshotMaxItems: this.planSnapshotMaxItems,
        saveStateFn: () =>
          this.saveState(
            runId,
            specGoal,
            workspaceRoot,
            ctx.turn + 1,
            maxSteps,
            ctxMgr,
            planner,
            ctx.taskState,
          ),
        agentGroup,
        childPolicy: this.childPolicy,
        subAgentLauncher: this.subAgentLauncher,
        skillRegistry: this.skillRegistry,
        watcher: this.watcher,
        evalHooks: this.evalHooks,
        memoryRuntime: this._memoryRuntime ?? undefined,
        memoryTaskId: this._memoryTaskId ?? undefined,
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
    return actionResult.state;
  }

  private refreshContextPackage(ctx: PhaseContext): void {
    const codeLines =
      this._contextPackageCode.length > 0
        ? [
            "",
            "[Relevant Code]",
            ...this._contextPackageCode.slice(0, 5).map((b) => {
              const parts = [`- ${b.path}: ${b.reason}`];
              if (b.symbols?.length)
                parts.push(`  symbols=${b.symbols.slice(0, 8).join(", ")}`);
              return parts.join("\n");
            }),
          ]
        : [];
    const taskSnap = ctx.taskState.snapshot();
    const text = [
      CONTEXT_PACKAGE_PREFIX,
      `[Task] ${taskSnap.goal}`,
      this._memoryContextSection || "",
      ...codeLines,
    ]
      .filter((line) => line !== undefined)
      .join("\n");
    ctx.ctxMgr.upsertUserByPrefix(CONTEXT_PACKAGE_PREFIX, text);
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
      .map((a) => `<file path="${a.name}">\n${a.content}\n</file>`)
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
    outcome?: { status: "completed" | "failed"; message: string },
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
    const state: AppState = {
      runId,
      goal: cleanGoal,
      workspaceRoot,
      turn,
      maxSteps,
      messages: ctxMgr.buildMessages(),
      ...(plan
        ? { plan: { revision: plan.revision, items: plan.items as unknown[] } }
        : {}),
      ...(this.todoStore ? { todos: this.todoStore.items } : {}),
      taskState: taskState.snapshot(),
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
    finishReason?: string;
    /** 原生结构化工具调用（当 provider 支持 function calling 时） */
    nativeToolCalls?: readonly NativeToolCall[];
  }> {
    // 创建超时信号：2 分钟
    const timeout = AbortSignal.timeout(AgentOrchestrator.MODEL_TIMEOUT_MS);
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

    if (useStreaming) {
      // ═══ 流式调用 ═══
      let acc = "";
      let thinkingAcc = "";
      let usage: ModelTokenUsage | undefined;
      let finishReason: string | undefined;
      const nativeToolCalls: NativeToolCall[] = [];

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
          recoveryStream?.write(chunk.delta);
          emit({ type: "model.chunk", text: acc });
        } else if (chunk.type === "thinking") {
          thinkingAcc += chunk.delta;
          recoveryStream?.write(`\n[thinking] ${chunk.delta}\n`);
          emit({ type: "model.thinking", text: thinkingAcc });
        } else if (chunk.type === "tool_use") {
          // 原生 tool_use：收集为结构化对象，同时转为文本用于 TUI 显示
          let parsedArgs: Record<string, unknown>;
          try {
            const raw = JSON.parse(chunk.input);
            parsedArgs =
              raw !== null && typeof raw === "object" && !Array.isArray(raw)
                ? (raw as Record<string, unknown>)
                : {};
          } catch {
            parsedArgs = {};
          }
          nativeToolCalls.push({
            id: chunk.id,
            name: chunk.name,
            arguments: parsedArgs,
          });
          const display = JSON.stringify({ tool: chunk.name, args: parsedArgs });
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
        usage,
        finishReason,
        ...(nativeToolCalls.length > 0 ? { nativeToolCalls } : {}),
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
      usage: result.usage,
      finishReason: result.finishReason,
      ...(result.toolCalls && result.toolCalls.length > 0
        ? { nativeToolCalls: result.toolCalls }
        : {}),
    };
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
  ): Promise<{
    text: string;
    usage?: ModelTokenUsage;
    thinking?: string;
    nativeToolCalls?: readonly NativeToolCall[];
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

    // 检测截断：需要续写
    if (
      result.finishReason === "length" ||
      result.finishReason === "max_tokens"
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

      emit({
        type: "model.done",
        text: combinedText,
        ...(combinedThinking ? { thinking: combinedThinking } : {}),
        ...(combinedUsage !== undefined ? { usage: combinedUsage } : {}),
      });
      return {
        text: combinedText,
        thinking: combinedThinking,
        usage: combinedUsage,
        // 合并 tool calls：第一次调用可能在截断前已完成部分工具调用
        nativeToolCalls: [
          ...(result.nativeToolCalls ?? []),
          ...(continued.nativeToolCalls ?? []),
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
    finishReason?: string;
    nativeToolCalls?: readonly NativeToolCall[];
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
    ctxMgr: ContextManager;
    planner: TaskPlanner;
    taskState: TaskStateManager;
    sessionMemoryStore: SessionMemoryStore;
    compactor: ContextCompactor;
    emit: (event: RunEvent) => void;
    emitRunMetrics: (status: "completed" | "failed") => void;
    seq: { n: number };
    checkpointSeq: { n: number };
    shellSandbox: import("@paw/harness").ShellSandboxConfig;
  }> {
    const runId = spec.runId;
    const workspaceRoot = (() => {
      const given = spec.workspaceRoot?.trim()
        ? path.resolve(spec.workspaceRoot)
        : path.resolve(".");
      // findPawRoot：向上查找 .paw 目录，确定项目根
      return findPawRoot(given) ?? given;
    })();
    const maxSteps = resolveMaxSteps(workspaceRoot, spec.maxSteps);

    const seq = { n: 0 };
    const checkpointSeq = { n: 0 };

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
      this.sessionStore?.saveEvent(runId, envelope);
    };

    /** 运行结束时发出汇总指标事件 */
    const emitRunMetrics = (_status: "completed" | "failed") => {
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

    runStartTime = Date.now();
    emit({ type: "run.started", goal: spec.goal });

    // ── 模型选择 ──
    const model =
      this.overrideModel ?? createDefaultLanguageModel(workspaceRoot);
    const ctxMgr = this.contextManager ?? new ContextManager();
    const planner = new TaskPlanner();
    const taskState = new TaskStateManager(
      spec.goal,
      spec.resumeFromState?.taskState,
    );
    this._contextPackageCode = [];
    let startTurn = 0;
    const sessionMemoryStore = new SessionMemoryStore({ workspaceRoot });
    const compactor = new ContextCompactor({}, ctxMgr.estimator);

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

    // 获取完整的工具定义列表（内置工具 + MCP 工具）
    const toolDefs = toolDefinitions(mcp);
    // 工具名映射表：sanitized（字母数字）→ original（含特殊字符如 "Bash(git *)"）
    const toolNameMap = toolNameReverseMap(mcp);

    const contextWindow = model.capabilities?.contextWindow ?? 128_000;
    const shellSandbox = resolveShellSandboxConfig(workspaceRoot);

    // ═══ 子 Agent 模式（child）═══
    // 子 Agent 使用精简的 system prompt，不加载记忆/skills/git状态
    if (this.runMode === "child" && this.sharedContext) {
      const systemContent = buildChildSystemPrompt({
        sharedContext: this.sharedContext,
        toolCatalog: toolCatalogText(mcp),
        workspaceRoot,
      });

      if (spec.resumeFromState) {
        // 从断点恢复子 Agent
        const s = spec.resumeFromState;
        startTurn = s.turn;
        ctxMgr.setSystem(systemContent);
        const history = s.messages.filter((m) => m.role !== "system");
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
      AgentOrchestrator.emitContextBudget(emit, contextWindow, initBudget);

      return {
        runId,
        workspaceRoot,
        maxSteps,
        startTurn,
        model,
        mcp,
        toolDefs,
        toolNameMap,
        ctxMgr,
        planner,
        taskState,
        sessionMemoryStore,
        compactor,
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
    const cleanMemoryQuery = extractCleanMemoryQuery(spec.goal);
    let memoryContextSection: string | undefined;
    let selectedForEvent: {
      id: string;
      title: string;
      source: string;
      summary: string;
      relatedFiles: readonly string[];
    }[] = [];

    this._memoryRuntime = null;
    this._memoryTaskId = null;
    this._memoryContextSection = "";
    this._lastDynamicMemoryGoal = "";

    try {
      const runtime = await createMemoryRuntime({ workspaceRoot });
      const ok = await runtime.ping();
      if (!ok) {
        emit({
          type: "memory.retrieve.done",
          query: cleanMemoryQuery,
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
        });
        this._memoryRuntime = runtime;
        this._memoryTaskId = begun.taskId;
        this._lastDynamicMemoryGoal = spec.goal;

        const section = await runtime.buildContextSection({
          taskId: begun.taskId,
          query: cleanMemoryQuery || spec.goal,
          tokenBudget: 1500,
          currentUserRequest: cleanMemoryQuery || spec.goal,
          limit: 8,
        });
        this._memoryContextSection = section.promptSection;
        memoryContextSection = section.promptSection;
        selectedForEvent = section.items.map((item) => ({
          id: item.id,
          title: item.title,
          source: "auto",
          summary: item.title,
          relatedFiles: [],
        }));
        emit({
          type: "memory.retrieve.done",
          query: cleanMemoryQuery,
          totalCandidates: section.items.length,
          selectedCount: section.items.length,
          scores: section.items.map((i) => i.score),
          injectedTokens: section.tokens,
          retrievalMode: "keyword",
          selectedMemories: selectedForEvent,
        });
      }
    } catch {
      emit({
        type: "memory.retrieve.done",
        query: cleanMemoryQuery,
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
    const promptBuild = buildSystemPromptWithBudget(
      {
        workspaceRoot,
        toolCatalog: toolCatalogText(mcp),
        skills: skillsText,
        gitStatus: gitStatusLine,
        pawMd: pawMdContent,
        projectMemory,
        memoryContextSection,
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
    const systemContent = promptBuild.content;

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
    this._contextPackageCode = selectCodeContext(workspaceRoot, spec.goal, mentionedPaths);
    if (spec.resumeFromState) {
      // 断点恢复：重建 system prompt，恢复历史消息和计划
      const s = spec.resumeFromState;
      startTurn = s.turn;
      ctxMgr.setSystem(systemContent);
      const history = s.messages.filter((m) => m.role !== "system");

      if (history.length > 0) {
        // Step 1: 先不做硬截断——把完整历史放进去
        ctxMgr.setHistoryRaw(history);

        // Step 2: L1 prune — 把超大的工具输出落盘，上下文中只留指针
        const toolResultsDir = getToolResultsDir(workspaceRoot, runId);
        const pruneResult = ctxMgr.prune({
          toolResultsDir,
          keepRecentTools: DEFAULT_KEEP_RECENT_TOOLS,
        });
        if (pruneResult.pruned) {
          emit({
            type: "compression.prune.done",
            freedTokens: pruneResult.freedTokens,
            remainingTokens: ctxMgr.estimatedTokens,
          });
        }

        // Step 3: L2 compact — 如果历史依然太大，用辅助模型把中间段压成摘要
        const historyTokensAfterPrune = ctxMgr.historyEstimatedTokens;
        const resumeCompactThreshold = Math.floor(contextWindow * 0.4);
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
        planner.createPlan(runId, []);
        try {
          planner.applyUpdate(
            s.plan.items as readonly PlanItem[],
            [],
            "resume",
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
        ctxMgr.addUser(
          `[Previous session context]\nTask: ${prevMemory.task}\nState: ${prevMemory.currentState ?? "unknown"}`,
        );
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

    // 计算初始上下文预算
    const initBudget = AgentOrchestrator.measureBudget(
      ctxMgr,
      toolDefs,
      contextWindow,
    );
    ctxMgr.setHistoryTokenBudget(initBudget.allocation.historyBudget);
    AgentOrchestrator.emitContextBudget(emit, contextWindow, initBudget);

    return {
      runId,
      workspaceRoot,
      maxSteps,
      startTurn,
      model,
      mcp,
      toolDefs,
      toolNameMap,
      ctxMgr,
      planner,
      taskState,
      sessionMemoryStore,
      compactor,
      emit,
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
  ): ContextBudgetSnapshot {
    return measureContextBudget({
      contextWindow,
      systemTokens: ctxMgr.systemEstimatedTokens,
      toolsTokens: AgentOrchestrator.estimateToolTokens(
        toolDefs,
        ctxMgr.estimator,
      ),
      historyTokens: ctxMgr.historyEstimatedTokens,
    });
  }

  /**
   * 发出上下文预算事件。
   *
   * 包含去重逻辑：如果连续两轮的预算值完全相同，跳过发射，
   * 避免在 TUI 中刷屏相同的信息。
   */
  private static emitContextBudget(
    emit: (event: RunEvent) => void,
    contextWindow: number,
    snapshot: ContextBudgetSnapshot,
  ): void {
    // 去重：值没变就不发
    const key = `${snapshot.systemUsed}/${snapshot.allocation.systemBudget}/${snapshot.historyUsed}/${snapshot.allocation.historyBudget}`;
    if (key === AgentOrchestrator._lastBudgetKey) return;
    AgentOrchestrator._lastBudgetKey = key;

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

  // 429 限流 — 尝试提取 Retry-After 头
  if (/\b429\b/.test(msg)) {
    const retryAfterMatch = msg.match(/retry[_-]?after[\s:]*(\d+)/i);
    if (retryAfterMatch) {
      const seconds = parseInt(retryAfterMatch[1]!, 10);
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
