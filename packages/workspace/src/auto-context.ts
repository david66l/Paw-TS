/**
 * Auto-context: discover relevant files from a user goal without explicit @mentions.
 *
 * Strategy:
 * 1. Extract keywords from the goal (stop-word filtering).
 * 2. Grep codebase for those keywords.
 * 3. Score files by match count + recency (git modified).
 * 4. Read top-N files and return as inline context blocks.
 */

import path from "node:path";

import { gitStatus } from "./git-tools.js";
import { grepWorkspaceText } from "./local-fs.js";
import { readWorkspaceFile } from "./local-fs.js";

/** Common English stop words to filter from keyword extraction. */
const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for", "of",
  "with", "by", "from", "as", "is", "are", "was", "were", "be", "been",
  "being", "have", "has", "had", "do", "does", "did", "will", "would",
  "could", "should", "may", "might", "can", "shall", "this", "that", "these",
  "those", "i", "you", "he", "she", "it", "we", "they", "me", "him", "her",
  "us", "them", "my", "your", "his", "its", "our", "their", "what", "which",
  "who", "when", "where", "why", "how", "all", "each", "every", "both",
  "few", "more", "most", "other", "some", "such", "no", "not", "only",
  "own", "same", "so", "than", "too", "very", "just", "now", "then",
  "also", "get", "add", "fix", "make", "create", "update", "change",
  "remove", "delete", "use", "using", "need", "want", "should", "please",
  "help", "look", "see", "check", "find", "search", "file", "files",
  "code", "function", "class", "method", "variable", "test", "tests",
  "bug", "issue", "error", "problem", "feature", "implement", "write",
  "read", "run", "build", "compile", "deploy", "install", "configure",
  "set", "new", "old", "current", "next", "previous", "first", "last",
  "one", "two", "three", "1", "2", "3",
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
  if ([".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".go", ".java"].includes(ext)) {
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
      content = content.slice(0, MAX_FILE_CHARS) + "\n... (truncated)";
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
