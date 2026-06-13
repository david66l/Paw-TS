/**
 * Unified memory record — common interface for all memory types.
 *
 * SessionMemory, AutoMemoryEntry, and ProjectMemory all map to this
 * structure for unified retrieval, scoring, and injection.
 */

import type { AutoMemoryEntry } from "./auto-memory.js";
import type { ChatMessage } from "./context-manager.js";
import type { SessionMemory } from "./session-memory.js";

export type MemorySource = "session" | "auto" | "project" | "user_explicit";

export type MemoryScope = "project" | "workspace" | "global";

export interface MemoryRecord {
  readonly id: string;
  readonly source: MemorySource;
  readonly scope: MemoryScope;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly title: string;
  readonly summary: string;
  readonly content: string;
  readonly tags: readonly string[];
  readonly relatedFiles: readonly string[];
  /** Error signatures (error codes, exception names, key lines) — NOT full descriptions */
  readonly relatedErrors: readonly string[];
}

// ── Mappers ──

export function sessionMemoryToRecord(sm: SessionMemory): MemoryRecord {
  return {
    id: sm.session,
    source: "session",
    scope: "project",
    createdAt: sm.updatedAt,
    updatedAt: sm.updatedAt,
    title: sm.task ?? "Untitled session",
    summary: sm.currentState ?? "",
    content: [
      sm.task,
      sm.currentState,
      ...(sm.keyDecisions ?? []),
      ...(sm.errorsAndFixes ?? []),
      sm.relevantContext,
    ]
      .filter((x): x is string => !!x)
      .join("\n"),
    tags: inferTags(sm),
    relatedFiles: sm.filesAndFunctions ?? [],
    relatedErrors: extractErrorSignatures(sm.errorsAndFixes),
  };
}

export function autoMemoryToRecord(
  entry: AutoMemoryEntry,
  mtime?: number,
): MemoryRecord {
  const ts = mtime ?? Date.now();
  return {
    id: entry.name,
    source: "auto",
    scope: "project",
    createdAt: entry.createdAt ?? ts,
    updatedAt: entry.updatedAt ?? ts,
    title: entry.name,
    summary: entry.description,
    content: entry.content,
    tags: entry.tags ?? [entry.type],
    relatedFiles: entry.relatedFiles ?? extractFilePaths(entry.content),
    relatedErrors: [],
  };
}

// ── Helpers ──

/**
 * Strip resumed-session context (background + previous goals) from a goal
 * string so that memory retrieval only scores against the current user
 * request.
 */
export function extractCleanMemoryQuery(goal: string): string {
  const marker = "[Current user request]";
  const idx = goal.indexOf(marker);
  if (idx >= 0) {
    return goal.slice(idx + marker.length).trim();
  }
  return goal;
}

const TOOL_RESULT_HEAD = /^\[Tool (.+?) (completed|failed)\]/;

export interface MemoryRetrievalSignals {
  readonly recentFiles: readonly string[];
  readonly recentToolNames: readonly string[];
  readonly errorMessage?: string;
}

/** Derive path/tool/error signals from recent conversation for memory scoring. */
export function buildRetrievalSignalsFromMessages(
  messages: readonly ChatMessage[],
  lookback = 24,
): MemoryRetrievalSignals {
  const recent = messages.filter((m) => m.role !== "system").slice(-lookback);
  const recentFilesSet = new Set<string>();
  const recentToolNames: string[] = [];
  let errorMessage: string | undefined;

  for (const msg of recent) {
    for (const p of extractFilePaths(msg.content)) {
      recentFilesSet.add(p);
    }
    if (msg.role !== "user") continue;
    const head = msg.content.match(TOOL_RESULT_HEAD);
    if (!head) continue;
    recentToolNames.push(head[1]!);
    if (head[2] === "failed" && errorMessage === undefined) {
      errorMessage = msg.content.slice(0, 500);
    }
  }

  return {
    recentFiles: [...recentFilesSet],
    recentToolNames,
    errorMessage,
  };
}

/** True when the user is asking about stored memories rather than a code task. */
export function isMemoryMetaQuery(goal: string): boolean {
  const g = goal.trim();
  if (
    /(?:还记得|记不记得|之前的记忆|有哪些\s*(?:reference\s*)?记忆|什么记忆|记得.*吗)/i.test(
      g,
    )
  ) {
    return true;
  }
  if (/以前.{0,8}记(?!录|录器|账|号|者)/i.test(g)) {
    return true;
  }
  if (
    /\b(?:what|which|list|show)\s+(?:are\s+)?(?:my|the|all|stored)?\s*memories\b/i.test(
      g,
    )
  ) {
    return true;
  }
  if (/\bdo\s+you\s+remember\b/i.test(g)) {
    return true;
  }
  if (/\brecall\s+(?:our|the|any)\s+memories\b/i.test(g)) {
    return true;
  }
  return false;
}

const ARCHITECTURE_QUERY_KEYWORDS = [
  "registry",
  "compactor",
  "orchestrator",
  "path-guard",
  "path guard",
  "context-manager",
  "context manager",
  "memory-retriever",
  "memory retriever",
  "memory retrieval",
] as const;

/** True when the query is about core agent architecture / infrastructure. */
export function isArchitectureQuery(goal: string): boolean {
  const lower = goal.toLowerCase();
  return ARCHITECTURE_QUERY_KEYWORDS.some((kw) => lower.includes(kw));
}

/** Reference memories (architecture docs, long-lived project facts). */
export function isReferenceMemory(record: MemoryRecord): boolean {
  return record.tags.includes("reference");
}

/** Extract file paths from free-form text (heuristic). */
export function extractFilePaths(text: string): string[] {
  const paths: string[] = [];
  // Match common path patterns: src/foo.ts, packages/core/src/bar.ts, ./relative/path.js
  const re =
    /(?:\.\/|[a-zA-Z0-9_-]+\/)(?:[a-zA-Z0-9._-]+\/)*[a-zA-Z0-9._-]+\.[a-zA-Z0-9]+/g;
  let m: RegExpExecArray | null = re.exec(text);
  while (m !== null) {
    paths.push(m[0]);
    m = re.exec(text);
  }
  return [...new Set(paths)];
}

/** Extract concise error signatures from full error descriptions. */
export function extractErrorSignatures(
  errorsAndFixes?: readonly string[],
): string[] {
  if (!errorsAndFixes) return [];
  const signatures: string[] = [];

  for (const text of errorsAndFixes) {
    // TypeScript error codes: TS1234, TS12345
    const tsCodes = text.match(/TS\d{4,5}/g);
    if (tsCodes) signatures.push(...tsCodes);

    // Exception names
    const exceptions = text.match(
      /\b(Error|TypeError|ReferenceError|SyntaxError|RangeError)\b/g,
    );
    if (exceptions) signatures.push(...exceptions);

    // Key error lines (first 2 lines that look like errors)
    const keyLines = text
      .split("\n")
      .filter((l) =>
        /cannot|does not|is not|failed|undefined|null/.test(l.toLowerCase()),
      )
      .slice(0, 2);
    for (const line of keyLines) {
      const normalized = line.trim().slice(0, 80);
      if (normalized) signatures.push(normalized);
    }
  }

  return [...new Set(signatures)];
}

/** Infer tags from session memory content using keyword heuristics. */
export function inferTags(sm: SessionMemory): string[] {
  const tags = new Set<string>();
  const text = [sm.task, sm.currentState, ...(sm.errorsAndFixes ?? [])]
    .join(" ")
    .toLowerCase();

  if (text.includes("bug") || text.includes("fix") || text.includes("error"))
    tags.add("bug");
  if (text.includes("refactor")) tags.add("refactor");
  if (text.includes("test") || text.includes("spec")) tags.add("testing");
  if (text.includes("api") || text.includes("endpoint")) tags.add("api");
  if (
    text.includes("perf") ||
    text.includes("performance") ||
    text.includes("slow")
  )
    tags.add("performance");
  if (text.includes("typescript") || text.includes("type "))
    tags.add("typescript");
  if (text.includes("react") || text.includes("component"))
    tags.add("frontend");
  if (text.includes("memory") || text.includes("context")) tags.add("memory");
  if (text.includes("build") || text.includes("compile")) tags.add("build");
  if (text.includes("lint") || text.includes("format")) tags.add("lint");

  return [...tags];
}
