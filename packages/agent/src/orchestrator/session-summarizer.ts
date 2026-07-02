/**
 * A.2 会话记忆 ↔ 自动记忆 双向链接。
 * ===================================
 *
 * 两个子功能：
 *
 * A.2.1 — extractSessionHighlightsToAutoMemory()：
 *   从压缩生成的 SessionMemory 中提取关键决策和错误修复，
 *   写入永久 AutoMemory。零额外 LLM 调用（复用压缩 Agent 的输出）。
 *   每条决策/修复用确定性哈希命名，确保相同内容不会重复存储。
 *
 * A.2.3 — maybeGenerateShortSessionMemory()：
 *   为触发了压缩的短小高价值 Run 生成轻量级会话记忆。
 *   适用条件（三个 Gate）：
 *   1. 轮数 ≤ 5（短 Run）
 *   2. Goal 包含 fix/bug/refactor/debug 等高价值关键词
 *   3. 还没有已有的会话记忆
 */

import {
  type AutoMemoryStore,
  EmbeddingCache,
  type SessionMemory,
  SessionMemoryStore,
  extractErrorSignatures,
} from "@paw/core";
import type { LanguageModel } from "@paw/models";
import { computeMemoryEmbedding } from "../settings.js";
import { createHash } from "node:crypto";

import { completeAuxiliaryTask } from "../auxiliary-complete.js";

// ═══ A.2.1：从压缩输出中提取决策和错误 ═══

/**
 * 将压缩生成的 SessionMemory 中的每条关键决策和错误修复
 * 转换为持久的 AutoMemory 条目。
 *
 * 设计亮点：
 * - 零额外 LLM 调用：直接复用压缩 Agent 已经产生的结构化输出
 * - 确定性命名：相同内容的决策/错误 → 相同哈希 → findSimilar 按名去重
 * - Embedding 计算是 best-effort，非阻塞
 */
export async function extractSessionHighlightsToAutoMemory(opts: {
  readonly sessionMemory: SessionMemory;
  readonly autoMemoryStore: AutoMemoryStore;
  readonly workspaceRoot: string;
}): Promise<{ created: number; updated: number }> {
  const { sessionMemory, autoMemoryStore, workspaceRoot } = opts;
  const now = Date.now();
  let created = 0;
  let updated = 0;

  const entries: Array<{
    name: string;
    description: string;
    content: string;
    priority?: "high" | "mid" | "low";
    tags?: readonly string[];
    relatedFiles?: readonly string[];
    error_signatures?: readonly string[];
    tools_used?: readonly string[];
    linked_memories?: readonly string[];
  }> = [];

  // 会话 ID 的前 8 位哈希 → 可追溯的记忆命名前缀
  const sessionPrefix = createHash("sha256")
    .update(sessionMemory.session)
    .digest("hex")
    .slice(0, 8);

  // 每条关键决策 → 一条 auto memory（高优先级）
  for (let i = 0; i < (sessionMemory.keyDecisions ?? []).length; i++) {
    const decision = sessionMemory.keyDecisions![i]!;
    const trimmed = decision.trim();
    if (!trimmed || trimmed.length < 10) continue;
    // 确定性命名：相同文本 → 相同哈希 → upsert 自动去重
    const contentHash = createHash("sha256").update(trimmed).digest("hex").slice(0, 12);
    const name = `sess-${sessionPrefix}-dec-${contentHash}`;
    entries.push({
      name,
      description: `[Session] ${trimmed.slice(0, 120)}`,
      content: `From session: ${sessionMemory.session}\n\nDecision: ${trimmed}\n\nFiles: ${(sessionMemory.filesAndFunctions ?? []).join(", ")}`,
      priority: "high" as const,
      tags: ["session-decision", "architecture"],
      relatedFiles: sessionMemory.filesAndFunctions ?? [],
      tools_used: [],
      linked_memories: [],
    });
  }

  // 每条错误修复 → 一条 auto memory（高优先级，bug 标签）
  for (let i = 0; i < (sessionMemory.errorsAndFixes ?? []).length; i++) {
    const err = sessionMemory.errorsAndFixes![i]!;
    const trimmed = err.trim();
    if (!trimmed || trimmed.length < 10) continue;
    const contentHash = createHash("sha256").update(trimmed).digest("hex").slice(0, 12);
    const name = `sess-${sessionPrefix}-err-${contentHash}`;
    const errorSigs = extractErrorSignatures([trimmed]);
    const relatedFiles = sessionMemory.filesAndFunctions ?? [];
    entries.push({
      name,
      description: `[Session] Fix: ${trimmed.slice(0, 120)}`,
      content: `From session: ${sessionMemory.session}\n\nError & Fix: ${trimmed}\n\nFiles: ${relatedFiles.join(", ")}`,
      priority: "high" as const,
      tags: ["session-error", "bug"],
      relatedFiles,
      error_signatures: errorSigs.length > 0 ? errorSigs : undefined,
      tools_used: [],
      linked_memories: [],
    });
  }

  if (entries.length === 0) return { created: 0, updated: 0 };

  // 写入 AutoMemoryStore
  for (const entry of entries) {
    // 计算 embedding（best-effort）
    const emb = await computeMemoryEmbedding(workspaceRoot, {
      title: entry.name,
      summary: entry.description,
      content: entry.content,
    });
    const embedding = emb ? EmbeddingCache.encodeEmbedding(emb) : undefined;

    const action = autoMemoryStore.upsert({
      name: entry.name,
      description: entry.description,
      type: "project",
      content: entry.content,
      createdAt: now,
      updatedAt: now,
      priority: entry.priority ?? "high",
      tags: entry.tags ?? [],
      relatedFiles: entry.relatedFiles ?? [],
      error_signatures: entry.error_signatures ?? [],
      tools_used: entry.tools_used ?? [],
      linked_memories: entry.linked_memories ?? [],
      ...(embedding ? { embedding } : {}),
    });
    if (action === "created") created++;
    else updated++;
  }

  if (created + updated > 0) {
    autoMemoryStore.buildIndex();
  }

  return { created, updated };
}

// ═══ A.2.3：短 Run 的轻量级会话记忆 ═══

/** 短 Run 的最大轮数阈值 */
const SHORT_RUN_MAX_TURNS = 5;

/** 高价值 Goal 的匹配模式：修复、重构、调试相关 */
const HIGH_VALUE_GOAL_PATTERN =
  /\b(?:fix|bug|refactor|debug)\b|修复|重构|调试|报错|错误/i;

/** 短会话摘要的系统提示词 */
const SHORT_SESSION_SYSTEM = `You summarize coding sessions briefly. Respond with a short markdown document.`;

/** 构建短会话摘要的用户提示词 */
function buildShortSessionUser(
  goal: string,
  finalAnswer: string,
  filePaths: string[],
  errors: string[],
): string {
  const parts = [
    `Summarize this short coding session:`,
    ``,
    `**Goal**: ${goal}`,
  ];
  if (finalAnswer.trim()) {
    parts.push(`**Final answer**: ${finalAnswer.slice(0, 500)}`);
  }
  if (filePaths.length > 0) {
    parts.push(
      `**Files touched**: ${filePaths.slice(0, 10).join(", ")}`,
    );
  }
  if (errors.length > 0) {
    parts.push(`**Errors**: ${errors.slice(0, 3).join("; ")}`);
  }
  parts.push(
    ``,
    `Respond with ONLY:`,
    `## Current State`,
    `<one sentence about what was accomplished>`,
    `## Errors & Fixes`,
    `- <error>: <fix>  (one per line, skip if none)`,
  );
  return parts.join("\n");
}

/** 解析短会话摘要的 LLM 输出为 SessionMemory 结构 */
function parseShortSessionSummary(
  text: string,
  sessionId: string,
  project: string,
  goal: string,
): SessionMemory | null {
  // 最小解析器：提取 ## Current State 和 ## Errors & Fixes 两个段落
  const stateMatch = text.match(/##\s*Current\s*State\s*\n+(.+?)(?:\n##|\n*$)/is);
  const errMatch = text.match(
    /##\s*Errors\s*&\s*Fixes\s*\n+([\s\S]*?)(?:\n##|\n*$)/i,
  );

  const currentState = stateMatch?.[1]?.trim();
  const errorsBlock = errMatch?.[1]?.trim();

  const errorsAndFixes: string[] = [];
  if (errorsBlock && !/skip|none/i.test(errorsBlock)) {
    for (const line of errorsBlock.split("\n")) {
      const cleaned = line.replace(/^[-*]\s*/, "").trim();
      if (cleaned && cleaned.length > 5) errorsAndFixes.push(cleaned);
    }
  }

  if (!currentState && errorsAndFixes.length === 0) return null;

  return {
    session: sessionId,
    project,
    updatedAt: Date.now(),
    task: goal.slice(0, 200),
    currentState: currentState ?? "",
    ...(errorsAndFixes.length > 0 ? { errorsAndFixes } : {}),
  };
}

/**
 * 为未触发自动压缩的短小高价值 Run 生成轻量级会话记忆。
 *
 * 三个 Gate（全部通过才生成）：
 * 1. 轮数 ≤ SHORT_RUN_MAX_TURNS（5）
 * 2. Goal 匹配 HIGH_VALUE_GOAL_PATTERN（fix/bug/refactor/debug）
 * 3. 没有已有的会话记忆
 *
 * 返回 null 表示不满足条件或生成失败。
 */
export async function maybeGenerateShortSessionMemory(opts: {
  readonly runId: string;
  readonly goal: string;
  readonly turn: number;
  readonly finalText: string;
  readonly filePaths: string[];
  readonly errors: string[];
  readonly model: LanguageModel;
  readonly workspaceRoot: string;
}): Promise<SessionMemory | null> {
  // Gate 1：短 Run
  if (opts.turn > SHORT_RUN_MAX_TURNS) return null;

  // Gate 2：高价值 Goal
  if (!HIGH_VALUE_GOAL_PATTERN.test(opts.goal)) return null;

  // Gate 3：没有已有会话记忆
  const sessionStore = new SessionMemoryStore({
    workspaceRoot: opts.workspaceRoot,
  });
  if (sessionStore.load(opts.runId)) return null;

  // 生成
  try {
    const user = buildShortSessionUser(
      opts.goal,
      opts.finalText,
      opts.filePaths,
      opts.errors,
    );
    const text = await completeAuxiliaryTask({
      model: opts.model,
      system: SHORT_SESSION_SYSTEM,
      user,
      signal: AbortSignal.timeout(15_000),
    });

    const project = opts.workspaceRoot.split("/").pop() ?? "unknown";
    const memory = parseShortSessionSummary(
      text,
      opts.runId,
      project,
      opts.goal,
    );
    if (memory) {
      sessionStore.save(opts.runId, memory);
    }
    return memory;
  } catch {
    return null;
  }
}
