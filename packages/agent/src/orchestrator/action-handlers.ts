/**
 * Action handlers: each action type has its own isolated handler.
 * Adding a new action type only requires registering a new handler here.
 */

import type { AgentAction, AgentToolCallAction, EvalHooks } from "@paw/core";
import type { TaskPlanner } from "@paw/store";
import type { AgentGroup } from "./agent-group.js";
import { isSubAgentCall } from "./constants.js";
import { DefaultContextSummarizer } from "./context-summarizer.js";
import { executeToolCalls, finalizeToolExecution } from "./tool-runner.js";
import type { PhaseContext, TurnFlags, TurnState } from "./types.js";

// ─────────────────────────────────────────────────────────────
// Handler registry
// ─────────────────────────────────────────────────────────────

export async function handleAction(
  actions: AgentAction[],
  toolCalls: AgentToolCallAction[],
  ctx: PhaseContext,
  flags: TurnFlags,
  text: string,
  thinking: string | undefined,
  opts: {
    readonly resolveAskUser?: (input: {
      readonly question: string;
      readonly timeoutSec: number | null;
    }) => Promise<string>;
    readonly resolveToolApproval?: (input: {
      readonly tool: string;
      readonly args: unknown;
    }) => Promise<boolean>;
    readonly approvalPolicy?: (tool: string) => boolean | undefined;
    readonly todoStore?: {
      readonly items: readonly { readonly status: string }[];
    };
    readonly planner: TaskPlanner;
    readonly planSnapshotMaxItems?: number;
    readonly saveStateFn: () => void;
    readonly agentGroup?: AgentGroup;
    readonly childPolicy?: "read_only" | "read_write";
    readonly subAgentLauncher?: import("@paw/harness").SubAgentLauncher;
    readonly skillRegistry?: import("@paw/core").SkillRegistry;
    readonly watcher?: import("@paw/workspace").WorkspaceWatcher;
    readonly evalHooks?: EvalHooks;
  },
): Promise<{ readonly state: TurnState; readonly flags: TurnFlags }> {
  // If there are sub-agent calls, route them separately
  const subAgentCalls = toolCalls.filter(isSubAgentCall);
  const normalToolCalls = toolCalls.filter((c) => !isSubAgentCall(c));

  // Handle sub-agent calls first (batch mode)
  if (subAgentCalls.length > 0) {
    return handleRunAgent(subAgentCalls, ctx, flags, text, thinking, opts);
  }

  // Handle normal tool calls
  if (normalToolCalls.length > 0) {
    return handleToolCalls(normalToolCalls, ctx, flags, text, thinking, opts);
  }

  // No tool calls – handle structured actions
  const action = actions[0] ?? null;
  if (!action) {
    return handleNoAction(ctx, flags, text, thinking, opts);
  }

  ctx.emit({ type: "agent.action", action });

  switch (action.type) {
    case "final_answer":
      return handleFinalAnswer(action, ctx, flags, text, thinking, opts);
    case "abort":
      return handleAbort(action);
    case "ask_user":
      return handleAskUser(action, ctx, flags, text, thinking, opts);
    case "plan_update":
      return handlePlanUpdate(action, ctx, flags, text, thinking, opts);
    default:
      // Fallback: treat as no action
      return handleNoAction(ctx, flags, text, thinking, opts);
  }
}

// ─────────────────────────────────────────────────────────────
// No action (auto-nudge or complete)
// ─────────────────────────────────────────────────────────────

function handleNoAction(
  ctx: PhaseContext,
  flags: TurnFlags,
  text: string,
  thinking: string | undefined,
  opts: {
    readonly saveStateFn: () => void;
  },
): { readonly state: TurnState; readonly flags: TurnFlags } {
  if (flags.hasEverUsedTools && flags.autoContinueNudges < 2) {
    // Auto-nudge: model stopped without final_answer after using tools
    const nextFlags: TurnFlags = {
      ...flags,
      autoContinueNudges: flags.autoContinueNudges + 1,
      lastTurnHadToolCall: false,
    };
    ctx.ctxMgr.addAssistant(text, thinking);
    ctx.ctxMgr.addUser(
      `[You stopped without a final_answer action. If you have completed the task, output: {"action":"final_answer","summary":"<your complete findings here>"}. If not done, continue — call the next tool or take the next action.]`,
    );
    opts.saveStateFn();
    return { state: { type: "continue", nextFlags }, flags: nextFlags };
  }

  // Complete with plain text (conversational reply, no tools needed)
  const displayText =
    text.trim() ||
    (thinking?.trim()
      ? `[model produced only reasoning]\n${thinking.trim()}`
      : "(empty model output)");
  ctx.ctxMgr.addAssistant(displayText, thinking);
  ctx.emit({ type: "model.done", text: displayText });
  return {
    state: {
      type: "completed",
      message: displayText,
    },
    flags,
  };
}

// ─────────────────────────────────────────────────────────────
// final_answer
// ─────────────────────────────────────────────────────────────

function handleFinalAnswer(
  action: Extract<AgentAction, { type: "final_answer" }>,
  ctx: PhaseContext,
  flags: TurnFlags,
  text: string,
  thinking: string | undefined,
  opts: {
    readonly todoStore?: {
      readonly items: readonly { readonly status: string }[];
    };
    readonly planner: TaskPlanner;
    readonly saveStateFn: () => void;
  },
): { readonly state: TurnState; readonly flags: TurnFlags } {
  const plan = opts.planner.plan;
  const hasPendingPlan = plan && !plan.allComplete && plan.items.length > 0;
  const hasPendingTodos = opts.todoStore?.items.some(
    (t) => t.status !== "done",
  );

  if (
    (hasPendingPlan || hasPendingTodos) &&
    flags.autoContinueNudges < 3 &&
    flags.lastTurnHadToolCall
  ) {
    // Nudge for pending plan/todo items
    const nextFlags: TurnFlags = {
      ...flags,
      autoContinueNudges: flags.autoContinueNudges + 1,
      lastTurnHadToolCall: false,
    };
    ctx.ctxMgr.addAssistant(text, thinking);

    const pendingPlanCount =
      plan?.items.filter(
        (i) =>
          typeof i === "object" &&
          i !== null &&
          "status" in i &&
          (i as Record<string, unknown>).status !== "completed" &&
          (i as Record<string, unknown>).status !== "skipped",
      ).length ?? 0;
    const pendingTodoCount =
      opts.todoStore?.items.filter((t) => t.status !== "done").length ?? 0;
    const pending = [
      pendingPlanCount > 0 ? `${pendingPlanCount} plan item(s)` : null,
      pendingTodoCount > 0 ? `${pendingTodoCount} todo(s)` : null,
    ]
      .filter(Boolean)
      .join(", ");

    ctx.ctxMgr.addUser(
      `[You have pending work: ${pending}. Continue from where you left off — do not summarize or apologize, just take the next action.]`,
    );
    opts.saveStateFn();
    return { state: { type: "continue", nextFlags }, flags: nextFlags };
  }

  return {
    state: {
      type: "completed",
      message: action.summary.trim() || "(empty summary)",
    },
    flags,
  };
}

// ─────────────────────────────────────────────────────────────
// abort
// ─────────────────────────────────────────────────────────────

function handleAbort(action: Extract<AgentAction, { type: "abort" }>): {
  readonly state: TurnState;
  readonly flags: TurnFlags;
} {
  return {
    state: { type: "failed", message: action.reason.trim() || "Aborted." },
    flags: {
      autoContinueNudges: 0,
      lastTurnHadToolCall: false,
      hasEverUsedTools: false,
    },
  };
}

// ─────────────────────────────────────────────────────────────
// ask_user
// ─────────────────────────────────────────────────────────────

async function handleAskUser(
  action: Extract<AgentAction, { type: "ask_user" }>,
  ctx: PhaseContext,
  flags: TurnFlags,
  text: string,
  thinking: string | undefined,
  opts: {
    readonly resolveAskUser?: (input: {
      readonly question: string;
      readonly timeoutSec: number | null;
    }) => Promise<string>;
    readonly saveStateFn: () => void;
  },
): Promise<{ readonly state: TurnState; readonly flags: TurnFlags }> {
  const nextFlags: TurnFlags = {
    ...flags,
    lastTurnHadToolCall: false,
  };

  if (opts.resolveAskUser) {
    ctx.emit({
      type: "user.reply.required",
      question: action.question,
      timeoutSec: action.timeoutSec,
    });
    const reply = await opts.resolveAskUser({
      question: action.question,
      timeoutSec: action.timeoutSec,
    });
    ctx.ctxMgr.addAssistant(text, thinking);
    ctx.ctxMgr.addUser(reply);

    if (ctx.turn + 1 >= ctx.maxSteps) {
      return {
        state: {
          type: "completed",
          message: `Max steps (${ctx.maxSteps}) reached after ask_user`,
        },
        flags: nextFlags,
      };
    }

    opts.saveStateFn();
    return { state: { type: "continue", nextFlags }, flags: nextFlags };
  }

  // No resolver – treat as completion
  return {
    state: { type: "completed", message: `[Ask user] ${action.question}` },
    flags: nextFlags,
  };
}

// ─────────────────────────────────────────────────────────────
// plan_update
// ─────────────────────────────────────────────────────────────

async function handlePlanUpdate(
  action: Extract<AgentAction, { type: "plan_update" }>,
  ctx: PhaseContext,
  flags: TurnFlags,
  text: string,
  thinking: string | undefined,
  opts: {
    readonly planner: TaskPlanner;
    readonly planSnapshotMaxItems?: number;
    readonly saveStateFn: () => void;
  },
): Promise<{ readonly state: TurnState; readonly flags: TurnFlags }> {
  const nextFlags: TurnFlags = {
    ...flags,
    lastTurnHadToolCall: false,
  };

  const { planItemsFromUnknown, planToSnapshotPayload } = await import(
    "@paw/store"
  );
  const parsedItems = planItemsFromUnknown(action.newItems);

  try {
    opts.planner.applyUpdate(
      parsedItems,
      action.deprecatedItems,
      action.reason,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { state: { type: "failed", message: msg }, flags: nextFlags };
  }

  const p = opts.planner.plan;
  if (p) {
    ctx.emit({
      type: "plan.updated",
      revision: p.revision,
      itemCount: p.items.length,
      reason: action.reason,
    });
  }

  ctx.ctxMgr.addAssistant(text, thinking);

  const snapshotOpts =
    opts.planSnapshotMaxItems !== undefined
      ? { maxItems: opts.planSnapshotMaxItems }
      : undefined;
  const planSnap = p ? planToSnapshotPayload(p, snapshotOpts) : null;
  const planBlock = planSnap
    ? `Current plan (JSON):\n${JSON.stringify(planSnap)}`
    : "Current plan: (empty)";
  ctx.ctxMgr.addUser(`Plan updated: ${action.reason}.\n\n${planBlock}`);

  if (ctx.turn + 1 >= ctx.maxSteps) {
    return {
      state: {
        type: "completed",
        message: `Max steps (${ctx.maxSteps}) reached after plan_update`,
      },
      flags: nextFlags,
    };
  }

  opts.saveStateFn();
  return { state: { type: "continue", nextFlags }, flags: nextFlags };
}

// ─────────────────────────────────────────────────────────────
// Normal tool calls
// ─────────────────────────────────────────────────────────────

async function handleToolCalls(
  calls: readonly AgentToolCallAction[],
  ctx: PhaseContext,
  flags: TurnFlags,
  text: string,
  thinking: string | undefined,
  opts: {
    readonly resolveToolApproval?: (input: {
      readonly tool: string;
      readonly args: unknown;
    }) => Promise<boolean>;
    readonly approvalPolicy?: (tool: string) => boolean | undefined;
    readonly saveStateFn: () => void;
    readonly childPolicy?: "read_only" | "read_write";
    readonly subAgentLauncher?: import("@paw/harness").SubAgentLauncher;
    readonly todoStore?: import("@paw/core").TodoStore;
    readonly skillRegistry?: import("@paw/core").SkillRegistry;
    readonly watcher?: import("@paw/workspace").WorkspaceWatcher;
    readonly evalHooks?: EvalHooks;
  },
): Promise<{ readonly state: TurnState; readonly flags: TurnFlags }> {
  const nextFlags: TurnFlags = {
    ...flags,
    lastTurnHadToolCall: true,
    hasEverUsedTools: true,
  };

  for (const action of calls) {
    ctx.emit({ type: "agent.action", action });
  }
  ctx.emit({ type: "phase", name: "tool" });
  for (const call of calls) {
    ctx.emit({ type: "tool.call", tool: call.tool, args: call.args });
  }

  const toolStartTime = Date.now();
  const results = await executeToolCalls(
    calls,
    {
      workspaceRoot: ctx.workspaceRoot,
      runId: ctx.runId,
      mcp: ctx.mcp,
      emit: ctx.emit,
      checkpointSeq: ctx.checkpointSeq,
      childPolicy: opts.childPolicy,
      subAgentLauncher: opts.subAgentLauncher,
      todoStore: opts.todoStore,
      skillRegistry: opts.skillRegistry,
      watcher: opts.watcher,
      parentContextManager: ctx.ctxMgr,
      abortSignal: ctx.signal,
      shellSandbox: ctx.shellSandbox,
    },
    {
      resolveToolApproval: opts.resolveToolApproval,
      approvalPolicy: opts.approvalPolicy,
    },
  );
  const toolDuration = Date.now() - toolStartTime;

  // Eval hooks: notify after each tool call
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i]!;
    const tr = results[i]!;
    opts.evalHooks?.afterToolCall?.({
      tool: call.tool,
      args: call.args,
      result: tr.summary,
      ok: tr.ok,
      durationMs: Math.round(toolDuration / calls.length),
    });
  }

  const final = finalizeToolExecution(calls, results, {
    ctxMgr: ctx.ctxMgr,
    emit: ctx.emit,
    runId: ctx.runId,
    workspaceRoot: ctx.workspaceRoot,
    turn: ctx.turn,
    maxSteps: ctx.maxSteps,
    specGoal: ctx.specGoal,
    text,
    thinking,
    saveStateFn: opts.saveStateFn,
  });

  if (final.type === "completed") {
    return {
      state: { type: "completed", message: final.message! },
      flags: nextFlags,
    };
  }

  return { state: { type: "continue", nextFlags }, flags: nextFlags };
}

// ─────────────────────────────────────────────────────────────
// Sub-agent (run_agent) calls
// ─────────────────────────────────────────────────────────────

async function handleRunAgent(
  calls: readonly AgentToolCallAction[],
  ctx: PhaseContext,
  flags: TurnFlags,
  text: string,
  thinking: string | undefined,
  opts: {
    readonly saveStateFn: () => void;
    readonly agentGroup?: AgentGroup;
    readonly evalHooks?: EvalHooks;
  },
): Promise<{ readonly state: TurnState; readonly flags: TurnFlags }> {
  const nextFlags: TurnFlags = {
    ...flags,
    lastTurnHadToolCall: true,
    hasEverUsedTools: true,
  };

  if (!opts.agentGroup) {
    return {
      state: {
        type: "failed",
        message: "Sub-agent launcher not configured",
      },
      flags: nextFlags,
    };
  }

  // Emit tool.call for each sub-agent invocation
  for (const call of calls) {
    ctx.emit({ type: "tool.call", tool: call.tool, args: call.args });
  }

  const summarizer = new DefaultContextSummarizer();

  // Emit waiting_children state
  ctx.emit({
    type: "phase",
    name: "waiting_children",
  });

  // Launch children and wait for batch completion
  const agentStartTime = Date.now();
  const results = await opts.agentGroup.launchAll(
    calls,
    (call) => summarizer.summarizeForCall(ctx.ctxMgr, call),
    ctx.signal,
  );
  const agentDuration = Date.now() - agentStartTime;

  // Emit merging_results state
  ctx.emit({
    type: "phase",
    name: "merging_results",
  });

  // Merge results into parent context (concise summary only)
  ctx.ctxMgr.addAssistant(text, thinking);
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i]!;
    const r = results[i]!;
    ctx.emit({
      type: "tool.result",
      tool: call.tool,
      ok: r.status === "completed",
      summary: r.summary,
      detail: r.errors?.join("; ") || r.summary,
    });
    opts.evalHooks?.afterToolCall?.({
      tool: call.tool,
      args: call.args,
      result: r.summary,
      ok: r.status === "completed",
      durationMs: Math.round(agentDuration / calls.length),
    });
  }
  ctx.ctxMgr.addToolResults(
    results.map((r) => ({
      tool: "workspace.run_agent",
      ok: r.status === "completed",
      summary: r.summary,
      payload: {
        findings: r.findings,
        changedFiles: r.changedFiles,
        errors: r.errors,
      },
    })),
  );

  if (ctx.turn + 1 >= ctx.maxSteps) {
    return {
      state: {
        type: "completed",
        message: `Max steps (${ctx.maxSteps}) reached after sub-agents`,
      },
      flags: nextFlags,
    };
  }

  opts.saveStateFn();
  return { state: { type: "continue", nextFlags }, flags: nextFlags };
}
