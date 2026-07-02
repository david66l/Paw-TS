/**
 * 自动上下文发现 — 从用户目标中推断相关文件（无需 @mention）。
 * ==============================================================
 *
 * 策略：
 * 1. 从 goal 中提取关键词（去停用词）
 * 2. 用关键词 grep 代码库
 * 3. 文件评分 = 匹配次数 * 10 + Git 修改加分 + 源码文件加分 - 大文件扣分
 * 4. 读取 top-N 文件并返回内联上下文块
 *
 * 面试要点：
 * - 这是"零配置上下文"的关键：用户不需要 @ 文件，Agent 自动发现相关代码
 * - 评分策略体现了工程直觉：源码文件（.ts/.py 等）加分，JSON/lock/md 文件扣分
 */

import fs from "node:fs";
import path from "node:path";

import { gitStatus } from "./git-tools.js";
import { grepWorkspaceText, readWorkspaceFile } from "./files/read.js";
import { checkWorkspacePath } from "./path-guard.js";

/** Common English stop words to filter from keyword extraction. */
const STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "but",
  "in",
  "on",
  "at",
  "to",
  "for",
  "of",
  "with",
  "by",
  "from",
  "as",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "can",
  "shall",
  "this",
  "that",
  "these",
  "those",
  "i",
  "you",
  "he",
  "she",
  "it",
  "we",
  "they",
  "me",
  "him",
  "her",
  "us",
  "them",
  "my",
  "your",
  "his",
  "its",
  "our",
  "their",
  "what",
  "which",
  "who",
  "when",
  "where",
  "why",
  "how",
  "all",
  "each",
  "every",
  "both",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "no",
  "not",
  "only",
  "own",
  "same",
  "so",
  "than",
  "too",
  "very",
  "just",
  "now",
  "then",
  "also",
  "get",
  "add",
  "fix",
  "make",
  "create",
  "update",
  "change",
  "remove",
  "delete",
  "use",
  "using",
  "need",
  "want",
  "should",
  "please",
  "help",
  "look",
  "see",
  "check",
  "find",
  "search",
  "file",
  "files",
  "code",
  "function",
  "class",
  "method",
  "variable",
  "test",
  "tests",
  "bug",
  "issue",
  "error",
  "problem",
  "feature",
  "implement",
  "write",
  "read",
  "run",
  "build",
  "compile",
  "deploy",
  "install",
  "configure",
  "set",
  "new",
  "old",
  "current",
  "next",
  "previous",
  "first",
  "last",
  "one",
  "two",
  "three",
  "1",
  "2",
  "3",
]);

/** Minimum keyword length to consider. */
const MIN_KEYWORD_LEN = 3;

/** Max files to auto-discover. */
const MAX_AUTO_CONTEXT_FILES = 8;

/** Max chars per file to include in context. */
const MAX_FILE_CHARS = 8_000;

export interface AutoContextResult {
  readonly content: string;
  readonly filesRead: readonly string[];
  readonly filesNotFound: readonly string[];
}

function extractKeywords(goal: string): string[] {
  const words = goal
    .toLowerCase()
    .replace(/[^a-z0-9_./-]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= MIN_KEYWORD_LEN && !STOP_WORDS.has(w));
  // Deduplicate while preserving order
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of words) {
    if (!seen.has(w)) {
      seen.add(w);
      out.push(w);
    }
  }
  return out.slice(0, 8); // cap at 8 keywords
}

function scoreFile(
  filePath: string,
  matchCount: number,
  modifiedFiles: Set<string>,
): number {
  let score = matchCount * 10;
  // Boost recently modified files
  if (modifiedFiles.has(filePath)) {
    score += 50;
  }
  // Penalize very large files (likely generated/vendor)
  const ext = path.extname(filePath);
  if ([".json", ".lock", ".log", ".md", ".txt"].includes(ext)) {
    score -= 20;
  }
  // Boost source code files
  if (
    [".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".go", ".java"].includes(ext)
  ) {
    score += 15;
  }
  return score;
}

/**
 * Discover relevant files for a goal and return formatted context.
 */
export function discoverContext(
  workspaceRoot: string,
  goal: string,
  excludeFiles?: readonly string[],
): AutoContextResult {
  const keywords = extractKeywords(goal);
  if (keywords.length === 0) {
    return { content: "", filesRead: [], filesNotFound: [] };
  }

  // Gather recently modified files from git
  const git = gitStatus(workspaceRoot);
  const modifiedFiles = new Set<string>([
    ...(git.modified ?? []),
    ...(git.staged ?? []),
  ]);

  // Grep for each keyword
  const fileScores = new Map<string, number>();
  for (const keyword of keywords) {
    const result = grepWorkspaceText(workspaceRoot, ".", {
      pattern: keyword,
      regex: false,
      caseSensitive: false,
      outputMode: "files_with_matches",
      maxResults: 20,
      maxDepth: 6,
    });
    if (result.error || result.mode !== "files_with_matches") continue;
    for (const f of result.filenames ?? []) {
      const current = fileScores.get(f) ?? 0;
      fileScores.set(f, current + 1);
    }
  }

  // Score and rank
  const scored = Array.from(fileScores.entries()).map(([filePath, count]) => ({
    filePath,
    score: scoreFile(filePath, count, modifiedFiles),
  }));
  scored.sort((a, b) => b.score - a.score);

  // Read top files
  const filesRead: string[] = [];
  const filesNotFound: string[] = [];
  const blocks: string[] = [];

  for (const { filePath } of scored.slice(0, MAX_AUTO_CONTEXT_FILES)) {
    if (excludeFiles?.includes(filePath)) continue;
    const result = readWorkspaceFile(workspaceRoot, filePath, {
      limit: Math.floor(MAX_FILE_CHARS / 80), // rough line estimate
    });
    if (result.error || result.content === undefined) {
      filesNotFound.push(filePath);
      continue;
    }
    let content = result.content;
    if (content.length > MAX_FILE_CHARS) {
      content = `${content.slice(0, MAX_FILE_CHARS)}\n... (truncated)`;
    }
    blocks.push(`<file path="${filePath}">\n${content}\n</file>`);
    filesRead.push(filePath);
  }

  if (blocks.length === 0) {
    return { content: "", filesRead, filesNotFound };
  }

  const content = `<auto-context>\n${blocks.join("\n\n")}\n</auto-context>`;
  return { content, filesRead, filesNotFound };
}

export interface BriefOptions {
  /** 要扫描的子目录路径（相对于工作区根目录），默认为 "." */
  readonly path?: string;
  /** 最多扫描的文件数量，默认 50 */
  readonly maxFiles?: number;
}

/** brief 功能的返回结果 */
export interface BriefResult {
  /** 生成的摘要文本 */
  readonly summary?: string;
  /** 实际扫描的文件数量 */
  readonly filesScanned?: number;
  /** 错误信息（如有） */
  readonly error?: string;
}

/** 内部使用的文件信息结构 */
interface FileInfo {
  name: string;
  relPath: string;
  size: number;
}

/**
 * 判断文件名是否属于关键配置文件。
 * 包含常见的包管理器配置、构建工具配置、CI/CD 配置等。
 */
function isConfigFile(name: string): boolean {
  const configNames = new Set([
    "package.json",
    "pyproject.toml",
    "cargo.toml",
    "composer.json",
    "go.mod",
    "build.gradle",
    "pom.xml",
    "requirements.txt",
    "setup.py",
    "setup.cfg",
    "Gemfile",
    "mix.exs",
    "project.clj",
    "build.sbt",
    "dune-project",
    "CMakeLists.txt",
    "Makefile",
    "Dockerfile",
    "docker-compose.yml",
    ".gitignore",
    "tsconfig.json",
    "jsconfig.json",
    "vite.config.ts",
    "vite.config.js",
    "webpack.config.js",
    "rollup.config.js",
    "next.config.js",
    "tailwind.config.js",
    "jest.config.js",
    "pytest.ini",
    "tox.ini",
    ".github",
  ]);
  return configNames.has(name.toLowerCase());
}

/** 判断文件名是否为 README 文件（不区分大小写） */
function isReadme(name: string): boolean {
  return /^readme/i.test(name);
}

/**
 * 判断文件是否为源代码文件。
 * 覆盖了 TypeScript、JavaScript、Python、Rust、Go、Java、Kotlin、
 * Scala、Ruby、PHP、C#、C/C++、Swift、Objective-C、R、Perl、Shell、
 * Lua、Elixir、Clojure、Haskell、Elm、Erlang、F#、OCaml、Dart、
 * Groovy、Nim、Vue、Svelte、Astro、Solid 等主流语言的扩展名。
 */
function isSourceFile(name: string): boolean {
  const ext = path.extname(name).toLowerCase();
  return [
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".py",
    ".rs",
    ".go",
    ".java",
    ".kt",
    ".scala",
    ".rb",
    ".php",
    ".cs",
    ".cpp",
    ".c",
    ".h",
    ".hpp",
    ".swift",
    ".m",
    ".mm",
    ".r",
    ".pl",
    ".sh",
    ".bat",
    ".ps1",
    ".lua",
    ".ex",
    ".exs",
    ".clj",
    ".cljs",
    ".hs",
    ".elm",
    ".erl",
    ".fs",
    ".fsx",
    ".ml",
    ".mli",
    ".dart",
    ".groovy",
    ".nim",
    ".vue",
    ".svelte",
    ".astro",
    ".solid",
  ].includes(ext);
}

/** 统计各文件扩展名的出现次数，用于展示项目的语言分布 */
function countByExtension(files: FileInfo[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const f of files) {
    const ext = path.extname(f.name).toLowerCase() || "(no ext)";
    counts[ext] = (counts[ext] || 0) + 1;
  }
  return counts;
}

/**
 * 根据工作区中存在的标志性文件推断项目类型。
 *
 * 推断规则（按优先级）：
 * 1. package.json 存在 → 检查 next/vite 配置文件，否则归类为 Node.js
 * 2. pyproject.toml / setup.py / requirements.txt → Python
 * 3. cargo.toml → Rust
 * 4. go.mod → Go
 * 5. composer.json → PHP
 * 6. Gemfile → Ruby
 * 7. pom.xml / build.gradle → Java/JVM
 * 8. Dockerfile / docker-compose.yml → Docker
 * 9. 以上都不匹配 → Unknown
 */
function detectProjectType(files: FileInfo[]): string {
  const names = new Set(files.map((f) => f.name.toLowerCase()));
  if (names.has("package.json")) {
    if (
      files.some(
        (f) =>
          f.name === "next.config.js" ||
          f.name === "next.config.ts" ||
          f.name === "next.config.mjs",
      )
    ) {
      return "Next.js";
    }
    if (
      files.some(
        (f) => f.name === "vite.config.ts" || f.name === "vite.config.js",
      )
    ) {
      return "Vite";
    }
    if (
      files.some(
        (f) => f.relPath.includes("src/app") || f.relPath.includes("app/"),
      )
    ) {
      return "Next.js App Router";
    }
    return "Node.js / JavaScript";
  }
  if (
    names.has("pyproject.toml") ||
    names.has("setup.py") ||
    names.has("requirements.txt")
  ) {
    return "Python";
  }
  if (names.has("cargo.toml")) {
    return "Rust";
  }
  if (names.has("go.mod")) {
    return "Go";
  }
  if (names.has("composer.json")) {
    return "PHP";
  }
  if (names.has("gemfile")) {
    return "Ruby";
  }
  if (
    names.has("pom.xml") ||
    names.has("build.gradle") ||
    names.has("build.gradle.kts")
  ) {
    return "Java / JVM";
  }
  if (
    names.has("dockerfile") ||
    names.has("docker-compose.yml") ||
    names.has("docker-compose.yaml")
  ) {
    return "Docker";
  }
  return "Unknown";
}

/**
 * 读取文件的前 maxBytes 个字节，并截断到最后一个完整行。
 * 避免返回被截断的半行文本，确保输出整洁。
 *
 * @returns 文件内容片段，或 null（读取失败时）
 */
function readFileSnippet(
  workspaceRoot: string,
  relPath: string,
  maxBytes: number,
): string | null {
  try {
    const p = path.join(workspaceRoot, relPath);
    const fd = fs.openSync(p, "r");
    const buf = Buffer.alloc(maxBytes);
    const n = fs.readSync(fd, buf, 0, maxBytes, 0);
    fs.closeSync(fd);
    let text = buf.toString("utf8", 0, n);
    // 截断到最后一个换行符，避免返回不完整的行
    const lastNL = text.lastIndexOf("\n");
    if (lastNL > 0 && n === maxBytes) {
      text = text.slice(0, lastNL);
    }
    return text;
  } catch {
    return null;
  }
}

/**
 * 生成项目摘要。
 *
 * 扫描目标路径下的文件，收集文件信息，然后输出：
 * - 项目类型
 * - 文件数量统计
 * - 文件类型分布（Top 5 扩展名）
 * - README 文件摘要（最多 2 个）
 * - 关键配置文件内容（最多 5 个）
 *
 * @param workspaceRoot 工作区根目录的绝对路径
 * @param opts 可选配置：目标子路径和最大文件数
 * @returns 包含 summary 文本和 filesScanned 计数的结果
 */
export function generateBrief(
  workspaceRoot: string,
  opts?: BriefOptions,
): BriefResult {
  const targetPath = opts?.path?.trim() ? opts.path : ".";
  // 安全检查：确保目标路径在工作区范围内
  const guard = checkWorkspacePath(workspaceRoot, targetPath);
  if (!guard.allowed) {
    return { error: guard.reason };
  }

  const baseDir = guard.resolvedPath;
  const maxFiles = opts?.maxFiles ?? 50;

  let files: FileInfo[] = [];
  try {
    files = collectFiles(baseDir, baseDir, maxFiles);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { error: msg };
  }

  if (files.length === 0) {
    return { summary: "Empty workspace.", filesScanned: 0 };
  }

  const projectType = detectProjectType(files);
  const extCounts = countByExtension(files);
  // 取 Top 5 扩展名
  const topExts = Object.entries(extCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  const configFiles = files.filter((f) => isConfigFile(f.name));
  const readmeFiles = files.filter((f) => isReadme(f.name));
  const sourceFiles = files.filter((f) => isSourceFile(f.name));

  const lines: string[] = [];
  lines.push(`Project type: ${projectType}`);
  lines.push(`Files scanned: ${files.length}`);
  lines.push(`Source files: ${sourceFiles.length}`);
  lines.push("");

  if (topExts.length > 0) {
    lines.push("Top file types:");
    for (const [ext, count] of topExts) {
      lines.push(`  ${ext}: ${count}`);
    }
    lines.push("");
  }

  // 读取 README 文件摘要（最多 2 个，每个最多 600 字符）
  if (readmeFiles.length > 0) {
    lines.push("README snippets:");
    for (const f of readmeFiles.slice(0, 2)) {
      const snippet = readFileSnippet(baseDir, f.relPath, 800);
      if (snippet) {
        lines.push(`--- ${f.relPath} ---`);
        lines.push(snippet.slice(0, 600));
        lines.push("");
      }
    }
  }

  // 读取关键配置文件内容（最多 5 个，每个最多 400 字符）
  if (configFiles.length > 0) {
    lines.push("Key config files:");
    for (const f of configFiles.slice(0, 5)) {
      const snippet = readFileSnippet(baseDir, f.relPath, 600);
      if (snippet) {
        lines.push(`--- ${f.relPath} ---`);
        lines.push(snippet.slice(0, 400));
        lines.push("");
      }
    }
  }

  return {
    summary: lines.join("\n"),
    filesScanned: files.length,
  };
}

/**
 * 递归收集目录下的文件信息。
 *
 * 安全策略：
 * - 最大递归深度 4 层，防止无限深入
 * - 硬编码忽略目录列表（node_modules、.git 等），排除噪声
 * - 到达 maxFiles 上限后停止收集
 *
 * @param baseDir 基准目录（用于计算相对路径）
 * @param dir 当前扫描的目录
 * @param maxFiles 剩余可收集的文件数量上限
 * @param depth 当前递归深度
 * @returns 收集到的文件信息列表
 */
function collectFiles(
  baseDir: string,
  dir: string,
  maxFiles: number,
  depth = 0,
): FileInfo[] {
  if (depth > 4) {
    return [];
  }
  const IGNORE_DIRS = new Set([
    ".git",
    "node_modules",
    "__pycache__",
    ".venv",
    "venv",
    "target",
    "dist",
    "build",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    ".coverage",
    "vendor",
    ".claude",
  ]);
  const results: FileInfo[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (results.length >= maxFiles) break;
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      results.push(
        ...collectFiles(
          baseDir,
          path.join(dir, entry.name),
          // 动态计算剩余配额，确保不超出 maxFiles
          maxFiles - results.length,
          depth + 1,
        ),
      );
    } else if (entry.isFile()) {
      const fullPath = path.join(dir, entry.name);
      const stat = fs.statSync(fullPath);
      results.push({
        name: entry.name,
        relPath: path.relative(baseDir, fullPath),
        size: stat.size,
      });
    }
  }
  return results;
}
