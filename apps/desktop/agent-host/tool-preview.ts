/**
 * 工具审批卡的参数预览：从 args 提炼一行摘要 + 可展开的完整 JSON（截断长字符串）。
 *
 * 独立成模块是为了可测试（run.ts 是带副作用的脚本入口）。
 */

/** 单个字符串字段的最大预览长度 */
const MAX_FIELD = 2000;
/** 整体预览的最大长度 */
const MAX_TOTAL = 6000;
/** 摘要行的最大长度 */
const MAX_SUMMARY = 200;

function truncate(s: string, max: number): string {
  return s.length > max
    ? `${s.slice(0, max)}…（截断，共 ${s.length} 字符）`
    : s;
}

/** 递归清洗：截断长字符串、限制嵌套深度，保证可安全序列化传输 */
function sanitize(value: unknown, depth: number): unknown {
  if (typeof value === "string") return truncate(value, MAX_FIELD);
  if (Array.isArray(value)) {
    if (depth >= 4) return "[…]";
    return value.map((v) => sanitize(v, depth + 1));
  }
  if (value !== null && typeof value === "object") {
    if (depth >= 4) return "{…}";
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = sanitize(v, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * 一行摘要：优先取最有定位价值的字段（路径 / 命令 / 查询 / 目标）。
 * 无匹配字段时返回空串（调用方不渲染摘要行）。
 */
export function summarizeToolArgs(_tool: string, args: unknown): string {
  if (args === null || typeof args !== "object") return "";
  const o = args as Record<string, unknown>;
  for (const key of ["path", "file", "command", "query", "goal", "url"]) {
    const v = o[key];
    if (typeof v === "string" && v.trim())
      return truncate(v.trim(), MAX_SUMMARY);
  }
  return "";
}

/** 完整预览：pretty JSON（长字符串已截断），整体再截断一次 */
export function previewToolArgs(args: unknown): string {
  if (args === undefined || args === null) return "";
  let text: string;
  try {
    text = JSON.stringify(sanitize(args, 0), null, 2);
  } catch {
    text = String(args);
  }
  return truncate(text, MAX_TOTAL);
}

/**
 * 「始终允许」的去重键：
 * - 带 command 的工具（如 run_shell）按整条命令，避免一次放行所有 shell
 * - 其它工具按工具名
 */
export function alwaysAllowKey(tool: string, args: unknown): string {
  if (args !== null && typeof args === "object") {
    const cmd = (args as Record<string, unknown>).command;
    if (typeof cmd === "string" && cmd.trim()) {
      return `${tool} :: ${cmd.trim()}`;
    }
  }
  return tool;
}
