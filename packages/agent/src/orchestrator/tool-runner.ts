/**
 * ToolRunner：统一的工具执行和执行后处理。
 * ==========================================
 *
 * 消除了并行工具和串行工具两条路径之间的重复代码。
 * 所有工具调用（无论单工具还是批量）都经过这个模块。
 *
 * 核心职责：
 * 1. executeToolCalls()：审批门控 + 子 Agent 策略检查 + 并行执行
 * 2. finalizeToolExecution()：结果注入上下文 + maxSteps 检查 + 状态保存
 *
 * 审批门控（Approval Gate）：
 * - 工具可配置为需要用户审批后才能执行
 * - 审批策略可预定义（approvalPolicy），也可以实时询问用户（resolveToolApproval）
 * - 子 Agent 在 read_only 模式下，所有修改性工具被自动拒绝
 *
 * Checkpoint 机制：
 * - 执行修改性工具前保存代码快照（checkpoint）
 * - 用于断点恢复时回滚文件状态
 */

import type { AgentToolCallAction, ContextManager, RunEvent } from "@paw/core";
import { isMutatingTool } from "@paw/core";
import { saveCheckpoint } from "@paw/core";
import type { HarnessContext, ShellSandboxConfig, ToolRunResult } from "@paw/harness";
import { toolRequiresApproval } from "@paw/harness";
import { DefaultContextSummarizer } from "./context-summarizer.js";
import { SUB_AGENT_TOOL_NAME } from "./constants.js";
import { formatToolResultEventDetail } from "../tool-result-detail.js";

/** 工具执行的环境上下文 */
interface ToolExecutionContext {
  readonly workspaceRoot: string;
  readonly runId: string;
  readonly mcp?: HarnessContext["mcp"];
  readonly todoStore?: HarnessContext["todoStore"];
  readonly subAgentLauncher?: HarnessContext["subAgentLauncher"];
  readonly skillRegistry?: HarnessContext["skillRegistry"];
  readonly watcher?: HarnessContext["watcher"];
  /** 父 Agent 的上下文管理器（子 Agent 用于生成 SharedContext） */
  readonly parentContextManager?: ContextManager;
  readonly abortSignal?: AbortSignal;
  readonly emit: (event: RunEvent) => void;
  /** Checkpoint 序列号（可变引用） */
  readonly checkpointSeq: { n: number };
  /** 子 Agent 策略 */
  readonly childPolicy?: "read_only" | "read_write";
  /** Shell 沙箱配置 */
  readonly shellSandbox?: ShellSandboxConfig;
}

/** 审批上下文 */
interface ApprovalContext {
  readonly resolveToolApproval?:
    | ((input: {
        readonly tool: string;
        readonly args: unknown;
      }) => Promise<boolean>)
    | undefined;
  readonly approvalPolicy?: ((tool: string) => boolean | undefined) | undefined;
}

/**
 * 判断工具是否需要走审批门控。
 *
 * 优先级：
 * 1. approvalPolicy 明确返回 true/false → 直接使用
 * 2. 没有 resolver → 不需要审批（无人交互环境，默认允许）
 * 3. 有 resolver → 调用 toolRequiresApproval 检查默认规则
 */
function toolNeedsApprovalGate(
  tool: string,
  args: Record<string, unknown> | undefined,
  approvalPolicy: ((tool: string) => boolean | undefined) | undefined,
  hasApprovalResolver: boolean,
): boolean {
  const o = approvalPolicy?.(tool);
  if (o !== undefined) {
    return o;
  }
  // 只有在有审批回调的情况下才做门控。
  // 如果没有回调（自动化环境），修改性工具默认放行。
  if (!hasApprovalResolver) {
    return false;
  }
  return toolRequiresApproval(tool, undefined, args);
}

/**
 * 批量执行工具调用（并行），带审批门控和 checkpoint 机制。
 *
 * 执行步骤：
 * 1. 子 Agent 策略检查：read_only 模式下标记所有修改性工具为 blocked
 * 2. 审批收集（串行）：UI 交互必须有序，逐个询问用户
 * 3. Checkpoint 预分配：为每个修改性工具分配序列号
 * 4. 并行执行：所有工具通过 Promise.all 并发执行
 *
 * 为什么审批是串行的？
 * - TUI 每次只能展示一个审批弹窗
 * - 用户需要逐个决策，批量展示会造成混乱
 */
export async function executeToolCalls(
  calls: readonly AgentToolCallAction[],
  toolCtx: ToolExecutionContext,
  approvalCtx: ApprovalContext,
): Promise<ToolRunResult[]> {
  // 步骤 1：子 Agent 策略前置检查（审批之前）
  // read_only 模式下直接拒绝修改性工具，不需要询问用户
  const blockedByPolicy = calls.map(
    (call) =>
      toolCtx.childPolicy === "read_only" && isMutatingTool(call.tool),
  );

  // 步骤 2：收集审批结果（串行 — UI 交互必须有序）
  const approvals: boolean[] = [];
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i]!;
    // 已被策略阻止 → 跳过审批
    if (blockedByPolicy[i]) {
      approvals.push(false);
      continue;
    }
    const needsApproval = toolNeedsApprovalGate(
      call.tool,
      call.args as Record<string, unknown> | undefined,
      approvalCtx.approvalPolicy,
      !!approvalCtx.resolveToolApproval,
    );

    if (needsApproval) {
      if (approvalCtx.resolveToolApproval) {
        // 有审批回调 → 询问用户
        toolCtx.emit({
          type: "tool.approval.pending",
          tool: call.tool,
          args: call.args,
        });
        const approved = await approvalCtx.resolveToolApproval({
          tool: call.tool,
          args: call.args,
        });
        toolCtx.emit({
          type: "tool.approval.resolved",
          tool: call.tool,
          approved,
        });
        approvals.push(approved);
      } else {
        // 无审批回调 → 拒绝修改性工具（安全优先）
        toolCtx.emit({
          type: "tool.approval.pending",
          tool: call.tool,
          args: call.args,
        });
        toolCtx.emit({
          type: "tool.approval.resolved",
          tool: call.tool,
          approved: false,
        });
        approvals.push(false);
      }
    } else {
      // 不需要审批 → 直接放行
      approvals.push(true);
    }
  }

  // 步骤 3：为修改性工具预分配 checkpoint 序列号
  // checkpoint 用于断点续跑时恢复文件状态
  const checkpointNums: Array<number | undefined> = calls.map((call) => {
    if (!isMutatingTool(call.tool)) return undefined;
    toolCtx.checkpointSeq.n += 1;
    return toolCtx.checkpointSeq.n;
  });

  // 步骤 4：并行执行所有工具
  // 使用动态 import 避免循环依赖
  const { executeTool } = await import("@paw/harness");
  const results = await Promise.all(
    calls.map(async (call, i) => {
      // 被策略阻止 → 返回 block 结果
      if (blockedByPolicy[i]) {
        return {
          ok: false,
          summary: `Tool ${call.tool} blocked: child agent is in read_only mode`,
          payload: { blocked: true, reason: "read_only_policy" },
        };
      }
      // 被用户拒绝 → 返回 deny 结果
      if (!approvals[i]) {
        return {
          ok: false,
          summary: "tool execution denied by user",
          payload: { denied: true },
        };
      }

      // 保存 checkpoint（修改性工具）
      const cpNum = checkpointNums[i];
      if (cpNum !== undefined) {
        saveCheckpoint(
          toolCtx.workspaceRoot,
          toolCtx.runId,
          cpNum,
          call.tool,
          call.args,
        );
      }

      // 执行工具
      return executeTool(
        {
          workspaceRoot: toolCtx.workspaceRoot,
          mcp: toolCtx.mcp,
          todoStore: toolCtx.todoStore,
          subAgentLauncher: toolCtx.subAgentLauncher,
          skillRegistry: toolCtx.skillRegistry,
          watcher: toolCtx.watcher,
          abortSignal: toolCtx.abortSignal,
          parentRunId: toolCtx.runId,
          // 构建子 Agent 的共享上下文（用于子 Agent 的工具调用）
          buildSubAgentSharedContext: toolCtx.parentContextManager
            ? ({ goal, args }) => {
                const summarizer = new DefaultContextSummarizer();
                return summarizer.summarizeForCall(
                  toolCtx.parentContextManager!,
                  {
                    type: "tool_call",
                    tool: SUB_AGENT_TOOL_NAME,
                    args: { goal, ...args },
                  },
                );
              }
            : undefined,
          // Shell 工具实时输出回调（流式推送到 TUI）
          onShellChunk: (tool, chunk, isStderr) =>
            toolCtx.emit({
              type: "tool.result.chunk",
              tool,
              chunk,
              isStderr,
            }),
          ...(toolCtx.shellSandbox
            ? { shellSandbox: toolCtx.shellSandbox }
            : {}),
        },
        call.tool,
        call.args,
      );
    }),
  );

  return results;
}

/**
 * 工具执行后的统一处理：注入结果到上下文。
 *
 * 这一步是 ReAct 循环中 "Feedback" 环节的关键：
 * 将工具执行结果格式化后注入到 ContextManager，模型在下一轮会看到这些结果。
 *
 * 处理步骤：
 * 1. 发出 tool.result 事件（TUI 展示用）
 * 2. 将 assistant 消息（模型的工具调用文本）加入上下文
 * 3. 将工具结果（tool results）加入上下文
 * 4. 处理工具产生的新消息（newMessages，如子 Agent 的报告）
 * 5. Max steps 检查
 * 6. 保存断点状态
 */
export function finalizeToolExecution(
  calls: readonly AgentToolCallAction[],
  results: ToolRunResult[],
  ctx: {
    readonly ctxMgr: ContextManager;
    readonly emit: (event: RunEvent) => void;
    readonly runId: string;
    readonly workspaceRoot: string;
    readonly turn: number;
    readonly maxSteps: number;
    readonly specGoal: string;
    readonly text: string;
    readonly thinking?: string;
    readonly saveStateFn: () => void;
  },
): {
  readonly type: "continue" | "completed";
  readonly message?: string;
} {
  // 步骤 1：逐个发出工具结果事件
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i]!;
    const tr = results[i]!;
    ctx.emit({
      type: "tool.result",
      tool: call.tool,
      ok: tr.ok,
      summary: tr.summary,
      detail: formatToolResultEventDetail(tr),
    });
  }

  // 步骤 2：将模型的工具调用文本作为 assistant 消息加入
  ctx.ctxMgr.addAssistant(ctx.text, ctx.thinking);

  // 步骤 3：将工具执行结果作为 user 消息加入（模型在下一轮看到这些）
  ctx.ctxMgr.addToolResults(
    results.map((tr, i) => ({
      tool: calls[i]!.tool,
      ok: tr.ok,
      summary: tr.summary,
      payload: tr.payload,
    })),
  );

  // 步骤 4：处理工具产生的新消息
  // 某些工具（如子 Agent）会在结果中附带额外的 user/assistant 消息
  for (const tr of results) {
    if (tr.newMessages) {
      for (const msg of tr.newMessages) {
        if (msg.role === "user") ctx.ctxMgr.addUser(msg.content);
        else if (msg.role === "assistant") ctx.ctxMgr.addAssistant(msg.content);
      }
    }
  }

  // 步骤 5：Max steps 检查
  if (ctx.turn + 1 >= ctx.maxSteps) {
    const toolNames = calls.map((c) => c.tool).join(", ");
    return {
      type: "completed",
      message: `Max steps (${ctx.maxSteps}) reached after tool(s): ${toolNames}`,
    };
  }

  // 步骤 6：保存状态（断点续跑）+ 继续
  ctx.saveStateFn();
  return { type: "continue" };
}
