/**
 * 工具名短写 → 完整 workspace.* / memory.* 名。
 */

import { listToolNames } from "@paw/harness";

const ALIASES: Record<string, string> = {
  read_file: "workspace.read_file",
  read: "workspace.read_file",
  list_dir: "workspace.list_dir",
  list: "workspace.list_dir",
  write_file: "workspace.write_file",
  write: "workspace.write_file",
  edit_file: "workspace.edit_file",
  edit: "workspace.edit_file",
  search: "workspace.search",
  glob: "workspace.glob",
  grep: "workspace.grep",
  run_shell: "workspace.run_shell",
  shell: "workspace.run_shell",
  web_fetch: "workspace.web_fetch",
  web_search: "workspace.web_search",
  todo_write: "workspace.todo_write",
  notebook_edit: "workspace.notebook_edit",
  brief: "workspace.brief",
  git_status: "workspace.git_status",
  git_log: "workspace.git_log",
  git_diff: "workspace.git_diff",
  run_agent: "workspace.run_agent",
  run_skill: "workspace.run_skill",
  lsp: "workspace.lsp",
  apply_patch: "workspace.apply_patch",
  symbol_search: "workspace.symbol_search",
  create_agent: "workspace.create_agent",
  memory_list: "memory.list",
  memory_read: "memory.read",
  memory_save: "memory.save",
};

/** 全部已知内置工具名（无 MCP） */
export function knownBuiltinTools(): readonly string[] {
  return listToolNames();
}

export function normalizeToolName(raw: string): string {
  const t = raw.trim();
  if (!t) return t;
  const lower = t.toLowerCase();
  if (ALIASES[lower]) return ALIASES[lower]!;
  // 已是完整名
  if (t.includes(".")) return t;
  // 默认挂 workspace.
  return `workspace.${t}`;
}

/**
 * 解析 tools 字段。
 * - inherit / * / 空 → null（不裁剪）
 * - 逗号分隔或数组 → 归一化完整名列表
 */
export function parseToolsField(
  raw: string | readonly string[] | undefined,
): "inherit" | string[] {
  if (raw === undefined || raw === null) return "inherit";
  if (Array.isArray(raw)) {
    if (raw.length === 0) return "inherit";
    return raw.map((x) => normalizeToolName(String(x)));
  }
  const s = String(raw).trim();
  if (!s || s === "inherit" || s === "*" || s.toLowerCase() === "all") {
    return "inherit";
  }
  // JSON 数组字面量
  if (s.startsWith("[")) {
    try {
      const arr = JSON.parse(s) as unknown;
      if (Array.isArray(arr)) {
        return arr.map((x) => normalizeToolName(String(x)));
      }
    } catch {
      /* fall through */
    }
  }
  return s
    .split(/[,|]/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map(normalizeToolName);
}

/**
 * 解析后的白名单 → 执行时允许的工具集合。
 * canSpawn=false 时强制去掉 run_agent。
 * childPolicy=read_only 时不在此裁写工具（由 tool-runner 硬拦），但可仍列出。
 */
export function resolveAllowedTools(opts: {
  readonly tools: "inherit" | readonly string[];
  readonly canSpawn: boolean;
}): readonly string[] | null {
  if (opts.tools === "inherit") {
    if (opts.canSpawn) return null;
    // inherit 但不能 spawn：去掉 run_agent
    return knownBuiltinTools().filter((t) => t !== "workspace.run_agent");
  }
  let list = [...opts.tools];
  if (!opts.canSpawn) {
    list = list.filter((t) => t !== "workspace.run_agent");
  }
  // 去重
  return [...new Set(list)];
}
