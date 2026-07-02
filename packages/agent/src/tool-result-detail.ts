/**
 * 工具结果的事件详情格式化（用于 TUI / 日志展示）。
 * ===================================================
 *
 * 从工具执行的 payload 中提取可读的摘要，截断到合理长度。
 *
 * 支持的工具结果类型：
 * - 错误结果：提取 error 字段
 * - 文件内容：提取 content 字段（截断到 MAX_FILE_LINES 行）
 * - 文件列表：提取 files 数组（截断到 MAX_LIST_FILES 个）
 * - Shell 命令：提取 exit_code + stdout + stderr
 * - 搜索匹配：提取 matches 数组
 * - 文件写入：提取 path + bytes_written
 */

import type { ToolRunResult } from "@paw/harness";

/** 详情文本最大字符数 */
const MAX_DETAIL_CHARS = 6000;
/** 文件内容最大显示行数 */
const MAX_FILE_LINES = 64;
/** 文件列表最大显示条目数 */
const MAX_LIST_FILES = 50;

/**
 * 为 TUI / 日志生成可读的工具结果详情。
 * 从工具 payload 中提取关键信息，截断到合理长度。
 *
 * @returns 格式化的详情字符串，或 undefined（无需展示详情）
 */
export function formatToolResultEventDetail(
  tr: ToolRunResult,
): string | undefined {
  const p = tr.payload;
  if (p === null || typeof p !== "object") {
    return tr.ok ? undefined : tr.summary;
  }

  // 失败结果：提取错误信息
  if (!tr.ok) {
    if ("error" in p) {
      return String((p as { error: unknown }).error).slice(0, MAX_DETAIL_CHARS);
    }
    return tr.summary;
  }

  // 文件内容结果（如 Read 工具）
  if (
    "content" in p &&
    typeof (p as { content?: unknown }).content === "string"
  ) {
    const c = (p as { content: string }).content;
    return c
      .split("\n")
      .slice(0, MAX_FILE_LINES)
      .join("\n")
      .slice(0, MAX_DETAIL_CHARS);
  }

  // 文件列表结果（如 Glob 工具）
  if ("files" in p && Array.isArray((p as { files?: unknown }).files)) {
    const files = (p as { files: string[] }).files;
    return files.slice(0, MAX_LIST_FILES).join("\n").slice(0, MAX_DETAIL_CHARS);
  }

  // Shell 命令结果（如 Bash 工具）
  if (typeof (p as { exit_code?: unknown }).exit_code === "number") {
    const ex = (p as { exit_code: number }).exit_code;
    const out =
      typeof (p as { stdout?: unknown }).stdout === "string"
        ? (p as { stdout: string }).stdout
        : "";
    const err =
      typeof (p as { stderr?: unknown }).stderr === "string"
        ? (p as { stderr: string }).stderr
        : "";
    const parts = [`exit ${ex}`];
    if (out) {
      parts.push(out);
    }
    if (err) {
      parts.push(`stderr: ${err}`);
    }
    return parts.join("\n").slice(0, MAX_DETAIL_CHARS);
  }

  // 搜索匹配结果（如 Grep 工具）
  if ("matches" in p && Array.isArray((p as { matches?: unknown }).matches)) {
    const mm = (
      p as {
        matches: Array<{ path?: string; line?: number; text?: string }>;
      }
    ).matches;
    const lines = mm.slice(0, 40).map((m) => {
      const loc = `${m.path ?? "?"}:${m.line ?? "?"}`;
      const snippet = String(m.text ?? "").slice(0, 200);
      return `${loc}: ${snippet}`;
    });
    return lines.join("\n").slice(0, MAX_DETAIL_CHARS);
  }

  // 文件写入结果
  if (
    typeof (p as { bytes_written?: unknown }).bytes_written === "number" &&
    (p as { bytes_written: number }).bytes_written >= 0
  ) {
    const path =
      typeof (p as { path?: unknown }).path === "string"
        ? (p as { path: string }).path
        : "";
    const b = (p as { bytes_written: number }).bytes_written;
    const line = path ? `${path}\n${b} bytes written` : `${b} bytes written`;
    return line.slice(0, MAX_DETAIL_CHARS);
  }

  return undefined;
}
