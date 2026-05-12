import path from "node:path";

import {
  AutoMemoryStore,
  ContextCompactor,
  ContextManager,
  CostTracker,
  estimateMessageTokens,
  formatTodosForPrompt,
  isMutatingTool,
  loadProjectMemory,
  loadSkillsFromDirectory,
  saveCheckpoint,
  SessionMemoryStore,
  skillsFromProjectMemory,
  type AgentAction,
  type AppState,
  type AppStateStore,
  type ModelTokenUsage,
  type RunEvent,
  type RunEventEnvelope,
  type RunResult,
  type RunSpec,
  type SessionStore,
  SkillRegistry,
  type SkillRegistry as SkillRegistryType,
  type TodoStore,
} from "@paw/core";

import {
  type ToolRunResult,
  executeTool,
  toolCatalogText,
  toolRequiresApproval,
  McpClientManager,
  type McpServerConfig,
  type SubAgentLauncher,
} from "@paw/harness";
import {
  type ChatMessage,
  type LanguageModel,
  createDefaultLanguageModel,
} from "@paw/models";
import {
  TaskPlanner,
  planItemsFromUnknown,
  planToSnapshotPayload,
  type PlanItem,
} from "@paw/store";
import { extractMemories } from "./memory-extraction-agent.js";
import { runCompressionAgent } from "./compression-agent.js";
import { parseAgentActionFromModelText, parseAgentActionsFromModelText } from "./parse-agent-action.js";
import { resolveMaxSteps } from "./resolve-max-steps.js";
import { formatToolResultEventDetail } from "./tool-result-detail.js";
import { discoverContext, extractAtMentions, gitStatus, loadPawMd, resolveMentions, WorkspaceWatcher } from "@paw/workspace";

export interface AskUserResolveInput {
  readonly question: string;
  readonly timeoutSec: number | null;
}

export interface ToolApprovalInput {
  readonly tool: string;
  readonly args: unknown;
}

export interface AgentOrchestratorOptions {
  /** When omitted, `run()` uses `createDefaultLanguageModel(workspaceRoot)` from the spec. */
  readonly model?: LanguageModel;
  readonly onEvent?: (envelope: RunEventEnvelope) => void;
  /**
   * Max plan rows embedded in the post-`plan_update` user message (`planToSnapshotPayload` in `@paw/store`).
   * Omit for the store default (64); use `0` for unlimited.
   */
  readonly planSnapshotMaxItems?: number;
  /**
   * When set, `ask_user` appends the reply and continues the same run instead of completing early.
   */
  readonly resolveAskUser?: (input: AskUserResolveInput) => Promise<string>;
  /**
   * When set, tools that {@link toolRequiresApproval} (or {@link approvalPolicy}) marks as gated
   * wait for approval before {@link executeTool}. If omitted, gated tools still execute (compat).
   */
  readonly resolveToolApproval?: (input: ToolApprovalInput) => Promise<boolean>;
  /**
   * Per-tool override for whether approval is required when {@link resolveToolApproval} is set.
   * Return `undefined` to fall back to harness defaults.
   */
  readonly approvalPolicy?: (tool: string) => boolean | undefined;
  /**
   * MCP server configurations to connect at run start and disconnect at completion.
   * When provided, MCP tools are included in the tool catalog and routed via {@link McpClientManager}.
   */
  readonly mcpServers?: readonly McpServerConfig[];
  /**
   * When set, every {@link RunEventEnvelope} is automatically persisted via
   * {@link SessionStore.saveEvent} so runs can be replayed or reviewed later.
   */
  readonly sessionStore?: SessionStore;
  /**
   * When set, the `workspace.todo_write` tool updates this store and the current
   * task list is injected into the system prompt so the model sees open items.
   */
  readonly todoStore?: TodoStore;
  /**
   * Optional context manager for sliding-window message history.
   * When omitted, the orchestrator creates an internal default.
   */
  readonly contextManager?: ContextManager;
  /**
   * Optional sub-agent launcher for the `workspace.run_agent` tool.
   * When omitted, the tool returns an error.
   */
  readonly subAgentLauncher?: SubAgentLauncher;
  /**
   * When set, the orchestrator saves a snapshot of its state after every turn
   * so the conversation can be resumed later.
   */
  readonly appStateStore?: AppStateStore;
  /**
   * Optional skill registry for the `workspace.run_skill` tool.
   * When omitted, the tool returns an error.
   */
  readonly skillRegistry?: SkillRegistryType;
  /**
   * Auto-load skills from this directory (recursively, `.json` files).
   * Populates {@link skillRegistry} when set.
   */
  readonly skillsDir?: string;
  /**
   * Optional cost tracker for token usage and cost estimation.
   * When set, usage is accumulated and `cost.update` events are emitted.
   */
  readonly costTracker?: CostTracker;
  /**
   * Optional filesystem watcher. When set, the orchestrator checks for
   * external file modifications before each model call and injects a notice.
   */
  readonly watcher?: WorkspaceWatcher;
}

/**
 * Multi-turn orchestrator: model ↔ tool loop until the model omits a tool line
 * or `maxSteps` model calls are exhausted.
 */
export class AgentOrchestrator {
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

  private toolNeedsApprovalGate(tool: string, args?: Record<string, unknown>): boolean {
    const o = this.approvalPolicy?.(tool);
    if (o !== undefined) {
      return o;
    }
    return toolRequiresApproval(tool, undefined, args);
  }

  /**
   * Resolve @-mentions in user text, read the files, and return a formatted
   * message that includes file contents inline so every model provider sees them.
   */
  private static resolveUserMentions(
    workspaceRoot: string,
    text: string,
  ): { content: string; notFound: readonly string[] } {
    const { strippedText, attachments, notFound } = resolveMentions(
      workspaceRoot,
      text,
    );
    if (attachments.length === 0) {
      return { content: text, notFound };
    }
    const fileBlocks = attachments
      .map(
        (a) =>
          `<file path="${a.name}">\n${a.content}\n</file>`,
      )
      .join("\n\n");
    const content = `<files>\n${fileBlocks}\n</files>\n\n${strippedText}`;
    return { content, notFound };
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
    if (!this.appStateStore) {
      return;
    }
    const plan = planner.plan;
    const state: AppState = {
      runId,
      goal,
      workspaceRoot,
      turn,
      maxSteps,
      messages: ctxMgr.buildMessages(),
      ...(plan
        ? {
            plan: {
              revision: plan.revision,
              items: plan.items as unknown[],
            },
          }
        : {}),
      ...(this.todoStore
        ? { todos: this.todoStore.items }
        : {}),
      ...(outcome ? { outcome } : {}),
      savedAt: Date.now(),
    };
    this.appStateStore.save(state);
  }

  private async invokeModel(
    model: LanguageModel,
    messages: readonly ChatMessage[],
    signal: AbortSignal | undefined,
    emit: (event: RunEvent) => void,
  ): Promise<{ text: string; usage?: ModelTokenUsage; thinking?: string }> {
    const streamFn = model.completeStream;
    if (typeof streamFn === "function") {
      let acc = "";
      let thinkingAcc = "";
      let usage: ModelTokenUsage | undefined;
      for await (const chunk of streamFn.call(model, messages, { signal })) {
        if (chunk.type === "text") {
          acc += chunk.delta;
          emit({ type: "model.chunk", text: acc });
        } else if (chunk.type === "thinking") {
          thinkingAcc += chunk.delta;
          emit({ type: "model.thinking", text: thinkingAcc });
        } else if (chunk.type === "tool_use") {
          // tool_use from stream is a preview; the orchestrator still parses
          // the final text for the actual action. We could emit a preview event
          // here in the future.
        } else if (chunk.type === "done") {
          usage = chunk.usage;
        }
      }
      emit({
        type: "model.done",
        text: acc,
        ...(thinkingAcc ? { thinking: thinkingAcc } : {}),
        ...(usage !== undefined ? { usage } : {}),
      });
      if (usage) {
        this.costTracker?.record(model.label, usage);
        const snap = this.costTracker?.snapshot();
        if (snap) {
          emit({ type: "cost.update", ...snap });
        }
      }
      return { text: acc, thinking: thinkingAcc || undefined, usage };
    }
    const result = await model.complete(messages, { signal });
    emit({ type: "model.chunk", text: result.text });
    emit({
      type: "model.done",
      text: result.text,
      ...(result.thinking !== undefined ? { thinking: result.thinking } : {}),
      ...(result.usage !== undefined ? { usage: result.usage } : {}),
    });
    if (result.usage) {
      this.costTracker?.record(model.label, result.usage);
      const snap = this.costTracker?.snapshot();
      if (snap) {
        emit({ type: "cost.update", ...snap });
      }
    }
    return { text: result.text, thinking: result.thinking, usage: result.usage };
  }

  async run(spec: RunSpec): Promise<RunResult> {
    const runId = spec.runId;
    const workspaceRoot = path.resolve(
      spec.workspaceRoot?.trim() ? spec.workspaceRoot : ".",
    );
    const signal = spec.abortSignal;
    const maxSteps = resolveMaxSteps(workspaceRoot, spec.maxSteps);

    const seq = { n: 0 };
    const checkpointSeq = { n: 0 };
    const emit = (event: RunEvent) => {
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

    emit({ type: "run.started", goal: spec.goal });

    const model =
      this.overrideModel ?? createDefaultLanguageModel(workspaceRoot);

    const mcp =
      this.mcpServers && this.mcpServers.length > 0
        ? new McpClientManager()
        : undefined;
    if (mcp) {
      for (const cfg of this.mcpServers!) {
        try {
          await mcp.connect(cfg);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          emit({
            type: "run.failed",
            message: `MCP connect (${cfg.name}): ${msg}`,
          });
          emit({
            type: "run.completed",
            status: "failed",
            message: `MCP connect (${cfg.name}): ${msg}`,
          });
          await mcp.disconnectAll();
          return {
            runId,
            status: "failed",
            message: `MCP connect (${cfg.name}): ${msg}`,
          };
        }
      }
    }

    const systemParts = [
      "You are Paw (TS harness). Follow user goals using the tools below.",
      `Workspace root (all relative tool paths are under this directory): ${workspaceRoot}`,
      'When you need a tool, output ONE JSON object on its own line at the end (valid JSON, no markdown fences). To call multiple tools at once, output multiple JSON objects, each on its own line. Tool shape: {"tool":"<id>","args":{...}} or {"name":"<id>","args":{...}}.',
      'Other structured endings: {"action":"final_answer","summary":"..."}, {"action":"abort","reason":"..."}, {"action":"ask_user","question":"..."}, {"action":"plan_update","reason":"...","new_items":[],"deprecated_items":[]}.',
      'After a plan_update, you may receive "Current plan (JSON):" with next_pending (next runnable row given dependencies, or null), all_complete (true when every row is completed or skipped), truncated/items_total when the item list was shortened.',
      "After tool results, you may call another tool or answer without a JSON line.",
      "Integrity: Do not claim you created, edited, deleted, or executed files or shell commands unless this conversation already contains a matching workspace.* tool result. To change files or run commands you MUST output the tool JSON line and continue until you receive Tool result (JSON).",
      toolCatalogText(mcp),
    ];
    if (this.skillRegistry.list().length > 0) {
      systemParts.push(this.skillRegistry.catalogText());
    }
    if (this.todoStore && this.todoStore.items.length > 0) {
      systemParts.push(formatTodosForPrompt(this.todoStore.items));
    }
    try {
      const git = gitStatus(workspaceRoot);
      if (!git.error && git.branch) {
        const parts: string[] = [];
        parts.push(`Git branch: ${git.branch}`);
        if (git.ahead) parts.push(`ahead ${git.ahead}`);
        if (git.behind) parts.push(`behind ${git.behind}`);
        if (git.staged?.length) parts.push(`${git.staged.length} staged`);
        if (git.modified?.length) parts.push(`${git.modified.length} modified`);
        if (git.untracked?.length) parts.push(`${git.untracked.length} untracked`);
        if (parts.length > 1) {
          systemParts.push(parts.join("\n"));
        }
      }
    } catch {
      // ignore git errors
    }
    try {
      const pawMd = loadPawMd(workspaceRoot);
      if (pawMd.content) {
        systemParts.push(`Project instructions (${pawMd.path}):\n${pawMd.content}`);
      }
    } catch {
      // ignore paw.md read errors
    }

    // Load project memory (.paw/CLAUDE.md and .paw/CLAUDE.local.md)
    const projectMemory = loadProjectMemory(workspaceRoot);
    if (projectMemory.committed) {
      systemParts.push(`Project rules (.paw/CLAUDE.md):\n${projectMemory.committed}`);
    }
    if (projectMemory.local) {
      systemParts.push(`Local preferences (.paw/CLAUDE.local.md):\n${projectMemory.local}`);
    }

    // Register project memory as implicit skills
    for (const skill of skillsFromProjectMemory(projectMemory.committed, projectMemory.local)) {
      if (!this.skillRegistry.has(skill.id)) {
        this.skillRegistry.register(skill);
      }
    }

    // Load auto memory entries and inject as system reminders
    const autoMemoryStore = new AutoMemoryStore({ workspaceRoot });
    const autoMemories = autoMemoryStore.list();
    if (autoMemories.length > 0) {
      const memoryLines = autoMemories.map((m) => `- ${m.name}: ${m.description}`);
      systemParts.push(`Previous session memories:\n${memoryLines.join("\n")}`);
    }

    const systemContent = systemParts.join("\n\n");

    const ctxMgr = this.contextManager ?? new ContextManager();
    const planner = new TaskPlanner();
    let startTurn = 0;

    // Session memory + compaction setup
    const sessionMemoryStore = new SessionMemoryStore({ workspaceRoot });
    const compactor = new ContextCompactor();

    // Resume from saved state if provided
    if (spec.resumeFromState) {
      const s = spec.resumeFromState;
      startTurn = s.turn;
      if (s.messages.length > 0) {
        ctxMgr.replaceHistory(s.messages);
      }
      if (s.plan) {
        planner.createPlan(runId, []);
        try {
          planner.applyUpdate(s.plan.items as readonly PlanItem[], [], "resume");
        } catch {
          // ignore plan restore errors
        }
      }
      if (s.todos && this.todoStore) {
        this.todoStore.set(s.todos);
      }
      // Load previous session memory on resume
      const prevMemory = sessionMemoryStore.load(runId);
      if (prevMemory?.task) {
        ctxMgr.addUser(`[Previous session context]\nTask: ${prevMemory.task}\nState: ${prevMemory.currentState ?? "unknown"}`);
      }
      emit({
        type: "run.started",
        goal: spec.goal,
      });
    } else {
      ctxMgr.setSystem(systemContent);
      const goalMentions = AgentOrchestrator.resolveUserMentions(
        workspaceRoot,
        spec.goal,
      );

      // Auto-discover relevant files from the goal, excluding @-mentioned ones
      const mentionedPaths = extractAtMentions(spec.goal);
      const autoCtx = discoverContext(workspaceRoot, spec.goal, mentionedPaths);
      let userContent = goalMentions.content;
      if (autoCtx.content) {
        userContent = `${autoCtx.content}\n\n${goalMentions.content}`;
      }

      ctxMgr.addUser(userContent);
    }

    try {
      let finalMessage = "";
      planner.createPlan(runId, []);

      for (let turn = startTurn; turn < maxSteps; turn++) {
        if (signal?.aborted) {
          finalMessage = "Run aborted.";
          this.saveState(runId, spec.goal, workspaceRoot, turn, maxSteps, ctxMgr, planner, {
            status: "failed",
            message: finalMessage,
          });
          emit({
            type: "run.completed",
            status: "failed",
            message: finalMessage,
          });
          return { runId, status: "failed", message: finalMessage };
        }

        emit({ type: "loop.tick", turn: turn + 1, maxSteps });
        emit({ type: "phase", name: "model" });
        emit({
          type: "model.request",
          label: model.label,
          messageCount: ctxMgr.length,
        });

        const staleFiles = this.watcher?.takeExternallyModified() ?? [];
        if (staleFiles.length > 0) {
          ctxMgr.addUser(
            `Note: the following file(s) were modified externally since the last turn and may be stale:\n${staleFiles.map((f) => `- ${f}`).join("\n")}`,
          );
        }

        // Layer 1: Prune old tool results before sending to model
        const pruneResult = ctxMgr.prune();
        if (pruneResult.pruned) {
          emit({
            type: "compression.prune.done",
            freedTokens: pruneResult.freedTokens,
            remainingTokens: ctxMgr.estimatedTokens,
          });
        }

        // Layer 2/3: Session Memory + Auto-Compact
        const CONTEXT_WINDOW = 200_000; // default for Claude 3.5 Sonnet
        const compactCheck = compactor.check(ctxMgr.buildMessages(), CONTEXT_WINDOW);
        if (
          compactCheck.shouldCompact &&
          this.subAgentLauncher &&
          !compactor.isDisabled &&
          !compactor.shouldSkipDueToThrashing()
        ) {
          emit({
            type: "compression.auto_compact.started",
            beforeTokens: compactCheck.currentTokens,
          });

          try {
            const boundaries = compactor.determineBoundaries(ctxMgr.buildMessages());
            const messages = ctxMgr.buildMessages();
            const headMessages = messages.slice(0, boundaries.headEnd + 1);
            const tailMessages = messages.slice(boundaries.tailStart);

            // Load existing summary for anchored updates
            const existing = sessionMemoryStore.load(runId);
            const prompt = compactor.buildSummaryPrompt(
              headMessages,
              existing ? sessionMemoryStore.toMarkdown(existing) : null,
            );

            const { summary, sessionMemory } = await runCompressionAgent(
              this.subAgentLauncher,
              prompt,
              runId,
            );

            // Replace compressed section with summary message
            const summaryMsg: ChatMessage = {
              role: "user",
              content: `[Context Summary]\n${summary}`,
            };
            const newMessages = [...headMessages, summaryMsg, ...tailMessages];
            ctxMgr.replaceHistory(newMessages);

            // Save session memory
            const memoryToSave = { ...sessionMemory, project: path.basename(workspaceRoot) };
            sessionMemoryStore.save(runId, memoryToSave);

            const afterTokens = ctxMgr.estimatedTokens;
            emit({
              type: "compression.auto_compact.done",
              afterTokens,
              summaryTokens: estimateMessageTokens(summaryMsg),
            });

            compactor.recordResult(compactCheck.currentTokens, afterTokens, true);
          } catch (err) {
            compactor.recordResult(compactCheck.currentTokens, compactCheck.currentTokens, false);
            emit({
              type: "compression.skipped",
              reason: `compaction failed: ${err instanceof Error ? err.message : String(err)}`,
            });
          }
        }

        const { text, thinking } = await this.invokeModel(model, ctxMgr.buildMessages(), signal, emit);

        emit({ type: "phase", name: "parse" });
        const { actions: toolCalls, text: reasoningText } =
          parseAgentActionsFromModelText(text);

        // Parallel tool execution for multiple tool calls
        if (toolCalls.length > 1) {
          for (const action of toolCalls) {
            emit({ type: "agent.action", action });
          }

          emit({ type: "phase", name: "tool" });
          for (const call of toolCalls) {
            emit({ type: "tool.call", tool: call.tool, args: call.args });
          }

          const approvals: boolean[] = [];
          for (const call of toolCalls) {
            const approveFn = this.resolveToolApproval;
            const gated =
              this.toolNeedsApprovalGate(call.tool, call.args as Record<string, unknown>) && approveFn !== undefined;
            if (gated && approveFn) {
              emit({
                type: "tool.approval.pending",
                tool: call.tool,
                args: call.args,
              });
              const approved = await approveFn({
                tool: call.tool,
                args: call.args,
              });
              emit({
                type: "tool.approval.resolved",
                tool: call.tool,
                approved,
              });
              approvals.push(approved);
            } else {
              approvals.push(true);
            }
          }

          const results = await Promise.all(
            toolCalls.map(async (call, i) => {
              if (!approvals[i]) {
                return {
                  ok: false,
                  summary: "tool execution denied by user",
                  payload: { denied: true },
                };
              }
              if (isMutatingTool(call.tool)) {
                checkpointSeq.n += 1;
                saveCheckpoint(workspaceRoot, runId, checkpointSeq.n, call.tool, call.args);
              }
              return executeTool(
                {
                  workspaceRoot,
                  mcp,
                  todoStore: this.todoStore,
                  subAgentLauncher: this.subAgentLauncher,
                  skillRegistry: this.skillRegistry,
                  watcher: this.watcher,
                  onShellChunk: (tool, chunk, isStderr) =>
                    emit({
                      type: "tool.result.chunk",
                      tool,
                      chunk,
                      isStderr,
                    }),
                },
                call.tool,
                call.args,
              );
            }),
          );

          for (let i = 0; i < toolCalls.length; i++) {
            const call = toolCalls[i]!;
            const tr = results[i]!;
            emit({
              type: "tool.result",
              tool: call.tool,
              ok: tr.ok,
              summary: tr.summary,
              detail: formatToolResultEventDetail(tr),
            });
          }

          ctxMgr.addAssistant(reasoningText || text, thinking);
          ctxMgr.addToolResults(
            results.map((tr, i) => ({
              tool: toolCalls[i]!.tool,
              ok: tr.ok,
              summary: tr.summary,
              payload: tr.payload,
            })),
          );

          if (turn + 1 >= maxSteps) {
            finalMessage = `Max steps (${maxSteps}) reached after parallel tools`;
            this.saveState(
              runId,
              spec.goal,
              workspaceRoot,
              turn + 1,
              maxSteps,
              ctxMgr,
              planner,
              {
                status: "completed",
                message: finalMessage,
              },
            );
            emit({
              type: "run.completed",
              status: "completed",
              message: finalMessage,
            });
            return {
              runId,
              status: "completed",
              message: finalMessage,
            };
          }
          this.saveState(
            runId,
            spec.goal,
            workspaceRoot,
            turn + 1,
            maxSteps,
            ctxMgr,
            planner,
          );
          // Background memory extraction (non-blocking)
          this.maybeExtractMemories(autoMemoryStore, turn, ctxMgr.buildMessages(), runId, emit);
          continue;
        }

        let action: AgentAction | null = null;
        if (toolCalls.length === 1) {
          action = toolCalls[0]!;
        } else {
          action = parseAgentActionFromModelText(text);
        }

        if (action) {
          emit({ type: "agent.action", action });
        }

        if (!action) {
          finalMessage = text.trim() || "(empty model output)";
          this.saveState(runId, spec.goal, workspaceRoot, turn + 1, maxSteps, ctxMgr, planner, {
            status: "completed",
            message: finalMessage,
          });
          emit({
            type: "run.completed",
            status: "completed",
            message: finalMessage,
          });
          return { runId, status: "completed", message: finalMessage };
        }

        if (action.type === "final_answer") {
          finalMessage = action.summary.trim() || "(empty summary)";
          this.saveState(runId, spec.goal, workspaceRoot, turn + 1, maxSteps, ctxMgr, planner, {
            status: "completed",
            message: finalMessage,
          });
          emit({
            type: "run.completed",
            status: "completed",
            message: finalMessage,
          });
          return { runId, status: "completed", message: finalMessage };
        }

        if (action.type === "abort") {
          finalMessage = action.reason.trim() || "Aborted.";
          this.saveState(runId, spec.goal, workspaceRoot, turn + 1, maxSteps, ctxMgr, planner, {
            status: "failed",
            message: finalMessage,
          });
          emit({
            type: "run.completed",
            status: "failed",
            message: finalMessage,
          });
          return { runId, status: "failed", message: finalMessage };
        }

        if (action.type === "ask_user") {
          if (this.resolveAskUser) {
            emit({
              type: "user.reply.required",
              question: action.question,
              timeoutSec: action.timeoutSec,
            });
            const reply = await this.resolveAskUser({
              question: action.question,
              timeoutSec: action.timeoutSec,
            });
            ctxMgr.addAssistant(text, thinking);
            const replyMentions = AgentOrchestrator.resolveUserMentions(
              workspaceRoot,
              reply,
            );
            ctxMgr.addUser(replyMentions.content);
            if (turn + 1 >= maxSteps) {
              finalMessage = `Max steps (${maxSteps}) reached after ask_user`;
              this.saveState(runId, spec.goal, workspaceRoot, turn + 1, maxSteps, ctxMgr, planner, {
                status: "completed",
                message: finalMessage,
              });
              emit({
                type: "run.completed",
                status: "completed",
                message: finalMessage,
              });
              return { runId, status: "completed", message: finalMessage };
            }
            // Save state after each successful turn so it can be resumed
            this.saveState(runId, spec.goal, workspaceRoot, turn + 1, maxSteps, ctxMgr, planner);
            // Background memory extraction (non-blocking)
            this.maybeExtractMemories(autoMemoryStore, turn, ctxMgr.buildMessages(), runId, emit);
            continue;
          }
          finalMessage = `[Ask user] ${action.question}`;
          this.saveState(runId, spec.goal, workspaceRoot, turn + 1, maxSteps, ctxMgr, planner, {
            status: "completed",
            message: finalMessage,
          });
          emit({
            type: "run.completed",
            status: "completed",
            message: finalMessage,
          });
          return { runId, status: "completed", message: finalMessage };
        }

        if (action.type === "plan_update") {
          const parsedItems = planItemsFromUnknown(action.newItems);
          try {
            planner.applyUpdate(
              parsedItems,
              action.deprecatedItems,
              action.reason,
            );
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.saveState(runId, spec.goal, workspaceRoot, turn + 1, maxSteps, ctxMgr, planner, {
              status: "failed",
              message: msg,
            });
            emit({
              type: "run.completed",
              status: "failed",
              message: msg,
            });
            return { runId, status: "failed", message: msg };
          }
          const p = planner.plan;
          if (p) {
            emit({
              type: "plan.updated",
              revision: p.revision,
              itemCount: p.items.length,
              reason: action.reason,
            });
          }
          ctxMgr.addAssistant(text, thinking);
          const snapshotOpts =
            this.planSnapshotMaxItems !== undefined
              ? { maxItems: this.planSnapshotMaxItems }
              : undefined;
          const planSnap = p ? planToSnapshotPayload(p, snapshotOpts) : null;
          const planBlock = planSnap
            ? `Current plan (JSON):\n${JSON.stringify(planSnap)}`
            : "Current plan: (empty)";
          ctxMgr.addUser(`Plan updated: ${action.reason}.\n\n${planBlock}`);
          if (turn + 1 >= maxSteps) {
            finalMessage = `Max steps (${maxSteps}) reached after plan_update`;
            this.saveState(runId, spec.goal, workspaceRoot, turn + 1, maxSteps, ctxMgr, planner, {
              status: "completed",
              message: finalMessage,
            });
            emit({
              type: "run.completed",
              status: "completed",
              message: finalMessage,
            });
            return { runId, status: "completed", message: finalMessage };
          }
          this.saveState(runId, spec.goal, workspaceRoot, turn + 1, maxSteps, ctxMgr, planner);
          // Background memory extraction (non-blocking)
          this.maybeExtractMemories(autoMemoryStore, turn, ctxMgr.buildMessages(), runId, emit);
          continue;
        }

        const call = action;

        emit({ type: "phase", name: "tool" });
        emit({ type: "tool.call", tool: call.tool, args: call.args });

        let tr: ToolRunResult;
        const approveFn = this.resolveToolApproval;
        const gated =
          this.toolNeedsApprovalGate(call.tool) && approveFn !== undefined;

        if (isMutatingTool(call.tool)) {
          checkpointSeq.n += 1;
          saveCheckpoint(workspaceRoot, runId, checkpointSeq.n, call.tool, call.args);
        }

        if (gated && approveFn) {
          emit({
            type: "tool.approval.pending",
            tool: call.tool,
            args: call.args,
          });
          const approved = await approveFn({
            tool: call.tool,
            args: call.args,
          });
          emit({
            type: "tool.approval.resolved",
            tool: call.tool,
            approved,
          });
          if (!approved) {
            tr = {
              ok: false,
              summary: "tool execution denied by user",
              payload: { denied: true },
            };
          } else {
            tr = await executeTool({ workspaceRoot, mcp, todoStore: this.todoStore, subAgentLauncher: this.subAgentLauncher, skillRegistry: this.skillRegistry, watcher: this.watcher, onShellChunk: (tool, chunk, isStderr) => emit({ type: "tool.result.chunk", tool, chunk, isStderr }) }, call.tool, call.args);
          }
        } else {
          tr = await executeTool({ workspaceRoot, mcp, todoStore: this.todoStore, subAgentLauncher: this.subAgentLauncher, skillRegistry: this.skillRegistry, onShellChunk: (tool, chunk, isStderr) => emit({ type: "tool.result.chunk", tool, chunk, isStderr }) }, call.tool, call.args);
        }

        emit({
          type: "tool.result",
          tool: call.tool,
          ok: tr.ok,
          summary: tr.summary,
          detail: formatToolResultEventDetail(tr),
        });

        ctxMgr.addAssistant(text, thinking);
        const observation = JSON.stringify({
          tool: call.tool,
          ok: tr.ok,
          summary: tr.summary,
          payload: tr.payload,
        });
        ctxMgr.addUser(`Tool result (JSON):\n${observation.slice(0, 50_000)}`);

        if (turn + 1 >= maxSteps) {
          finalMessage = `Max steps (${maxSteps}) reached after tool ${call.tool}: ${tr.summary}`;
          this.saveState(runId, spec.goal, workspaceRoot, turn + 1, maxSteps, ctxMgr, planner, {
            status: "completed",
            message: finalMessage,
          });
          emit({
            type: "run.completed",
            status: "completed",
            message: finalMessage,
          });
          return { runId, status: "completed", message: finalMessage };
        }
        // Save state after each successful tool turn
        this.saveState(runId, spec.goal, workspaceRoot, turn + 1, maxSteps, ctxMgr, planner);
        // Background memory extraction (non-blocking)
        this.maybeExtractMemories(autoMemoryStore, turn, ctxMgr.buildMessages(), runId, emit);
      }

      const exhaustedMessage = "internal: model loop exhausted without return";
      this.saveState(runId, spec.goal, workspaceRoot, maxSteps, maxSteps, ctxMgr, planner, {
        status: "failed",
        message: exhaustedMessage,
      });
      return {
        runId,
        status: "failed",
        message: exhaustedMessage,
      };
    } catch (e) {
      const message =
        e instanceof Error
          ? e.name === "AbortError"
            ? "Run aborted."
            : e.message
          : String(e);
      this.saveState(runId, spec.goal, workspaceRoot, maxSteps, maxSteps, ctxMgr, planner, {
        status: "failed",
        message,
      });
      emit({ type: "run.failed", message });
      emit({
        type: "run.completed",
        status: "failed",
        message,
      });
      return {
        runId,
        status: "failed",
        message,
      };
    } finally {
      await mcp?.disconnectAll();
    }
  }

  /**
   * Fire a background memory extraction agent.
   * Non-blocking — errors are swallowed.
   */
  private async maybeExtractMemories(
    store: AutoMemoryStore,
    turn: number,
    messages: readonly ChatMessage[],
    runId: string,
    emit: (event: RunEvent) => void,
  ): Promise<void> {
    if (!this.subAgentLauncher) return;

    // Only extract every 5 turns to avoid excessive LLM calls
    if (turn % 5 !== 0) return;

    const conversationText = messages
      .slice(-20) // last 20 messages
      .map((m) => {
        const prefix = m.role === "user" ? "User" : m.role === "assistant" ? "Assistant" : "System";
        return `[${prefix}]\n${m.content.slice(0, 2000)}`;
      })
      .join("\n\n");

    try {
      const { entries } = await extractMemories(this.subAgentLauncher, conversationText);
      if (entries.length > 0) {
        for (const entry of entries) {
          store.save(entry);
        }
        emit({
          type: "memory.extracted",
          entries: entries.length,
          runId,
        });
      }
    } catch (err) {
      // Log but don't fail the main loop
      console.error("[memory extraction] failed:", err instanceof Error ? err.message : String(err));
    }
  }
}
