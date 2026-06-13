import type { RunEventEnvelope } from "@paw/core";

export interface ContextBudgetHud {
  readonly historyUsed: number;
  readonly historyBudget: number;
  readonly systemUsed: number;
  readonly systemBudget: number;
  readonly historyOverBudget: boolean;
  readonly systemOverBudget: boolean;
}

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

export interface CostDetail {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  readonly estimatedCostUsd: number;
  readonly costCurrency?: "CNY" | "USD";
  readonly cachedPromptTokens?: number;
  readonly turnPromptTokens?: number;
  readonly turnCompletionTokens?: number;
}

function formatMoney(amount: number, currency: "CNY" | "USD" = "USD"): string {
  const sym = currency === "CNY" ? "¥" : "$";
  return `${sym}${amount.toFixed(4)}`;
}

export interface FooterState {
  readonly askOpen: boolean;
  readonly approvalOpen: boolean;
  readonly streaming?: boolean;
}

export interface FooterLayout {
  readonly showApprovalPicker: boolean;
  readonly showAskPrompt: boolean;
  readonly showTextarea: boolean;
  readonly showBottomBar: boolean;
  readonly showStreamPreview: boolean;
  readonly streamPreviewHeight: number;
  readonly textareaHeight: number;
}

export type ApprovalKeyAction =
  | "approve"
  | "confirm"
  | "deny"
  | "select-allow"
  | "select-deny";

export interface KeyLike {
  readonly name: string;
  readonly ctrl?: boolean;
}

const BOTTOM_BAR_HEIGHT = 2;
const STREAM_PREVIEW_ROWS = 4;
export const FOOTER_HEIGHT = 10;
const ASK_PROMPT_ROWS = 2;

export function getFooterLayout(state: FooterState): FooterLayout {
  if (state.approvalOpen) {
    return {
      showApprovalPicker: true,
      showAskPrompt: false,
      showTextarea: false,
      showBottomBar: true,
      showStreamPreview: false,
      streamPreviewHeight: 0,
      textareaHeight: 0,
    };
  }
  const streamRows = state.streaming ? STREAM_PREVIEW_ROWS : 0;
  if (state.askOpen) {
    return {
      showApprovalPicker: false,
      showAskPrompt: true,
      showTextarea: true,
      showBottomBar: true,
      showStreamPreview: state.streaming === true,
      streamPreviewHeight: streamRows,
      textareaHeight:
        FOOTER_HEIGHT - BOTTOM_BAR_HEIGHT - ASK_PROMPT_ROWS - streamRows,
    };
  }
  return {
    showApprovalPicker: false,
    showAskPrompt: false,
    showTextarea: true,
    showBottomBar: true,
    showStreamPreview: state.streaming === true,
    streamPreviewHeight: streamRows,
    textareaHeight: FOOTER_HEIGHT - BOTTOM_BAR_HEIGHT - streamRows,
  };
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/** Per-turn prefix cache stats (not session-cumulative). */
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

export function formatTurnCachePart(cd: CostDetail): string | null {
  const stats = computeTurnCacheStats(cd);
  if (!stats) return null;
  return `缓存命中 ${stats.hitPct}% (${formatTokens(stats.hit)}/${formatTokens(stats.miss > 0 ? stats.miss : 0)})`;
}

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

export function formatBottomBar(hud: HudState, contextWindow?: number): string {
  return buildBottomBarChips(hud, contextWindow)
    .map((c) => c.text)
    .join(" │ ");
}

export type BottomBarChipColor =
  | "success"
  | "info"
  | "warning"
  | "error"
  | "highlight"
  | "muted";

export interface BottomBarChip {
  readonly text: string;
  readonly color: BottomBarChipColor;
}

/** Shared bottom-bar chip list for plain text and OpenTUI colored rendering. */
export function buildBottomBarChips(
  hud: HudState,
  contextWindow?: number,
): readonly BottomBarChip[] {
  const cd = hud.costDetail;
  const chips: BottomBarChip[] = [];

  const currency = cd?.costCurrency ?? "USD";
  chips.push({
    text: cd ? formatMoney(cd.estimatedCostUsd, currency) : "-",
    color: "success",
  });

  if (hud.tokens != null) {
    chips.push({
      text:
        contextWindow != null
          ? `ctx ${formatTokens(hud.tokens)}/${formatTokens(contextWindow)}`
          : `ctx ${formatTokens(hud.tokens)}`,
      color: "info",
    });
  }

  const poolPart = formatPoolBudget(hud.contextBudget);
  if (poolPart) {
    const poolOver =
      hud.contextBudget?.historyOverBudget ||
      hud.contextBudget?.systemOverBudget;
    chips.push({ text: poolPart, color: poolOver ? "warning" : "muted" });
  }

  if (cd?.turnPromptTokens != null || cd?.turnCompletionTokens != null) {
    chips.push({
      text: `本轮 ${formatTokens((cd.turnPromptTokens ?? 0) + (cd.turnCompletionTokens ?? 0))}`,
      color: "highlight",
    });
  }

  chips.push({
    text: cd ? `累计 ${formatTokens(cd.totalTokens)}` : "累计 -",
    color: "muted",
  });

  const cachePart = cd ? formatTurnCachePart(cd) : null;
  if (cachePart && cd) {
    const stats = computeTurnCacheStats(cd);
    const hitPct = stats?.hitPct ?? 0;
    const cacheColor =
      hitPct >= 80 ? "success" : hitPct >= 40 ? "warning" : "error";
    chips.push({ text: cachePart, color: cacheColor });
  }

  chips.push({ text: formatElapsed(hud.elapsedMs), color: "muted" });
  return chips;
}

function formatPoolBudget(budget: ContextBudgetHud | null): string | null {
  if (!budget) return null;
  const histWarn = budget.historyOverBudget ? "!" : "";
  const sysWarn = budget.systemOverBudget ? "!" : "";
  return `上下文预算 ${formatTokens(budget.historyUsed)}/${formatTokens(budget.historyBudget)}${histWarn} │ SP预算 ${formatTokens(budget.systemUsed)}/${formatTokens(budget.systemBudget)}${sysWarn}`;
}

export { formatPoolBudget };

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

function formatElapsed(ms: number | null): string {
  if (ms === null || ms < 0) return "⏱ --:--";
  const totalSec = Math.floor(ms / 1000);
  return `⏱ ${String(Math.floor(totalSec / 60)).padStart(2, "0")}:${String(totalSec % 60).padStart(2, "0")}`;
}

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
