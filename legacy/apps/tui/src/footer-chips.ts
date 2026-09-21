import type { ContextBudgetHud, CostDetail, HudState, BottomBarChip, BottomBarChipColor } from "./footer-types.js";

export type { BottomBarChip, BottomBarChipColor };

function formatMoney(amount: number, currency: "CNY" | "USD" = "USD"): string {
  const sym = currency === "CNY" ? "¥" : "$";
  return `${sym}${amount.toFixed(4)}`;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

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

function formatElapsed(ms: number | null): string {
  if (ms === null || ms < 0) return "⏱ --:--";
  const totalSec = Math.floor(ms / 1000);
  return `⏱ ${String(Math.floor(totalSec / 60)).padStart(2, "0")}:${String(totalSec % 60).padStart(2, "0")}`;
}

export function formatPoolBudget(budget: ContextBudgetHud | null): string | null {
  if (!budget) return null;
  const histWarn = budget.historyOverBudget ? "!" : "";
  const sysWarn = budget.systemOverBudget ? "!" : "";
  return `上下文预算 ${formatTokens(budget.historyUsed)}/${formatTokens(budget.historyBudget)}${histWarn} │ SP预算 ${formatTokens(budget.systemUsed)}/${formatTokens(budget.systemBudget)}${sysWarn}`;
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
