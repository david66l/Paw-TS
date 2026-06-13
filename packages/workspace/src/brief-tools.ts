/**
 * BriefTool — generate a concise project summary from workspace files.
 */

import fs from "node:fs";
import path from "node:path";

import { checkWorkspacePath } from "./path-guard.js";

export interface BriefOptions {
  readonly path?: string;
  readonly maxFiles?: number;
}

export interface BriefResult {
  readonly summary?: string;
  readonly filesScanned?: number;
  readonly error?: string;
}

interface FileInfo {
  name: string;
  relPath: string;
  size: number;
}

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

function isReadme(name: string): boolean {
  return /^readme/i.test(name);
}

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

function countByExtension(files: FileInfo[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const f of files) {
    const ext = path.extname(f.name).toLowerCase() || "(no ext)";
    counts[ext] = (counts[ext] || 0) + 1;
  }
  return counts;
}

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
    // truncate at last newline to avoid partial lines
    const lastNL = text.lastIndexOf("\n");
    if (lastNL > 0 && n === maxBytes) {
      text = text.slice(0, lastNL);
    }
    return text;
  } catch {
    return null;
  }
}

export function generateBrief(
  workspaceRoot: string,
  opts?: BriefOptions,
): BriefResult {
  const targetPath = opts?.path?.trim() ? opts.path : ".";
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
