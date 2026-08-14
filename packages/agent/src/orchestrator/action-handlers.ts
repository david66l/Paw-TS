/**
 * Action 处理器：每种 action 类型有独立的处理函数。
 * ====================================================
 *
 * 这是 orchestrator 的"动作分发层"。模型返回的动作经过 parse-agent-action.ts
 * 解析后，由 handleAction() 根据类型路由到对应的处理器。
 *
 * 支持的 action 类型：
 * - final_answer：任务完成，返回最终结果
 * - abort：任务中止
 * - ask_user：向用户提问（需要审批回调）
 * - plan_update：更新执行计划
 * - 工具调用（normal tool calls）：通过 tool-runner.ts 执行
 * - 子 Agent 调用（run_agent）：通过 AgentGroup 批量启动
 *
 * 特殊机制 —— auto-nudge（自动推动）：
 * 当模型在使用了工具后没有给出 final_answer 就停止时，系统会自动注入一条
 * 提示消息推动模型继续。这个机制防止模型"卡住"——比如模型调用了 Read 工具
 * 读取了文件，但忘了输出 final_answer。提示会随连续无动作次数升级；任务是否
 * 终止仍只由 maxSteps、墙钟和 idle fuse 等生命周期预算决定。
 *
 * 添加新 action 类型只需在这里注册一个新的 handler，无需修改其他代码。
 */

import type {
  AgentAction,
  AgentToolCallAction,
  EvalHooks,
  SkillRegistry,
  TodoStore,
} from "@paw/core";
import type { ToolRunResult } from "@paw/harness";
import type { TaskPlanner } from "@paw/store";
import {
  candidateReviewInput,
  candidateSummaryFingerprint,
} from "../candidate-review.js";
import type {
  ToolEffectPolicy,
  ToolExecutionPolicy,
} from "../execution-policy.js";
import {
  EMPTY_CODING_PHASE_STATE,
  advanceCodingPhase,
  codingPhaseBlockReason,
  goalUsesCodingPhaseBudget,
  isCodingNavigationTool,
  isCodingVerificationCall,
} from "../lifecycle/coding-phase.js";
import { isControlPlaneToolResult } from "../lifecycle/control-plane.js";
import {
  convergenceToolBlockReason,
  isEditRecoveryRead,
} from "../lifecycle/convergence.js";
import { advanceRepeatToolReminder } from "../lifecycle/repeat-tool-reminder.js";
import {
  type AcceptanceGateDecision,
  IDLE_FUSE_ESCALATION,
  checkAcceptanceCriteria,
  decideCompletion,
  evaluateBudgetExhaustion,
  evaluateFinalAnswer,
  goalRequiresMutation,
  resolveLifecycleBudget,
} from "../lifecycle/task-lifecycle.js";
import type { LoopV2ShadowMutationCapture } from "../loop-v2/index.js";
import type { ParseDiagnosis } from "../parse-agent-action.js";
import {
  markPlanItemsCompleted,
  planItemsToEventSnapshot,
} from "../plan-bootstrap.js";
import { formatTaskStateForContext } from "../task-state.js";
import { parseChildPolicy } from "./agent-args.js";
import type { AgentGroup } from "./agent-group.js";
import { isSubAgentCall } from "./constants.js";
import { DefaultContextSummarizer } from "./context-summarizer.js";
import {
  commitToolExecutionResult,
  createLoopV2NoMutationCapture,
  executeToolCalls,
  executeToolCallsV2,
  finalizeToolExecution,
  finalizeToolExecutionContext,
  toolNeedsApprovalGate,
} from "./tool-runner.js";
import type { PhaseContext, TurnFlags, TurnState } from "./types.js";

/**
 * Action 处理器的依赖注入上下文。
 * 所有外部依赖通过此接口传入，方便测试和隔离。
 */
interface ActionHandlerContext {
  /** ask_user 回调：向用户提问并获取回答 */
  readonly resolveAskUser?: (input: {
    readonly question: string;
    readonly timeoutSec: number | null;
  }) => Promise<string>;
  /** 工具审批回调：执行前请求用户批准 */
  readonly resolveToolApproval?: (input: {
    readonly tool: string;
    readonly args: unknown;
  }) => Promise<boolean>;
  /** 工具审批策略：传入工具名返回预定义策略 */
  readonly approvalPolicy?: (tool: string) => boolean | undefined;
  readonly todoStore?: TodoStore;
  readonly planner: TaskPlanner;
  /** 计划快照最大条目数 */
  readonly planSnapshotMaxItems?: number;
  /** 保存断点续跑状态的函数 */
  readonly saveStateFn: () => void;
  /** 子 Agent 管理器 */
  readonly agentGroup?: AgentGroup;
  /** 子 Agent 权限策略：read_only 或 read_write */
  readonly childPolicy?: "read_only" | "read_write";
  readonly subAgentLauncher?: import("@paw/harness").SubAgentLauncher;
  readonly skillRegistry?: SkillRegistry;
  readonly watcher?: import("@paw/workspace").WorkspaceWatcher;
  readonly evalHooks?: EvalHooks;
  readonly memoryRuntime?: import("@paw/memory").MemoryRuntime;
  readonly memoryTaskId?: string;
  readonly createAgent?: import("@paw/harness").HarnessContext["createAgent"];
  readonly allowedTools?: readonly string[] | null;
  /** 并行子 Agent 的文件锁（仅子 Agent 注入） */
  readonly fileLock?: import("@paw/harness").FileLockLike;
  readonly toolExecutionPolicy?: ToolExecutionPolicy;
  readonly toolEffectPolicy?: ToolEffectPolicy;
}

// ═════════════════════════════════════════════════════════════
// 动作分发入口
// ═════════════════════════════════════════════════════════════

/** 格式错误反馈次数上限（防止死循环） */
const FORMAT_ERROR_NUDGE_LIMIT = 2;

/** 原生通道解析失败的调用（未执行，需回灌给模型） */
export interface NativeToolError {
  readonly id: string;
  readonly name: string;
  readonly raw: string;
}

/** 解析阶段的反馈信息：文本通道诊断 + 原生通道失败调用 */
export interface ParseFeedback {
  /** 文本通道解析诊断（无 action 时使用） */
  readonly diagnosis?: ParseDiagnosis;
  /** 原生通道解析失败的调用（拒绝执行） */
  readonly nativeToolErrors?: readonly NativeToolError[];
}

/**
 * 动作分发主函数。
 *
 * 路由优先级：
 * 1. 原生通道解析失败的调用（nativeToolErrors）→ 注入错误工具结果，不执行
 * 2. 子 Agent 调用（run_agent）→ 独立处理，与普通工具调用分开
 * 3. 普通工具调用 → 通过 tool-runner 执行
 * 4. 结构化 action（final_answer / abort / ask_user / plan_update）
 * 5. 无 action → 格式反馈（解析失败时）或 auto-nudge 或直接完成
 */
export async function handleAction(
  actions: AgentAction[],
  toolCalls: AgentToolCallAction[],
  ctx: PhaseContext,
  flags: TurnFlags,
  text: string,
  thinking: string | undefined,
  opts: ActionHandlerContext,
  feedback?: ParseFeedback,
): Promise<{
  readonly state: TurnState;
  readonly flags: TurnFlags;
  readonly subResults?: Array<{ runId: string; summary: string }>;
}> {
  // 原生通道解析失败的调用：拒绝执行，注入错误工具结果让模型自纠
  if (feedback?.nativeToolErrors && feedback.nativeToolErrors.length > 0) {
    return handleNativeToolErrors(
      feedback.nativeToolErrors,
      ctx,
      flags,
      text,
      thinking,
      opts,
    );
  }

  // 按工具类型分流：子 Agent vs 普通工具
  const subAgentCalls = toolCalls.filter(isSubAgentCall);
  const normalToolCalls = toolCalls.filter((c) => !isSubAgentCall(c));
  const recoveredFlags: TurnFlags = { ...flags, noActionNudges: 0 };

  // V2 owns the complete model-ordered batch. Child calls are scheduler items,
  // so a sibling grep/edit cannot be silently dropped by the legacy split.
  if (ctx.loopKernelVersion === "v2" && toolCalls.length > 0) {
    return handleToolCalls(
      toolCalls,
      ctx,
      recoveredFlags,
      text,
      thinking,
      opts,
    );
  }

  // 子 Agent 调用（批量模式）
  if (subAgentCalls.length > 0) {
    return handleRunAgent(
      subAgentCalls,
      ctx,
      recoveredFlags,
      text,
      thinking,
      opts,
    );
  }

  // 普通工具调用
  if (normalToolCalls.length > 0) {
    return handleToolCalls(
      normalToolCalls,
      ctx,
      recoveredFlags,
      text,
      thinking,
      opts,
    );
  }

  // 没有工具调用 → 处理结构化 action
  const action = actions[0] ?? null;
  if (!action) {
    return handleNoAction(
      ctx,
      flags,
      text,
      thinking,
      opts,
      feedback?.diagnosis,
    );
  }

  ctx.emit({ type: "agent.action", action });

  switch (action.type) {
    case "final_answer":
      return await handleFinalAnswer(
        action,
        ctx,
        recoveredFlags,
        text,
        thinking,
        opts,
      );
    case "abort":
      return handleAbort(action);
    case "ask_user":
      return handleAskUser(action, ctx, recoveredFlags, text, thinking, opts);
    case "plan_update":
      return handlePlanUpdate(
        action,
        ctx,
        recoveredFlags,
        text,
        thinking,
        opts,
      );
    case "acceptance_update":
      return handleAcceptanceUpdate(
        action,
        ctx,
        recoveredFlags,
        text,
        thinking,
        opts,
      );
    default:
      // 未知 action 类型 → 回退到无 action 处理
      return handleNoAction(ctx, flags, text, thinking, opts);
  }
}

function handleAcceptanceUpdate(
  action: Extract<AgentAction, { type: "acceptance_update" }>,
  ctx: PhaseContext,
  flags: TurnFlags,
  text: string,
  thinking: string | undefined,
  opts: Pick<ActionHandlerContext, "saveStateFn">,
): { readonly state: TurnState; readonly flags: TurnFlags } {
  ctx.ctxMgr.addAssistant(text, thinking);
  const applied = ctx.taskState.applyAcceptanceUpdate(action, ctx.turn);
  if (!applied.ok) {
    ctx.ctxMgr.addUser(`[AcceptanceLedger] ${applied.error}`);
  } else {
    ctx.ctxMgr.addUser(
      `Acceptance ledger updated: ${action.reason || "explicit model update"}.\n\n${formatTaskStateForContext(ctx.taskState.snapshot())}`,
    );
  }
  const nextFlags: TurnFlags = {
    ...flags,
    acceptanceNudges: applied.ok ? 0 : flags.acceptanceNudges,
    lastTurnHadToolCall: false,
  };
  if (ctx.turn + 1 >= ctx.maxSteps) {
    const decision = evaluateBudgetExhaustion(
      `Max steps (${ctx.maxSteps}) reached after acceptance_update`,
      ctx.taskState.snapshot(),
      "max_steps_after_tools",
    );
    return {
      state: { type: "incomplete", message: decision.message },
      flags: nextFlags,
    };
  }
  opts.saveStateFn();
  return { state: { type: "continue", nextFlags }, flags: nextFlags };
}

// ═════════════════════════════════════════════════════════════
// handleNoAction：auto-nudge 机制
// ═════════════════════════════════════════════════════════════

/**
 * 处理"模型没有返回任何结构化动作"的情况。
 *
 * 三种可能：
 * 1. 模型尝试输出工具调用但格式坏了（JSON 语法错误 / 字段缺失 / 工具名未知）
 *    → 格式反馈：把具体原因回灌给模型，让它自纠（绝不静默降级为纯文本回复）
 * 2. 模型用过工具但忘记输出 final_answer → auto-nudge：推一条消息让模型继续
 * 3. 模型真的完成了（对话式回复，不需要工具）→ 直接作为 completed 返回
 *
 * 反馈上限：格式反馈与 auto-nudge 独立计数（formatErrorNudges / autoContinueNudges），
 * 各自最多 2 次，防止死循环。
 */
function handleNoAction(
  ctx: PhaseContext,
  flags: TurnFlags,
  text: string,
  thinking: string | undefined,
  opts: Pick<ActionHandlerContext, "saveStateFn">,
  diagnosis?: ParseDiagnosis,
): { readonly state: TurnState; readonly flags: TurnFlags } {
  const displayText =
    text.trim() ||
    (thinking?.trim()
      ? `[model produced only reasoning]\n${thinking.trim()}`
      : "(empty model output)");

  // 已是最后一轮：不能再 nudge，否则会耗尽 maxSteps 变成 failed
  const noRoomForAnotherTurn = ctx.turn + 1 >= ctx.maxSteps;

  // 格式反馈：输出有工具调用痕迹但解析失败 → 回灌具体原因，绝不静默降级
  const formatNudges = flags.formatErrorNudges ?? 0;
  if (
    diagnosis &&
    diagnosis.kind !== "ok" &&
    formatNudges < FORMAT_ERROR_NUDGE_LIMIT &&
    !noRoomForAnotherTurn
  ) {
    const nextFlags: TurnFlags = {
      ...flags,
      formatErrorNudges: formatNudges + 1,
      lastTurnHadToolCall: false,
    };
    ctx.ctxMgr.addAssistant(text, thinking);
    ctx.ctxMgr.addUser(formatErrorFeedbackMessage(diagnosis));
    opts.saveStateFn();
    return { state: { type: "continue", nextFlags }, flags: nextFlags };
  }

  // 用过工具但没给 final_answer → 协议恢复（且还有后续轮次预算）。
  // 这是可恢复状态，不是独立的任务终止预算。否则第三次无动作会在
  // 23/64 之类的位置被错误标记为 maxSteps exhausted。
  if (flags.hasEverUsedTools && !noRoomForAnotherTurn) {
    const noActionNudges = flags.noActionNudges ?? 0;
    const nextFlags: TurnFlags = {
      ...flags,
      noActionNudges: noActionNudges + 1,
      lastTurnHadToolCall: false,
    };
    // 把模型的文本输出作为 assistant 消息注入
    ctx.ctxMgr.addAssistant(text, thinking);
    // 推一条提示让模型继续
    ctx.ctxMgr.addUser(noActionRecoveryMessage(noActionNudges + 1));
    opts.saveStateFn();
    return { state: { type: "continue", nextFlags }, flags: nextFlags };
  }

  // 真正没有后续轮次预算 → incomplete（禁止假 completed）
  if (flags.hasEverUsedTools) {
    ctx.ctxMgr.addAssistant(displayText, thinking);
    ctx.emit({ type: "model.done", text: displayText });
    const decision = evaluateBudgetExhaustion(
      displayText,
      ctx.taskState.snapshot(),
      "budget_exhausted",
    );
    return {
      state: { type: "incomplete", message: decision.message },
      flags,
    };
  }

  const acceptance = checkAcceptanceCriteria(ctx.taskState.snapshot());
  if (!acceptance.ok) {
    return handleAcceptanceGateFailure(
      acceptance,
      ctx,
      flags,
      text,
      thinking,
      opts,
      noRoomForAnotherTurn,
    );
  }

  // 真正完成：纯对话式回复（未使用工具）
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

function noActionRecoveryMessage(attempt: number): string {
  if (attempt === 1) {
    return `[You stopped without a final_answer action. If you have completed the task, output: {"action":"final_answer","summary":"<your complete findings here>"}. If not done, continue — call the next tool or take the next action.]`;
  }
  if (attempt === 2) {
    return `[Your previous response again contained no executable action. Continue by emitting exactly one valid tool call, or emit {"action":"final_answer","summary":"<complete result>"} only if the task is actually done.]`;
  }
  return `[Protocol recovery attempt ${attempt}: do not narrate the action you intend to take. Emit the valid tool-call JSON now. If and only if the task is complete, emit {"action":"final_answer","summary":"<complete result>"}.]`;
}

/** 格式错误反馈消息：具体原因 + 正确格式示例（参考 OpenHands 的 corrective nudge 注入形式）。 */
function formatErrorFeedbackMessage(
  diagnosis: Extract<ParseDiagnosis, { kind: "malformed" | "invalid" }>,
): string {
  return [
    "[Your last output could not be parsed as a tool call and was NOT executed.]",
    `Reason: ${diagnosis.reason}.`,
    "Correct format is a single JSON object, no surrounding text or code fences:",
    '{"tool":"workspace.read_file","args":{"path":"<file>"}}',
    "Fix the format and retry the call, or if you are done reply with:",
    '{"action":"final_answer","summary":"<your complete findings>"}',
  ].join("\n");
}

/**
 * 原生通道解析失败的调用：拒绝执行，注入错误工具结果。
 *
 * 模型下一轮会看到「assistant 文本 + 解析失败的工具结果」，
 * 能够直接看到自己发的内容和错误原因，自我纠正后重新发起调用。
 */
function handleNativeToolErrors(
  errors: readonly NativeToolError[],
  ctx: PhaseContext,
  flags: TurnFlags,
  text: string,
  thinking: string | undefined,
  opts: Pick<ActionHandlerContext, "saveStateFn">,
): { readonly state: TurnState; readonly flags: TurnFlags } {
  const nextFlags: TurnFlags = {
    ...flags,
    lastTurnHadToolCall: false,
  };

  ctx.emit({ type: "phase", name: "tool" });
  ctx.ctxMgr.addAssistant(text, thinking);

  const results = errors.map((e) => {
    const summary = `[Tool call not executed] arguments for "${e.name}" failed to parse as JSON. Raw input (truncated): ${e.raw.slice(0, 160)}. Retry the call with valid JSON arguments.`;
    ctx.emit({
      type: "tool.result",
      tool: e.name,
      ok: false,
      summary,
    });
    return { tool: e.name, ok: false, summary };
  });
  ctx.ctxMgr.addToolResults(results);

  // maxSteps 检查：最后一轮不能纠正格式，诚实返回 incomplete。
  if (ctx.turn + 1 >= ctx.maxSteps) {
    const decision = evaluateBudgetExhaustion(
      `Max steps (${ctx.maxSteps}) reached after malformed tool call(s)`,
      ctx.taskState.snapshot(),
      "max_steps_after_tools",
    );
    return {
      state: {
        type: "incomplete",
        message: decision.message,
      },
      flags: nextFlags,
    };
  }

  opts.saveStateFn();
  return { state: { type: "continue", nextFlags }, flags: nextFlags };
}

// ═════════════════════════════════════════════════════════════
// handleFinalAnswer：答案完成
// ═════════════════════════════════════════════════════════════

/**
 * 处理 final_answer 动作。
 *
 * 额外逻辑：pending 工作检查。
 * 如果模型输出了 final_answer，但还有未完成的 plan items 或 todos，
 * 且 autoContinueNudges < 3 且上一轮刚执行了工具，
 * 系统会推动模型继续处理剩余的待办项。
 *
 * 这样防止模型"过早完成"——比如还有 3 个文件没改就说做完了。
 */
async function handleFinalAnswer(
  action: Extract<AgentAction, { type: "final_answer" }>,
  ctx: PhaseContext,
  flags: TurnFlags,
  text: string,
  thinking: string | undefined,
  opts: Pick<ActionHandlerContext, "todoStore" | "planner" | "saveStateFn">,
): Promise<{ readonly state: TurnState; readonly flags: TurnFlags }> {
  const plan = opts.planner.plan;
  // 仅当计划被模型/applyUpdate 推进过（revision>0）才因 pending plan 而 nudge。
  // goal bootstrap 的 plan  revision 仍为 0，避免「右栏兜底计划」卡住 final_answer。
  const hasPendingPlan =
    !!plan && !plan.allComplete && plan.items.length > 0 && plan.revision > 0;
  const hasPendingTodos = opts.todoStore?.items.some(
    (t) => t.status !== "done",
  );

  // 有未完成的模型计划或 Todo 就不能宣告完成。还有预算时推动继续；
  // 没预算时 honest-incomplete，绝不能把 pending 项自动涂绿。
  const noRoomForAnotherTurn = ctx.turn + 1 >= ctx.maxSteps;
  if (
    (hasPendingPlan || hasPendingTodos) &&
    flags.autoContinueNudges < 3 &&
    !noRoomForAnotherTurn
  ) {
    const nextFlags: TurnFlags = {
      ...flags,
      autoContinueNudges: flags.autoContinueNudges + 1,
      lastTurnHadToolCall: false,
    };
    ctx.ctxMgr.addAssistant(text, thinking);

    // 统计未完成的 plan items 和 todos
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

    // 注入提醒消息
    ctx.ctxMgr.addUser(
      `[You have pending work: ${pending}. Continue from where you left off — do not summarize or apologize, just take the next action.]`,
    );
    opts.saveStateFn();
    return { state: { type: "continue", nextFlags }, flags: nextFlags };
  }

  if (hasPendingPlan || hasPendingTodos) {
    const pendingPlanCount =
      plan?.items.filter(
        (i) => i.status !== "completed" && i.status !== "skipped",
      ).length ?? 0;
    const pendingTodoCount =
      opts.todoStore?.items.filter((t) => t.status !== "done").length ?? 0;
    return {
      state: {
        type: "incomplete",
        message: `The model declared completion with unfinished work (${pendingPlanCount} plan item(s), ${pendingTodoCount} todo(s)). Update their status with plan_update/todo_write or report an honest blocker.`,
      },
      flags,
    };
  }

  const acceptance = checkAcceptanceCriteria(ctx.taskState.snapshot());
  if (!acceptance.ok) {
    return handleAcceptanceGateFailure(
      acceptance,
      ctx,
      flags,
      text,
      thinking,
      opts,
      noRoomForAnotherTurn,
    );
  }

  const summary = action.summary.trim() || "(empty summary)";
  const evaluated = evaluateFinalAnswer(
    summary,
    ctx.taskState.snapshot(),
    flags.hasEverUsedTools,
    ctx.verificationPolicy,
  );
  const verifyNudges = flags.verifyNudges ?? 0;
  if (
    evaluated.shouldNudge &&
    evaluated.nudgeMessage &&
    verifyNudges < 2 &&
    !noRoomForAnotherTurn
  ) {
    const nextFlags: TurnFlags = {
      ...flags,
      verifyNudges: verifyNudges + 1,
      lastTurnHadToolCall: false,
    };
    ctx.ctxMgr.addAssistant(text, thinking);
    ctx.ctxMgr.addUser(evaluated.nudgeMessage);
    opts.saveStateFn();
    return { state: { type: "continue", nextFlags }, flags: nextFlags };
  }

  // Verification failed and no nudge budget → incomplete via CompletionPolicy
  if (evaluated.shouldNudge || !evaluated.decision) {
    const decision = decideCompletion({
      intent: "final_answer",
      message: summary,
      taskState: ctx.taskState.snapshot(),
      verification: evaluated.verification,
      hasEverUsedTools: flags.hasEverUsedTools,
    });
    return {
      state: {
        type: "decided",
        decision,
      },
      flags,
    };
  }

  const candidateGate = await checkCandidateReviewGate(
    summary,
    ctx,
    flags,
    text,
    thinking,
    opts,
    noRoomForAnotherTurn,
  );
  if (candidateGate) return candidateGate;

  // 无 pending 工作 / 验证通过 → 真正完成。revision=0 的 bootstrap
  // 计划只是 UI 兜底，可随最终完成同步标绿；模型计划必须已自行完成。
  if (plan && plan.items.length > 0) {
    const completed = markPlanItemsCompleted(plan.items);
    plan.items.splice(0, plan.items.length, ...completed);
    plan.revision += 1;
    ctx.taskState.setPlan(plan.items);
    ctx.emit({
      type: "plan.updated",
      revision: plan.revision,
      itemCount: plan.items.length,
      reason: "task_completed",
      items: planItemsToEventSnapshot(plan.items),
    });
  }

  return {
    state: {
      type: "decided",
      decision: evaluated.decision,
    },
    flags,
  };
}

async function checkCandidateReviewGate(
  summary: string,
  ctx: PhaseContext,
  flags: TurnFlags,
  text: string,
  thinking: string | undefined,
  opts: Pick<ActionHandlerContext, "saveStateFn">,
  noRoomForAnotherTurn: boolean,
): Promise<
  { readonly state: TurnState; readonly flags: TurnFlags } | undefined
> {
  const reviewer = ctx.candidateReviewer;
  const state = ctx.taskState.snapshot();
  const revision = state.mutationRevision ?? 0;
  if (!reviewer || revision === 0) return undefined;

  const summaryFingerprint = candidateSummaryFingerprint(summary);
  const recorded =
    state.candidateReview?.mutationRevision === revision
      ? state.candidateReview
      : undefined;

  let review =
    recorded &&
    (recorded.verdict !== "pass" ||
      recorded.summaryFingerprint === summaryFingerprint)
      ? recorded
      : undefined;
  if (!review) {
    try {
      const result = await reviewer.review(
        candidateReviewInput(
          ctx.runId,
          ctx.workspaceRoot,
          summary,
          state,
          ctx.signal,
          undefined,
          ctx.ctxMgr.buildMessages(),
        ),
      );
      const reviewSummary = boundCandidateReviewSummary(result.summary);
      review = {
        mutationRevision: revision,
        verdict: result.verdict,
        reportGrounding: result.reportGrounding,
        summaryFingerprint,
        summary: reviewSummary,
        reviewedAt: Date.now(),
      };
      ctx.emit({
        type: "candidate.review",
        mutationRevision: revision,
        verdict: result.verdict,
        reportGrounding: result.reportGrounding,
        summary: reviewSummary,
        modelCalls: result.modelCalls ?? 0,
        ...(result.usage ? { usage: result.usage } : {}),
      });
    } catch (error) {
      const reviewSummary = boundCandidateReviewSummary(
        `Independent review could not execute: ${error instanceof Error ? error.message : String(error)}`,
      );
      review = {
        mutationRevision: revision,
        verdict: "partial",
        reportGrounding: "unknown",
        summaryFingerprint,
        summary: reviewSummary,
        reviewedAt: Date.now(),
      };
      ctx.emit({
        type: "candidate.review",
        mutationRevision: revision,
        verdict: "partial",
        reportGrounding: "unknown",
        summary: reviewSummary,
        modelCalls: 0,
      });
    }
    ctx.taskState.recordCandidateReview(review);
    opts.saveStateFn();
  }

  const reportGrounding = review.reportGrounding ?? "unknown";
  if (review.verdict === "pass" && reportGrounding === "pass") {
    return undefined;
  }
  if (review.verdict === "partial" && reportGrounding !== "pass") {
    return {
      state: {
        type: "incomplete",
        message: `[IndependentReview:PROTOCOL_INCOMPLETE r${revision}] ${review.summary}\nThe independent reviewer did not establish report grounding after protocol recovery, so completion is fail-closed.`,
      },
      flags,
    };
  }
  const reportIssue = review.verdict === "pass" && reportGrounding !== "pass";
  const previousNudges =
    flags.candidateReviewRevision === revision &&
    (!reportIssue ||
      flags.candidateReviewSummaryFingerprint === summaryFingerprint)
      ? (flags.candidateReviewNudges ?? 0)
      : 0;
  const maxNudges = reportIssue ? 2 : review.verdict === "fail" ? 2 : 1;
  const message = reportIssue
    ? `[IndependentReview:REPORT_GROUNDING_${reportGrounding.toUpperCase()} r${revision}] ${review.summary}\nRevise only the proposed final summary so every verification, baseline, and pass/fail claim matches the host-recorded evidence. Do not mutate source merely to satisfy this reporting gate. A materially revised summary will be reviewed again on the same source revision.`
    : `[IndependentReview:${review.verdict.toUpperCase()} r${revision}] ${review.summary}\n${
        review.verdict === "fail"
          ? "Fix the concrete issue, re-run relevant verification, inspect the new diff, and then try final_answer again. The semantic reviewer will run again only after a real source mutation."
          : "Address any actionable semantic finding. If this is only an unavoidable environment limitation, try final_answer again and report the limitation honestly."
      }`;
  if (previousNudges < maxNudges && !noRoomForAnotherTurn) {
    const nextFlags: TurnFlags = {
      ...flags,
      candidateReviewRevision: revision,
      candidateReviewNudges: previousNudges + 1,
      ...(reportIssue
        ? { candidateReviewSummaryFingerprint: summaryFingerprint }
        : {}),
      lastTurnHadToolCall: false,
    };
    ctx.ctxMgr.addAssistant(text, thinking);
    ctx.ctxMgr.addUser(message);
    opts.saveStateFn();
    return { state: { type: "continue", nextFlags }, flags: nextFlags };
  }
  if (reportIssue) return { state: { type: "incomplete", message }, flags };
  if (review.verdict === "partial" && !noRoomForAnotherTurn) return undefined;
  return { state: { type: "incomplete", message }, flags };
}

function boundCandidateReviewSummary(summary: string): string {
  const maxChars = 8_000;
  if (summary.length <= maxChars) return summary;
  const tailChars = 2_000;
  return `${summary.slice(0, maxChars - tailChars - 52)}\n[review summary truncated]\n${summary.slice(-tailChars)}`;
}

function handleAcceptanceGateFailure(
  acceptance: Extract<AcceptanceGateDecision, { readonly ok: false }>,
  ctx: PhaseContext,
  flags: TurnFlags,
  text: string,
  thinking: string | undefined,
  opts: Pick<ActionHandlerContext, "saveStateFn">,
  noRoomForAnotherTurn: boolean,
): { readonly state: TurnState; readonly flags: TurnFlags } {
  if (acceptance.mode === "blocked") {
    return {
      state: { type: "incomplete", message: acceptance.message },
      flags,
    };
  }

  const acceptanceNudges = flags.acceptanceNudges ?? 0;
  if (acceptanceNudges < 2 && !noRoomForAnotherTurn) {
    const nextFlags: TurnFlags = {
      ...flags,
      acceptanceNudges: acceptanceNudges + 1,
      lastTurnHadToolCall: false,
    };
    ctx.ctxMgr.addAssistant(text, thinking);
    ctx.ctxMgr.addUser(acceptance.message);
    opts.saveStateFn();
    return { state: { type: "continue", nextFlags }, flags: nextFlags };
  }

  return {
    state: { type: "incomplete", message: acceptance.message },
    flags,
  };
}

// ═════════════════════════════════════════════════════════════
// handleAbort：任务中止
// ═════════════════════════════════════════════════════════════

/**
 * 处理 abort 动作。
 * 模型判断任务无法完成（如权限不足、信息不可获取等）时主动中止。
 */
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

// ═════════════════════════════════════════════════════════════
// handleAskUser：向用户提问
// ═════════════════════════════════════════════════════════════

/**
 * 处理 ask_user 动作。
 *
 * 模型需要用户输入时（如选择方案、澄清需求），通过此处理器暂停执行
 * 等待用户回复。回复会作为 user 消息注入到上下文中，下一轮继续执行。
 *
 * 如果没有配置 resolveAskUser 回调（非交互模式），则直接完成。
 */
async function handleAskUser(
  action: Extract<AgentAction, { type: "ask_user" }>,
  ctx: PhaseContext,
  flags: TurnFlags,
  text: string,
  thinking: string | undefined,
  opts: Pick<ActionHandlerContext, "resolveAskUser" | "saveStateFn">,
): Promise<{ readonly state: TurnState; readonly flags: TurnFlags }> {
  const nextFlags: TurnFlags = {
    ...flags,
    lastTurnHadToolCall: false,
  };

  if (opts.resolveAskUser) {
    // 通知外部等待用户回复
    ctx.emit({
      type: "user.reply.required",
      question: action.question,
      timeoutSec: action.timeoutSec,
    });
    // 阻塞等待用户输入
    const reply = await opts.resolveAskUser({
      question: action.question,
      timeoutSec: action.timeoutSec,
    });
    // 将模型的提问和用户的回答都注入上下文
    ctx.ctxMgr.addAssistant(text, thinking);
    ctx.ctxMgr.addUser(reply);

    // 检查是否达到最大轮数
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

  // 无 resolver（非交互模式）→ 直接作为完成返回
  return {
    state: { type: "completed", message: `[Ask user] ${action.question}` },
    flags: nextFlags,
  };
}

// ═════════════════════════════════════════════════════════════
// handlePlanUpdate：更新执行计划
// ═════════════════════════════════════════════════════════════

/**
 * 处理 plan_update 动作。
 *
 * 模型可以动态更新执行计划：添加新项、标记废弃项。
 * 更新后的计划以 JSON 格式注入到上下文，供模型下一轮参考。
 *
 * 使用动态 import（`await import("@paw/store")`）避免循环依赖。
 */
async function handlePlanUpdate(
  action: Extract<AgentAction, { type: "plan_update" }>,
  ctx: PhaseContext,
  flags: TurnFlags,
  text: string,
  thinking: string | undefined,
  opts: Pick<
    ActionHandlerContext,
    | "planner"
    | "planSnapshotMaxItems"
    | "saveStateFn"
    | "memoryRuntime"
    | "memoryTaskId"
  >,
): Promise<{ readonly state: TurnState; readonly flags: TurnFlags }> {
  const nextFlags: TurnFlags = {
    ...flags,
    lastTurnHadToolCall: false,
  };

  // 动态 import 避免循环依赖
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
    ctx.taskState.setPlan(p.items);
    const planLines = p.items.map((item) =>
      typeof item === "string"
        ? item
        : typeof item === "object" && item && "text" in item
          ? String((item as { text: unknown }).text)
          : JSON.stringify(item),
    );
    const runtime = opts.memoryRuntime ?? ctx.memoryRuntime;
    const memTaskId = opts.memoryTaskId ?? ctx.memoryTaskId;
    if (runtime && memTaskId) {
      await runtime
        .patchWorkingMemory({
          taskId: memTaskId,
          patch: { plan: planLines },
        })
        .catch(() => {
          /* best-effort */
        });
    }
    const snapshotItems = p.items.map((item) => ({
      id: item.id,
      text: (item.note?.trim() || item.task_id || item.id).slice(0, 500),
      status: item.status,
    }));
    ctx.emit({
      type: "plan.updated",
      revision: p.revision,
      itemCount: p.items.length,
      reason: action.reason,
      items: snapshotItems,
    });
  }

  ctx.ctxMgr.addAssistant(text, thinking);

  // 将更新后的计划注入到上下文供模型参考
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
    const decision = evaluateBudgetExhaustion(
      `Max steps (${ctx.maxSteps}) reached after plan_update`,
      ctx.taskState.snapshot(),
      "max_steps_after_tools",
    );
    return {
      state: {
        type: "incomplete",
        message: decision.message,
      },
      flags: nextFlags,
    };
  }

  opts.saveStateFn();
  return { state: { type: "continue", nextFlags }, flags: nextFlags };
}

// ═════════════════════════════════════════════════════════════
// handleToolCalls：普通工具调用
// ═════════════════════════════════════════════════════════════

/**
 * 处理普通工具调用（非子 Agent）。
 *
 * 流程：
 * 1. 发出 tool.call 事件（给 TUI 展示）
 * 2. 调用 executeToolCalls() 并行执行所有工具
 * 3. 调用 finalizeToolExecution() 将结果注入上下文
 * 4. 返回 continue（让模型看到工具结果后继续思考）
 *
 * executeToolCalls 内部处理了审批门控（approval gate）和子 Agent 策略检查。
 */
async function handleToolCalls(
  calls: readonly AgentToolCallAction[],
  ctx: PhaseContext,
  flags: TurnFlags,
  text: string,
  thinking: string | undefined,
  opts: ActionHandlerContext,
): Promise<{
  readonly state: TurnState;
  readonly flags: TurnFlags;
  readonly subResults?: Array<{ runId: string; summary: string }>;
}> {
  const nextFlags: TurnFlags = {
    ...flags,
    lastTurnHadToolCall: true,
    hasEverUsedTools: true,
  };

  // 发出事件
  for (const action of calls) {
    ctx.emit({ type: "agent.action", action });
  }
  ctx.emit({ type: "phase", name: "tool" });
  for (const [sourceIndex, call] of calls.entries()) {
    ctx.emit({
      type: "tool.call",
      tool: call.tool,
      args: call.args,
      ...(ctx.loopKernelVersion === "v2" && isSubAgentCall(call)
        ? { callId: `child-${ctx.runId}-${sourceIndex}` }
        : {}),
    });
  }

  const toolStartTime = Date.now();

  // 并行执行所有工具（审批门控 + 子 Agent 策略检查在内部处理）
  const codingPhaseEnabled =
    goalRequiresMutation(ctx.specGoal) &&
    goalUsesCodingPhaseBudget(ctx.specGoal);
  const priorCodingPhase = flags.codingPhase ?? EMPTY_CODING_PHASE_STATE;
  let projectedCodingPhase = priorCodingPhase;
  const taskState = ctx.taskState.snapshot();
  const convergenceBlockReasons = calls.map((call) =>
    convergenceToolBlockReason(
      call,
      taskState,
      ctx.turn + 1,
      ctx.maxSteps,
      ctx.verificationPolicy,
    ),
  );
  const codingPhaseBlockReasons = calls.map((call, index) => {
    // A call rejected by the general loop policy never reaches the opt-in
    // coding-phase state machine and must not consume its violation budget.
    if (convergenceBlockReasons[index]) return null;
    if (!codingPhaseEnabled) return null;
    if (isEditRecoveryRead(call, taskState)) return null;
    const reason = codingPhaseBlockReason(call, projectedCodingPhase);
    if (!reason && isCodingNavigationTool(call.tool)) {
      projectedCodingPhase = {
        ...projectedCodingPhase,
        navigationCalls: projectedCodingPhase.navigationCalls + 1,
        postEditNavigationCalls:
          projectedCodingPhase.successfulEdits > 0
            ? projectedCodingPhase.postEditNavigationCalls + 1
            : projectedCodingPhase.postEditNavigationCalls,
      };
    }
    return reason;
  });
  const phaseBlockReasons = calls.map(
    (_, index) =>
      convergenceBlockReasons[index] ?? codingPhaseBlockReasons[index],
  );
  const blockedResult = (index: number): ToolRunResult | undefined => {
    const blockReason = phaseBlockReasons[index];
    if (!blockReason) return undefined;
    return {
      ok: false,
      payload: {
        code: convergenceBlockReasons[index]
          ? "E_LOOP_POLICY"
          : "E_CODING_PHASE",
        message: blockReason,
      },
      summary: blockReason,
    };
  };
  const toolExecutionContext = {
    workspaceRoot: ctx.workspaceRoot,
    runId: ctx.runId,
    mcp: ctx.mcp,
    emit: ctx.emit,
    checkpointSeq: ctx.checkpointSeq,
    childPolicy: opts.childPolicy,
    subAgentLauncher: opts.subAgentLauncher,
    todoStore: opts.todoStore,
    acceptanceLedger: {
      apply: (
        input: Parameters<typeof ctx.taskState.applyAcceptanceUpdate>[0],
      ) => ctx.taskState.applyAcceptanceUpdate(input, ctx.turn),
    },
    skillRegistry: opts.skillRegistry,
    watcher: opts.watcher,
    parentContextManager: ctx.ctxMgr,
    abortSignal: ctx.signal,
    shellSandbox: ctx.shellSandbox,
    memoryRuntime: opts.memoryRuntime,
    memoryTaskId: opts.memoryTaskId ?? ctx.memoryTaskId,
    createAgent: opts.createAgent,
    allowedTools: opts.allowedTools,
    fileLock: opts.fileLock,
    artifactRegistry: ctx.artifactRegistry,
    toolExecutionPolicy: opts.toolExecutionPolicy,
    toolEffectPolicy: opts.toolEffectPolicy,
    captureLoopV2Facts: Boolean(ctx.observeLoopV2ToolCommit),
  };
  const approvalContext = {
    resolveToolApproval: opts.resolveToolApproval,
    approvalPolicy: opts.approvalPolicy,
  };
  let results: ToolRunResult[];
  let mutationCaptures: Array<LoopV2ShadowMutationCapture | undefined>;
  const commitsOwnedByScheduler = ctx.loopKernelVersion === "v2";
  if (commitsOwnedByScheduler) {
    const batch = await executeToolCallsV2(
      calls,
      toolExecutionContext,
      approvalContext,
      {
        preSettledResults: calls.map((_, index) => blockedResult(index)),
        async dispatchOverride(call, sourceIndex) {
          if (!isSubAgentCall(call)) return undefined;
          const args =
            call.args &&
            typeof call.args === "object" &&
            !Array.isArray(call.args)
              ? (call.args as Record<string, unknown>)
              : undefined;
          const effectPolicyApplies = opts.toolEffectPolicy
            ? (opts.toolEffectPolicy.appliesTo?.({
                tool: call.tool,
                args: call.args,
                workspaceRoot: ctx.workspaceRoot,
              }) ?? true)
            : false;
          const approvalApplies = toolNeedsApprovalGate(
            call.tool,
            args,
            opts.approvalPolicy,
            Boolean(opts.resolveToolApproval),
          );
          // Trusted policy/effect/approval stays owned by the established
          // single-call runner. The harness launcher still preserves this
          // scheduler slot; AgentGroup is used only when no gate is bypassed.
          if (
            opts.toolExecutionPolicy ||
            effectPolicyApplies ||
            approvalApplies
          ) {
            return undefined;
          }
          if (!opts.agentGroup) {
            return {
              result: {
                ok: false,
                summary: "run_agent: sub-agent launcher not configured",
                payload: { error: "sub-agent launcher not configured" },
              },
              mutationCapture: createLoopV2NoMutationCapture(),
            };
          }
          ctx.emit({ type: "phase", name: "waiting_children" });
          const summarizer = new DefaultContextSummarizer();
          const childResults = await opts.agentGroup.launchAll(
            [call],
            (childCall) => summarizer.summarizeForCall(ctx.ctxMgr, childCall),
            ctx.signal,
            [sourceIndex],
          );
          ctx.emit({ type: "phase", name: "merging_results" });
          const child = childResults[0];
          if (!child) {
            throw new Error(`Missing child result at source ${sourceIndex}`);
          }
          const readWrite =
            (parseChildPolicy(args) ?? "read_only") === "read_write";
          return {
            result: {
              ok: child.status === "completed",
              summary: child.summary,
              payload: {
                status: child.status,
                findings: child.findings,
                changedFiles: child.changedFiles,
                testsRun: child.testsRun,
                errors: child.errors,
              },
            },
            mutationCapture: readWrite
              ? {
                  status: "gap",
                  reason: "unbounded_mutation_surface",
                }
              : createLoopV2NoMutationCapture(),
          };
        },
        commit(call, result, mutationCapture, sourceIndex) {
          commitToolExecutionResult(call, result, sourceIndex, ctx, {
            concurrentMutation: false,
            ...(mutationCapture ? { mutationCapture } : {}),
          });
        },
      },
    );
    results = [...batch.results];
    mutationCaptures = [...batch.mutationCaptures];
  } else {
    const allowedCalls = calls.filter((_, index) => !phaseBlockReasons[index]);
    const allowedBatch = await executeToolCalls(
      allowedCalls,
      toolExecutionContext,
      approvalContext,
    );
    const allowedResults = allowedBatch.results;
    let allowedIndex = 0;
    mutationCaptures = [];
    results = calls.map((_, index) => {
      const blocked = blockedResult(index);
      if (blocked) {
        mutationCaptures.push(
          ctx.observeLoopV2ToolCommit
            ? createLoopV2NoMutationCapture()
            : undefined,
        );
        return blocked;
      }
      const result = allowedResults[allowedIndex];
      if (!result)
        throw new Error(`Missing allowed tool result ${allowedIndex}`);
      mutationCaptures.push(allowedBatch.mutationCaptures[allowedIndex]);
      allowedIndex += 1;
      return result;
    });
  }
  const toolDuration = Date.now() - toolStartTime;

  // 评估钩子：逐个通知工具调用完成
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

  // 新记忆：工具结果写入（best-effort）；v2 失败触发 T2 action_failed 检索注入 [Memory hint]
  const runtime = opts.memoryRuntime ?? ctx.memoryRuntime;
  const memTaskId = opts.memoryTaskId ?? ctx.memoryTaskId;
  if (runtime && memTaskId) {
    const injections: string[] = [];
    for (let i = 0; i < calls.length; i++) {
      const call = calls[i]!;
      const tr = results[i]!;
      if (
        call.tool === "workspace.acceptance_update" ||
        isControlPlaneToolResult(tr)
      )
        continue;
      const injected = await runtime
        .onToolResult({
          taskId: memTaskId,
          toolName: call.tool,
          args: call.args,
          ok: tr.ok,
          summary: tr.summary,
          rawPayload: tr.payload,
          idempotencyKey: `${ctx.runId}-t${ctx.turn}-${i}-${call.tool}`,
        })
        .catch(() => undefined);
      if (injected?.injected) injections.push(injected.injected);
    }
    if (injections.length > 0) {
      ctx.ctxMgr.addUser(
        `[Memory hint]\n${injections.join("\n\n").slice(0, 2000)}`,
      );
    }
  }

  // 将工具结果注入上下文（assistant 消息 + tool results）
  const finalizationContext = {
    ctxMgr: ctx.ctxMgr,
    emit: ctx.emit,
    runId: ctx.runId,
    workspaceRoot: ctx.workspaceRoot,
    turn: ctx.turn,
    maxSteps: ctx.maxSteps,
    specGoal: ctx.specGoal,
    text,
    thinking,
    taskState: ctx.taskState,
    mutationCaptures,
    observeLoopV2ToolCommit: ctx.observeLoopV2ToolCommit,
    saveStateFn: opts.saveStateFn,
    payloadDeduper: ctx.payloadDeduper,
    artifactRegistry: ctx.artifactRegistry,
    failureSignatures: flags.failureSignatures,
  };
  const final = commitsOwnedByScheduler
    ? finalizeToolExecutionContext(calls, results, finalizationContext)
    : finalizeToolExecution(calls, results, finalizationContext);
  const subResults = calls.flatMap((call, sourceIndex) =>
    isSubAgentCall(call)
      ? [
          {
            runId: `child-${ctx.runId}-${sourceIndex}`,
            summary: results[sourceIndex]?.summary ?? "Child agent failed",
          },
        ]
      : [],
  );

  const codingPhase = codingPhaseEnabled
    ? advanceCodingPhase(priorCodingPhase, calls, results)
    : undefined;
  const repeatTool = advanceRepeatToolReminder(flags.repeatTool, calls);
  for (const nudge of repeatTool.reminders) {
    ctx.ctxMgr.addUser(nudge);
  }
  for (const nudge of codingPhase?.nudges ?? []) {
    ctx.ctxMgr.addUser(nudge);
  }
  const phaseViolationThisTurn =
    codingPhaseEnabled && codingPhaseBlockReasons.some(Boolean);
  const requiredPhaseActionSucceeded =
    codingPhaseEnabled &&
    calls.some(
      (call, index) =>
        results[index]?.ok === true &&
        (priorCodingPhase.successfulEdits === 0
          ? (codingPhase?.state.successfulEdits ?? 0) >
            priorCodingPhase.successfulEdits
          : isCodingVerificationCall(call)),
    );
  const codingPhaseViolationTurns = codingPhaseEnabled
    ? phaseViolationThisTurn
      ? (flags.codingPhaseViolationTurns ?? 0) + 1
      : requiredPhaseActionSucceeded
        ? 0
        : (flags.codingPhaseViolationTurns ?? 0)
    : 0;

  const madeProgress = results.some((result) => result.ok);
  const acceptanceProgress = calls.some(
    (call, index) =>
      call.tool === "workspace.acceptance_update" &&
      results[index]?.ok === true,
  );
  const fusedFlags: TurnFlags = {
    ...nextFlags,
    ...(repeatTool.state ? { repeatTool: repeatTool.state } : {}),
    ...(codingPhase ? { codingPhase: codingPhase.state } : {}),
    ...(codingPhaseEnabled ? { codingPhaseViolationTurns } : {}),
    // These are consecutive-stall budgets, not lifetime counters. A concrete
    // successful tool result proves the loop moved forward and earns a fresh
    // recovery/finalization window.
    ...(madeProgress
      ? { autoContinueNudges: 0, verifyNudges: 0, idleFuseTrips: 0 }
      : {}),
    ...(acceptanceProgress ? { acceptanceNudges: 0 } : {}),
    ...(final.failureSignatures
      ? { failureSignatures: final.failureSignatures }
      : {}),
    ...(final.idleFuseTripped
      ? { idleFuseTrips: (flags.idleFuseTrips ?? 0) + 1 }
      : {}),
  };

  if (codingPhaseEnabled && codingPhaseViolationTurns >= 2) {
    const decision = decideCompletion({
      intent: "budget_exhausted",
      message:
        "[CodingPhase:hard_stop] The agent attempted phase-blocked navigation on two turns without moving to the required edit/test action.",
      taskState: ctx.taskState.snapshot(),
      hasEverUsedTools: true,
    });
    return {
      state: { type: "incomplete", message: decision.message },
      flags: fusedFlags,
      ...(subResults.length > 0 ? { subResults } : {}),
    };
  }

  // Idle fuse hard-stop：重复同一失败达到预算后诚实 incomplete
  const budget = resolveLifecycleBudget();
  if (
    final.idleFuseTripped &&
    (fusedFlags.idleFuseTrips ?? 0) >= budget.idleFuseHardStopTrips
  ) {
    const decision = decideCompletion({
      intent: "budget_exhausted",
      message: `${IDLE_FUSE_ESCALATION}\n(idle fuse hard-stop after ${fusedFlags.idleFuseTrips} trips)`,
      taskState: ctx.taskState.snapshot(),
      hasEverUsedTools: true,
    });
    return {
      state: { type: "incomplete", message: decision.message },
      flags: fusedFlags,
      ...(subResults.length > 0 ? { subResults } : {}),
    };
  }

  // Max steps after tools → incomplete（CompletionPolicy）
  if (final.type === "incomplete") {
    const decision = evaluateBudgetExhaustion(
      final.message ?? "Max steps reached after tools",
      ctx.taskState.snapshot(),
      "max_steps_after_tools",
    );
    return {
      state: { type: "incomplete", message: decision.message },
      flags: fusedFlags,
      ...(subResults.length > 0 ? { subResults } : {}),
    };
  }

  // 正常情况：继续下一轮
  return {
    state: { type: "continue", nextFlags: fusedFlags },
    flags: fusedFlags,
    ...(subResults.length > 0 ? { subResults } : {}),
  };
}

// ═════════════════════════════════════════════════════════════
// handleRunAgent：子 Agent 批量调用
// ═════════════════════════════════════════════════════════════

/**
 * 处理子 Agent 调用（workspace.run_agent）。
 *
 * 子 Agent 调用与普通工具调用分开处理，因为：
 * 1. 子 Agent 是异步的：需要等待所有子 Agent 完成才能继续
 * 2. 子 Agent 有专门的上下文摘要逻辑：父上下文通过 ContextSummarizer 压缩后传入
 * 3. 子 Agent 的结果需要合并到父 Agent 上下文（concise summary only）
 *
 * 流程：
 * 1. 用 DefaultContextSummarizer 为每个子 Agent 生成精简的父上下文
 * 2. AgentGroup.launchAll() 批量启动所有子 Agent
 * 3. 等待全部完成后合并结果到父 Agent 上下文
 */
async function handleRunAgent(
  calls: readonly AgentToolCallAction[],
  ctx: PhaseContext,
  flags: TurnFlags,
  text: string,
  thinking: string | undefined,
  opts: Pick<ActionHandlerContext, "saveStateFn" | "agentGroup" | "evalHooks">,
): Promise<{
  readonly state: TurnState;
  readonly flags: TurnFlags;
  readonly subResults?: Array<{ runId: string; summary: string }>;
}> {
  const nextFlags: TurnFlags = {
    ...flags,
    lastTurnHadToolCall: true,
    hasEverUsedTools: true,
  };

  // 没有子 Agent 启动器就无法执行
  if (!opts.agentGroup) {
    return {
      state: { type: "failed", message: "Sub-agent launcher not configured" },
      flags: nextFlags,
    };
  }

  // 为每个子 Agent 调用发出 tool.call 事件（callId 与 AgentGroup 分配的 agentId 一致）
  calls.forEach((call, i) => {
    ctx.emit({
      type: "tool.call",
      tool: call.tool,
      args: call.args,
      callId: `child-${ctx.runId}-${i}`,
    });
  });

  const summarizer = new DefaultContextSummarizer();

  // 通知 TUI：进入等待子 Agent 阶段
  ctx.emit({
    type: "phase",
    name: "waiting_children",
  });

  // 批量启动所有子 Agent，等待全部完成
  // summarizeForCall() 将父 Agent 的完整上下文压缩为子 Agent 可用的精简版
  const agentStartTime = Date.now();
  const results = await opts.agentGroup.launchAll(
    calls,
    (call) => summarizer.summarizeForCall(ctx.ctxMgr, call),
    ctx.signal,
  );
  const agentDuration = Date.now() - agentStartTime;

  // 通知 TUI：进入合并结果阶段
  ctx.emit({
    type: "phase",
    name: "merging_results",
  });

  // 合并子 Agent 结果到父上下文
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
  // 将子 Agent 结果作为工具结果注入上下文（父 Agent 的模型会在下一轮看到）
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

  // P4: 提取子 Agent 摘要供父 Agent 收割（runId 与 AgentGroup 的 child id 一致）
  const subResults = results.map((r, i) => ({
    runId: `child-${ctx.runId}-${i}`,
    summary: r.summary,
  }));

  if (ctx.turn + 1 >= ctx.maxSteps) {
    const decision = evaluateBudgetExhaustion(
      `Max steps (${ctx.maxSteps}) reached after sub-agents`,
      ctx.taskState.snapshot(),
      "max_steps_after_tools",
    );
    return {
      state: {
        type: "incomplete",
        message: decision.message,
      },
      flags: nextFlags,
      subResults,
    };
  }

  opts.saveStateFn();
  return {
    state: { type: "continue", nextFlags },
    flags: nextFlags,
    subResults,
  };
}
