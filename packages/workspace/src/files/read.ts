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

import { checkWorkspacePath } from "../path-guard.js";

const LIST_IGNORE_DIR = new Set([
  ".git",
  ".paw",
  "__pycache__",
  ".pytest_cache",
  ".venv",
  "venv",
  "node_modules",
  "vendor",
  "target",
  ".mypy_cache",
  ".ruff_cache",
  ".coverage",
  "dist",
  "build",
]);

const MAX_LIST_FILES = 200;

function fnmatchLite(fileName: string, pattern: string | undefined): boolean {
  if (!pattern) {
    return true;
  }
  if (!pattern.includes("*") && !pattern.includes("?")) {
    return fileName === pattern;
  }
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `^${escaped.replaceAll("?", ".").replaceAll("*", ".*")}$`,
  );
  return re.test(fileName);
}

function depthFromDir(dirpath: string, filePath: string): number {
  const rel = path.relative(dirpath, filePath);
  if (!rel || rel === ".") {
    return 0;
  }
  return rel.split(path.sep).length;
}

function isIgnoredUnderDir(relParts: string[]): boolean {
  return relParts.some((p) => LIST_IGNORE_DIR.has(p));
}


export interface ReadFileResult {
  readonly path?: string;
  readonly content?: string;
  readonly line_count?: number;
  readonly total_lines?: number;
  readonly size?: number;
  readonly error?: string;
}

export function readWorkspaceFile(
  workspaceRoot: string,
  relPath: string,
  options: { encoding?: BufferEncoding; limit?: number; offset?: number } = {},
): ReadFileResult {
  const { encoding = "utf8", limit, offset = 0 } = options;
  const d = checkWorkspacePath(workspaceRoot, relPath);
  if (!d.allowed) {
    return { error: `Path escapes workspace: ${relPath}`, content: "" };
  }
  const filepath = d.resolvedPath;
  if (!fs.existsSync(filepath) || !fs.statSync(filepath).isFile()) {
    return { error: `File not found: ${relPath}`, content: "" };
  }
  const allText = fs.readFileSync(filepath, { encoding });
  const allLines = allText.split(/\r?\n/);
  const total_lines = allLines.length;
  let lines = allLines;
  if (offset > 0) {
    lines = lines.slice(offset);
  }
  if (limit !== undefined) {
    lines = lines.slice(0, limit);
  }
  const content = lines.join("\n");
  return {
    path: filepath,
    content,
    line_count: lines.length,
    total_lines,
    size: content.length,
  };
}

export interface ListFilesResult {
  readonly directory?: string;
  readonly file_count?: number;
  /**
   * Entry names relative to `directory`.
   * Directories end with `/` so agents can tell them from files.
   */
  readonly files?: string[];
  readonly truncated?: boolean;
  readonly error?: string;
}

/** Normalize a relative path to posix and mark directories with trailing `/`. */
function formatListEntry(relPath: string, isDirectory: boolean): string {
  const posix = relPath.split(path.sep).join("/");
  if (!isDirectory) {
    return posix;
  }
  return posix.endsWith("/") ? posix : `${posix}/`;
}

export function listWorkspaceFiles(
  workspaceRoot: string,
  directory: string,
  options: { pattern?: string; recursive?: boolean; maxDepth?: number } = {},
): ListFilesResult {
  const { pattern, recursive = false, maxDepth = 3 } = options;
  const d = checkWorkspacePath(workspaceRoot, directory);
  if (!d.allowed) {
    return { error: `Directory escapes workspace: ${directory}`, files: [] };
  }
  const dirpath = d.resolvedPath;
  if (!fs.existsSync(dirpath) || !fs.statSync(dirpath).isDirectory()) {
    return { error: `Directory not found: ${directory}`, files: [] };
  }

  const collected: string[] = [];

  if (!recursive) {
    for (const ent of fs.readdirSync(dirpath, { withFileTypes: true })) {
      const isDir = ent.isDirectory();
      const isFile = ent.isFile();
      if (!isDir && !isFile) {
        continue;
      }
      if (!fnmatchLite(ent.name, pattern)) {
        continue;
      }
      if (isIgnoredUnderDir([ent.name])) {
        continue;
      }
      collected.push(formatListEntry(ent.name, isDir));
    }
  } else {
    const walk = (current: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of entries) {
        const full = path.join(current, ent.name);
        const relToListRoot = path.relative(dirpath, full);
        const relParts = relToListRoot
          .split(path.sep)
          .filter((p) => p.length > 0);
        if (isIgnoredUnderDir(relParts)) {
          continue;
        }
        if (ent.isDirectory()) {
          if (depthFromDir(dirpath, full) > maxDepth) {
            continue;
          }
          // Include the directory itself so agents can see structure.
          if (fnmatchLite(ent.name, pattern)) {
            collected.push(formatListEntry(relToListRoot, true));
          }
          walk(full);
        } else if (ent.isFile()) {
          if (!fnmatchLite(ent.name, pattern)) {
            continue;
          }
          collected.push(formatListEntry(relToListRoot, false));
        }
      }
    };
    walk(dirpath);
  }

  // Directories first (trailing `/`), then files; stable locale sort within each.
  const sorted = [...collected].sort((a, b) => {
    const aDir = a.endsWith("/");
    const bDir = b.endsWith("/");
    if (aDir !== bDir) {
      return aDir ? -1 : 1;
    }
    return a.localeCompare(b);
  });
  const truncated = sorted.length > MAX_LIST_FILES;
  const files = sorted.slice(0, MAX_LIST_FILES);
  return {
    directory: dirpath,
    file_count: files.length,
    files,
    truncated,
  };
}

const MAX_SEARCH_RESULTS_DEFAULT = 50;
const MAX_SEARCH_RESULTS_CAP = 200;
const MAX_SEARCH_FILE_BYTES = 512 * 1024;
const DEFAULT_SEARCH_DEPTH = 4;

export interface SearchMatch {
  /** Path relative to workspace root (posix-style separators). */
  readonly path: string;
  /** 1-based line number. */
  readonly line: number;
  readonly text: string;
}

export interface SearchTextResult {
  readonly matches?: SearchMatch[];
  readonly match_count?: number;
  readonly truncated?: boolean;
  readonly scanned_files?: number;
  readonly error?: string;
}

/**
 * Search for a literal substring or regex in UTF-8 text files under the workspace.
 * Skips binary-ish content and large files; ignores the same directory names as {@link listWorkspaceFiles}.
 */
export function searchWorkspaceText(
  workspaceRoot: string,
  relPath: string,
  options: {
    pattern: string;
    filePattern?: string;
    maxResults?: number;
    caseSensitive?: boolean;
    regex?: boolean;
    maxDepth?: number;
  },
): SearchTextResult {
  const {
    pattern,
    filePattern,
    maxResults = MAX_SEARCH_RESULTS_DEFAULT,
    caseSensitive = false,
    regex = false,
    maxDepth = DEFAULT_SEARCH_DEPTH,
  } = options;

  const cap = Math.min(
    Math.max(1, Math.floor(maxResults)),
    MAX_SEARCH_RESULTS_CAP,
  );

  const d = checkWorkspacePath(workspaceRoot, relPath);
  if (!d.allowed) {
    return { error: `Path escapes workspace: ${relPath}` };
  }
  const target = d.resolvedPath;
  if (!fs.existsSync(target)) {
    return { error: `Path not found: ${relPath}` };
  }

  let matcher: (line: string) => boolean;
  if (regex) {
    try {
      const re = new RegExp(pattern, caseSensitive ? "" : "i");
      matcher = (line) => re.test(line);
    } catch {
      return { error: "invalid regex pattern" };
    }
  } else {
    const needle = caseSensitive ? pattern : pattern.toLowerCase();
    matcher = (line) => {
      const hay = caseSensitive ? line : line.toLowerCase();
      return hay.includes(needle);
    };
  }

  const matches: SearchMatch[] = [];
  let scanned = 0;

  const relPosix = (fullPath: string) =>
    path.relative(workspaceRoot, fullPath).split(path.sep).join("/");

  const tryFile = (fullPath: string) => {
    if (matches.length >= cap) {
      return;
    }
    let st: fs.Stats;
    try {
      st = fs.statSync(fullPath);
    } catch {
      return;
    }
    if (!st.isFile() || st.size > MAX_SEARCH_FILE_BYTES) {
      return;
    }
    scanned += 1;
    let content: string;
    try {
      content = fs.readFileSync(fullPath, { encoding: "utf8" });
    } catch {
      return;
    }
    if (content.includes("\u0000")) {
      return;
    }
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (matches.length >= cap) {
        return;
      }
      const line = lines[i] ?? "";
      if (matcher(line)) {
        matches.push({
          path: relPosix(fullPath),
          line: i + 1,
          text: line.slice(0, 400),
        });
      }
    }
  };

  const st = fs.statSync(target);
  if (st.isFile()) {
    if (!fnmatchLite(path.basename(target), filePattern)) {
      return {
        matches: [],
        match_count: 0,
        truncated: false,
        scanned_files: 0,
      };
    }
    tryFile(target);
    return {
      matches,
      match_count: matches.length,
      truncated: matches.length >= cap,
      scanned_files: scanned,
    };
  }
  if (!st.isDirectory()) {
    return { error: `Not a file or directory: ${relPath}` };
  }

  const searchRoot = target;
  const walk = (current: string) => {
    if (matches.length >= cap) {
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (matches.length >= cap) {
        return;
      }
      const full = path.join(current, ent.name);
      const relToWs = path.relative(workspaceRoot, full);
      const relParts = relToWs.split(path.sep).filter((p) => p.length > 0);
      if (isIgnoredUnderDir(relParts)) {
        continue;
      }
      if (ent.isDirectory()) {
        if (depthFromDir(searchRoot, full) > maxDepth) {
          continue;
        }
        walk(full);
      } else if (ent.isFile()) {
        if (!fnmatchLite(ent.name, filePattern)) {
          continue;
        }
        tryFile(full);
      }
    }
  };

  walk(searchRoot);

  return {
    matches,
    match_count: matches.length,
    truncated: matches.length >= cap,
    scanned_files: scanned,
  };
}

// --- Glob support ---

function globToRegex(pattern: string): RegExp {
  let regex = "^";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern.charAt(i);
    if (c === "*") {
      regex += "[^/]*";
      i++;
    } else if (c === "?") {
      regex += "[^/]";
      i++;
    } else if (/[.+^${}()|[\]\\]/.test(c)) {
      regex += `\\${c}`;
      i++;
    } else {
      regex += c;
      i++;
    }
  }
  regex += "$";
  return new RegExp(regex);
}

/** Match a relative POSIX path against a glob pattern supporting `**`. */
function matchGlobPattern(filePath: string, pattern: string): boolean {
  const fp = filePath.replace(/\\/g, "/");
  const pat = pattern.replace(/\\/g, "/");

  // **/suffix
  if (pat.startsWith("**/")) {
    const suffix = pat.slice(3);
    const suffixRe = globToRegex(suffix);
    const parts = fp.split("/");
    for (let i = 0; i < parts.length; i++) {
      const subPath = parts.slice(i).join("/");
      if (suffixRe.test(subPath)) {
        return true;
      }
    }
    return false;
  }

  // prefix/**/suffix
  const idx = pat.indexOf("/**/");
  if (idx >= 0) {
    const prefix = pat.slice(0, idx);
    const suffix = pat.slice(idx + 4);
    if (!fp.startsWith(prefix)) {
      return false;
    }
    const rest = fp.slice(prefix.length);
    const parts = rest.split("/").filter((p) => p.length > 0);
    const suffixRe = globToRegex(suffix);
    for (let i = 0; i < parts.length; i++) {
      const subPath = parts.slice(i).join("/");
      if (suffixRe.test(subPath)) {
        return true;
      }
    }
    return false;
  }

  return globToRegex(pat).test(fp);
}

const MAX_GLOB_RESULTS = 200;
const DEFAULT_GLOB_MAX_DEPTH = 6;

export interface GlobResult {
  readonly filenames?: string[];
  readonly numFiles?: number;
  readonly truncated?: boolean;
  readonly error?: string;
}

/** Recursively list files matching a glob pattern under the workspace root. */
export function globWorkspaceFiles(
  workspaceRoot: string,
  relPath: string,
  options: { pattern: string; maxDepth?: number } = { pattern: "*" },
): GlobResult {
  const { pattern, maxDepth = DEFAULT_GLOB_MAX_DEPTH } = options;
  const d = checkWorkspacePath(workspaceRoot, relPath);
  if (!d.allowed) {
    return { error: d.reason };
  }
  const target = d.resolvedPath;
  if (!fs.existsSync(target)) {
    return { error: `Path not found: ${relPath}` };
  }
  const st = fs.statSync(target);
  if (!st.isDirectory()) {
    return { error: `Not a directory: ${relPath}` };
  }

  const files: string[] = [];
  const cap = MAX_GLOB_RESULTS;

  const relPosix = (fullPath: string) =>
    path.relative(workspaceRoot, fullPath).split(path.sep).join("/");

  const walk = (current: string) => {
    if (files.length >= cap) {
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (files.length >= cap) {
        return;
      }
      const full = path.join(current, ent.name);
      const relToWs = path.relative(workspaceRoot, full);
      const relParts = relToWs.split(path.sep).filter((p) => p.length > 0);
      if (isIgnoredUnderDir(relParts)) {
        continue;
      }
      if (ent.isDirectory()) {
        if (depthFromDir(target, full) > maxDepth) {
          continue;
        }
        walk(full);
      } else if (ent.isFile()) {
        const relPathStr = relPosix(full);
        if (matchGlobPattern(relPathStr, pattern)) {
          files.push(relPathStr);
        }
      }
    }
  };

  walk(target);

  const sorted = [...files].sort((a, b) => a.localeCompare(b));
  return {
    filenames: sorted,
    numFiles: sorted.length,
    truncated: files.length >= cap,
  };
}

// --- Grep support ---

export interface GrepMatch {
  readonly path: string;
  readonly line: number;
  readonly text: string;
  readonly before?: string[];
  readonly after?: string[];
}

export interface GrepResult {
  readonly mode?: "content" | "files_with_matches" | "count";
  readonly matches?: GrepMatch[];
  readonly match_count?: number;
  readonly filenames?: string[];
  readonly content?: string;
  readonly truncated?: boolean;
  readonly error?: string;
}

function applyHeadLimit<T>(
  items: T[],
  limit: number | undefined,
  offset = 0,
): { items: T[]; wasTruncated: boolean } {
  if (limit === 0 || limit === undefined) {
    return { items: items.slice(offset), wasTruncated: false };
  }
  const sliced = items.slice(offset, offset + limit);
  return { items: sliced, wasTruncated: items.length > offset + limit };
}

function formatGrepContent(
  matches: GrepMatch[],
  showLineNumbers: boolean,
): string {
  const lines: string[] = [];
  let lastPath = "";
  for (const m of matches) {
    if (m.path !== lastPath) {
      if (lastPath) {
        lines.push("");
      }
      lines.push(`─── ${m.path} ───`);
      lastPath = m.path;
    }
    if (m.before) {
      for (const b of m.before) {
        lines.push(showLineNumbers ? `  ${b}` : `  ${b}`);
      }
    }
    const prefix = showLineNumbers ? `${m.line}:` : ">>>";
    lines.push(`${prefix} ${m.text}`);
    if (m.after) {
      for (const a of m.after) {
        lines.push(showLineNumbers ? `  ${a}` : `  ${a}`);
      }
    }
  }
  return lines.join("\n");
}

/** Enhanced search with context lines, output modes, and pagination. */
export function grepWorkspaceText(
  workspaceRoot: string,
  relPath: string,
  options: {
    pattern: string;
    regex?: boolean;
    caseSensitive?: boolean;
    filePattern?: string;
    maxResults?: number;
    maxDepth?: number;
    outputMode?: "content" | "files_with_matches" | "count";
    contextBefore?: number;
    contextAfter?: number;
    context?: number;
    showLineNumbers?: boolean;
    headLimit?: number;
    offset?: number;
  },
): GrepResult {
  const {
    outputMode = "files_with_matches",
    contextBefore = 0,
    contextAfter = 0,
    context = 0,
    showLineNumbers = true,
    headLimit,
    offset = 0,
    ...searchOpts
  } = options;

  const actualBefore = context > 0 ? context : contextBefore;
  const actualAfter = context > 0 ? context : contextAfter;

  const searchResult = searchWorkspaceText(workspaceRoot, relPath, searchOpts);
  if (searchResult.error) {
    return { error: searchResult.error };
  }

  const matches = searchResult.matches ?? [];

  if (outputMode === "count") {
    return {
      mode: "count",
      match_count: matches.length,
    };
  }

  if (outputMode === "files_with_matches") {
    const filenames = [...new Set(matches.map((m) => m.path))];
    const { items, wasTruncated } = applyHeadLimit(
      filenames,
      headLimit,
      offset,
    );
    return {
      mode: "files_with_matches",
      filenames: items,
      match_count: matches.length,
      truncated: wasTruncated,
    };
  }

  // content mode: extract context lines
  const fileCache = new Map<string, string[]>();
  const grepMatches: GrepMatch[] = [];

  for (const m of matches) {
    let lines = fileCache.get(m.path);
    if (!lines) {
      try {
        const filepath = path.join(workspaceRoot, m.path);
        const content = fs.readFileSync(filepath, { encoding: "utf8" });
        lines = content.split(/\r?\n/);
        fileCache.set(m.path, lines);
      } catch {
        continue;
      }
    }
    const lineIdx = m.line - 1;
    const before =
      actualBefore > 0
        ? lines.slice(Math.max(0, lineIdx - actualBefore), lineIdx)
        : undefined;
    const after =
      actualAfter > 0
        ? lines.slice(
            lineIdx + 1,
            Math.min(lines.length, lineIdx + 1 + actualAfter),
          )
        : undefined;
    grepMatches.push({
      path: m.path,
      line: m.line,
      text: m.text,
      ...(before ? { before } : {}),
      ...(after ? { after } : {}),
    });
  }

  const { items, wasTruncated } = applyHeadLimit(
    grepMatches,
    headLimit,
    offset,
  );
  const formatted = formatGrepContent(items, showLineNumbers);

  return {
    mode: "content",
    content: formatted,
    match_count: grepMatches.length,
    truncated: wasTruncated,
  };
}
