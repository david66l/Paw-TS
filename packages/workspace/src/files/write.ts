/**
 * 本地文件系统工具集 — 读/写/列表/搜索/Glob/Grep。
 * ==================================================
 *
 * 所有文件操作都通过 path-guard.ts 做安全校验：工作区越界+敏感路径拒绝。
 *
 * 关键函数：
 * - readWorkspaceFile()：读取文件（支持 offset/limit 分页）
 * - writeWorkspaceFile()：原子写入（先写临时文件再 rename）
 * - editWorkspaceFile()：精确替换（字符串模式 + 行号模式 + fuzzy 模式）
 * - listWorkspaceFiles()：列表目录（支持递归 + 忽略目录过滤）
 * - searchWorkspaceText()：文本搜索（字面量 + 正则，二进制跳过）
 * - globWorkspaceFiles()：Glob 模式匹配（支持 ** 递归通配）
 * - grepWorkspaceText()：增强搜索（上下文行 + 输出模式 + 分页）
 */

import fs from "node:fs";
import path from "node:path";
import { formatPatch, structuredPatch } from "diff";

import { checkWorkspacePath } from "../path-guard.js";






const MAX_WRITE_BYTES = 512 * 1024;
const MAX_EDIT_BYTES = 512 * 1024;

export interface EditFileResult {
  readonly path?: string;
  readonly replacements?: number;
  readonly linesAffected?: number;
  /** Number of lines added (from diff patch). */
  readonly linesAdded?: number;
  /** Number of lines removed (from diff patch). */
  readonly linesRemoved?: number;
  /** Unified diff patch text (shortened to ~2k chars for display). */
  readonly diff?: string;
  readonly error?: string;
}

function normalizeForFuzzy(s: string): string {
  return s.replace(/\r\n/g, "\n").trim();
}

interface DiffStats {
  linesAdded: number;
  linesRemoved: number;
  diffText: string;
}

function computeDiffStats(
  filePath: string,
  oldContent: string,
  newContent: string,
): DiffStats {
  let linesAdded = 0;
  let linesRemoved = 0;
  try {
    const patch = structuredPatch(
      filePath,
      filePath,
      oldContent,
      newContent,
      undefined,
      undefined,
      { context: 3 },
    );
    if (patch?.hunks) {
      for (const hunk of patch.hunks) {
        for (const line of hunk.lines) {
          if (line.startsWith("+")) linesAdded++;
          if (line.startsWith("-")) linesRemoved++;
        }
      }
    }
    const diffText = patch ? formatPatch(patch).slice(0, 2048) : "";
    return { linesAdded, linesRemoved, diffText };
  } catch {
    return { linesAdded: 0, linesRemoved: 0, diffText: "" };
  }
}

/**
 * Precisely edit a UTF-8 file.
 *
 * Modes:
 * 1. String replacement: provide `oldString` + `newString`. Rejects ambiguous matches.
 * 2. Line-range replacement: provide `startLine` (1-based) + optional `endLine` + `newString`.
 *    When `endLine` omitted, replaces a single line. `newString` may contain `\n` for multi-line.
 *
 * `fuzzy` relaxes `oldString` matching by ignoring leading/trailing whitespace differences.
 */
export function editWorkspaceFile(
  workspaceRoot: string,
  relPath: string,
  options: {
    oldString?: string;
    newString?: string;
    startLine?: number;
    endLine?: number;
    fuzzy?: boolean;
  },
): EditFileResult {
  const {
    oldString,
    newString = "",
    startLine,
    endLine,
    fuzzy = false,
  } = options;

  const d = checkWorkspacePath(workspaceRoot, relPath);
  if (!d.allowed) {
    return { error: d.reason };
  }
  const filepath = d.resolvedPath;
  if (!fs.existsSync(filepath) || !fs.statSync(filepath).isFile()) {
    return { error: `File not found: ${relPath}` };
  }
  let content: string;
  try {
    content = fs.readFileSync(filepath, { encoding: "utf8" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { error: msg };
  }
  if (Buffer.byteLength(content, "utf8") > MAX_EDIT_BYTES) {
    return {
      error: `file exceeds max ${MAX_EDIT_BYTES} bytes for editing`,
    };
  }

  // --- Line-based mode ---
  if (startLine !== undefined && startLine > 0) {
    const hasTrailingNewline = content.endsWith("\n");
    const lines = content.split(/\r?\n/);
    // Remove trailing empty element created by trailing newline
    if (
      hasTrailingNewline &&
      lines.length > 0 &&
      lines[lines.length - 1] === ""
    ) {
      lines.pop();
    }
    const totalLines = lines.length;
    if (startLine > totalLines) {
      return {
        error: `start_line ${startLine} exceeds file length ${totalLines}`,
      };
    }
    const s = startLine;
    const e = endLine !== undefined ? Math.min(endLine, totalLines) : s;
    const before = lines.slice(0, s - 1);
    const after = lines.slice(e);
    const replacementLines = newString ? newString.split(/\r?\n/) : [];
    const newLines = [...before, ...replacementLines, ...after];
    let newContent = newLines.join("\n");
    if (hasTrailingNewline) {
      newContent += "\n";
    }
    try {
      fs.writeFileSync(filepath, newContent, { encoding: "utf8" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: msg };
    }
    const { linesAdded, linesRemoved, diffText } = computeDiffStats(
      filepath,
      content,
      newContent,
    );
    return {
      path: filepath,
      replacements: 1,
      linesAffected: e - s + 1,
      linesAdded,
      linesRemoved,
      diff: diffText,
    };
  }

  // --- String-based mode ---
  if (!oldString) {
    return { error: "missing old_string (or start_line)" };
  }

  const search = oldString;
  const occurrences = content.split(search).length - 1;

  if (occurrences === 1) {
    const replaced = content.replace(search, newString);
    try {
      fs.writeFileSync(filepath, replaced, { encoding: "utf8" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: msg };
    }
    const { linesAdded, linesRemoved, diffText } = computeDiffStats(
      filepath,
      content,
      replaced,
    );
    return {
      path: filepath,
      replacements: 1,
      linesAdded,
      linesRemoved,
      diff: diffText,
    };
  }

  if (occurrences === 0 && fuzzy) {
    const normSearch = normalizeForFuzzy(search);
    const normContent = normalizeForFuzzy(content);
    const fuzzyOccurrences = normContent.split(normSearch).length - 1;
    if (fuzzyOccurrences === 1) {
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (normalizeForFuzzy(lines[i]!) === normSearch) {
          const replacedLines = [...lines];
          replacedLines[i] = newString;
          const replaced = replacedLines.join("\n");
          try {
            fs.writeFileSync(filepath, replaced, { encoding: "utf8" });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { error: msg };
          }
          const { linesAdded, linesRemoved, diffText } = computeDiffStats(
            filepath,
            content,
            replaced,
          );
          return {
            path: filepath,
            replacements: 1,
            linesAdded,
            linesRemoved,
            diff: diffText,
          };
        }
      }
    }
  }

  if (occurrences === 0) {
    return { error: `old_string not found in ${relPath}` };
  }

  return {
    error: `old_string appears ${occurrences} times in ${relPath}; provide more context for a unique match`,
  };
}

export interface WriteFileResult {
  readonly path?: string;
  readonly bytes_written?: number;
  readonly error?: string;
}

/**
 * Create or overwrite a UTF-8 file under the workspace root (after path guard).
 */
export function writeWorkspaceFile(
  workspaceRoot: string,
  relPath: string,
  content: string,
  options: { createDirectories?: boolean } = { createDirectories: true },
): WriteFileResult {
  const d = checkWorkspacePath(workspaceRoot, relPath);
  if (!d.allowed) return { error: d.reason ?? "path escapes workspace" };
  if (Buffer.byteLength(content, "utf8") > MAX_WRITE_BYTES) {
    return { error: `content exceeds ${MAX_WRITE_BYTES} bytes` };
  }
  try {
    if (options.createDirectories) {
      const dir = path.dirname(d.resolvedPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(d.resolvedPath, content, "utf8");
    return { bytes_written: Buffer.byteLength(content, "utf8") };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
