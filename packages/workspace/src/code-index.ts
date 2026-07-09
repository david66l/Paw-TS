import fs from "node:fs";
import path from "node:path";
import { discoverContext } from "./project-context.js";

export interface CodeContextBlock {
  readonly path: string;
  readonly symbols: readonly string[];
  readonly tests: readonly string[];
  readonly reason: string;
}

interface IndexedFile extends CodeContextBlock {
  readonly kind: "source" | "test" | "config" | "doc" | "other";
}

interface CodeIndex {
  readonly version: 1;
  readonly createdAt: number;
  readonly files: readonly IndexedFile[];
}

const IGNORE_DIRS = new Set([
  ".git",
  ".paw",
  "node_modules",
  "dist",
  "build",
  "target",
  "coverage",
  ".next",
]);

const SOURCE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".py", ".go", ".rs", ".java"]);
const MAX_FILES = 1_000;
const MAX_FILE_BYTES = 256 * 1024;

export function selectCodeContext(
  workspaceRoot: string,
  query: string,
  mentionedPaths: readonly string[] = [],
  limit = 5,
): readonly CodeContextBlock[] {
  const index = buildCodeIndex(workspaceRoot);
  const wanted = new Set(mentionedPaths.map(normalizeRel));
  const terms = tokenize(query);
  const scored = index.files
    .map((file) => ({ file, score: scoreFile(file, terms, wanted) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ file }) => ({
      path: file.path,
      symbols: file.symbols,
      tests: file.tests,
      reason: file.reason,
    }));

  if (scored.length > 0) return scored;

  const fallback = discoverContext(workspaceRoot, query, mentionedPaths);
  return fallback.filesRead.slice(0, limit).map((file) => ({
    path: normalizeRel(file),
    symbols: [],
    tests: [],
    reason: "discoverContext fallback",
  }));
}

export function buildCodeIndex(workspaceRoot: string): CodeIndex {
  const files = walkFiles(workspaceRoot)
    .map((file) => indexFile(workspaceRoot, file))
    .filter((file): file is IndexedFile => file !== null);
  const index: CodeIndex = { version: 1, createdAt: Date.now(), files };
  writeIndex(workspaceRoot, index);
  return index;
}

function writeIndex(workspaceRoot: string, index: CodeIndex): void {
  try {
    const dir = path.join(workspaceRoot, ".paw", "code-index");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(indexPath(workspaceRoot, "repo-map.json"), JSON.stringify(index, null, 2), "utf8");
    fs.writeFileSync(indexPath(workspaceRoot, "symbols.json"), JSON.stringify(symbolsIndex(index), null, 2), "utf8");
    fs.writeFileSync(indexPath(workspaceRoot, "test-map.json"), JSON.stringify(testIndex(index), null, 2), "utf8");
  } catch {
    // ponytail: cache write is best-effort; rebuild in memory if the filesystem says no.
  }
}

function indexPath(workspaceRoot: string, name: string): string {
  return path.join(workspaceRoot, ".paw", "code-index", name);
}

function walkFiles(workspaceRoot: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (out.length >= MAX_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (out.length >= MAX_FILES) break;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (!IGNORE_DIRS.has(ent.name)) walk(full);
      } else if (ent.isFile()) {
        out.push(full);
      }
    }
  };
  walk(workspaceRoot);
  return out;
}

function indexFile(workspaceRoot: string, file: string): IndexedFile | null {
  const rel = normalizeRel(path.relative(workspaceRoot, file));
  const ext = path.extname(rel).toLowerCase();
  const kind = fileKind(rel);
  let text = "";
  if (SOURCE_EXTS.has(ext)) {
    try {
      const stat = fs.statSync(file);
      if (stat.size <= MAX_FILE_BYTES) text = fs.readFileSync(file, "utf8");
    } catch {
      text = "";
    }
  }
  const symbols = extractSymbols(text);
  const tests = extractTests(text, rel);
  return {
    path: rel,
    kind,
    symbols,
    tests,
    reason: symbols.length > 0 ? `symbols: ${symbols.slice(0, 3).join(", ")}` : kind,
  };
}

function scoreFile(file: IndexedFile, terms: readonly string[], mentioned: Set<string>): number {
  let score = mentioned.has(file.path) ? 100 : 0;
  const haystack = `${file.path} ${file.symbols.join(" ")} ${file.tests.join(" ")}`.toLowerCase();
  for (const term of terms) {
    if (path.basename(file.path).toLowerCase().includes(term)) score += 8;
    if (file.path.toLowerCase().includes(term)) score += 4;
    if (haystack.includes(term)) score += 6;
  }
  if (file.kind === "source") score += 2;
  if (file.kind === "test" && terms.some((t) => t.includes("test") || t.includes("spec"))) score += 8;
  return score;
}

function extractSymbols(text: string): string[] {
  const symbols = new Set<string>();
  const re = /\b(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
  for (const match of text.matchAll(re)) {
    if (match[1]) symbols.add(match[1]);
    if (symbols.size >= 20) break;
  }
  return [...symbols];
}

function extractTests(text: string, rel: string): string[] {
  const tests = new Set<string>();
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(rel)) tests.add(path.basename(rel));
  const re = /\b(?:test|it|describe)\s*\(\s*["'`]([^"'`]{1,120})/g;
  for (const match of text.matchAll(re)) {
    if (match[1]) tests.add(match[1]);
    if (tests.size >= 20) break;
  }
  return [...tests];
}

function fileKind(rel: string): IndexedFile["kind"] {
  const ext = path.extname(rel).toLowerCase();
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(rel)) return "test";
  if (SOURCE_EXTS.has(ext)) return "source";
  if ([".json", ".toml", ".yaml", ".yml"].includes(ext)) return "config";
  if ([".md", ".mdx"].includes(ext)) return "doc";
  return "other";
}

function tokenize(text: string): string[] {
  return [...new Set(text.toLowerCase().match(/[a-z0-9_./-]{3,}/g) ?? [])].slice(0, 12);
}

function normalizeRel(value: string): string {
  return value.split(path.sep).join("/");
}

function symbolsIndex(index: CodeIndex): Record<string, readonly string[]> {
  return Object.fromEntries(index.files.filter((f) => f.symbols.length > 0).map((f) => [f.path, f.symbols]));
}

function testIndex(index: CodeIndex): Record<string, readonly string[]> {
  return Object.fromEntries(index.files.filter((f) => f.tests.length > 0).map((f) => [f.path, f.tests]));
}
