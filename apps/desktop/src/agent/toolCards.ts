/**
 * 聊天流内联卡（工具执行卡 / Changed files 卡）的纯逻辑，独立成模块以便测试。
 */

import type { FileChangeItem, ToolRunRow } from "./types";

/** 从 tool.call 的 args 提取一行定位摘要（路径 / 命令 / 查询等） */
export function summarizeToolCallArgs(args: unknown): string {
  if (args === null || typeof args !== "object") return "";
  const o = args as Record<string, unknown>;
  for (const key of [
    "path",
    "relPath",
    "file",
    "command",
    "query",
    "goal",
    "url",
  ]) {
    const v = o[key];
    if (typeof v === "string" && v.trim()) {
      const t = v.trim();
      return t.length > 120 ? `${t.slice(0, 120)}…` : t;
    }
  }
  return "";
}

/** tool.result → 卡片行状态；拒绝是 ok=false 的特定摘要 */
export function toolRowStatusFromResult(
  ok: boolean,
  summary: string,
): ToolRunRow["status"] {
  if (!ok && /denied|拒绝/i.test(summary)) return "denied";
  return ok ? "ok" : "fail";
}

/**
 * 聚合文件变更：同一路径多次修改时累加 +/−，diff 拼接保留所有 hunk。
 * 返回新数组（不可变更新）。
 */
export function mergeFileChanges(
  prev: readonly FileChangeItem[],
  incoming: readonly FileChangeItem[],
): FileChangeItem[] {
  const next = [...prev];
  for (const inc of incoming) {
    if (!inc.path) continue;
    const idx = next.findIndex((c) => c.path === inc.path);
    if (idx === -1) {
      next.push({ ...inc });
    } else {
      const cur = next[idx]!;
      // diff 拼接：多次 edit 各产一段 unified diff，全部保留才能看到完整改动
      const diff =
        cur.diff && inc.diff
          ? `${cur.diff}\n${inc.diff}`
          : (inc.diff ?? cur.diff);
      next[idx] = {
        path: cur.path,
        added: cur.added + inc.added,
        removed: cur.removed + inc.removed,
        ...(diff !== undefined ? { diff } : {}),
      };
    }
  }
  return next;
}

/** Changed files 卡的合计统计 */
export function totalChangeStats(changes: readonly FileChangeItem[]): {
  added: number;
  removed: number;
} {
  return changes.reduce(
    (acc, c) => ({
      added: acc.added + c.added,
      removed: acc.removed + c.removed,
    }),
    { added: 0, removed: 0 },
  );
}

/** 工具卡定格后的单行 fallback 文本（会话重载后静态展示） */
export function toolBatchSummaryLine(rows: readonly ToolRunRow[]): string {
  const ok = rows.filter((r) => r.status === "ok").length;
  const bad = rows.length - ok;
  return bad > 0
    ? `调用 ${rows.length} 个工具 · ${ok} 成功 · ${bad} 失败/拒绝`
    : `调用 ${rows.length} 个工具 · 全部成功`;
}

// ---------------------------------------------------------------------------
// 子 Agent 实时工具流（child.tool_call / child.tool_result 驱动）
// ---------------------------------------------------------------------------

export interface AgentToolEvent {
  readonly id: string;
  readonly tool: string;
  /** 一行定位摘要（路径 / 命令等） */
  readonly summary: string;
  /** undefined = 执行中；true/false = 结果 */
  readonly ok?: boolean;
  /** 结果摘要（tool.result 的 summary） */
  readonly result?: string;
  readonly at: number;
}

/** 工具流展示容量上限（防长 run 撑爆面板） */
const AGENT_TOOLS_CAP = 12;

/** 追加一条工具调用（执行中），保留最近 N 条 */
export function appendAgentTool(
  list: readonly AgentToolEvent[],
  ev: AgentToolEvent,
  cap: number = AGENT_TOOLS_CAP,
): AgentToolEvent[] {
  return [...list, ev].slice(-cap);
}

/** 结果到达：回填最后一个同工具且未完成的事件；找不到则原样返回 */
export function resolveAgentTool(
  list: readonly AgentToolEvent[],
  toolName: string,
  ok: boolean,
  result: string,
): AgentToolEvent[] {
  for (let i = list.length - 1; i >= 0; i--) {
    const t = list[i]!;
    if (t.tool === toolName && t.ok === undefined) {
      return list.map((x, j) => (j === i ? { ...x, ok, result } : x));
    }
  }
  return [...list];
}

/** 工具名去 workspace. 前缀（展示更紧凑） */
export function shortToolName(tool: string): string {
  return tool.replace(/^workspace\./, "");
}
