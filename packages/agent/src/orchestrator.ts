/**
 * AgentOrchestrator: multi-turn model ↔ tool loop.
 *
 * Refactored from a monolithic 1300-line file to a state-machine-driven
 * architecture with explicit phase handlers.
 */

import path from "node:path";

import {
  type AppState,
  type AppStateStore,
  type AgentToolCallAction,
  AutoMemoryStore,
  ContextCompactor,
  CONTEXT_SUMMARY_PREFIX,
  ContextManager,
  type CostTracker,
  MAX_STEPS_WARNING,
  retrieveMemories,
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
  UnifiedMemoryStore,
  stripContextSummaryMessages,
  buildSystemPromptWithBudget,
  allocateContextBudget,
  buildRetrievalSignalsFromMessages,
  extractCleanMemoryQuery,
  extractFilePaths,
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

import {
  McpClientManager,
  type McpServerConfig,
  type SubAgentLauncher,
  toolCatalogText,
  toolDefinitions,
  toolNameReverseMap,
} from "@paw/harness";

import {
  type ChatMessage,
  type LanguageModel,
  type NativeToolCall,
  createDefaultLanguageModel,
} from "@paw/models";

import { type PlanItem, TaskPlanner } from "@paw/store";

import {
  type WorkspaceWatcher,
  discoverContext,
  extractAtMentions,
  gitStatus,
  loadPawMd,
  resolveMentions,
} from "@paw/workspace";

import { runCompressionAgent } from "./compression-agent.js";
import { buildChildSystemPrompt } from "./child-system-prompt.js";
import { handleAction } from "./orchestrator/action-handlers.js";
import { AgentGroup } from "./orchestrator/agent-group.js";
import { runMemoryExtractionAfterRun } from "./orchestrator/memory-extraction.js";
import type {
  PhaseContext,
  SharedContext,
  TurnFlags,
  TurnState,
} from "./orchestrator/types.js";
import {
  parseAgentActionFromModelText,
  parseAgentActionsFromModelText,
} from "./parse-agent-action.js";
import { resolveMaxSteps } from "./resolve-max-steps.js";
import {
  resolveMemoryRetrievalSettings,
  toRetrieveMemoriesOptions,
} from "./resolve-memory-retrieval.js";
import { resolveShellSandboxConfig } from "./resolve-shell-sandbox.js";
import {
  CircuitBreaker,
  CircuitBreakerOpenError,
} from "./resilience/circuit-breaker.js";

// ─────────────────────────────────────────────────────────────
// Public options
// ─────────────────────────────────────────────────────────────

export interface AskUserResolveInput {
  readonly question: string;
  readonly timeoutSec: number | null;
}

export interface ToolApprovalInput {
  readonly tool: string;
  readonly args: unknown;
}

export interface AgentOrchestratorOptions {
  readonly model?: LanguageModel;
  readonly onEvent?: (envelope: RunEventEnvelope) => void;
  readonly planSnapshotMaxItems?: number;
  readonly resolveAskUser?: (input: AskUserResolveInput) => Promise<string>;
  readonly resolveToolApproval?: (input: ToolApprovalInput) => Promise<boolean>;
  readonly approvalPolicy?: (tool: string) => boolean | undefined;
  readonly mcpServers?: readonly McpServerConfig[];
  readonly sessionStore?: SessionStore;
  readonly todoStore?: TodoStore;
  readonly contextManager?: ContextManager;
  readonly subAgentLauncher?: SubAgentLauncher;
  readonly appStateStore?: AppStateStore;
  readonly skillRegistry?: SkillRegistryType;
  readonly skillsDir?: string;
  readonly costTracker?: CostTracker;
  readonly watcher?: WorkspaceWatcher;
  /** When set to "read_only", child agents cannot execute mutating tools. */
  readonly childPolicy?: "read_only" | "read_write";
  /** Full agent (default) or lightweight child sub-agent. */
  readonly runMode?: "full" | "child";
  /** Structured parent context for {@link runMode} `"child"`. */
  readonly sharedContext?: SharedContext;
  /** Model for compression / memory extraction (defaults to main model). */
  readonly auxiliaryModel?: LanguageModel;
  /** Test injection: override retry sleep. Defaults to setTimeout. */
  readonly retrySleep?: (ms: number) => Promise<void>;
  /** When to run post-run memory extraction (requires subAgentLauncher). */
  readonly memoryExtraction?: "background" | "await" | "off";
  /** Evaluation hooks for collecting trace data (non-invasive). */
  readonly evalHooks?: EvalHooks;
}

// ─────────────────────────────────────────────────────────────
// Orchestrator
// ─────────────────────────────────────────────────────────────

export class AgentOrchestrator {
  private static readonly COMPACT_COOLDOWN_TURNS = 5;

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
  private compactCooldownTurns = 0;
  private readonly retrySleep: (ms: number) => Promise<void>;
  private readonly memoryExtraction: "background" | "await" | "off";
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
    this.skillRegistry = opts?.skillRegistry ?? new SkillRegistry();
    this.costTracker = opts?.costTracker;
    this.watcher = opts?.watcher;
    this.childPolicy = opts?.childPolicy;
    this.runMode = opts?.runMode ?? "full";
    this.sharedContext = opts?.sharedContext;
    this.auxiliaryModel = opts?.auxiliaryModel;
    this.retrySleep =
      opts?.retrySleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.memoryExtraction = opts?.memoryExtraction ?? "background";
    this.evalHooks = opts?.evalHooks;
    if (opts?.skillsDir) {
      const skills = loadSkillsFromDirectory(opts.skillsDir);
      for (const skill of skills) {
        this.skillRegistry.register(skill);
      }
    }
  }

  describe(): string {
    return "AgentOrchestrator (TS): model + harness tool loop + run events.";
  }

  // ─────────────────────────────────────────────────────────
  // Resume a previously saved run
  // ─────────────────────────────────────────────────────────

  async resumeRun(opts: {
    readonly runId: string;
    readonly workspaceRoot?: string;
    readonly fromTurn?: number;
    readonly abortSignal?: AbortSignal;
  }): Promise<RunResult> {
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

    // If fromTurn is specified, restore file checkpoints to that turn
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
  // Main entry
  // ─────────────────────────────────────────────────────────

  async run(spec: RunSpec): Promise<RunResult> {
    let init: Awaited<ReturnType<typeof this.initializeRun>> | undefined;
    let agentGroup: AgentGroup | undefined;
    let emitRunMetrics:
      | ((status: "completed" | "failed") => void)
      | undefined;

    try {
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
        autoMemoryStore,
        sessionMemoryStore,
        compactor,
        emit,
        emitRunMetrics: _emitRunMetrics,
        checkpointSeq,
        shellSandbox,
      } = init;
      emitRunMetrics = _emitRunMetrics;
      const signal = spec.abortSignal;

      // Create AgentGroup for sub-agent management
      if (this.subAgentLauncher) {
        agentGroup = new AgentGroup({
          parentRunId: runId,
          parentOnEvent: (envelope) => {
            this.onEvent?.(envelope);
            this.sessionStore?.saveEvent(runId, envelope);
          },
          parentCtxMgr: ctxMgr,
          parentWatcher: this.watcher,
          launcher: this.subAgentLauncher,
          depth: 0,
        });
      }

      let flags: TurnFlags = {
        autoContinueNudges: 0,
        lastTurnHadToolCall: false,
        hasEverUsedTools: false,
      };

      // Store for executeTurn access
      const turnCompactor = compactor;
      const turnSessionMemoryStore = sessionMemoryStore;
      const turnAutoMemoryStore = autoMemoryStore;

      planner.createPlan(runId, []);

      for (let turn = startTurn; turn < maxSteps; turn++) {
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
            {
              status: "failed",
              message,
            },
          );
          emit({ type: "run.completed", status: "failed", message });
          emitRunMetrics("failed");
          return { runId, status: "failed", message };
        }

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
          emit,
          checkpointSeq,
          specGoal: spec.goal,
          shellSandbox,
        };

        const state = await this.executeTurn(
          phaseCtx,
          flags,
          agentGroup,
          turnCompactor,
          turnSessionMemoryStore,
          turnAutoMemoryStore,
        );

        if (state.type === "continue") {
          flags = state.nextFlags;
          continue;
        }

        if (state.type === "completed" || state.type === "failed") {
          this.saveState(
            runId,
            spec.goal,
            workspaceRoot,
            turn + 1,
            maxSteps,
            ctxMgr,
            planner,
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
          if (state.type === "completed") {
            await this.maybeExtractMemoriesAfterRun(
              runId,
              ctxMgr,
              turnAutoMemoryStore,
              emit,
              model,
            );
          }
          return { runId, status: state.type, message: state.message };
        }
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
        {
          status: "failed",
          message: exhaustedMessage,
        },
      );
      emitRunMetrics("failed");
      return { runId, status: "failed", message: exhaustedMessage };
    } catch (e) {
      const message =
        e instanceof Error
          ? e.name === "AbortError"
            ? "Run aborted."
            : e.message
          : String(e);
      if (init) {
        const { runId, workspaceRoot, maxSteps, ctxMgr, planner, emit } = init;
        this.saveState(
          runId,
          spec.goal,
          workspaceRoot,
          maxSteps,
          maxSteps,
          ctxMgr,
          planner,
          {
            status: "failed",
            message,
          },
        );
        emit({ type: "run.failed", message });
        emit({ type: "run.completed", status: "failed", message });
        emitRunMetrics("failed");
        return { runId, status: "failed", message };
      }
      return { runId: spec.runId, status: "failed", message };
    } finally {
      await init?.mcp?.disconnectAll();
    }
  }

  // ─────────────────────────────────────────────────────────
  // Turn execution (state-machine driven)
  // ─────────────────────────────────────────────────────────

  private async executeTurn(
    ctx: PhaseContext,
    flags: TurnFlags,
    agentGroup: AgentGroup | undefined,
    compactor: ContextCompactor,
    sessionMemoryStore: SessionMemoryStore,
    _autoMemoryStore: AutoMemoryStore,
  ): Promise<TurnState> {
    const {
      runId,
      workspaceRoot,
      maxSteps,
      signal,
      model,
      toolDefs,
      toolNameMap,
      ctxMgr,
      planner,
      emit,
      specGoal,
    } = ctx;

    if (this.compactCooldownTurns > 0) {
      this.compactCooldownTurns--;
    }

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

    // 1. Stale file check
    const STALE_IGNORE = [
      "node_modules",
      ".git",
      ".paw",
      ".next",
      "dist",
      ".turbo",
      "__pycache__",
    ];
    const staleFiles = (this.watcher?.takeExternallyModified() ?? []).filter(
      (f) =>
        !STALE_IGNORE.some(
          (ign) =>
            f.includes(`/${ign}/`) || f.startsWith(`${ign}/`) || f === ign,
        ),
    );
    if (staleFiles.length > 0) {
      const MAX_STALE = 30;
      const shown = staleFiles.slice(0, MAX_STALE);
      const suffix =
        staleFiles.length > MAX_STALE
          ? `\n... and ${staleFiles.length - MAX_STALE} more`
          : "";
      ctxMgr.addUser(
        `Note: the following file(s) were modified externally since the last turn and may be stale:\n${shown.map((f) => `- ${f}`).join("\n")}${suffix}`,
      );
    }

    // 2. Prune context (L1: persist oversized + evict beyond last N tool results)
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

    const budgetSnapshot = AgentOrchestrator.measureBudget(
      ctxMgr,
      toolDefs,
      contextWindow,
    );
    ctxMgr.setHistoryTokenBudget(budgetSnapshot.allocation.historyBudget);
    AgentOrchestrator.emitContextBudget(emit, contextWindow, budgetSnapshot);

    // 3. Auto-compact (history pool threshold)
    const historyTokensBeforeCompact = budgetSnapshot.historyUsed;
    const auxModel = this.auxiliaryModel ?? model;
    if (
      shouldCompactHistory(budgetSnapshot) &&
      this.compactCooldownTurns <= 0 &&
      !compactor.isDisabled &&
      !compactor.shouldSkipDueToThrashing()
    ) {
      emit({
        type: "compression.auto_compact.started",
        beforeTokens: historyTokensBeforeCompact,
      });
      try {
        const boundaries = compactor.determineBoundaries(
          ctxMgr.buildMessages(),
        );
        const messages = ctxMgr.buildMessages();
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
            reason: "no middle segment to compact",
          });
        } else {
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
            compactor.recordResult(
              historyTokensBeforeCompact,
              historyTokensBeforeCompact,
              false,
            );
            emit({
              type: "compression.skipped",
              reason: `summary quality: ${quality.reason}`,
            });
          } else {
            const summaryMsg: ChatMessage = {
              role: "user",
              content: `${CONTEXT_SUMMARY_PREFIX}\n${summary}`,
            };
            const newMessages = [...headMessages, summaryMsg, ...tailMessages];
            const newHistory = newMessages.filter((m) => m.role !== "system");
            const afterHistoryTokens =
              ctxMgr.estimator.countMessages(newHistory);

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
            } else {
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
              this.compactCooldownTurns =
                AgentOrchestrator.COMPACT_COOLDOWN_TURNS;
            }
          }
        }
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

    // 4. Inject max-steps warning when within 3 turns of the limit
    // Only fires once, after at least 5 turns have passed
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

    // 4. Model call
    this.evalHooks?.beforeModelCall?.({
      messages: ctxMgr.buildMessages(),
      contextManager: ctxMgr,
    });
    const modelCallStart = Date.now();
    const { text, thinking, nativeToolCalls } = await this.invokeModel(
      model,
      ctxMgr.buildMessages(),
      signal,
      emit,
      toolDefs,
      toolNameMap,
    );

    // 5. Parse actions — prefer native tool_use over text scanning
    emit({ type: "phase", name: "parse" });
    // Accept both sanitized names (e.g. workspace_read_file) and original names
    const knownTools = new Set([
      ...toolNameMap.values(),
      ...toolNameMap.keys(),
    ]);
    let toolCalls: AgentToolCallAction[];
    let reasoningText: string;

    if (nativeToolCalls && nativeToolCalls.length > 0) {
      // Native function calling: model returned structured tool_calls.
      // Map sanitized names back to paw-ts dot-format tool names.
      toolCalls = nativeToolCalls
        .map((tc) => {
          const originalName = toolNameMap.get(tc.name) ?? tc.name;
          return {
            type: "tool_call" as const,
            tool: originalName,
            args: tc.arguments,
          };
        })
        .filter((tc): tc is AgentToolCallAction => knownTools.has(tc.tool));
      // Deduplicate by tool+args (same logic as text parser)
      const seen = new Set<string>();
      toolCalls = toolCalls.filter((tc) => {
        const key = `${tc.tool}:${JSON.stringify(tc.args)}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      reasoningText = text;
    } else {
      // Fallback: text scanning for providers without native function calling
      const parsed = parseAgentActionsFromModelText(text, { knownTools });
      toolCalls = parsed.actions;
      reasoningText = parsed.text;
    }

    // Parse non-tool actions only when no tool calls are present
    const singleAction =
      toolCalls.length === 0
        ? parseAgentActionFromModelText(text, { knownTools })
        : null;

    const modelCallLatency = Date.now() - modelCallStart;
    this.evalHooks?.afterModelCall?.({
      turnIndex: ctx.turn,
      responseText: text,
      thinking,
      toolCalls: toolCalls.length > 0
        ? toolCalls.map((tc) => ({ tool: tc.tool, args: tc.args }))
        : undefined,
      usage: undefined, // filled by invokeModel's emit path; captured later by data collector
      latencyMs: modelCallLatency,
    });

    // 6. Dispatch via action handlers
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
          ),
        agentGroup,
        childPolicy: this.childPolicy,
        subAgentLauncher: this.subAgentLauncher,
        skillRegistry: this.skillRegistry,
        watcher: this.watcher,
        evalHooks: this.evalHooks,
      },
    );
    return actionResult.state;
  }

  // ─────────────────────────────────────────────────────────
  // Helpers (unchanged logic, extracted to private methods)
  // ─────────────────────────────────────────────────────────

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

  private saveState(
    runId: string,
    goal: string,
    workspaceRoot: string,
    turn: number,
    maxSteps: number,
    ctxMgr: ContextManager,
    planner: TaskPlanner,
    outcome?: { status: "completed" | "failed"; message: string },
  ): void {
    if (!this.appStateStore) return;
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
      ...(outcome ? { outcome } : {}),
      savedAt: Date.now(),
    };
    this.appStateStore.save(state);
  }

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

  private static normalizeToolCalls(
    text: string,
    nameMap?: Map<string, string>,
  ): string {
    let out = text
      .replace(/<overview>[\s\S]*?<\/overview>/gi, "")
      .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
      .replace(/<think>[\s\S]*?<\/think>/gi, "");
    if (nameMap && nameMap.size > 0) {
      for (const [sanitized, original] of nameMap) {
        out = out.split(`"${sanitized}"`).join(`"${original}"`);
      }
    }
    out = out.replace(
      /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/gi,
      (_, json) => `\n${json.trim()}\n`,
    );
    const toolXmlRegex =
      /<tool>([^<]+)<\/tool>\s*(?:<args>(\{[\s\S]*?\})<\/args>)?/gi;
    out = out.replace(toolXmlRegex, (_m, name, argsJson) => {
      let args: unknown = {};
      if (argsJson) {
        try {
          args = JSON.parse(argsJson);
        } catch {
          /* ignore */
        }
      }
      return `\n${JSON.stringify({ tool: name.trim(), args })}\n`;
    });
    out = out.replace(
      /```json\s*(\{[\s\S]*?\})\s*```/g,
      (_, json) => `\n${json.trim()}\n`,
    );
    return out.trim();
  }

  private static readonly MODEL_TIMEOUT_MS = 120_000;

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
    /** Native structured tool calls (when provider supports function calling). */
    nativeToolCalls?: readonly NativeToolCall[];
  }> {
    const timeout = AbortSignal.timeout(AgentOrchestrator.MODEL_TIMEOUT_MS);
    const combinedSignal = signal
      ? AbortSignal.any([signal, timeout])
      : timeout;
    const streamFn = model.completeStream;
    const modelOpts = {
      signal: combinedSignal,
      ...(tools && tools.length > 0 ? { tools } : {}),
    };

    // Qwen3 via vLLM ≤0.22 doesn't emit tool_use stream chunks — use non-streaming
    const isQwen =
      model.label.toLowerCase().includes("qwen") ||
      model.label.toLowerCase().includes("/qwen");
    const useStreaming = typeof streamFn === "function" && !isQwen;

    if (useStreaming) {
      let acc = "";
      let thinkingAcc = "";
      let usage: ModelTokenUsage | undefined;
      let finishReason: string | undefined;
      const nativeToolCalls: NativeToolCall[] = [];
      for await (const chunk of streamFn.call(model, messages, modelOpts)) {
        if (chunk.type === "text") {
          acc += chunk.delta;
          emit({ type: "model.chunk", text: acc });
        } else if (chunk.type === "thinking") {
          thinkingAcc += chunk.delta;
          emit({ type: "model.thinking", text: thinkingAcc });
        } else if (chunk.type === "tool_use") {
          // Collect native tool_use as structured objects.
          // Also emit as text for TUI display compatibility.
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
          emit({ type: "model.chunk", text: acc });
        } else if (chunk.type === "done") {
          usage = chunk.usage;
          finishReason = chunk.finishReason;
        }
      }
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
      const normalized = AgentOrchestrator.normalizeToolCalls(acc, toolNameMap);
      return {
        text: normalized,
        rawText: acc,
        thinking: thinkingAcc || undefined,
        usage,
        finishReason,
        ...(nativeToolCalls.length > 0 ? { nativeToolCalls } : {}),
      };
    }

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
    const result = await this.callModelWithRetry(
      model,
      messages,
      signal,
      emit,
      tools,
      toolNameMap,
    );
    if (
      result.finishReason === "length" ||
      result.finishReason === "max_tokens"
    ) {
      emit({ type: "model.truncated", finishReason: result.finishReason });
      const continueMessages = [
        ...messages,
        { role: "assistant" as const, content: result.text },
        {
          role: "user" as const,
          content:
            "[Continue from where you were cut off. Do not repeat any content — pick up exactly where the previous message stopped.]",
        },
      ];
      const continued = await this.callModelWithRetry(
        model,
        continueMessages,
        signal,
        emit,
        tools,
        toolNameMap,
      );
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
        // Merge tool calls: the first response may have completed tool calls
        // before truncation; the continuation has the rest.
        nativeToolCalls: [
          ...(result.nativeToolCalls ?? []),
          ...(continued.nativeToolCalls ?? []),
        ],
      };
    }
    emit({
      type: "model.done",
      text: result.text,
      ...(result.thinking ? { thinking: result.thinking } : {}),
      ...(result.usage !== undefined ? { usage: result.usage } : {}),
    });
    return result;
  }

  private getOrCreateBreaker(label: string): CircuitBreaker {
    let b = this.circuitBreakers.get(label);
    if (!b) {
      b = new CircuitBreaker(label);
      this.circuitBreakers.set(label, b);
    }
    return b;
  }

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
      const prevState = breaker.snapshot().state;
      breaker.recordFailure();
      const newState = breaker.snapshot().state;
      if (prevState !== newState && newState === "open") {
        this.emitCircuitBreakerEvent(breaker, emit);
      }

      // If the circuit breaker itself is the cause, don't retry
      if (err instanceof CircuitBreakerOpenError) throw err;

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
    autoMemoryStore: AutoMemoryStore;
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
      return findPawRoot(given) ?? given;
    })();
    const maxSteps = resolveMaxSteps(workspaceRoot, spec.maxSteps);

    const seq = { n: 0 };
    const checkpointSeq = { n: 0 };

    // ── Run metrics accumulator ──
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

    const emit = (event: RunEvent) => {
      // Collect metrics from the event stream
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
        metrics.estimatedCost =
          event.estimatedCostUsd ?? event.estimatedCost ?? 0;
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

    const emitRunMetrics = (status: "completed" | "failed") => {
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

    const model =
      this.overrideModel ?? createDefaultLanguageModel(workspaceRoot);
    const ctxMgr = this.contextManager ?? new ContextManager();
    const planner = new TaskPlanner();
    let startTurn = 0;
    const sessionMemoryStore = new SessionMemoryStore({ workspaceRoot });
    const compactor = new ContextCompactor({}, ctxMgr.estimator);

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

    const toolDefs = toolDefinitions(mcp);
    const toolNameMap = toolNameReverseMap(mcp);

    const contextWindow = model.capabilities?.contextWindow ?? 128_000;

    if (this.runMode === "child" && this.sharedContext) {
      const systemContent = buildChildSystemPrompt({
        sharedContext: this.sharedContext,
        toolCatalog: toolCatalogText(mcp),
        workspaceRoot,
      });

      if (spec.resumeFromState) {
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

      const childAutoMemoryStore = new AutoMemoryStore({ workspaceRoot });
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
        autoMemoryStore: childAutoMemoryStore,
        sessionMemoryStore,
        compactor,
        emit,
        emitRunMetrics,
        seq,
        checkpointSeq,
      };
    }

    const skillsText =
      this.skillRegistry.list().length > 0
        ? this.skillRegistry.catalogText()
        : undefined;
    const todosText =
      this.todoStore && this.todoStore.items.length > 0
        ? formatTodosForPrompt(this.todoStore.items)
        : undefined;
    const projectMemory = loadProjectMemory(workspaceRoot);

    for (const skill of skillsFromProjectMemory(
      projectMemory.committed,
      projectMemory.local,
    )) {
      if (!this.skillRegistry.has(skill.id)) {
        this.skillRegistry.register(skill);
      }
    }

    // ── Memory retrieval (P3) ──
    // Derive a clean query from spec.goal so that resumed session context
    // (background + previous goals) does not pollute memory scoring.
    const cleanMemoryQuery = extractCleanMemoryQuery(spec.goal);

    const autoMemoryStore = new AutoMemoryStore({ workspaceRoot });
    const memoryIndex = autoMemoryStore.loadIndex(200) ?? undefined;

    const unifiedStore = new UnifiedMemoryStore({
      workspaceRoot,
      sessionId: runId,
    });
    const memoryRetrievalSettings = resolveMemoryRetrievalSettings(workspaceRoot);
    const shellSandbox = resolveShellSandboxConfig(workspaceRoot);

    const historyForSignals = spec.resumeFromState?.messages ?? [];
    const retrievalSignals = buildRetrievalSignalsFromMessages(historyForSignals);
    const queryFiles = [
      ...new Set([
        ...extractFilePaths(cleanMemoryQuery),
        ...retrievalSignals.recentFiles,
      ]),
    ];
    const retrievalQuery = {
      goal: cleanMemoryQuery,
      currentFile: queryFiles[0],
      recentFiles: queryFiles,
      recentToolNames: retrievalSignals.recentToolNames,
      errorMessage: retrievalSignals.errorMessage,
      workspaceRoot,
      limit: 5,
      maxTokens: 1500,
    };
    const memoryResult = await retrieveMemories(
      unifiedStore,
      retrievalQuery,
      toRetrieveMemoriesOptions(memoryRetrievalSettings, {
        workspaceRoot,
        auxiliaryModel: this.auxiliaryModel,
        signal: spec.abortSignal,
      }),
    );

    emit({
      type: "memory.retrieve.done",
      query: cleanMemoryQuery,
      totalCandidates: memoryResult.totalCandidates,
      selectedCount: memoryResult.records.length,
      scores: memoryResult.scores,
      injectedTokens: memoryResult.injectedTokens,
      retrievalMode: memoryResult.retrievalMode ?? memoryRetrievalSettings.mode,
      usedLlmFallback: memoryResult.usedLlmFallback,
      embeddingCacheHits: memoryResult.embeddingCacheHits,
      embeddingCacheMisses: memoryResult.embeddingCacheMisses,
      selectedMemories: memoryResult.records.map((record) => ({
        id: record.id,
        title: record.title,
        source: record.source,
        summary: record.summary,
        relatedFiles: record.relatedFiles,
      })),
    });

    const autoMemoryStoreForRun = autoMemoryStore;

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
      /* ignore */
    }

    let pawMdContent: string | undefined;
    try {
      const pawMd = loadPawMd(workspaceRoot);
      if (pawMd.content) pawMdContent = pawMd.content;
    } catch {
      /* ignore */
    }

    const systemBudget = allocateContextBudget(contextWindow).systemBudget;
    const promptBuild = buildSystemPromptWithBudget(
      {
        workspaceRoot,
        toolCatalog: toolCatalogText(mcp),
        skills: skillsText,
        gitStatus: gitStatusLine,
        pawMd: pawMdContent,
        projectMemory,
        relevantMemories:
          memoryResult.records.length > 0 ? memoryResult.records : undefined,
        memoryIndex,
        todos: todosText,
        modelLabel: model.label,
        modelId: model.label,
        memoryDir: autoMemoryStoreForRun.memoryDir,
        hasAutoMemory: true,
      },
      systemBudget,
      (text) => ctxMgr.estimator.count(text),
    );
    const systemContent = promptBuild.content;

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

    if (spec.resumeFromState) {
      const s = spec.resumeFromState;
      startTurn = s.turn;
      // Always rebuild system prompt (tools/skills may have changed).
      ctxMgr.setSystem(systemContent);
      const history = s.messages.filter((m) => m.role !== "system");
      if (history.length > 0) ctxMgr.replaceHistory(history);
      if (s.plan) {
        planner.createPlan(runId, []);
        try {
          planner.applyUpdate(
            s.plan.items as readonly PlanItem[],
            [],
            "resume",
          );
        } catch {
          /* ignore plan restore errors */
        }
      }
      if (s.todos && this.todoStore) this.todoStore.set(s.todos);
      // Inject session-memory summary only on cold resume (no prior turns in history).
      const prevMemory = sessionMemoryStore.load(runId);
      if (prevMemory?.task && history.length <= 1) {
        ctxMgr.addUser(
          `[Previous session context]\nTask: ${prevMemory.task}\nState: ${prevMemory.currentState ?? "unknown"}`,
        );
      }
      emit({ type: "run.started", goal: spec.goal });
    } else {
      ctxMgr.setSystem(systemContent);
      const goalMentions = AgentOrchestrator.resolveUserMentions(
        workspaceRoot,
        spec.goal,
      );
      const mentionedPaths = extractAtMentions(spec.goal);
      const autoCtx = discoverContext(workspaceRoot, spec.goal, mentionedPaths);
      let userContent = goalMentions.content;
      if (autoCtx.content)
        userContent = `${autoCtx.content}\n\n${goalMentions.content}`;
      ctxMgr.addUser(userContent, goalMentions.imageAttachments);
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
      autoMemoryStore: autoMemoryStoreForRun,
      sessionMemoryStore,
      compactor,
      emit,
      emitRunMetrics,
      seq,
      checkpointSeq,
      shellSandbox,
    };
  }

  private async maybeExtractMemoriesAfterRun(
    runId: string,
    ctxMgr: ContextManager,
    autoMemoryStore: AutoMemoryStore,
    emit: (event: RunEvent) => void,
    model: LanguageModel,
  ): Promise<void> {
    if (this.memoryExtraction === "off" || !this.auxiliaryModel) {
      return;
    }

    const work = runMemoryExtractionAfterRun({
      runId,
      ctxMgr,
      autoMemoryStore,
      model: this.auxiliaryModel,
      emit,
    }).catch(() => {
      /* background extraction must not fail the run */
    });

    if (this.memoryExtraction === "await") {
      await work;
    }
  }

  /** Tool JSON schemas are billed separately from chat messages by most providers. */
  private static estimateToolTokens(
    tools: readonly import("@paw/models").ToolDefinition[],
    estimator: TokenEstimator,
  ): number {
    if (tools.length === 0) return 0;
    return estimator.count(JSON.stringify(tools));
  }

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

  private static _lastBudgetKey: string | null = null;

  private static emitContextBudget(
    emit: (event: RunEvent) => void,
    contextWindow: number,
    snapshot: ContextBudgetSnapshot,
  ): void {
    // Dedup: skip if values haven't changed since last emission
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

// ---------------------------------------------------------------------------
// Error classification & retry policy
// ---------------------------------------------------------------------------

type RetryableErrorType =
  | "rate_limit"
  | "server_error"
  | "timeout"
  | "network"
  | "transient"
  | "non_retryable";

interface ErrorClassification {
  readonly type: RetryableErrorType;
  readonly retryAfterMs?: number;
}

function classifyError(err: unknown): ErrorClassification {
  if (!(err instanceof Error)) {
    // Unknown non-Error throws are treated as non-retryable by default
    return { type: "non_retryable" };
  }
  const msg = err.message;

  // 429 rate limit — try to extract Retry-After
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

  // 5xx server errors
  if (/\b5\d\d\b/.test(msg)) return { type: "server_error" };

  // Non-retryable 4xx (auth, bad request, etc.)
  if (/\b4\d\d\b/.test(msg)) return { type: "non_retryable" };

  // Timeouts
  if (/\btimeout\b|ETIMEDOUT/i.test(msg)) return { type: "timeout" };

  // Network-level failures
  if (/fetch|network|ECONN|ENOTFOUND|DNS|ECONNRESET/i.test(msg)) {
    return { type: "network" };
  }

  // Default: unknown errors are non-retryable (whitelist approach)
  return { type: "non_retryable" };
}

function isRetryable(classification: ErrorClassification): boolean {
  return classification.type !== "non_retryable";
}

function computeRetryDelay(
  attempt: number,
  classification: ErrorClassification,
): number {
  const jitter = 0.5 + Math.random() * 0.5; // 0.5x – 1.0x

  if (classification.type === "rate_limit") {
    if (classification.retryAfterMs) {
      return classification.retryAfterMs * jitter;
    }
    const fixed = [5_000, 10_000, 20_000];
    return (fixed[attempt - 1] ?? 20_000) * jitter;
  }

  // Exponential backoff for server_error, timeout, network, transient
  const base = 1_000 * 2 ** (attempt - 1);
  return Math.min(base * jitter, 30_000);
}
