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

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type {
  AgentToolCallAction,
  ArtifactRegistry,
  ContextManager,
  NativeToolTurnCallV1,
  RunEvent,
  ToolDecisionCommitV1,
  ToolFileChange,
} from "@paw/core";
import { extractCheckpointTargets, isMutatingTool } from "@paw/core";
import { saveCheckpoint } from "@paw/core";
import type {
  HarnessContext,
  ShellSandboxConfig,
  ToolRunResult,
} from "@paw/harness";
import {
  JOB_KILL,
  JOB_LIST,
  JOB_READ,
  JOB_START,
  JOB_WAIT,
  toolRequiresApproval,
} from "@paw/harness";
import type { FileLockLike } from "@paw/harness";
import type { ExecutionEnvironmentRegistryV1 } from "../execution-environment.js";
import type {
  ToolEffectPolicy,
  ToolExecutionPolicy,
} from "../execution-policy.js";
import { collectToolRecoveryMessage } from "../lifecycle/task-lifecycle.js";
import {
  decomposeVerificationFailuresV2,
  renderVerificationFailureRecordsV2,
} from "../loop-v2/failure-records.js";
import type {
  LoopV2ShadowMutationCapture,
  LoopV2ShadowVerificationCapture,
  ToolExecutionModeV2,
} from "../loop-v2/index.js";
import { executeToolBatchV2 } from "../loop-v2/index.js";
import {
  observationProvenanceForToolV1,
  wrapCapabilityContentV1,
} from "../observation-provenance.js";
import type {
  TaskState,
  TaskStateManager,
  TestResultSummary,
} from "../task-state.js";
import { formatToolResultEventDetail } from "../tool-result-detail.js";
import { analyzeVerificationInvocation } from "../verification-command.js";
import { parseChildPolicy } from "./agent-args.js";
import { SUB_AGENT_TOOL_NAME } from "./constants.js";
import { DefaultContextSummarizer } from "./context-summarizer.js";
import { truncatePayloadWithOutcome } from "./truncate-payload.js";

/** 文件锁等待超时（毫秒）：超时后该工具调用按冲突失败返回 */
const FILE_LOCK_TIMEOUT_MS = 20_000;

function isManagedJobControlTool(tool: string): boolean {
  return (
    tool === JOB_START ||
    tool === JOB_LIST ||
    tool === JOB_READ ||
    tool === JOB_WAIT ||
    tool === JOB_KILL
  );
}

/**
 * 从工具结果 payload 提取文件变更统计（供 tool.result 事件的 fileChanges 字段）。
 * 兼容三种 payload：
 * - write_file / edit_file：单对象 {path, linesAdded, linesRemoved, diff?}
 * - apply_patch：{results: [{path, linesAdded?, linesRemoved?, ok}]}
 */
export function fileChangesFromPayload(
  payload: unknown,
  workspaceRoot: string,
): ToolFileChange[] | undefined {
  const direct = toFileChange(payload, workspaceRoot);
  if (direct) return [direct];
  if (payload !== null && typeof payload === "object") {
    const results = (payload as Record<string, unknown>).results;
    if (Array.isArray(results)) {
      const out = results
        .map((r) => toFileChange(r, workspaceRoot))
        .filter((c): c is ToolFileChange => c !== undefined);
      if (out.length > 0) return out;
    }
  }
  return undefined;
}

function workspaceEffectFromPayload(
  payload: unknown,
):
  | { readonly changed: boolean; readonly paths: readonly string[] }
  | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const raw = (payload as Record<string, unknown>).workspaceEffect;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const effect = raw as Record<string, unknown>;
  if (typeof effect.changed !== "boolean" || !Array.isArray(effect.paths)) {
    return undefined;
  }
  return {
    changed: effect.changed,
    paths: effect.paths.filter(
      (item): item is string => typeof item === "string" && item.length > 0,
    ),
  };
}

function toFileChange(
  value: unknown,
  workspaceRoot: string,
): ToolFileChange | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const o = value as Record<string, unknown>;
  if (o.ok === false) return undefined;
  if (o.changed === false) return undefined;
  const added = o.linesAdded;
  const removed = o.linesRemoved;
  if (typeof added !== "number" && typeof removed !== "number") {
    return undefined;
  }
  let p = typeof o.path === "string" ? o.path : "";
  // edit_file 返回绝对路径 → 归一化为工作区相对路径
  const root = workspaceRoot.replace(/[/\\]$/, "");
  if (p.startsWith(`${root}/`) || p.startsWith(`${root}\\`)) {
    p = p.slice(root.length + 1);
  }
  return {
    path: p || "(unknown)",
    added: typeof added === "number" ? added : 0,
    removed: typeof removed === "number" ? removed : 0,
    ...(typeof o.diff === "string" && o.diff ? { diff: o.diff } : {}),
  };
}

/**
 * 从多文件 unified patch 文本中抽取某个文件的 diff 段。
 * 按 `--- ` 行切段（每段 = 一个文件），用 `+++ ` 行匹配目标路径。
 * 供 apply_patch 的结果补齐 per-file diff（其 payload 只有 +/− 无文本）。
 */
export function extractFilePatch(
  patchText: string,
  filePath: string,
): string | undefined {
  if (!patchText || !filePath) return undefined;
  const sections: string[][] = [];
  let cur: string[] | null = null;
  for (const line of patchText.split("\n")) {
    if (line.startsWith("--- ")) {
      if (cur) sections.push(cur);
      cur = [line];
    } else if (cur) {
      cur.push(line);
    }
    // diff --git / Index: 等头行不在 --- 段内，自然丢弃
  }
  if (cur) sections.push(cur);

  const norm = (p: string) =>
    p
      .replace(/^[ab]\//, "")
      .replace(/\\/g, "/")
      .trim();
  const want = norm(filePath);
  for (const sec of sections) {
    const plusLine = sec.find((l) => l.startsWith("+++ "));
    if (!plusLine) continue;
    const target = norm(plusLine.slice(4).replace(/^"|"$/g, ""));
    if (
      target === want ||
      target.endsWith(`/${want}`) ||
      want.endsWith(`/${target}`)
    ) {
      return sec.join("\n").slice(0, 2048);
    }
  }
  return undefined;
}

/** 从 tool.call args 中取 patch 文本（apply_patch 的 args 形如 {patch: "..."}） */
function patchTextFromArgs(args: unknown): string | undefined {
  if (args === null || typeof args !== "object") return undefined;
  const p = (args as Record<string, unknown>).patch;
  return typeof p === "string" ? p : undefined;
}

/** 工具执行的环境上下文 */
export interface ToolExecutionContext {
  readonly workspaceRoot: string;
  readonly runId: string;
  readonly mcp?: HarnessContext["mcp"];
  readonly todoStore?: HarnessContext["todoStore"];
  readonly acceptanceLedger?: HarnessContext["acceptanceLedger"];
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
  /** 并行子 Agent 的文件锁（仅子 Agent 注入；root 无锁） */
  readonly fileLock?: FileLockLike;
  /** Shell 沙箱配置 */
  readonly shellSandbox?: ShellSandboxConfig;
  /** 可插拔记忆后端（注入到 HarnessContext 供 memory.save 使用） */
  readonly memoryRuntime?: HarnessContext["memoryRuntime"];
  readonly memoryTaskId?: string;
  readonly createAgent?: HarnessContext["createAgent"];
  /** 工具白名单硬裁（与 Orchestrator.allowedTools 一致） */
  readonly allowedTools?: readonly string[] | null;
  /** P3 冷库：会话级可寻址归档（context.recall 执行 + 截断全文归档） */
  readonly artifactRegistry?: ArtifactRegistry;
  /** Trusted policy gate, evaluated before approval, checkpoint, or execution. */
  readonly toolExecutionPolicy?: ToolExecutionPolicy;
  /** Trusted before/after audit for effects not derivable from tool args. */
  readonly toolEffectPolicy?: ToolEffectPolicy;
  /** Capture immutable rich facts only for the diagnostic v2-shadow path. */
  readonly captureLoopV2Facts?: boolean;
  readonly managedJobs?: HarnessContext["managedJobs"];
}

export interface ToolExecutionBatchResult {
  readonly results: readonly ToolRunResult[];
  readonly mutationCaptures: readonly (
    | LoopV2ShadowMutationCapture
    | undefined
  )[];
}

export interface ToolResultCommitContext {
  readonly emit: (event: RunEvent) => void;
  readonly runId: string;
  readonly workspaceRoot: string;
  readonly turn: number;
  readonly taskState?: TaskStateManager;
  readonly executionEnvironment?: ExecutionEnvironmentRegistryV1;
  /** Attach a versioned rich decision fact to the durable tool.result. */
  readonly captureLoopV2Facts?: boolean;
}

export interface ToolExecutionFinalizationContext
  extends ToolResultCommitContext {
  readonly ctxMgr: ContextManager;
  readonly maxSteps: number;
  readonly specGoal: string;
  readonly text: string;
  readonly thinking?: string;
  readonly nativeToolTurn?: {
    readonly assistantContent: string;
    readonly reasoningPassback?: string;
    readonly calls: readonly NativeToolTurnCallV1[];
  };
  readonly mutationCaptures?: readonly (
    | LoopV2ShadowMutationCapture
    | undefined
  )[];
  /** 会话级工具输出去重器（P1 入口闸） */
  readonly payloadDeduper?: import("./truncate-payload.js").PayloadDeduper;
  /** P3 冷库：截断的全文按内容哈希归档，注入 [archived id] 引用桩 */
  readonly artifactRegistry?: ArtifactRegistry;
  /** Idle-fuse failure signatures from prior turns */
  readonly failureSignatures?: readonly string[];
}

export interface ToolExecutionFinalizationResult {
  readonly type: "continue" | "incomplete";
  readonly message?: string;
  /** Request-only host advice derived from the durable tool observations. */
  readonly recoveryMessage?: string;
  readonly failureSignatures?: readonly string[];
  readonly idleFuseTripped?: boolean;
}

type MutationBeforeCapture =
  | Extract<LoopV2ShadowMutationCapture, { readonly status: "gap" }>
  | Readonly<{
      status: "before";
      paths: readonly string[];
      beforeContents: Readonly<Record<string, string | null>>;
    }>;

/** 审批上下文 */
export interface ApprovalContext {
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
export function toolNeedsApprovalGate(
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
): Promise<ToolExecutionBatchResult> {
  // 步骤 1：策略前置检查（审批之前）
  // - read_only：拒绝修改性工具
  // - allowedTools：拒绝不在白名单的工具
  const allowSet =
    toolCtx.allowedTools === undefined || toolCtx.allowedTools === null
      ? null
      : new Set(toolCtx.allowedTools);
  const policyBlocks = await Promise.all(
    calls.map(async (call) => {
      if (toolCtx.childPolicy === "read_only" && isMutatingTool(call.tool)) {
        return {
          reason: "read_only_policy",
          message: `Tool ${call.tool} is unavailable in a read-only child agent.`,
        };
      }
      if (allowSet && !allowSet.has(call.tool)) {
        return {
          reason: "tool_not_in_allowlist",
          message: `Tool ${call.tool} is not in this agent's tool allowlist.`,
        };
      }
      // job_start delegates authorization to ManagedJobController under the
      // canonical workspace.run_shell identity after the normal approval gate.
      const decision =
        call.tool === JOB_START
          ? undefined
          : await toolCtx.toolExecutionPolicy?.({
              tool: call.tool,
              args: call.args,
              workspaceRoot: toolCtx.workspaceRoot,
            });
      return decision && !decision.allowed
        ? { reason: decision.reason, message: decision.message }
        : undefined;
    }),
  );
  const blockedByPolicy = policyBlocks.map(Boolean);
  const effectPolicyApplies = calls.map((call) =>
    toolCtx.toolEffectPolicy && !isManagedJobControlTool(call.tool)
      ? (toolCtx.toolEffectPolicy.appliesTo?.({
          tool: call.tool,
          args: call.args,
          workspaceRoot: toolCtx.workspaceRoot,
        }) ?? true)
      : false,
  );

  // 步骤 1.5：并行子 Agent 的文件锁（仅当注入 fileLock，即子 Agent 场景）
  // 占用语义：先到先得，后来的等待，超时按冲突失败。
  const lockConflict: (string | undefined)[] = calls.map(() => undefined);
  if (toolCtx.fileLock) {
    for (let i = 0; i < calls.length; i++) {
      const call = calls[i]!;
      if (blockedByPolicy[i]) continue;
      // shell 目标不可预测，跳过锁（与 checkpoint 的 __shell_cmd__ 一致）
      if (!isMutatingTool(call.tool) || call.tool === "workspace.run_shell") {
        continue;
      }
      const targets = extractCheckpointTargets(call.tool, call.args).filter(
        (t) => t !== "__shell_cmd__",
      );
      if (targets.length === 0) continue;
      const r = await toolCtx.fileLock.acquire(
        targets,
        toolCtx.runId,
        FILE_LOCK_TIMEOUT_MS,
        (conflict) => {
          toolCtx.emit({
            type: "agent.file_lock",
            status: "wait",
            path: conflict.path ?? targets[0]!,
            ...(conflict.holder ? { holder: conflict.holder } : {}),
          });
        },
      );
      if (!r.ok) {
        lockConflict[i] = r.path ?? targets[0]!;
        toolCtx.emit({
          type: "agent.file_lock",
          status: "denied",
          path: r.path ?? targets[0]!,
          ...(r.holder ? { holder: r.holder } : {}),
        });
      }
    }
  }

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
  const checkpointNums: Array<number | undefined> = calls.map((call, index) => {
    if (
      blockedByPolicy[index] ||
      !approvals[index] ||
      !isMutatingTool(call.tool)
    )
      return undefined;
    toolCtx.checkpointSeq.n += 1;
    return toolCtx.checkpointSeq.n;
  });
  const mutationCallCount = calls.filter((call) =>
    isMutatingTool(call.tool),
  ).length;
  const mutationCaptures: Array<LoopV2ShadowMutationCapture | undefined> =
    calls.map(() => undefined);

  // 步骤 4：执行工具。注入 effect policy 时必须串行，确保每个 before/after
  // 快照只归因于一个工具；没有 effect policy 时保留原有并行语义。
  // 使用动态 import 避免循环依赖
  const { executeTool } = await import("@paw/harness");
  const executeOne = async (
    call: AgentToolCallAction,
    i: number,
  ): Promise<ToolRunResult> => {
    // 被策略阻止 → 返回 block 结果
    if (blockedByPolicy[i]) {
      if (toolCtx.captureLoopV2Facts) {
        mutationCaptures[i] = createLoopV2NoMutationCapture();
      }
      const block = policyBlocks[i]!;
      return {
        ok: false,
        summary: `[ToolPolicy:${block.reason}] ${block.message}`,
        payload: {
          blocked: true,
          code: "E_TOOL_POLICY",
          reason: block.reason,
          message: block.message,
        },
      };
    }
    // 文件锁冲突 → 返回冲突结果（模型可改派/重试）
    const conflictPath = lockConflict[i];
    if (conflictPath !== undefined) {
      if (toolCtx.captureLoopV2Facts) {
        mutationCaptures[i] = createLoopV2NoMutationCapture();
      }
      return {
        ok: false,
        summary: `File lock conflict: ${conflictPath} is being written by another agent; try a different file or retry later`,
        payload: { conflict: true, path: conflictPath },
      };
    }
    // 被用户拒绝 → 返回 deny 结果
    if (!approvals[i]) {
      if (toolCtx.captureLoopV2Facts) {
        mutationCaptures[i] = createLoopV2NoMutationCapture();
      }
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

    const beforeCapture = toolCtx.captureLoopV2Facts
      ? captureMutationBefore(toolCtx.workspaceRoot, call, mutationCallCount)
      : undefined;

    let prepared: unknown;
    if (toolCtx.toolEffectPolicy && effectPolicyApplies[i]) {
      try {
        prepared = await toolCtx.toolEffectPolicy.prepare({
          tool: call.tool,
          args: call.args,
          workspaceRoot: toolCtx.workspaceRoot,
        });
      } catch (error) {
        if (toolCtx.captureLoopV2Facts) {
          mutationCaptures[i] = createLoopV2NoMutationCapture();
        }
        const message = error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          summary: `[ToolEffectPolicy:prepare_failed] ${message}`,
          payload: {
            blocked: true,
            code: "E_TOOL_EFFECT_POLICY",
            reason: "prepare_failed",
            message,
            executed: false,
            recovered: true,
          },
        };
      }
    }

    const rawResult = await executeTool(
      {
        workspaceRoot: toolCtx.workspaceRoot,
        mcp: toolCtx.mcp,
        todoStore: toolCtx.todoStore,
        acceptanceLedger: toolCtx.acceptanceLedger,
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
            provenance: observationProvenanceForToolV1(tool),
          }),
        ...(toolCtx.shellSandbox ? { shellSandbox: toolCtx.shellSandbox } : {}),
        // Unified approval bus: tool gate approval covers shell "ask"
        ...(approvals[i] && call.tool === "workspace.run_shell"
          ? { shellCommandPreApproved: true }
          : {}),
        ...(toolCtx.memoryRuntime
          ? { memoryRuntime: toolCtx.memoryRuntime }
          : {}),
        ...(toolCtx.memoryTaskId ? { memoryTaskId: toolCtx.memoryTaskId } : {}),
        ...(toolCtx.createAgent ? { createAgent: toolCtx.createAgent } : {}),
        ...(toolCtx.artifactRegistry
          ? { artifactRegistry: toolCtx.artifactRegistry }
          : {}),
        ...(toolCtx.managedJobs ? { managedJobs: toolCtx.managedJobs } : {}),
      },
      call.tool,
      call.args,
    );

    let settledResult = rawResult;
    if (toolCtx.toolEffectPolicy && effectPolicyApplies[i]) {
      try {
        const decision = await toolCtx.toolEffectPolicy.settle(
          {
            tool: call.tool,
            args: call.args,
            workspaceRoot: toolCtx.workspaceRoot,
            result: rawResult,
          },
          prepared,
        );
        settledResult = decision.allowed
          ? (decision.result ?? rawResult)
          : {
              ok: false,
              summary: `[ToolEffectPolicy:${decision.reason}] ${decision.message}`,
              payload: {
                rejected: true,
                code: "E_TOOL_EFFECT_POLICY",
                reason: decision.reason,
                message: decision.message,
                executed: true,
                recovered: decision.recovered,
                originalOk: rawResult.ok,
                ...(decision.recovered
                  ? { workspaceEffect: { changed: false, paths: [] } }
                  : {}),
              },
            };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        settledResult = {
          ok: false,
          summary: `[ToolEffectPolicy:settle_failed] ${message}`,
          payload: {
            rejected: true,
            code: "E_TOOL_EFFECT_POLICY",
            reason: "settle_failed",
            message,
            executed: true,
            recovered: false,
            originalOk: rawResult.ok,
          },
        };
      }
    }
    if (beforeCapture) {
      mutationCaptures[i] = captureMutationAfter(
        toolCtx.workspaceRoot,
        beforeCapture,
        settledResult,
      );
    }
    return settledResult;
  };

  const results: ToolRunResult[] = [];
  if (
    effectPolicyApplies.some(Boolean) ||
    calls.some((call) => call.tool === "workspace.acceptance_update")
  ) {
    for (const [i, call] of calls.entries()) {
      results.push(await executeOne(call, i));
    }
  } else {
    results.push(...(await Promise.all(calls.map(executeOne))));
  }

  return { results, mutationCaptures };
}

const V2_PARALLEL_TOOLS = new Set([
  "workspace.read_file",
  "workspace.list_dir",
  "workspace.search",
  "workspace.glob",
  "workspace.grep",
  "workspace.web_fetch",
  "workspace.web_search",
  "workspace.brief",
  "workspace.git_status",
  "workspace.git_log",
  "workspace.git_diff",
  "workspace.lsp",
  "workspace.symbol_search",
  "memory.list",
  "memory.read",
]);

/**
 * Only explicitly declared read-only tools may overlap in v2. Shell, writes,
 * control-plane mutations, MCP tools, and unknown tools fail closed to an
 * exclusive barrier.
 */
export function classifyToolExecutionV2(
  call: AgentToolCallAction,
): ToolExecutionModeV2 {
  if (call.tool === SUB_AGENT_TOOL_NAME) {
    const args =
      call.args && typeof call.args === "object" && !Array.isArray(call.args)
        ? (call.args as Record<string, unknown>)
        : undefined;
    return (parseChildPolicy(args) ?? "read_only") === "read_only"
      ? { kind: "parallel" }
      : { kind: "exclusive" };
  }
  return V2_PARALLEL_TOOLS.has(call.tool)
    ? { kind: "parallel" }
    : { kind: "exclusive" };
}

export interface ToolExecutionV2Options {
  readonly preSettledResults?: readonly (ToolRunResult | undefined)[];
  readonly maxParallel?: number;
  readonly dispatchOverride?: (
    call: AgentToolCallAction,
    sourceIndex: number,
  ) => Promise<
    | {
        readonly result: ToolRunResult;
        readonly mutationCapture?: LoopV2ShadowMutationCapture;
      }
    | undefined
  >;
  readonly commit: (
    call: AgentToolCallAction,
    result: ToolRunResult,
    mutationCapture: LoopV2ShadowMutationCapture | undefined,
    sourceIndex: number,
    mode: ToolExecutionModeV2,
  ) => Promise<void> | void;
}

export interface ToolExecutionBatchResultV2 extends ToolExecutionBatchResult {
  readonly aborted: boolean;
}

interface SettledToolCallV2 {
  readonly result: ToolRunResult;
  readonly mutationCapture?: LoopV2ShadowMutationCapture;
}

/**
 * Production adapter for one model-ordered v2 tool batch. Legacy single-call
 * execution remains the authority for policy/approval/checkpoint/tool effects;
 * the v2 scheduler owns overlap, barriers, source-order commit, and abort fill.
 */
export async function executeToolCallsV2(
  calls: readonly AgentToolCallAction[],
  toolCtx: ToolExecutionContext,
  approvalCtx: ApprovalContext,
  options: ToolExecutionV2Options,
): Promise<ToolExecutionBatchResultV2> {
  const scheduled = calls.map((call, sourceIndex) => ({
    callId: `v2:${toolCtx.runId}:call:${sourceIndex}`,
    tool: call.tool,
    args:
      call.args && typeof call.args === "object" && !Array.isArray(call.args)
        ? (call.args as Readonly<Record<string, unknown>>)
        : {},
  }));
  const sourceIndexByCallId = new Map(
    scheduled.map((call, sourceIndex) => [call.callId, sourceIndex] as const),
  );
  const outcome = await executeToolBatchV2<
    number,
    SettledToolCallV2,
    SettledToolCallV2
  >(
    scheduled,
    {
      classify(scheduledCall) {
        const index = sourceIndexByCallId.get(scheduledCall.callId);
        if (index === undefined) return { kind: "exclusive" };
        const sourceCall = calls[index];
        if (!sourceCall) return { kind: "exclusive" };
        const args =
          sourceCall.args &&
          typeof sourceCall.args === "object" &&
          !Array.isArray(sourceCall.args)
            ? (sourceCall.args as Record<string, unknown>)
            : undefined;
        if (
          toolNeedsApprovalGate(
            sourceCall.tool,
            args,
            approvalCtx.approvalPolicy,
            Boolean(approvalCtx.resolveToolApproval),
          )
        ) {
          return { kind: "exclusive" };
        }
        if (
          toolCtx.toolEffectPolicy &&
          (toolCtx.toolEffectPolicy.appliesTo?.({
            tool: sourceCall.tool,
            args: sourceCall.args,
            workspaceRoot: toolCtx.workspaceRoot,
          }) ??
            true)
        ) {
          return { kind: "exclusive" };
        }
        return classifyToolExecutionV2(sourceCall);
      },
      async prepare(_scheduled, index) {
        const settled = options.preSettledResults?.[index];
        return settled
          ? {
              kind: "settled",
              result: {
                result: settled,
                mutationCapture: createLoopV2NoMutationCapture(),
              },
            }
          : { kind: "dispatch", prepared: index };
      },
      async dispatch(sourceIndex) {
        const sourceCall = calls[sourceIndex];
        if (!sourceCall) {
          throw new Error(`Tool scheduler missing source call ${sourceIndex}`);
        }
        const overridden = await options.dispatchOverride?.(
          sourceCall,
          sourceIndex,
        );
        if (overridden) return overridden;
        const batch = await executeToolCalls(
          [sourceCall],
          { ...toolCtx, captureLoopV2Facts: true },
          approvalCtx,
        );
        const result = batch.results[0];
        if (!result) {
          throw new Error(`Tool scheduler missing result ${sourceIndex}`);
        }
        return {
          result,
          ...(batch.mutationCaptures[0]
            ? { mutationCapture: batch.mutationCaptures[0] }
            : {}),
        };
      },
      async commit(_scheduled, settled, index, mode) {
        const sourceCall = calls[index];
        if (!sourceCall) {
          throw new Error(`Tool scheduler missing commit call ${index}`);
        }
        await options.commit(
          sourceCall,
          settled.result,
          settled.mutationCapture,
          index,
          mode,
        );
        return settled;
      },
      async skip(_scheduled, index) {
        return {
          result: {
            ok: false,
            summary: "tool execution skipped because the run was aborted",
            payload: {
              skipped: true,
              code: "E_RUN_ABORTED",
              sourceIndex: index,
            },
          },
          mutationCapture: createLoopV2NoMutationCapture(),
        };
      },
    },
    {
      ...(options.maxParallel === undefined
        ? {}
        : { maxParallel: options.maxParallel }),
      ...(toolCtx.abortSignal ? { signal: toolCtx.abortSignal } : {}),
    },
  );
  const ordered = outcome.committed.map((entry) => entry.value);
  return {
    results: ordered.map((entry) => entry.result),
    mutationCaptures: ordered.map((entry) => entry.mutationCapture),
    aborted: outcome.aborted,
  };
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
  ctx: ToolExecutionFinalizationContext,
): ToolExecutionFinalizationResult {
  const batchHasMutation = calls.some((call) => isMutatingTool(call.tool));
  // 步骤 1：逐个发出工具结果事件
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i];
    const result = results[i];
    if (!call || !result) {
      throw new Error(`Tool result batch is missing source index ${i}`);
    }
    commitToolExecutionResult(call, result, i, ctx, {
      concurrentMutation: batchHasMutation,
      mutationCapture: ctx.mutationCaptures?.[i],
    });
  }

  return finalizeToolExecutionContext(calls, results, ctx);
}

const UNTRUSTED_EXIT_TAG = "[UntrustedExitStatus]";

/**
 * Loop v2.1 §10：失败的验证输出在结果时刻即附带失败记录的结构化分区
 * （owned/environment），这是分解层事实的渲染，不含任何行为命令——
 * 模型从看到输出的第一眼起就拿到同一份分类事实，而不是原始日志加
 * 事后评语。与 untrusted 退出码标注同一接入位（journal + 模型上下文）。
 */
export function annotateVerificationFailureRecords(
  call: AgentToolCallAction,
  result: ToolRunResult,
  filesChanged: readonly string[],
): ToolRunResult {
  if (call.tool !== "workspace.run_shell" || result.ok) return result;
  const payload =
    result.payload && typeof result.payload === "object"
      ? (result.payload as Readonly<Record<string, unknown>>)
      : undefined;
  const output = [payload?.stdout, payload?.stderr, result.summary]
    .filter((value): value is string => typeof value === "string")
    .join("\n");
  const records = decomposeVerificationFailuresV2({
    output,
    filesChanged,
  });
  const rendered = renderVerificationFailureRecordsV2(records);
  if (!rendered) return result;
  if (result.summary.includes("[VerificationFailureRecords]")) return result;
  return {
    ...result,
    summary: `${result.summary}\n${rendered}`,
  };
}

/**
 * Loop v2.1 §6.1/K3：验证命令若运行在 shell 控制流（pipe/重定向/fallback/
 * 尾随命令）中，最终退出码不能证明测试通过。判定复用
 * analyzeVerificationInvocation 的 exitStatusReliable——与 task-state 的
 * untrusted_exit_status 分类同一事实源——在工具结果落 journal 与进入模型
 * 上下文时内联标注，模型无需等到 readiness 阶段才知道退出码不可信。
 *
 * 只标注真实产生了 shell 退出码的结果：被沙箱/审批拒绝（E_FATAL 等）或
 * 未执行的结果没有退出码可言，“被遮蔽”的表述会失真，也会稀释拒绝原因。
 */
export function annotateUntrustedShellExitSummary(
  call: AgentToolCallAction,
  result: ToolRunResult,
): ToolRunResult {
  if (call.tool !== "workspace.run_shell") return result;
  const payload =
    result.payload && typeof result.payload === "object"
      ? (result.payload as Readonly<Record<string, unknown>>)
      : undefined;
  if (typeof payload?.exit_code !== "number") return result;
  const args =
    call.args && typeof call.args === "object" && !Array.isArray(call.args)
      ? (call.args as Readonly<Record<string, unknown>>)
      : {};
  const command = typeof args.command === "string" ? args.command : undefined;
  if (!command) return result;
  const invocation = analyzeVerificationInvocation(command);
  if (!invocation || invocation.exitStatusReliable) return result;
  if (result.summary.includes(UNTRUSTED_EXIT_TAG)) return result;
  return {
    ...result,
    summary: `${result.summary} — ${UNTRUSTED_EXIT_TAG} the test runner's exit status is masked by shell control flow; do not claim a pass from this exit code — re-run the same runner directly without pipes, redirections, fallbacks, or trailing commands`,
  };
}

/**
 * Commit one tool result to TaskState and the durable event stream. The rich
 * v2 decision fact is attached atomically to tool.result, so replay never
 * depends on a memory-only callback. A v2 exclusive scheduler must keep its
 * barrier held until this function returns.
 */
export function commitToolExecutionResult(
  call: AgentToolCallAction,
  result: ToolRunResult,
  sourceIndex: number,
  ctx: ToolResultCommitContext,
  options: {
    readonly concurrentMutation: boolean;
    readonly mutationCapture?: LoopV2ShadowMutationCapture;
  },
): void {
  const annotatedExit = annotateUntrustedShellExitSummary(call, result);
  const observed = annotateVerificationFailureRecords(
    call,
    annotatedExit,
    ctx.taskState?.snapshot().filesChanged ?? [],
  );
  const taskStateBefore = ctx.taskState?.snapshot();
  const repositoryRevision = `run:${ctx.runId}:mutation:${taskStateBefore?.mutationRevision ?? 0}`;
  const sourceContentHash =
    ctx.captureLoopV2Facts &&
    observed.ok &&
    call.tool === "workspace.read_file" &&
    !options.concurrentMutation
      ? readSourceContentHash(ctx.workspaceRoot, call.args, observed.payload)
      : undefined;
  ctx.taskState?.recordToolResult(call, observed);
  ctx.executionEnvironment?.observeToolResult(ctx.turn, call, observed);
  const taskStateAfter = ctx.taskState?.snapshot();
  const verificationCapture = buildShadowVerificationCapture(
    ctx.workspaceRoot,
    call,
    observed,
    taskStateBefore,
    taskStateAfter,
  );
  const conflictPayload =
    observed.payload && typeof observed.payload === "object"
      ? (observed.payload as Record<string, unknown>)
      : null;
  if (
    conflictPayload?.conflict === true &&
    typeof conflictPayload.path === "string"
  ) {
    ctx.taskState?.recordFileLockConflict(conflictPayload.path);
  }
  let fileChanges = observed.ok
    ? fileChangesFromPayload(observed.payload, ctx.workspaceRoot)
    : undefined;
  // apply_patch：payload 只有 +/− 统计，从调用参数里抽取 per-file diff 文本补齐
  const patchText = patchTextFromArgs(call.args);
  if (fileChanges && patchText) {
    fileChanges = fileChanges.map((change) => {
      if (change.diff) return change;
      const diff = extractFilePatch(patchText, change.path);
      return diff ? { ...change, diff } : change;
    });
  }
  const workspaceEffect = workspaceEffectFromPayload(result.payload);
  const decisionCommit: ToolDecisionCommitV1 | undefined =
    ctx.captureLoopV2Facts
      ? {
          schemaVersion: "paw.tool-decision-commit.v1",
          callId: `legacy:${ctx.runId}:turn:${ctx.turn}:call:${sourceIndex}`,
          tool: call.tool,
          args: call.args,
          result: observed,
          repositoryRevision,
          concurrentMutation: options.concurrentMutation,
          ...(sourceContentHash ? { sourceContentHash } : {}),
          ...(options.mutationCapture
            ? { mutationCapture: options.mutationCapture }
            : {}),
          ...(verificationCapture ? { verificationCapture } : {}),
        }
      : undefined;
  ctx.emit({
    type: "tool.result",
    tool: call.tool,
    ok: observed.ok,
    summary: observed.summary,
    detail: formatToolResultEventDetail(observed),
    provenance: observationProvenanceForToolV1(call.tool),
    ...(workspaceEffect ? { workspaceEffect } : {}),
    ...(fileChanges ? { fileChanges } : {}),
    ...(decisionCommit ? { decisionCommit } : {}),
  });
}

/** Finish the model-facing batch after all source-ordered result commits. */
export function finalizeToolExecutionContext(
  calls: readonly AgentToolCallAction[],
  results: ToolRunResult[],
  ctx: ToolExecutionFinalizationContext,
): ToolExecutionFinalizationResult {
  // 步骤 2/3：准备模型可见结果。文本 fallback 保持 assistant + user
  // 消息；完整 OpenAI native batch 则作为一个原子 envelope 持久化。
  // v3 P1 入口闸：注入前做「内容哈希去重 + 分档截断」，
  // 单条结果在进入上下文前就被控制到预算内（TokenPilot ingestion gate）
  // v3 P3 冷库：截断的全文按内容哈希归档（ARC 存储与呈现分离），
  // 上下文中只留头尾预览 + [archived id=N] 引用桩，可经 context.recall 取回。
  const archive = ctx.artifactRegistry;
  const modelFacingResults = results.map((tr, i) => {
    const tool = calls[i]!.tool;
    const callerText = ctx.text;
    // 模型可见 summary 内联 untrusted 退出码标注（与 journal 事实同一判定）
    const annotated = annotateVerificationFailureRecords(
      calls[i]!,
      annotateUntrustedShellExitSummary(calls[i]!, tr),
      ctx.taskState?.snapshot().filesChanged ?? [],
    );
    let payload: unknown = tr.payload;
    // 去重：同一内容重复出现 → 预览引用（重复读文件/重复跑命令的浪费源）
    const dup = ctx.payloadDeduper?.check(payload);
    if (dup) {
      const archived = archive?.getByHash(dup.hash);
      payload = archived
        ? `[repeat of #${dup.hash}, same content as turn ${dup.turn}] ${archive!.toStub(archived.id)}`
        : `[repeat of #${dup.hash}, same content as turn ${dup.turn}]`;
    } else {
      ctx.payloadDeduper?.record(payload, ctx.turn);
    }
    // 分档截断（read 类不截断；run_shell 等头尾保留 + 错误行智能保留）
    const outcome = truncatePayloadWithOutcome(payload, tool);
    payload = outcome.payload;
    // 截断发生 → 全文归档 + 引用桩（可寻址恢复的前提）
    if (outcome.truncated && outcome.fullText && archive) {
      const id = archive.store(outcome.fullText, {
        tool,
        ok: tr.ok,
        turn: ctx.turn,
        callerText,
      });
      if (id) {
        const stub = archive.toStub(id);
        payload = `${String(payload)}\n${stub}`;
      }
    }
    return {
      tool,
      ok: annotated.ok,
      summary: annotated.summary,
      payload,
      provenance: observationProvenanceForToolV1(tool),
    };
  });
  const nativeTurn = ctx.nativeToolTurn;
  if (
    nativeTurn &&
    nativeTurn.calls.length === calls.length &&
    calls.length === modelFacingResults.length
  ) {
    const pairedResults = modelFacingResults.map((result, index) => {
      const call = nativeTurn.calls[index];
      if (!call) throw new Error(`Missing native call ${index}`);
      return { ...result, callId: call.callId };
    });
    ctx.ctxMgr.addNativeToolTurn(
      nativeTurn.assistantContent,
      nativeTurn.reasoningPassback,
      nativeTurn.calls,
      pairedResults,
    );
  } else {
    ctx.ctxMgr.addAssistant(ctx.text, ctx.thinking);
    ctx.ctxMgr.addToolResults(modelFacingResults);
  }

  // 步骤 4：处理工具产生的新消息
  // 某些工具（如子 Agent）会在结果中附带额外的 user/assistant 消息
  for (let index = 0; index < results.length; index += 1) {
    const tr = results[index];
    if (!tr) continue;
    const sourceTool = calls[index]?.tool ?? "unknown";
    if (tr.newMessages) {
      for (const msg of tr.newMessages) {
        if (msg.role === "user") {
          ctx.ctxMgr.addUser(wrapCapabilityContentV1(sourceTool, msg.content));
        } else if (msg.role === "assistant")
          ctx.ctxMgr.addAssistant(msg.content);
      }
    }
  }

  // 步骤 4.5：ToolFailureRecovery + idle fuse（结构化恢复，而非只靠模型自由发挥）
  const recovery = collectToolRecoveryMessage(
    calls,
    results,
    ctx.failureSignatures,
  );

  // 步骤 5：Max steps 检查 → incomplete（禁止假 completed）
  if (ctx.turn + 1 >= ctx.maxSteps) {
    const toolNames = calls.map((c) => c.tool).join(", ");
    return {
      type: "incomplete",
      message: `Max steps (${ctx.maxSteps}) reached after tool(s): ${toolNames}`,
      ...(recovery.message ? { recoveryMessage: recovery.message } : {}),
      failureSignatures: recovery.signatures,
      idleFuseTripped: recovery.fuseTripped,
    };
  }

  // AppState is saved by the action handler after it has atomically derived
  // recovery/repeat/coding flags from this finalized tool batch.
  return {
    type: "continue",
    ...(recovery.message ? { recoveryMessage: recovery.message } : {}),
    failureSignatures: recovery.signatures,
    idleFuseTripped: recovery.fuseTripped,
  };
}

function readSourceContentHash(
  workspaceRoot: string,
  args: unknown,
  payload: unknown,
): string | undefined {
  if (
    !args ||
    typeof args !== "object" ||
    Array.isArray(args) ||
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    return undefined;
  }
  const argRecord = args as Readonly<Record<string, unknown>>;
  const payloadRecord = payload as Readonly<Record<string, unknown>>;
  const requestedPath = argRecord.path;
  if (typeof requestedPath !== "string" || !requestedPath.trim()) {
    return undefined;
  }
  const root = path.resolve(workspaceRoot);
  const resolved = path.resolve(root, requestedPath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  try {
    const bytes = fs.readFileSync(resolved);
    const lines = bytes.toString("utf8").split(/\r?\n/);
    const offset = typeof argRecord.offset === "number" ? argRecord.offset : 0;
    const limit =
      typeof argRecord.limit === "number" ? argRecord.limit : undefined;
    const observed = lines
      .slice(offset, limit === undefined ? undefined : offset + limit)
      .join("\n");
    if (
      typeof payloadRecord.content !== "string" ||
      observed !== payloadRecord.content
    ) {
      return undefined;
    }
    return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  } catch {
    return undefined;
  }
}

function captureMutationBefore(
  workspaceRoot: string,
  call: AgentToolCallAction,
  mutationCallCount: number,
): MutationBeforeCapture | undefined {
  if (!isMutatingTool(call.tool)) return undefined;
  if (mutationCallCount > 1) {
    return { status: "gap", reason: "parallel_mutations" };
  }
  if (call.tool === "workspace.run_shell") {
    return { status: "gap", reason: "unbounded_mutation_surface" };
  }
  const normalized = normalizeMutationTargets(
    workspaceRoot,
    extractCheckpointTargets(call.tool, call.args),
  );
  if (!normalized) {
    return { status: "gap", reason: "unsafe_or_missing_target" };
  }
  const beforeContents = captureTargetContents(workspaceRoot, normalized);
  return beforeContents
    ? { status: "before", paths: normalized, beforeContents }
    : { status: "gap", reason: "capture_failed" };
}

export function createLoopV2NoMutationCapture(): LoopV2ShadowMutationCapture {
  return {
    status: "complete",
    paths: [],
    beforeContents: {},
    afterContents: {},
  };
}

function captureMutationAfter(
  workspaceRoot: string,
  before: MutationBeforeCapture,
  result: ToolRunResult,
): LoopV2ShadowMutationCapture {
  if (before.status === "gap") {
    if (
      before.reason === "unbounded_mutation_surface" &&
      workspaceEffectFromPayload(result.payload)?.changed === false
    ) {
      return {
        status: "complete",
        paths: [],
        beforeContents: {},
        afterContents: {},
      };
    }
    return before;
  }
  const afterContents = captureTargetContents(workspaceRoot, before.paths);
  return afterContents
    ? {
        status: "complete",
        paths: before.paths,
        beforeContents: before.beforeContents,
        afterContents,
      }
    : { status: "gap", reason: "capture_failed" };
}

function buildShadowVerificationCapture(
  workspaceRoot: string,
  call: AgentToolCallAction,
  result: ToolRunResult,
  before: TaskState | undefined,
  after: TaskState | undefined,
): LoopV2ShadowVerificationCapture | undefined {
  if (call.tool !== "workspace.run_shell" || !before || !after) {
    return undefined;
  }
  if ((after.shellCommandRevision ?? 0) <= (before.shellCommandRevision ?? 0)) {
    return undefined;
  }
  const testResult = after.testResults.at(-1);
  if (
    !testResult ||
    testResult.shellCommandRevision !== after.shellCommandRevision
  ) {
    return undefined;
  }
  const invocation = analyzeVerificationInvocation(testResult.command);
  if (!invocation || invocation.argv.length === 0) return undefined;
  const args =
    call.args && typeof call.args === "object" && !Array.isArray(call.args)
      ? (call.args as Readonly<Record<string, unknown>>)
      : {};
  const requestedCwd = typeof args.cwd === "string" ? args.cwd : ".";
  const cwd = path.resolve(workspaceRoot, requestedCwd);
  const payload =
    result.payload &&
    typeof result.payload === "object" &&
    !Array.isArray(result.payload)
      ? (result.payload as Readonly<Record<string, unknown>>)
      : {};
  const exitCode = payload.exit_code;
  return {
    runner: verificationRunner(testResult, invocation.argv),
    argv: invocation.argv,
    cwd,
    scope: verificationScope(invocation.argv),
    mutationRevision: testResult.mutationRevision ?? 0,
    outcome:
      testResult.outcome ?? (testResult.passed ? "passed" : "code_failed"),
    ...(typeof exitCode === "number" &&
    Number.isSafeInteger(exitCode) &&
    exitCode >= 0
      ? { exitCode }
      : {}),
    ...(testResult.failureKind ? { failureClass: testResult.failureKind } : {}),
    ...(testResult.failureRecords
      ? { failureRecords: testResult.failureRecords }
      : {}),
    output: [payload.stdout, payload.stderr, result.summary]
      .filter((value): value is string => typeof value === "string" && !!value)
      .join("\n"),
    authoritative: true,
  };
}

function verificationRunner(
  result: TestResultSummary,
  argv: readonly string[],
): LoopV2ShadowVerificationCapture["runner"] {
  if (result.family === "pytest") return "pytest";
  if (result.family === "unittest") return "unittest";
  if (result.family === "javascript") {
    const executable = argv[0]?.replaceAll("\\", "/").split("/").at(-1);
    return executable?.toLowerCase().startsWith("bun")
      ? "bun_test"
      : "npm_test";
  }
  return "custom";
}

function verificationScope(argv: readonly string[]): readonly string[] {
  return [
    ...new Set(
      argv
        .slice(1)
        .filter(
          (token) =>
            !token.startsWith("-") &&
            (/[\\/]/.test(token) ||
              /::/.test(token) ||
              /\.(?:py|ts|tsx|js|jsx)$/i.test(token)),
        )
        .map((token) => token.replaceAll("\\", "/")),
    ),
  ];
}

function normalizeMutationTargets(
  workspaceRoot: string,
  targets: readonly string[],
): readonly string[] | undefined {
  const root = path.resolve(workspaceRoot);
  const normalized = new Set<string>();
  for (const target of targets) {
    if (!target || target === "__shell_cmd__") return undefined;
    const resolved = path.resolve(root, target);
    const relative = path.relative(root, resolved);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      return undefined;
    }
    normalized.add(relative.replaceAll("\\", "/"));
  }
  return normalized.size > 0 ? [...normalized].sort() : undefined;
}

function captureTargetContents(
  workspaceRoot: string,
  targets: readonly string[],
): Readonly<Record<string, string | null>> | undefined {
  const contents: Record<string, string | null> = {};
  for (const target of targets) {
    const resolved = path.resolve(workspaceRoot, target);
    try {
      if (!fs.existsSync(resolved)) {
        contents[target] = null;
        continue;
      }
      if (!fs.statSync(resolved).isFile()) return undefined;
      contents[target] = fs.readFileSync(resolved, "utf8");
    } catch {
      return undefined;
    }
  }
  return contents;
}
