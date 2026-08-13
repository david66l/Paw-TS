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
  /** Whether the persisted file content is materially different. */
  readonly changed?: boolean;
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

function toLf(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** Prefer CRLF when the file already uses it (Windows checkouts). */
function detectEol(content: string): "\r\n" | "\n" {
  const crlf = (content.match(/\r\n/g) ?? []).length;
  if (crlf === 0) return "\n";
  const lfOnly = (content.match(/(?<!\r)\n/g) ?? []).length;
  return crlf >= lfOnly ? "\r\n" : "\n";
}

function applyEol(s: string, eol: "\r\n" | "\n"): string {
  const lf = toLf(s);
  return eol === "\r\n" ? lf.replace(/\n/g, "\r\n") : lf;
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
    /** When true, replace every LF-normalized match (not only unique). */
    replaceAll?: boolean;
  },
): EditFileResult {
  const {
    oldString,
    newString = "",
    startLine,
    endLine,
    fuzzy = false,
    replaceAll = false,
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

  const eol = detectEol(content);

  // --- Line-based mode ---
  if (startLine !== undefined && startLine > 0) {
    const hasTrailingNewline = /\r?\n$/.test(content);
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
    const replacementLines = newString ? toLf(newString).split("\n") : [];
    const newLines = [...before, ...replacementLines, ...after];
    let newContent = newLines.join(eol);
    if (hasTrailingNewline) {
      newContent += eol === "\r\n" ? "\r\n" : "\n";
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
      changed: newContent !== content,
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

  // Match on LF-normalized text so CRLF checkouts accept LF old_string from models.
  const contentLf = toLf(content);
  const searchLf = toLf(oldString);
  const newLf = toLf(newString);
  const occurrences = contentLf.split(searchLf).length - 1;

  if (occurrences === 1 || (replaceAll && occurrences > 1)) {
    const replacedLf = replaceAll
      ? contentLf.split(searchLf).join(newLf)
      : contentLf.replace(searchLf, newLf);
    const replaced = applyEol(replacedLf, eol);
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
      changed: replaced !== content,
      replacements: occurrences,
      linesAdded,
      linesRemoved,
      diff: diffText,
    };
  }

  if (occurrences === 0 && fuzzy) {
    const normSearch = normalizeForFuzzy(oldString);
    const lines = content.split(/\r?\n/);
    const fuzzyHits: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (normalizeForFuzzy(lines[i]!) === normSearch) fuzzyHits.push(i);
    }
    if (fuzzyHits.length === 1) {
      const replacedLines = [...lines];
      replacedLines[fuzzyHits[0]!] = newString;
      const replaced = applyEol(replacedLines.join("\n"), eol);
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
        changed: replaced !== content,
        replacements: 1,
        linesAdded,
        linesRemoved,
        diff: diffText,
      };
    }
  }

  if (occurrences === 0) {
    return { error: `old_string not found in ${relPath}` };
  }

  return {
    error: `old_string appears ${occurrences} times in ${relPath}; provide more context for a unique match, or set replace_all=true`,
  };
}

export interface WriteFileResult {
  readonly path?: string;
  /** True for content changes and new-file creation, including an empty file. */
  readonly changed?: boolean;
  readonly bytes_written?: number;
  /** 与 edit_file 对齐：结构化 diff 统计，供事件层/UI 展示 */
  readonly linesAdded?: number;
  readonly linesRemoved?: number;
  /** Unified diff 文本（截断 ~2k 字符） */
  readonly diff?: string;
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
    // 写入前读旧内容算 diff 统计；读失败（二进制/权限）不阻断写入
    let oldContent = "";
    const existed = fs.existsSync(d.resolvedPath);
    try {
      oldContent = existed ? fs.readFileSync(d.resolvedPath, "utf8") : "";
    } catch {
      /* best effort */
    }
    if (options.createDirectories) {
      const dir = path.dirname(d.resolvedPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(d.resolvedPath, content, "utf8");
    const { linesAdded, linesRemoved, diffText } = computeDiffStats(
      d.resolvedPath,
      oldContent,
      content,
    );
    return {
      path: relPath,
      changed: !existed || oldContent !== content,
      bytes_written: Buffer.byteLength(content, "utf8"),
      linesAdded,
      linesRemoved,
      diff: diffText,
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
