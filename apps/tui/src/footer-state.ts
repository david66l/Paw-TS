import type { RunEventEnvelope } from "@paw/core";

/** 上下文预算 HUD 数据结构。 */
export interface ContextBudgetHud {
  readonly historyUsed: number;      // 历史消息已用 tokens
  readonly historyBudget: number;    // 历史消息预算
  readonly systemUsed: number;       // 系统提示已用 tokens
  readonly systemBudget: number;     // 系统提示预算
  readonly historyOverBudget: boolean;
  readonly systemOverBudget: boolean;
}

/** 底部状态栏聚合所需的核心 HUD 数据。 */
export interface HudState {
  readonly modelLabel: string | null;
  readonly turn: number | null;
  readonly maxSteps: number | null;
  readonly phase: string | null;
  readonly tokens: number | null;
  readonly contextBudget: ContextBudgetHud | null;
  readonly costDetail: CostDetail | null;
  readonly elapsedMs: number | null;
}

/** Token 消耗与成本明细。 */
export interface CostDetail {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly estimatedCostUsd: number;
  readonly costCurrency?: "CNY" | "USD";
  readonly cachedPromptTokens?: number;       // 本轮缓存命中数
  readonly turnPromptTokens?: number;         // 本轮 prompt tokens
  readonly turnCompletionTokens?: number;     // 本轮 completion tokens
}

/**
 * 按货币格式化金额。
 *
 * @param amount 金额数值
 * @param currency 货币类型，默认 USD
 */
function formatMoney(amount: number, currency: "CNY" | "USD" = "USD"): string {
  const sym = currency === "CNY" ? "¥" : "$";
  return `${sym}${amount.toFixed(4)}`;
}

/** 审批对话框的键盘动作。 */
export type ApprovalKeyAction =
  | "approve"
  | "confirm"
  | "deny"
  | "select-allow"
  | "select-deny";

/** 简化的按键描述。 */
export interface KeyLike {
  readonly name: string;
  readonly ctrl?: boolean;
}

// ── Footer 布局常量 ──
// 这些常量被 PawFooter（高度计算）和 PawFooterView（渲染高度）共用，
// 避免两边硬编码不一致。

/** 顶部 HUD 占用的行数。 */
export const HUD_ROWS = 1;
/** 上下文使用量条占用的行数。 */
export const CONTEXT_BAR_ROWS = 1;
/** 底部状态栏占用的行数。 */
export const BOTTOM_BAR_ROWS = 2;
/** 流式输出预览区占用的行数。 */
export const STREAM_PREVIEW_ROWS = 4;
/** 工具审批选择器占用的行数。 */
export const APPROVAL_ROWS = 5;
/** 用户提问提示区占用的行数。 */
export const ASK_ROWS = 3;
/** 文本框最小行数。 */
export const TEXTAREA_MIN_ROWS = 1;
/** 文本框最大行数。 */
export const TEXTAREA_MAX_ROWS = 6;

/**
 * 将 token 数格式化为人类可读字符串（K/M）。
 *
 * @param n token 数量
 */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/**
 * 计算本轮缓存命中率。
 *
 * 注意：分母使用 turnPromptTokens（本轮 prompt），而非累计值。
 *
 * @param cd 成本明细
 * @returns 命中信息；数据不足时返回 null
 */
export function computeTurnCacheStats(cd: {
  readonly cachedPromptTokens?: number;
  readonly turnPromptTokens?: number;
}): { readonly hitPct: number; readonly hit: number; readonly miss: number } | null {
  const cached = cd.cachedPromptTokens;
  const turnPrompt = cd.turnPromptTokens;
  if (cached === undefined || turnPrompt == null || turnPrompt <= 0) {
    return null;
  }
  const hit = Math.min(Math.max(cached, 0), turnPrompt);
  const miss = turnPrompt - hit;
  const hitPct = Math.round((hit / turnPrompt) * 100);
  return { hitPct, hit, miss };
}

/**
 * 格式化本轮缓存命中片段，用于底部状态栏展示。
 *
 * @param cd 成本明细
 * @returns 中文描述或 null
 */
export function formatTurnCachePart(cd: CostDetail): string | null {
  const stats = computeTurnCacheStats(cd);
  if (!stats) return null;
  return `缓存命中 ${stats.hitPct}% (${formatTokens(stats.hit)}/${formatTokens(stats.miss > 0 ? stats.miss : 0)})`;
}

/**
 * 格式化顶部 HUD 文本。
 *
 * 输出格式：paw │ modelLabel │ 轮 turn/maxSteps │ phase
 *
 * @param hud HUD 数据
 */
export function formatHudText(hud: HudState): string {
  const phaseLabels: Record<string, string> = {
    model: "生成中…",
    tool: "执行工具…",
    parse: "解析中…",
    plan: "规划中…",
    idle: "空闲",
    waiting_children: "等待子Agent…",
    merging_results: "合并结果…",
  };
  const phase = (hud.phase && phaseLabels[hud.phase]) ?? hud.phase ?? "空闲";
  return [
    "paw",
    hud.modelLabel ?? "-",
    `轮 ${hud.turn ?? "-"}/${hud.maxSteps ?? "-"}`,
    phase,
  ].join(" │ ");
}

/**
 * 格式化上下文使用量进度条。
 *
 * 使用 20 个方块字符表示比例，并附加百分比。
 *
 * @param tokens 当前已用 tokens
 * @param maxTokens 最大上下文窗口
 */
export function formatContextBar(
  tokens: number | null,
  maxTokens: number,
): string {
  if (tokens === null) return "";
  const ratio = Math.min(tokens / maxTokens, 1);
  const filled = Math.round(ratio * 20);
  const pct = Math.round(ratio * 100);
  return `${"█".repeat(filled)}${"░".repeat(20 - filled)} ${pct}%`;
}

/**
 * 格式化底部状态栏为纯文本（用于测试与文本渲染）。
 *
 * @param hud HUD 数据
 * @param contextWindow 可选上下文窗口大小
 */
export function formatBottomBar(hud: HudState, contextWindow?: number): string {
  return buildBottomBarChips(hud, contextWindow)
    .map((c) => c.text)
    .join(" │ ");
}

/** 底部状态栏芯片颜色。 */
export type BottomBarChipColor =
  | "success"
  | "info"
  | "warning"
  | "error"
  | "highlight"
  | "muted";

/** 底部状态栏芯片。 */
export interface BottomBarChip {
  readonly text: string;
  readonly color: BottomBarChipColor;
}

/**
 * 构建底部状态栏芯片列表。
 *
 * 包含：成本、上下文估计、上下文预算、本轮 tokens、累计 tokens、
 * 缓存命中率、运行时长。
 *
 * @param hud HUD 数据
 * @param contextWindow 可选上下文窗口大小
 */
export function buildBottomBarChips(
  hud: HudState,
  contextWindow?: number,
): readonly BottomBarChip[] {
  const cd = hud.costDetail;
  const chips: BottomBarChip[] = [];

  // 成本
  const currency = cd?.costCurrency ?? "USD";
  chips.push({
    text: cd ? formatMoney(cd.estimatedCostUsd, currency) : "-",
    color: "success",
  });

  // 上下文使用量
  if (hud.tokens != null) {
    chips.push({
      text:
        contextWindow != null
          ? `ctx ${formatTokens(hud.tokens)}/${formatTokens(contextWindow)}`
          : `ctx ${formatTokens(hud.tokens)}`,
      color: "info",
    });
  }

  // 上下文预算
  const poolPart = formatPoolBudget(hud.contextBudget);
  if (poolPart) {
    const poolOver =
      hud.contextBudget?.historyOverBudget ||
      hud.contextBudget?.systemOverBudget;
    chips.push({ text: poolPart, color: poolOver ? "warning" : "muted" });
  }

  // 本轮 tokens
  if (cd?.turnPromptTokens != null || cd?.turnCompletionTokens != null) {
    chips.push({
      text: `本轮 ${formatTokens((cd.turnPromptTokens ?? 0) + (cd.turnCompletionTokens ?? 0))}`,
      color: "highlight",
    });
  }

  // 累计 tokens
  chips.push({
    text: cd ? `累计 ${formatTokens(cd.totalTokens)}` : "累计 -",
    color: "muted",
  });

  // 缓存命中率
  const cachePart = cd ? formatTurnCachePart(cd) : null;
  if (cachePart && cd) {
    const stats = computeTurnCacheStats(cd);
    const hitPct = stats?.hitPct ?? 0;
    const cacheColor =
      hitPct >= 80 ? "success" : hitPct >= 40 ? "warning" : "error";
    chips.push({ text: cachePart, color: cacheColor });
  }

  // 运行时长
  chips.push({ text: formatElapsed(hud.elapsedMs), color: "muted" });
  return chips;
}

/**
 * 格式化上下文预算为字符串。
 *
 * @param budget 上下文预算数据
 */
function formatPoolBudget(budget: ContextBudgetHud | null): string | null {
  if (!budget) return null;
  const histWarn = budget.historyOverBudget ? "!" : "";
  const sysWarn = budget.systemOverBudget ? "!" : "";
  return `上下文预算 ${formatTokens(budget.historyUsed)}/${formatTokens(budget.historyBudget)}${histWarn} │ SP预算 ${formatTokens(budget.systemUsed)}/${formatTokens(budget.systemBudget)}${sysWarn}`;
}

export { formatPoolBudget };

/**
 * 清理工具结果摘要，去除重复的工具名前缀。
 *
 * 例如 `workspace.memory.list: workspace.memory.list: 20 entries`
 * 会被处理为 `20 entries`。
 *
 * @param tool 工具名
 * @param summary 原始摘要
 */
export function formatToolResultSummary(tool: string, summary: string): string {
  let text = summary.trim();
  const dupPrefix = `${tool}: ${tool}:`;
  if (text.startsWith(dupPrefix)) {
    text = text.slice(`${tool}: `.length).trimStart();
  }
  const simplePrefix = `${tool}:`;
  if (text.startsWith(simplePrefix)) {
    text = text.slice(simplePrefix.length).trimStart();
  }
  return text;
}

/**
 * 格式化已运行时长为 `⏱ MM:SS`。
 *
 * @param ms 毫秒数
 */
function formatElapsed(ms: number | null): string {
  if (ms === null || ms < 0) return "⏱ --:--";
  const totalSec = Math.floor(ms / 1000);
  return `⏱ ${String(Math.floor(totalSec / 60)).padStart(2, "0")}:${String(totalSec % 60).padStart(2, "0")}`;
}

/**
 * 将键盘事件映射为审批对话框动作。
 *
 * @param key 按键描述
 * @returns 审批动作；无法识别返回 null
 */
export function resolveApprovalKey(key: KeyLike): ApprovalKeyAction | null {
  if (key.ctrl) return null;
  switch (key.name) {
    case "up":
      return "select-allow";
    case "down":
      return "select-deny";
    case "return":
      return "confirm";
    case "y":
      return "approve";
    case "escape":
    case "n":
      return "deny";
    default:
      return null;
  }
}

/**
 * 将运行事件转换为滚动日志中的单行文本。
 *
 * 对不影响交互的事件（如 loop.tick、cost.update）返回 null，
 * 避免日志刷屏。
 *
 * @param e 运行事件信封
 * @returns 中文展示文本或 null
 */
export function formatEventForScrollback(e: RunEventEnvelope): string | null {
  const ev = e.event;
  switch (ev.type) {
    case "run.started":
      return `开始: ${ev.goal}`;
    case "agent.action":
      return null;
    case "tool.call":
      return `${toolIcon(ev.tool)} ${ev.tool}`;
    case "tool.result":
      return `${ev.ok ? "✅" : "❌"} ${ev.tool}: ${formatToolResultSummary(ev.tool, ev.summary)}`;
    case "tool.approval.pending":
      return null;
    case "tool.approval.resolved":
      return ev.approved ? null : `❌ 已拒绝 ${ev.tool}`;
    case "plan.updated":
      return `📋 计划: ${ev.itemCount} 项`;
    case "compression.prune.done":
      return `📦 裁剪完成: ${ev.freedTokens} tokens`;
    case "compression.auto_compact.started":
      return `🗜️ 压缩开始: ${ev.beforeTokens} tokens`;
    case "compression.auto_compact.done":
      return `✅ 压缩完成: ${ev.afterTokens} tokens`;
    case "compression.skipped":
      return `已跳过压缩: ${ev.reason}`;
    case "context.budget":
      return `📊 历史 ${formatTokens(ev.historyUsed)}/${formatTokens(ev.historyBudget)} 系统 ${formatTokens(ev.systemUsed)}/${formatTokens(ev.systemBudget)}`;
    case "context.budget.trimmed":
      return `✂️ 系统裁剪: ${ev.sections.join(", ")} (-${ev.freedTokens} tok)`;
    case "memory.extracted":
      return `🧠 记忆: ${ev.entries} 条已保存`;
    case "memory.retrieve.done":
      if (ev.selectedCount === 0) return null;
      {
        const total =
          ev.totalCandidates > 0 ? `/${ev.totalCandidates}` : "";
        const mode =
          ev.retrievalMode === "cascade"
            ? ev.usedLlmFallback
              ? " · 级联+LLM"
              : " · 级联"
            : "";
        return `🧠 召回 ${ev.selectedCount}${total} 条记忆 (${ev.injectedTokens} tok${mode})`;
      }
    case "model.truncated":
      return `⚠️ 模型输出被截断 (${ev.finishReason})`;
    case "model.retry.waiting":
      return `↻ 第 ${ev.attempt} 次重试 ${Math.round(ev.delayMs / 1000)}s 后: ${ev.error.slice(0, 80)}`;
    case "mcp.connection_failed":
      return `⚠️ MCP ${ev.server}: ${ev.error.slice(0, 80)}`;
    case "run.completed":
      return ev.status === "completed"
        ? null
        : `❌ ${ev.status}: ${ev.message}`;
    case "run.failed":
      return `❌ 失败: ${ev.message}`;
    case "user.reply.required":
      return `❓ 请回复: ${ev.question}`;
    default:
      return null;
  }
}

/**
 * 根据工具名返回对应的展示图标。
 *
 * @param tool 工具名
 */
function toolIcon(tool: string): string {
  if (tool.includes("read_file") || tool.includes("list_dir")) return "📖";
  if (
    tool.includes("write_file") ||
    tool.includes("edit_file") ||
    tool.includes("apply_patch")
  )
    return "✏️";
  if (
    tool.includes("grep") ||
    tool.includes("glob") ||
    tool.includes("search") ||
    tool.includes("symbol")
  )
    return "🔍";
  if (tool.includes("shell")) return "⚙️";
  if (tool.includes("agent")) return "🤖";
  if (tool.includes("skill")) return "🛠️";
  if (tool.includes("web_fetch") || tool.includes("web_search")) return "🌐";
  if (tool.includes("todo")) return "📋";
  if (tool.includes("git")) return "🔀";
  if (tool.includes("lsp")) return "💡";
  if (tool.includes("notebook")) return "📓";
  if (tool.includes("brief")) return "📊";
  return "🔧";
}
