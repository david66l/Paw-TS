/**
 * MemoryRuntime v2 实现 — spec v2 长记忆管线接入 Agent 主循环的适配层。
 *
 * 与 v1（memory-runtime.ts）保持同一 MemoryRuntime 接口，内部换成 v2 组件：
 * - PostgresMemoryStoreEngine（V026+ 条目模型：semantic/episodic + 双时戳 + 效用账本）
 * - MemoryWritePipeline（五道关异步写入：outbox → 密钥拦截 → 验证门控 → 蒸馏 → Governor）
 * - TriggeredRetriever（T1 task_start / T2 action_failed / T3 post_compact 触发式检索）
 *
 * 与 v1 的关键差异（对应 spec v2 设计）：
 * - 写入全异步：completeTask 只入队（outbox），返回"已入队"语义
 * - 验证门控：无测试/编译/用户验收信号 → session_finalize 兜底蒸馏（conf ≤0.6），
 *   有测试结果 → test verdict（全过=固化 / 有失败=试用通道）
 * - 任务失败 → task_failed 试用通道（不直接入库）
 * - 检索为事件触发：task_start（每轮构建）、action_failed（工具失败）、post_compact（压缩后）
 * - 用户显式 save → 直写（user_statement，conf=1.0，免门控——用户即真相）
 *
 * 进程级单例（engine/pipeline/retriever 一次构造，多 run 共享）；
 * LLM 可注入（distill/rerank=agent 模型，govern=settings 强模型），缺失时优雅降级：
 * 无蒸馏 → append-only 原文摘要（degraded）；无裁决 → 直 ADD；无精排 → 召回直取（k 减半）。
 */

import type { RunEvent } from "@paw/core";
import { ping as dbPing } from "../db/connection.js";
import { generateId } from "../db/modules/platform/idGen.js";
import { loadMemoryConfigSync } from "../longterm/config.js";
import { ChatClient, resolveLlmConfig } from "../longterm/eval/llm-client.js";
import {
  MemoryDistiller,
  type MemoryWriteEvent,
  MemoryWritePipeline,
  PostgresMemoryStoreEngine,
  TriggeredRetriever,
  appendOpLog,
} from "../longterm/index.js";
import type { MemoryEntry, SemanticFact } from "../longterm/store/engine.js";
import { deriveEntryId } from "../longterm/store/id.js";
import { classifyMemoryCompletion } from "./outcome-contract.js";
import { type ResolvedScope, resolveScope } from "./scope.js";
import type {
  BeginTaskInput,
  BeginTaskResult,
  BuildContextInput,
  BuildContextResult,
  CompleteTaskInput,
  CompleteTaskResult,
  MemoryListItem,
  MemoryRuntime,
  MemoryRuntimeOptions,
  OnToolResultInput,
  PatchWorkingMemoryInput,
  SaveMemoryInput,
  SaveMemoryResult,
} from "./types.js";

// ── 进程级共享核心（engine / pipeline / retriever 一次构造）──

interface V2Core {
  engine: PostgresMemoryStoreEngine;
  pipeline: MemoryWritePipeline;
  retriever: TriggeredRetriever;
}

let sharedCore: V2Core | null = null;
/** 活动 runtime 实例数：最后一个 shutdown 时停 worker（否则单次 CLI 调用永不退出） */
let coreRefs = 0;

/** 从 settings.local.json / env 解析"强模型"（Governor 用，spec A10）；不可用返回 undefined */
function resolveGovernModel(
  workspaceRoot: string,
): ((prompt: string) => Promise<string>) | undefined {
  try {
    const cfg = resolveLlmConfig({ cwd: workspaceRoot });
    if ("error" in cfg) return undefined;
    const client = new ChatClient(cfg);
    return (prompt: string) => client.complete(prompt);
  } catch {
    return undefined;
  }
}

function buildCore(opts: {
  scope: ResolvedScope;
  llm?: MemoryRuntimeOptions["llm"];
  dailyBudget?: number;
  emit?: (event: RunEvent) => void;
}): V2Core {
  const engine = new PostgresMemoryStoreEngine();
  const { llm, emit } = opts;
  // llm === null（off 模式）：禁用全部 LLM（含 settings 解析）
  const governLlm: ((prompt: string) => Promise<string>) | undefined =
    llm == null
      ? undefined
      : (llm.govern ?? resolveGovernModel(opts.scope.workspaceRoot));

  const pipeline = new MemoryWritePipeline({
    distiller: llm?.distill
      ? new MemoryDistiller({ complete: llm.distill })
      : undefined,
    ...(governLlm ? { governorLlm: { complete: governLlm } } : {}),
    ...(llm?.confirm ? { correctionConfirmer: { confirm: llm.confirm } } : {}),
    dailyBudget: opts.dailyBudget ?? 50,
    emit,
    // readonly 回调是同步签名；config 文件读取用同步版（文件极小、变化低频）
    readonly: () => loadMemoryConfigSync(opts.scope.workspaceRoot).readonly,
  });
  pipeline.start();

  const retriever = new TriggeredRetriever({
    engine,
    reranker: llm?.rerank ? { complete: llm.rerank } : undefined,
    queryRewriter: llm?.rerank ? { complete: llm.rerank } : undefined, // T1 query 改写复用同一快模型
    emit,
  });

  return { engine, pipeline, retriever };
}

/** 测试/进程收尾用：停掉共享 worker 并清空单例 */
export function resetMemoryV2Core(): void {
  if (sharedCore) {
    sharedCore.pipeline.stop();
    sharedCore = null;
  }
  coreRefs = 0;
}

/** 测试用：当前进程共享 core（pipeline.processNext 可确定性排空 outbox，免等 worker 间隔） */
export function getMemoryV2CoreForTests(): V2Core | null {
  return sharedCore;
}

function getSharedCore(opts: {
  scope: ResolvedScope;
  llm?: MemoryRuntimeOptions["llm"];
  dailyBudget?: number;
  emit?: (event: RunEvent) => void;
}): V2Core {
  if (!sharedCore) {
    sharedCore = buildCore(opts);
    coreRefs = 0;
  }
  coreRefs += 1;
  // 幂等：worker 被上次 shutdown 停掉后，新实例恢复（start 有 timer 守卫）
  sharedCore.pipeline.start();
  return sharedCore;
}

// ── 任务轨迹（进程内，写入事件证据）──

interface TaskTrace {
  goal: string;
  branch?: string;
  repo: string;
  tools: {
    toolName: string;
    summary: string;
    ok: boolean;
    exitCode?: number;
  }[];
  /** 测试结果跟踪：供 completeTask 的 verdict 门控 */
  tests: { ran: boolean; lastPassed?: boolean };
  startedAt: string;
}

const TEST_TOOL_RE = /test|vitest|jest|pytest|bun test/i;
const MAX_TRACE_TOOLS = 60;

function summarizeArgs(args: unknown): string {
  if (args === undefined) return "";
  try {
    return JSON.stringify(args).slice(0, 100);
  } catch {
    return String(args).slice(0, 100);
  }
}

function commandFromArgs(args: unknown): string {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return "";
  }
  const command = (args as Record<string, unknown>).command;
  return typeof command === "string" ? command.slice(0, 1000) : "";
}

/** 轨迹摘要（蒸馏输入，≤4000 字符）：工具调用行 + 最终消息 */
function buildTrajectoryDigest(
  trace: TaskTrace,
  finalMessage?: string,
): string {
  const lines = trace.tools.map(
    (t) =>
      `- ${t.toolName}: ${(t.summary || (t.ok ? "ok" : "failed")).slice(0, 120)}${t.exitCode != null ? ` (exit ${t.exitCode})` : ""}`,
  );
  const digest = lines.join("\n");
  const finalMsg = finalMessage?.trim()
    ? `\nFinal message: ${finalMessage.trim().slice(0, 300)}`
    : "";
  return `${digest}${finalMsg}`.slice(0, 4000);
}

// ── 条目展示辅助（v2 条目无 title/summary 列语义，从 kind 特有字段派生）──

function entryTitle(entry: MemoryEntry): string {
  switch (entry.kind) {
    case "semantic":
      return entry.fact.slice(0, 200);
    case "episodic":
      return entry.whenToUse || entry.perspective || "(episodic)";
    case "profile":
      return entry.insight.slice(0, 200);
    case "vault_ref":
      return entry.refDescription.slice(0, 200);
    default:
      return String((entry as { fact?: string }).fact ?? "").slice(0, 200);
  }
}

function entrySummary(entry: MemoryEntry): string {
  switch (entry.kind) {
    case "semantic":
      return entry.fact;
    case "episodic":
      return [entry.whenToUse, entry.perspective, ...(entry.modification ?? [])]
        .filter(Boolean)
        .join("\n");
    case "profile":
      return entry.insight;
    case "vault_ref":
      return entry.refDescription;
    default:
      return String((entry as { fact?: string }).fact ?? "");
  }
}

function toListItem(entry: MemoryEntry): MemoryListItem {
  return {
    id: entry.id,
    title: entryTitle(entry),
    summary: entrySummary(entry).slice(0, 500),
    type: entry.kind,
    status: entry.tInvalid != null ? "invalidated" : "active",
    confidence: entry.confidence,
    subjectKey: entry.id,
    updatedAt: entry.created,
  };
}

/** 用户显式保存的 keywords：title/summary 词面切词（BM25 检索键，≤6 个） */
function extractKeywords(...texts: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const text of texts) {
    for (const tok of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
      if (tok.length < 3 || seen.has(tok)) continue;
      seen.add(tok);
      out.push(tok);
      if (out.length >= 6) return out;
    }
  }
  return out;
}

// ── 主类 ──

export class MemoryRuntimeV2 implements MemoryRuntime {
  readonly scope: ResolvedScope;
  private readonly core: V2Core;

  /** runId → taskId（同进程多 run；desktop 多轮 resume 语义） */
  private readonly runTaskMap = new Map<string, string>();
  /** taskId → 轨迹（一次任务的生命周期证据） */
  private readonly traces = new Map<string, TaskTrace>();

  constructor(opts: MemoryRuntimeOptions) {
    this.scope = resolveScope(opts);
    this.core = getSharedCore({
      scope: this.scope,
      llm: opts.llm,
      dailyBudget: opts.dailyBudget,
      emit: opts.emit,
    });
  }

  async ping(): Promise<boolean> {
    return dbPing();
  }

  async beginTask(input: BeginTaskInput): Promise<BeginTaskResult> {
    const taskId = input.resumeTaskId ?? `v2-${generateId("tsk")}`;
    if (input.resumeTaskId) {
      // 恢复：goal 刷新（desktop 多轮）
      const existing = this.traces.get(taskId);
      if (existing && input.goal) existing.goal = input.goal;
    } else {
      this.traces.set(taskId, {
        goal: input.goal,
        branch: input.branch,
        repo: this.scope.repositoryId,
        tools: [],
        tests: { ran: false },
        startedAt: new Date().toISOString(),
      });
    }
    this.runTaskMap.set(input.runId, taskId);
    return { taskId, resumed: input.resumeTaskId != null };
  }

  async buildContextSection(
    input: BuildContextInput,
  ): Promise<BuildContextResult> {
    const trace = this.traces.get(input.taskId);
    try {
      const pkg = await this.core.retriever.retrieve({
        type: "task_start",
        taskDescription: input.query || input.currentUserRequest,
        branch: trace?.branch,
        repo: this.scope.repositoryId,
        runId: input.taskId,
      });
      const items = pkg.items.map((i) => ({
        id: i.id,
        title: i.text.slice(0, 120),
        score: i.score,
        type: i.kind,
        summary: i.text.slice(0, 400),
        relatedFiles: [] as readonly string[],
      }));
      return {
        promptSection: pkg.render(),
        items,
        degraded: pkg.degraded,
        tokens: pkg.totalTokens,
        warnings: pkg.degraded ? ["memory retrieval degraded"] : [],
      };
    } catch {
      // 检索失败 → 空段（degraded），不阻断主流程
      return {
        promptSection: "",
        items: [],
        degraded: true,
        tokens: 0,
        warnings: ["memory retrieval failed"],
      };
    }
  }

  async onToolResult(
    input: OnToolResultInput,
  ): Promise<{ injected?: string } | undefined> {
    const trace = this.traces.get(input.taskId);
    if (trace) {
      trace.tools.push({
        toolName: input.toolName,
        summary: (input.summary ?? "").slice(0, 200),
        ok: input.ok,
        exitCode: input.exitCode,
      });
      if (trace.tools.length > MAX_TRACE_TOOLS)
        trace.tools.splice(0, trace.tools.length - MAX_TRACE_TOOLS);
      const testSignal = `${input.toolName} ${input.summary} ${commandFromArgs(input.args)} ${summarizeArgs(input.args)}`;
      if (TEST_TOOL_RE.test(testSignal)) {
        trace.tests.ran = true;
        // Legacy callers lack the authoritative outcome contract. Keep only
        // the latest result so a repaired failure can be superseded by green.
        trace.tests.lastPassed = input.ok;
      }
    }

    // T2 action_failed：失败且可行动 → 触发检索，注入 [Memory hint]
    if (!input.ok) {
      try {
        const rawOutput =
          typeof input.rawPayload === "string"
            ? input.rawPayload
            : input.rawPayload !== undefined
              ? JSON.stringify(input.rawPayload).slice(0, 400)
              : input.summary;
        const pkg = await this.core.retriever.retrieve({
          type: "action_failed",
          errorOutput: (rawOutput ?? "").slice(0, 400),
          lastActionSummary:
            `${input.toolName} ${summarizeArgs(input.args)}${input.exitCode != null ? ` (exit ${input.exitCode})` : ""}`.slice(
              0,
              100,
            ),
          repo: this.scope.repositoryId,
          runId: input.taskId,
        });
        if (pkg.totalTokens > 0) return { injected: pkg.render() };
      } catch {
        /* T2 best-effort：检索失败不阻断工具结果处理 */
      }
    }
    return undefined;
  }

  /** v2 无 WorkingMemory；接口兼容 no-op（plan/约束跟踪由 orchestrator 自身 context 承担） */
  async patchWorkingMemory(_input: PatchWorkingMemoryInput): Promise<void> {
    /* no-op */
  }

  /** T3 post_compact（spec §6.1）：上下文压缩后触发语义检索，命中返回注入段 */
  async retrievePostCompact(input: {
    taskId: string;
    summaryHead: string;
    goal: string;
    existingContextHints?: readonly string[];
  }): Promise<{ injected?: string } | undefined> {
    try {
      const pkg = await this.core.retriever.retrieve({
        type: "post_compact",
        summaryHead: input.summaryHead,
        goal: input.goal,
        existingContextHints: input.existingContextHints
          ? [...input.existingContextHints]
          : [],
        repo: this.scope.repositoryId,
        runId: input.taskId,
      });
      return pkg.totalTokens > 0 ? { injected: pkg.render() } : undefined;
    } catch {
      /* T3 best-effort */
      return undefined;
    }
  }

  async completeTask(input: CompleteTaskInput): Promise<CompleteTaskResult> {
    const trace = this.traces.get(input.taskId);
    if (!trace) {
      return {
        candidates: 0,
        approved: 0,
        rejected: 0,
        pendingReview: 0,
        writtenMemoryIds: [],
      };
    }

    // cancelled：不产生任何写入事件（与 v1 一致）
    if (input.status === "cancelled") {
      this.traces.delete(input.taskId);
      return {
        candidates: 0,
        approved: 0,
        rejected: 0,
        pendingReview: 0,
        writtenMemoryIds: [],
      };
    }

    const digest = buildTrajectoryDigest(trace, input.finalMessage);
    const disposition = classifyMemoryCompletion(input);
    let event: MemoryWriteEvent;
    if (disposition === "failed") {
      // 失败 → 试用通道（不直接入库，spec §5.3）
      event = {
        type: "task_failed",
        runId: input.taskId,
        trajectoryRef: `runs/${input.taskId}`,
        repo: trace.repo,
        goal: trace.goal,
        trajectory: digest,
      };
    } else if (
      disposition === "verified_success" ||
      (!input.outcome && trace.tests.ran)
    ) {
      // 新路径只接受 CompletionPolicy 的当前版本权威绿测；旧调用方
      // 保留最后一次测试结果兼容语义，不再让早期失败永久污染成功。
      event = {
        type: "task_succeeded",
        runId: input.taskId,
        trajectoryRef: `runs/${input.taskId}`,
        repo: trace.repo,
        goal: trace.goal,
        trajectory: digest,
        verdict: {
          kind: "test",
          passed:
            disposition === "verified_success" ||
            trace.tests.lastPassed === true,
        },
      };
    } else {
      // 务实模式：无测试信号 → session_finalize 兜底蒸馏（conf ≤0.6），不违反"禁止盲改"
      event = {
        type: "session_finalize",
        conversationId: input.taskId,
        runId: input.taskId,
        repo: trace.repo,
        goal: trace.goal,
        trajectory: digest,
      };
    }

    let enqueued = false;
    try {
      await this.core.pipeline.enqueue(event);
      enqueued = true;
    } catch {
      /* best-effort：入队失败（DB down）不影响 run 结束 */
    }
    this.traces.delete(input.taskId);
    return {
      candidates: enqueued ? 1 : 0,
      approved: 0,
      rejected: 0,
      pendingReview: 0,
      writtenMemoryIds: [],
    };
  }

  async listMemories(query?: { limit?: number; type?: string }): Promise<
    MemoryListItem[]
  > {
    try {
      const rows = await this.core.engine.query({
        includeDegraded: true,
        limit: query?.limit ?? 20,
      });
      const items = rows.map(toListItem);
      const type = query?.type;
      if (!type) return items;
      return items.filter((item) => item.type === type);
    } catch {
      return [];
    }
  }

  async readMemory(idOrSubject: string): Promise<MemoryListItem | null> {
    try {
      const byId = await this.core.engine.get(idOrSubject);
      if (byId) return toListItem(byId);
      // id 未命中：按 title 精确匹配兜底（v2 id 为内容哈希，subjectKey 语义即 id）
      const rows = await this.core.engine.query({
        includeDegraded: true,
        limit: 200,
      });
      const hit = rows.find((entry) => entryTitle(entry) === idOrSubject);
      return hit ? toListItem(hit) : null;
    } catch {
      return null;
    }
  }

  /** 用户显式保存 → 直写（user_statement conf=1.0，免门控——用户即真相，同 handleUserCorrection） */
  async saveMemory(input: SaveMemoryInput): Promise<SaveMemoryResult> {
    const now = new Date().toISOString();
    const text = (input.content ?? input.summary).trim();
    const title = input.title.trim();
    if (!text && !title) {
      return {
        candidateId: "",
        decision: "REJECT",
        decisionStatus: "REJECTED",
      };
    }
    const fact = text || title;
    const entry: SemanticFact = {
      id: "",
      kind: "semantic",
      repo: this.scope.repositoryId,
      created: now,
      tValid: now,
      tInvalid: null,
      source: "user_statement",
      confidence: 1.0,
      evidence: input.taskId ? [`runs/${input.taskId}`] : [],
      freq: 0,
      utility: 0,
      fact,
      keywords: extractKeywords(title, fact),
      embeddingKey: `${title} ${fact}`,
    };
    try {
      await this.core.engine.put(entry);
      const id = deriveEntryId(entry);
      await appendOpLog("governed", {
        runId: input.taskId,
        entryIds: [id],
        detail: { op: "ADD", by: "user_explicit_save" },
      });
      return {
        candidateId: id,
        decision: "APPROVE_CREATE",
        decisionStatus: "EXECUTED",
        memoryId: id,
      };
    } catch (e) {
      return {
        candidateId: "",
        decision: "REJECT",
        decisionStatus: "REJECTED",
        memoryId: undefined,
      };
    }
  }

  async shutdown(): Promise<void> {
    // 引用计数：最后一个实例 shutdown 时停 worker（否则单次 CLI 调用永不退出）。
    // orchestrator 的 run 级 runtime 不调 shutdown（多轮会话 worker 需持续运行）。
    coreRefs = Math.max(0, coreRefs - 1);
    if (coreRefs === 0) this.core.pipeline.stop();
  }
}
