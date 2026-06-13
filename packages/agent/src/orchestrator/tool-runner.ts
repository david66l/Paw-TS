/**
 * ToolRunner: unified tool execution and post-execution handling.
 * Eliminates duplication between parallel-tool and single-tool paths.
 */

import type { AgentToolCallAction, ContextManager, RunEvent } from "@paw/core";
import { isMutatingTool } from "@paw/core";
import { saveCheckpoint } from "@paw/core";
import type { HarnessContext, ShellSandboxConfig, ToolRunResult } from "@paw/harness";
import { toolRequiresApproval } from "@paw/harness";
import { DefaultContextSummarizer } from "./context-summarizer.js";
import { SUB_AGENT_TOOL_NAME } from "./constants.js";
import { formatToolResultEventDetail } from "../tool-result-detail.js";

interface ToolExecutionContext {
  readonly workspaceRoot: string;
  readonly runId: string;
  readonly mcp?: HarnessContext["mcp"];
  readonly todoStore?: HarnessContext["todoStore"];
  readonly subAgentLauncher?: HarnessContext["subAgentLauncher"];
  readonly skillRegistry?: HarnessContext["skillRegistry"];
  readonly watcher?: HarnessContext["watcher"];
  readonly parentContextManager?: ContextManager;
  readonly abortSignal?: AbortSignal;
  readonly emit: (event: RunEvent) => void;
  readonly checkpointSeq: { n: number };
  readonly childPolicy?: "read_only" | "read_write";
  readonly shellSandbox?: ShellSandboxConfig;
}

interface ApprovalContext {
  readonly resolveToolApproval?:
    | ((input: {
        readonly tool: string;
        readonly args: unknown;
      }) => Promise<boolean>)
    | undefined;
  readonly approvalPolicy?: ((tool: string) => boolean | undefined) | undefined;
}

function toolNeedsApprovalGate(
  tool: string,
  args: Record<string, unknown> | undefined,
  approvalPolicy: ((tool: string) => boolean | undefined) | undefined,
): boolean {
  const o = approvalPolicy?.(tool);
  if (o !== undefined) {
    return o;
  }
  return toolRequiresApproval(tool, undefined, args);
}

/**
 * Execute a batch of tool calls (parallel or single) with approval gates
 * and checkpointing.
 */
export async function executeToolCalls(
  calls: readonly AgentToolCallAction[],
  toolCtx: ToolExecutionContext,
  approvalCtx: ApprovalContext,
): Promise<ToolRunResult[]> {
  // 1. Collect approvals (sequential – UI prompts must be ordered)
  const approvals: boolean[] = [];
  for (const call of calls) {
    const gated =
      toolNeedsApprovalGate(
        call.tool,
        call.args as Record<string, unknown> | undefined,
        approvalCtx.approvalPolicy,
      ) && approvalCtx.resolveToolApproval !== undefined;

    if (gated && approvalCtx.resolveToolApproval) {
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
      approvals.push(true);
    }
  }

  // 2. Pre-assign checkpoint sequence numbers for mutating tools
  const checkpointNums: Array<number | undefined> = calls.map((call) => {
    if (!isMutatingTool(call.tool)) return undefined;
    toolCtx.checkpointSeq.n += 1;
    return toolCtx.checkpointSeq.n;
  });

  // 3. Execute in parallel
  const { executeTool } = await import("@paw/harness");
  const results = await Promise.all(
    calls.map(async (call, i) => {
      if (!approvals[i]) {
        return {
          ok: false,
          summary: "tool execution denied by user",
          payload: { denied: true },
        };
      }
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
      if (toolCtx.childPolicy === "read_only" && isMutatingTool(call.tool)) {
        return {
          ok: false,
          summary: `Tool ${call.tool} blocked: child agent is in read_only mode`,
          payload: { blocked: true, reason: "read_only_policy" },
        };
      }
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
          buildSubAgentSharedContext: toolCtx.parentContextManager
            ? ({ goal, args }) => {
                const summarizer = new DefaultContextSummarizer();
                return summarizer.summarizeForCall(
                  toolCtx.parentContextManager!,
                  {
                    tool: SUB_AGENT_TOOL_NAME,
                    args: { goal, ...args },
                  },
                );
              }
            : undefined,
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
 * Unified post-execution handling: add assistant message, tool results,
 * newMessages, maxSteps check, saveState, memory extraction.
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
  // Emit tool results
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

  // Add assistant message
  ctx.ctxMgr.addAssistant(ctx.text, ctx.thinking);

  // Add tool results to context
  ctx.ctxMgr.addToolResults(
    results.map((tr, i) => ({
      tool: calls[i]!.tool,
      ok: tr.ok,
      summary: tr.summary,
      payload: tr.payload,
    })),
  );

  // Handle newMessages produced by tools
  for (const tr of results) {
    if (tr.newMessages) {
      for (const msg of tr.newMessages) {
        if (msg.role === "user") ctx.ctxMgr.addUser(msg.content);
        else if (msg.role === "assistant") ctx.ctxMgr.addAssistant(msg.content);
      }
    }
  }

  // Max steps check
  if (ctx.turn + 1 >= ctx.maxSteps) {
    const toolNames = calls.map((c) => c.tool).join(", ");
    return {
      type: "completed",
      message: `Max steps (${ctx.maxSteps}) reached after tool(s): ${toolNames}`,
    };
  }

  // Save state and continue
  ctx.saveStateFn();
  return { type: "continue" };
}
