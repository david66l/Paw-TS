import type { RunEventEnvelope } from "@paw/core";
import { formatTokens } from "./footer-chips.js";

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
