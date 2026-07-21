#!/usr/bin/env bun
/**
 * 桌面端 Agent 宿主进程（由 Electron 主进程 spawn bun）。
 *
 * 行协议（stdin/stdout，每行一条 JSON）：
 *   → run / abort / approval.respond / ask.respond / memory.* / doctor / checkpoint.* / runs.* / status
 *   ← ready / event / run.done / error / approval.request / ask.request / *.done
 */

import path from "node:path";
import { createInterface } from "node:readline";
import {
  finalizeConversationMemory,
  formatDoctorOutput,
  getConversationMemoryTask,
  listWorkspaceMemories,
  loadAgentRegistry,
  runStubRun,
} from "@paw/agent";
import type { RunEventEnvelope } from "@paw/core";
import {
  FileSystemSessionStore,
  listCheckpoints,
  loadSkillsFromDirectory,
  undoLastCheckpoint,
} from "@paw/core";
import {
  defaultSettingsPath,
  hasApiKey,
  loadPawSettingsLocal,
  resolveBaseUrl,
  resolveModel,
  savePawSettingsLocal,
} from "@paw/settings";
import {
  alwaysAllowKey,
  previewToolArgs,
  summarizeToolArgs,
} from "./tool-preview.ts";

type HistoryTurn = {
  role: "user" | "assistant";
  content: string;
};

type InMsg =
  | {
      type: "run";
      requestId: string;
      goal: string;
      workspaceRoot: string;
      maxSteps?: number;
      conversationId?: string;
      history?: HistoryTurn[];
    }
  | { type: "abort"; requestId: string }
  | {
      type: "approval.respond";
      requestId: string;
      approvalId: string;
      approved: boolean;
      always?: boolean;
    }
  | {
      type: "ask.respond";
      requestId: string;
      askId: string;
      answer: string;
    }
  | {
      type: "memory.finalize";
      requestId: string;
      conversationId: string;
      finalMessage?: string;
      workspaceRoot?: string;
    }
  | {
      type: "memory.list";
      requestId: string;
      workspaceRoot?: string;
      limit?: number;
      memoryType?: string;
    }
  | { type: "doctor"; requestId: string; workspaceRoot?: string }
  | { type: "settings.get"; requestId: string; workspaceRoot?: string }
  | {
      type: "settings.set";
      requestId: string;
      workspaceRoot?: string;
      provider?: string;
      approvalMode?: "ask" | "auto";
    }
  | {
      type: "checkpoint.list";
      requestId: string;
      workspaceRoot?: string;
      runId: string;
    }
  | {
      type: "checkpoint.undo";
      requestId: string;
      workspaceRoot?: string;
      runId: string;
    }
  | { type: "runs.list"; requestId: string; workspaceRoot?: string }
  | {
      type: "runs.load";
      requestId: string;
      workspaceRoot?: string;
      runId: string;
      limit?: number;
    }
  | { type: "status"; requestId: string; workspaceRoot?: string };

type MemoryListRow = {
  id: string;
  title: string;
  summary: string;
  type: string;
  status: string;
  confidence: number;
  subjectKey?: string;
  relatedFiles?: readonly string[];
  updatedAt?: string;
};

type CheckpointRow = {
  seq: number;
  tool: string;
  targets: readonly string[];
  savedAt: number;
};

type RunSummaryRow = {
  runId: string;
  goal: string;
  status: string;
  startedAt: number;
  completedAt?: number;
  eventCount: number;
  toolCallCount: number;
  modelLabel?: string;
  finalMessage?: string;
};

type RunEventRow = {
  seq?: number;
  type: string;
  summary: string;
  tool?: string;
  ok?: boolean;
  text?: string;
};

type OutMsg =
  | { type: "ready" }
  | { type: "event"; requestId: string; event: RunEventEnvelope }
  | {
      type: "run.done";
      requestId: string;
      result: { runId: string; status: string; message: string };
    }
  | { type: "error"; requestId: string; message: string }
  | {
      type: "approval.request";
      requestId: string;
      approvalId: string;
      tool: string;
      summary: string;
      argsPreview: string;
    }
  | {
      type: "ask.request";
      requestId: string;
      askId: string;
      question: string;
      timeoutSec: number | null;
    }
  | {
      type: "memory.finalize.done";
      requestId: string;
      conversationId: string;
      completed: boolean;
      taskId?: string;
    }
  | {
      type: "memory.list.done";
      requestId: string;
      ok: boolean;
      items: MemoryListRow[];
      error?: string;
    }
  | {
      type: "doctor.done";
      requestId: string;
      ok: boolean;
      text: string;
    }
  | {
      type: "settings.done";
      requestId: string;
      ok: boolean;
      provider?: string;
      approvalMode: "ask" | "auto";
      presets: { id: string; model: string; baseUrl?: string }[];
      error?: string;
    }
  | {
      type: "checkpoint.list.done";
      requestId: string;
      ok: boolean;
      runId: string;
      items: CheckpointRow[];
      error?: string;
    }
  | {
      type: "checkpoint.undo.done";
      requestId: string;
      ok: boolean;
      runId: string;
      restored: CheckpointRow | null;
      error?: string;
    }
  | {
      type: "runs.list.done";
      requestId: string;
      ok: boolean;
      items: RunSummaryRow[];
      error?: string;
    }
  | {
      type: "runs.load.done";
      requestId: string;
      ok: boolean;
      runId: string;
      events: RunEventRow[];
      total: number;
      error?: string;
    }
  | {
      type: "status.done";
      requestId: string;
      ok: boolean;
      workspaceRoot: string;
      modelLabel: string;
      skillsCount: number;
      skillsDir: string;
      agentsCount?: number;
      agents?: readonly {
        id: string;
        name: string;
        role: string;
        emoji?: string;
        kind: string;
        /** 花名册详情（Agents tab 展开卡） */
        description?: string;
        childPolicy?: string;
        canSpawn?: boolean;
        model?: string;
        maxSteps?: number;
        tools?: "inherit" | readonly string[];
      }[];
      error?: string;
    };

function emit(msg: OutMsg): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function newId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// 审批 / 提问待决表（渲染进程通过 approval.respond / ask.respond 回答）
// ---------------------------------------------------------------------------

type PendingApproval = {
  readonly resolve: (decision: {
    approved: boolean;
    always?: boolean;
  }) => void;
};
type PendingAsk = { readonly resolve: (answer: string) => void };

const pendingApprovals = new Map<string, PendingApproval>();
const pendingAsks = new Map<string, PendingAsk>();
/** 会话级「始终允许」：conversationId（无则退化 requestId）→ 放行键集合 */
const alwaysAllowByConversation = new Map<string, Set<string>>();

function pendKey(requestId: string, id: string): string {
  return `${requestId}:${id}`;
}

/** 中止 / run 结束时兜底：拒绝未决审批、空答未决提问，避免 Promise 悬挂 */
function settlePendingForRequest(requestId: string): void {
  const prefix = `${requestId}:`;
  for (const [k, p] of pendingApprovals) {
    if (k.startsWith(prefix)) {
      pendingApprovals.delete(k);
      p.resolve({ approved: false });
    }
  }
  for (const [k, p] of pendingAsks) {
    if (k.startsWith(prefix)) {
      pendingAsks.delete(k);
      p.resolve("（用户已中止，未作答）");
    }
  }
}

function resolveRoot(raw?: string): string {
  if (typeof raw === "string" && raw.trim()) return path.resolve(raw.trim());
  return process.cwd();
}

function skillsDirFor(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".paw", "skills");
}

/**
 * 与 createDefaultLanguageModel 一致：优先 settings.provider，
 * 不要用「有哪个 key 就显示谁」——会在 multi-key 时标错（例如 provider=deepseek 却显示 qwen）。
 */
function resolveModelLabel(workspaceRoot: string): string {
  try {
    const p = defaultSettingsPath(workspaceRoot);
    const s = loadPawSettingsLocal(p);
    const provider = s.provider?.trim().toLowerCase();
    const modelTop = s.model?.trim();

    if (provider === "ollama") {
      const ollamaModel =
        (s.ollama_model as string | undefined)?.trim() || modelTop || "llama3";
      return `ollama:${ollamaModel}`;
    }

    // 命名预设别名：provider 指向 models 里的自定义条目名（非内置 provider）
    const builtin =
      provider === "deepseek" ||
      provider === "qwen" ||
      provider === "anthropic" ||
      provider === "openai";
    if (provider && !builtin && s.models) {
      const entry =
        s.models[provider] ??
        Object.entries(s.models).find(
          ([k]) => k.toLowerCase() === provider,
        )?.[1];
      const m = entry?.model?.trim();
      if (m) return `${provider}:${m}`;
    }

    // 显式 provider 优先
    if (provider === "deepseek") {
      return `deepseek:${resolveModel(s, "deepseek", "deepseek-chat")}`;
    }
    if (provider === "qwen") {
      return `qwen:${resolveModel(s, "qwen", "qwen-plus")}`;
    }
    if (provider === "anthropic") {
      return `anthropic:${resolveModel(s, "anthropic", "claude-3-5-sonnet")}`;
    }
    if (provider === "openai") {
      const base = resolveBaseUrl(s, "openai");
      const modelName = resolveModel(s, "openai", "gpt-4o-mini");
      if (base?.includes("deepseek")) return `deepseek:${modelName}`;
      return `openai:${modelName}`;
    }

    // 无 provider：按 key 探测（顺序与「常用云」无关，只是回退）
    if (hasApiKey(s, "deepseek")) {
      return `deepseek:${resolveModel(s, "deepseek", "deepseek-chat")}`;
    }
    if (hasApiKey(s, "anthropic")) {
      return `anthropic:${resolveModel(s, "anthropic", "claude-3-5-sonnet")}`;
    }
    if (hasApiKey(s, "openai")) {
      const base = resolveBaseUrl(s, "openai");
      const modelName = resolveModel(s, "openai", "gpt-4o-mini");
      if (base?.includes("deepseek")) return `deepseek:${modelName}`;
      return `openai:${modelName}`;
    }
    if (hasApiKey(s, "qwen")) {
      return `qwen:${resolveModel(s, "qwen", "qwen-plus")}`;
    }
    return "fake (no API keys)";
  } catch {
    return "unknown (settings)";
  }
}

function countSkills(workspaceRoot: string): number {
  try {
    return loadSkillsFromDirectory(skillsDirFor(workspaceRoot)).length;
  } catch {
    return 0;
  }
}

/** 读取审批模式：默认 ask（逐条审批）；auto = 全自动（向后兼容旧行为） */
function approvalModeFor(workspaceRoot: string): "ask" | "auto" {
  try {
    const s = loadPawSettingsLocal(defaultSettingsPath(workspaceRoot)) as {
      tool_approval_mode?: string;
    };
    return s.tool_approval_mode === "auto" ? "auto" : "ask";
  } catch {
    return "ask";
  }
}

function emitSettingsState(requestId: string, workspaceRoot: string): void {
  try {
    const s = loadPawSettingsLocal(defaultSettingsPath(workspaceRoot));
    const presets = Object.entries(s.models ?? {}).map(([id, m]) => ({
      id,
      model: m.model,
      ...(m.baseUrl ? { baseUrl: m.baseUrl } : {}),
    }));
    emit({
      type: "settings.done",
      requestId,
      ok: true,
      ...(s.provider ? { provider: s.provider } : {}),
      approvalMode: approvalModeFor(workspaceRoot),
      presets,
    });
  } catch (e) {
    emit({
      type: "settings.done",
      requestId,
      ok: false,
      approvalMode: "ask",
      presets: [],
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

function handleSettingsGet(
  msg: Extract<InMsg, { type: "settings.get" }>,
): void {
  emitSettingsState(msg.requestId, resolveRoot(msg.workspaceRoot));
}

function handleSettingsSet(
  msg: Extract<InMsg, { type: "settings.set" }>,
): void {
  const workspaceRoot = resolveRoot(msg.workspaceRoot);
  const filePath = defaultSettingsPath(workspaceRoot);
  try {
    const s = loadPawSettingsLocal(filePath) as Record<string, unknown>;
    if (typeof msg.provider === "string" && msg.provider.trim()) {
      s.provider = msg.provider.trim();
    }
    if (msg.approvalMode === "ask" || msg.approvalMode === "auto") {
      s.tool_approval_mode = msg.approvalMode;
    }
    savePawSettingsLocal(
      filePath,
      s as Parameters<typeof savePawSettingsLocal>[1],
    );
  } catch (e) {
    emit({
      type: "settings.done",
      requestId: msg.requestId,
      ok: false,
      approvalMode: "ask",
      presets: [],
      error: e instanceof Error ? e.message : String(e),
    });
    return;
  }
  emitSettingsState(msg.requestId, workspaceRoot);
}

function normalizeHistory(raw: unknown): HistoryTurn[] {
  if (!Array.isArray(raw)) return [];
  const out: HistoryTurn[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const role =
      o.role === "assistant" ? "assistant" : o.role === "user" ? "user" : null;
    const content = typeof o.content === "string" ? o.content.trim() : "";
    if (!role || !content) continue;
    out.push({ role, content });
  }
  return out;
}

function summarizeEvent(envelope: RunEventEnvelope): RunEventRow {
  const ev = envelope.event as Record<string, unknown>;
  const type = typeof ev.type === "string" ? ev.type : "unknown";
  const tool = typeof ev.tool === "string" ? ev.tool : undefined;
  const ok = typeof ev.ok === "boolean" ? ev.ok : undefined;
  const text =
    typeof ev.text === "string"
      ? ev.text.slice(0, 200)
      : typeof ev.message === "string"
        ? ev.message.slice(0, 200)
        : typeof ev.summary === "string"
          ? ev.summary.slice(0, 200)
          : undefined;
  let summary = type;
  if (tool) summary = `${type} · ${tool}`;
  if (text) summary = `${summary}: ${text.replace(/\s+/g, " ").slice(0, 120)}`;
  if (ok === false) summary = `${summary} (fail)`;
  return {
    ...(typeof envelope.seq === "number" ? { seq: envelope.seq } : {}),
    type,
    summary,
    ...(tool ? { tool } : {}),
    ...(ok !== undefined ? { ok } : {}),
    ...(text ? { text } : {}),
  };
}

const controllers = new Map<string, AbortController>();

async function handleRun(msg: Extract<InMsg, { type: "run" }>): Promise<void> {
  const existing = controllers.get(msg.requestId);
  if (existing) existing.abort();
  const ac = new AbortController();
  controllers.set(msg.requestId, ac);

  const goal = msg.goal.trim();
  if (!goal) {
    emit({ type: "error", requestId: msg.requestId, message: "任务目标为空" });
    controllers.delete(msg.requestId);
    return;
  }

  const workspaceRoot = resolveRoot(msg.workspaceRoot);
  const history = normalizeHistory(msg.history);
  const conversationId =
    typeof msg.conversationId === "string" && msg.conversationId.trim()
      ? msg.conversationId.trim()
      : undefined;

  const resumeMemoryTaskId = conversationId
    ? getConversationMemoryTask(conversationId)
    : undefined;
  const deferMemoryComplete = Boolean(conversationId);
  const skillsDir = skillsDirFor(workspaceRoot);

  try {
    const r = await runStubRun(goal, {
      workspaceRoot,
      maxSteps: msg.maxSteps,
      resumeSession: false,
      conversationHistory: history.length > 0 ? history : undefined,
      conversationId,
      resumeMemoryTaskId,
      deferMemoryComplete,
      abortSignal: ac.signal,
      skillsDir,
      // 审批模式：auto = 全自动（与旧行为一致）；ask = 走审批卡询问
      resolveToolApproval:
        approvalModeFor(workspaceRoot) === "auto"
          ? async () => true
          : (input) => {
              const key = alwaysAllowKey(input.tool, input.args);
              const convKey = conversationId ?? msg.requestId;
              if (alwaysAllowByConversation.get(convKey)?.has(key)) {
                return Promise.resolve(true);
              }
              const approvalId = newId("ap");
              emit({
                type: "approval.request",
                requestId: msg.requestId,
                approvalId,
                tool: input.tool,
                summary: summarizeToolArgs(input.tool, input.args),
                argsPreview: previewToolArgs(input.args),
              });
              return new Promise<boolean>((resolve) => {
                pendingApprovals.set(pendKey(msg.requestId, approvalId), {
                  resolve: (d) => {
                    if (d.approved && d.always) {
                      let set = alwaysAllowByConversation.get(convKey);
                      if (!set) {
                        set = new Set();
                        alwaysAllowByConversation.set(convKey, set);
                      }
                      set.add(key);
                    }
                    resolve(d.approved);
                  },
                });
              });
            },
      resolveAskUser: (input) => {
        const askId = newId("ask");
        emit({
          type: "ask.request",
          requestId: msg.requestId,
          askId,
          question: input.question,
          timeoutSec: input.timeoutSec,
        });
        return new Promise<string>((resolve) => {
          pendingAsks.set(pendKey(msg.requestId, askId), { resolve });
        });
      },
      onEvent: (envelope: RunEventEnvelope) => {
        emit({ type: "event", requestId: msg.requestId, event: envelope });
      },
    });

    let parsed: { runId?: string; status?: string; message?: string } = {};
    try {
      parsed = JSON.parse(r.text) as typeof parsed;
    } catch {
      parsed = { message: r.text };
    }

    emit({
      type: "run.done",
      requestId: msg.requestId,
      result: {
        runId: parsed.runId ?? `desktop-${msg.requestId}`,
        status: parsed.status ?? (r.ok ? "completed" : "failed"),
        message: parsed.message ?? r.text,
      },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    emit({ type: "error", requestId: msg.requestId, message });
  } finally {
    settlePendingForRequest(msg.requestId);
    controllers.delete(msg.requestId);
  }
}

async function handleMemoryFinalize(
  msg: Extract<InMsg, { type: "memory.finalize" }>,
): Promise<void> {
  const conversationId = msg.conversationId?.trim();
  if (!conversationId) {
    emit({
      type: "error",
      requestId: msg.requestId,
      message: "memory.finalize 缺少 conversationId",
    });
    return;
  }
  const workspaceRoot = resolveRoot(msg.workspaceRoot);
  try {
    const r = await finalizeConversationMemory({
      conversationId,
      workspaceRoot,
      finalMessage: msg.finalMessage,
    });
    emit({
      type: "memory.finalize.done",
      requestId: msg.requestId,
      conversationId,
      completed: r.completed,
      taskId: r.taskId,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    emit({ type: "error", requestId: msg.requestId, message });
    emit({
      type: "memory.finalize.done",
      requestId: msg.requestId,
      conversationId,
      completed: false,
    });
  }
}

async function handleMemoryList(
  msg: Extract<InMsg, { type: "memory.list" }>,
): Promise<void> {
  const workspaceRoot = resolveRoot(msg.workspaceRoot);
  const limit =
    typeof msg.limit === "number" && msg.limit > 0
      ? Math.min(msg.limit, 100)
      : 40;
  try {
    const r = await listWorkspaceMemories({
      workspaceRoot,
      limit,
      ...(typeof msg.memoryType === "string" && msg.memoryType.trim()
        ? { type: msg.memoryType.trim() }
        : {}),
    });
    emit({
      type: "memory.list.done",
      requestId: msg.requestId,
      ok: r.ok,
      items: r.items.map((it) => ({
        id: it.id,
        title: it.title,
        summary: it.summary,
        type: it.type,
        status: it.status,
        confidence: it.confidence,
        ...(it.subjectKey ? { subjectKey: it.subjectKey } : {}),
        ...(it.relatedFiles ? { relatedFiles: it.relatedFiles } : {}),
        ...(it.updatedAt ? { updatedAt: it.updatedAt } : {}),
      })),
      ...(r.error ? { error: r.error } : {}),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    emit({
      type: "memory.list.done",
      requestId: msg.requestId,
      ok: false,
      items: [],
      error: message,
    });
  }
}

async function handleDoctor(
  msg: Extract<InMsg, { type: "doctor" }>,
): Promise<void> {
  const workspaceRoot = resolveRoot(msg.workspaceRoot);
  try {
    const r = await formatDoctorOutput(workspaceRoot);
    emit({
      type: "doctor.done",
      requestId: msg.requestId,
      ok: r.ok,
      text: r.text,
    });
  } catch (e) {
    emit({
      type: "doctor.done",
      requestId: msg.requestId,
      ok: false,
      text: e instanceof Error ? e.message : String(e),
    });
  }
}

function handleCheckpointList(
  msg: Extract<InMsg, { type: "checkpoint.list" }>,
): void {
  const workspaceRoot = resolveRoot(msg.workspaceRoot);
  const runId = msg.runId?.trim();
  if (!runId) {
    emit({
      type: "checkpoint.list.done",
      requestId: msg.requestId,
      ok: false,
      runId: "",
      items: [],
      error: "缺少 runId",
    });
    return;
  }
  try {
    const items = listCheckpoints(workspaceRoot, runId).map((c) => ({
      seq: c.seq,
      tool: c.tool,
      targets: c.targets,
      savedAt: c.savedAt,
    }));
    emit({
      type: "checkpoint.list.done",
      requestId: msg.requestId,
      ok: true,
      runId,
      items,
    });
  } catch (e) {
    emit({
      type: "checkpoint.list.done",
      requestId: msg.requestId,
      ok: false,
      runId,
      items: [],
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

function handleCheckpointUndo(
  msg: Extract<InMsg, { type: "checkpoint.undo" }>,
): void {
  const workspaceRoot = resolveRoot(msg.workspaceRoot);
  const runId = msg.runId?.trim();
  if (!runId) {
    emit({
      type: "checkpoint.undo.done",
      requestId: msg.requestId,
      ok: false,
      runId: "",
      restored: null,
      error: "缺少 runId",
    });
    return;
  }
  try {
    const meta = undoLastCheckpoint(workspaceRoot, runId);
    emit({
      type: "checkpoint.undo.done",
      requestId: msg.requestId,
      ok: Boolean(meta),
      runId,
      restored: meta
        ? {
            seq: meta.seq,
            tool: meta.tool,
            targets: meta.targets,
            savedAt: meta.savedAt,
          }
        : null,
      ...(meta ? {} : { error: "没有可撤销的检查点" }),
    });
  } catch (e) {
    emit({
      type: "checkpoint.undo.done",
      requestId: msg.requestId,
      ok: false,
      runId,
      restored: null,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

function handleRunsList(msg: Extract<InMsg, { type: "runs.list" }>): void {
  const workspaceRoot = resolveRoot(msg.workspaceRoot);
  try {
    const store = new FileSystemSessionStore({ workspaceRoot });
    const items = store
      .listRuns()
      .slice(0, 40)
      .map((r) => ({
        runId: r.runId,
        goal: r.goal,
        status: r.status,
        startedAt: r.startedAt,
        ...(r.completedAt !== undefined ? { completedAt: r.completedAt } : {}),
        eventCount: r.eventCount,
        toolCallCount: r.toolCallCount,
        ...(r.modelLabel ? { modelLabel: r.modelLabel } : {}),
        ...(r.finalMessage ? { finalMessage: r.finalMessage } : {}),
      }));
    emit({
      type: "runs.list.done",
      requestId: msg.requestId,
      ok: true,
      items,
    });
  } catch (e) {
    emit({
      type: "runs.list.done",
      requestId: msg.requestId,
      ok: false,
      items: [],
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

function handleRunsLoad(msg: Extract<InMsg, { type: "runs.load" }>): void {
  const workspaceRoot = resolveRoot(msg.workspaceRoot);
  const runId = msg.runId?.trim();
  if (!runId) {
    emit({
      type: "runs.load.done",
      requestId: msg.requestId,
      ok: false,
      runId: "",
      events: [],
      total: 0,
      error: "缺少 runId",
    });
    return;
  }
  try {
    const store = new FileSystemSessionStore({ workspaceRoot });
    const all = store.loadRun(runId);
    if (!all) {
      emit({
        type: "runs.load.done",
        requestId: msg.requestId,
        ok: false,
        runId,
        events: [],
        total: 0,
        error: "run 不存在或为空",
      });
      return;
    }
    const limit =
      typeof msg.limit === "number" && msg.limit > 0
        ? Math.min(msg.limit, 500)
        : 200;
    const sliced = all.slice(0, limit);
    emit({
      type: "runs.load.done",
      requestId: msg.requestId,
      ok: true,
      runId,
      events: sliced.map(summarizeEvent),
      total: all.length,
    });
  } catch (e) {
    emit({
      type: "runs.load.done",
      requestId: msg.requestId,
      ok: false,
      runId,
      events: [],
      total: 0,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

function handleStatus(msg: Extract<InMsg, { type: "status" }>): void {
  const workspaceRoot = resolveRoot(msg.workspaceRoot);
  try {
    const skillsDir = skillsDirFor(workspaceRoot);
    let agentsCount = 0;
    let agents: {
      id: string;
      name: string;
      role: string;
      emoji?: string;
      kind: string;
      description?: string;
      childPolicy?: string;
      canSpawn?: boolean;
      model?: string;
      maxSteps?: number;
      tools?: "inherit" | readonly string[];
    }[] = [];
    try {
      const reg = loadAgentRegistry(workspaceRoot);
      agents = reg.list().map((s) => ({
        id: s.id,
        name: s.name,
        role: s.role,
        ...(s.emoji ? { emoji: s.emoji } : {}),
        kind: s.kind,
        ...(s.description ? { description: s.description } : {}),
        childPolicy: s.childPolicy,
        canSpawn: s.canSpawn,
        model: s.model,
        maxSteps: s.maxSteps,
        tools: s.tools === "inherit" ? "inherit" : [...s.tools],
      }));
      agentsCount = agents.length;
    } catch {
      /* optional */
    }
    emit({
      type: "status.done",
      requestId: msg.requestId,
      ok: true,
      workspaceRoot,
      modelLabel: resolveModelLabel(workspaceRoot),
      skillsCount: countSkills(workspaceRoot),
      skillsDir,
      agentsCount,
      agents,
    });
  } catch (e) {
    emit({
      type: "status.done",
      requestId: msg.requestId,
      ok: false,
      workspaceRoot,
      modelLabel: "unknown",
      skillsCount: 0,
      skillsDir: skillsDirFor(workspaceRoot),
      agentsCount: 0,
      agents: [],
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

function handleLine(line: string): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg: InMsg;
  try {
    msg = JSON.parse(trimmed) as InMsg;
  } catch {
    emit({
      type: "error",
      requestId: "?",
      message: `无效 JSON: ${trimmed.slice(0, 120)}`,
    });
    return;
  }

  switch (msg.type) {
    case "abort":
      controllers.get(msg.requestId)?.abort();
      settlePendingForRequest(msg.requestId);
      return;
    case "approval.respond": {
      const key = pendKey(msg.requestId, msg.approvalId);
      const p = pendingApprovals.get(key);
      if (p) {
        pendingApprovals.delete(key);
        p.resolve({
          approved: msg.approved === true,
          always: msg.always === true,
        });
      }
      return;
    }
    case "ask.respond": {
      const key = pendKey(msg.requestId, msg.askId);
      const p = pendingAsks.get(key);
      if (p) {
        pendingAsks.delete(key);
        const answer =
          typeof msg.answer === "string" && msg.answer.trim()
            ? msg.answer
            : "（用户未作答）";
        p.resolve(answer);
      }
      return;
    }
    case "run":
      void handleRun(msg);
      return;
    case "memory.finalize":
      void handleMemoryFinalize(msg);
      return;
    case "memory.list":
      void handleMemoryList(msg);
      return;
    case "doctor":
      void handleDoctor(msg);
      return;
    case "checkpoint.list":
      handleCheckpointList(msg);
      return;
    case "checkpoint.undo":
      handleCheckpointUndo(msg);
      return;
    case "runs.list":
      handleRunsList(msg);
      return;
    case "runs.load":
      handleRunsLoad(msg);
      return;
    case "settings.get":
      handleSettingsGet(msg);
      return;
    case "settings.set":
      handleSettingsSet(msg);
      return;
    case "status":
      handleStatus(msg);
      return;
    default:
      emit({
        type: "error",
        requestId: "?",
        message: `未知消息类型: ${(msg as { type?: string }).type}`,
      });
  }
}

const rl = createInterface({
  input: process.stdin,
  crlfDelay: Number.POSITIVE_INFINITY,
});
rl.on("line", handleLine);
rl.on("close", () => {
  for (const c of controllers.values()) c.abort();
  process.exit(0);
});

emit({ type: "ready" });
