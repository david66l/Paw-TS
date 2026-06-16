/**
 * Memory reflector — periodic background deduplication and archival.
 *
 * Runs after every 20 memory extraction cycles (persisted counter in
 * `.reflection_state.json` inside the memory directory). Uses the auxiliary
 * model to detect duplicate, expired, and conflicting memory entries.
 */

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { AutoMemoryStore } from "./auto-memory.js";

export interface ReflectionState {
  /** Total extraction runs since last reflection. */
  extractionCount: number;
  /** Timestamp of last reflection (ms). */
  lastReflectionAt: number;
}

const REFLECTION_INTERVAL = 20;

function loadReflectionState(memoryDir: string): ReflectionState {
  const statePath = path.join(memoryDir, ".reflection_state.json");
  try {
    if (existsSync(statePath)) {
      const raw = JSON.parse(readFileSync(statePath, "utf-8")) as Partial<ReflectionState>;
      return {
        extractionCount: raw.extractionCount ?? 0,
        lastReflectionAt: raw.lastReflectionAt ?? 0,
      };
    }
  } catch {
    // corrupted — reset
  }
  return { extractionCount: 0, lastReflectionAt: 0 };
}

function saveReflectionState(memoryDir: string, state: ReflectionState): void {
  mkdirSync(memoryDir, { recursive: true });
  writeFileSync(
    path.join(memoryDir, ".reflection_state.json"),
    JSON.stringify(state, null, 2),
    "utf-8",
  );
}

/** Increment the extraction counter and return true if reflection should run. */
export function shouldRunReflection(memoryDir: string): boolean {
  const state = loadReflectionState(memoryDir);
  state.extractionCount++;
  const shouldRun = state.extractionCount >= REFLECTION_INTERVAL;
  if (shouldRun) {
    state.extractionCount = 0;
    state.lastReflectionAt = Date.now();
  }
  saveReflectionState(memoryDir, state);
  return shouldRun;
}

/** Reset the counter manually (e.g., after a manual reflection). */
export function resetReflectionCounter(memoryDir: string): void {
  saveReflectionState(memoryDir, { extractionCount: 0, lastReflectionAt: Date.now() });
}

// ── Reflection types ────────────────────────────────────────────────

export interface ReflectionMergeAction {
  readonly keep: string;
  readonly remove: readonly string[];
  readonly reason: string;
}

export interface ReflectionArchiveAction {
  readonly name: string;
  readonly reason: string;
}

export interface ReflectionConflictAction {
  readonly a: string;
  readonly b: string;
  readonly reason: string;
}

export interface ReflectionPlan {
  readonly merges: readonly ReflectionMergeAction[];
  readonly archive: readonly ReflectionArchiveAction[];
  readonly conflicts: readonly ReflectionConflictAction[];
}

// ── Prompt ─────────────────────────────────────────────────────────

const REFLECTION_SYSTEM =
  "You analyze a project's memory store to keep it clean. Output JSON only.";

function buildReflectionPrompt(entries: Array<{
  name: string;
  type: string;
  priority: string;
  description: string;
  updatedAt: number;
  tags: string[];
}>): string {
  const catalog = entries
    .map((e) =>
      `- [${e.name}] type=${e.type} priority=${e.priority} updated=${new Date(e.updatedAt).toISOString().slice(0, 10)} tags=[${e.tags.join(",")}] desc="${e.description}"`,
    )
    .join("\n");

  return `Review this memory catalog and identify issues. Respond with JSON only.

## Catalog (${entries.length} entries)

${catalog}

## Actions to identify

1. **Merge duplicates** — entries describing the same fact with slightly different wording. Keep the most recently updated one, remove the older ones.

2. **Archive expired** — entries that describe obsolete facts (old bugs since fixed, deprecated features, completed one-off tasks). Priority=low entries older than 90 days are already auto-archived — focus on mid/high entries that are clearly stale.

3. **Flag conflicts** — two entries that make contradictory claims. Mark both — don't resolve.

## Output format

{
  "merges": [
    { "keep": "name-to-keep", "remove": ["dupe1", "dupe2"], "reason": "..." }
  ],
  "archive": [
    { "name": "stale-entry", "reason": "..." }
  ],
  "conflicts": [
    { "a": "entry-a", "b": "entry-b", "reason": "..." }
  ]
}

If nothing needs to change, output: { "merges": [], "archive": [], "conflicts": [] }`;
}

// ── Main reflection function ───────────────────────────────────────

export interface ReflectorOptions {
  readonly store: AutoMemoryStore;
  /** LLM completion function (auxiliary model). */
  readonly complete: (system: string, user: string) => Promise<string>;
}

/**
 * Execute one reflection cycle: analyze memories, merge duplicates,
 * archive stale entries.
 *
 * Returns the number of entries modified.
 */
export async function runReflection(
  opts: ReflectorOptions,
): Promise<{ modified: number; plan: ReflectionPlan }> {
  const entries = opts.store.list();

  // Build lightweight catalog (no full content — just metadata)
  const catalog = entries.map((e) => ({
    name: e.name,
    type: e.type,
    priority: e.priority ?? "mid",
    description: e.description,
    updatedAt: e.updatedAt ?? e.createdAt ?? 0,
    tags: e.tags ? [...e.tags] : [],
  }));

  // Get reflection plan from LLM
  let plan: ReflectionPlan;
  try {
    const response = await opts.complete(
      REFLECTION_SYSTEM,
      buildReflectionPrompt(catalog),
    );
    plan = parseReflectionPlan(response);
  } catch {
    // LLM unavailable — skip
    return { modified: 0, plan: { merges: [], archive: [], conflicts: [] } };
  }

  let modified = 0;

  // Execute merges
  for (const merge of plan.merges) {
    let keeper = opts.store.load(merge.keep);
    if (!keeper) continue;

    // Merge content from removed entries into keeper one at a time,
    // re-reading keeper after each save so subsequent merges accumulate.
    for (const removeName of merge.remove) {
      const removed = opts.store.load(removeName);
      if (!removed) continue;

      // Append unique content from removed into keeper
      const mergedContent = mergeContent(keeper.content, removed.content);
      const mergedTags: string[] = mergeArrays(keeper.tags, removed.tags);
      const mergedFiles: string[] = mergeArrays(keeper.relatedFiles, removed.relatedFiles);
      const mergedErrors: string[] = mergeArrays(keeper.error_signatures, removed.error_signatures);

      keeper = {
        ...keeper,
        content: mergedContent,
        tags: mergedTags,
        relatedFiles: mergedFiles,
        error_signatures: mergedErrors,
        updatedAt: Date.now(),
      };
      opts.store.save(keeper);

      opts.store.delete(removeName);
      modified++;
    }
  }

  // Execute archives
  for (const archive of plan.archive) {
    const entry = opts.store.load(archive.name);
    if (!entry) continue;

    const archiveDir = path.join(opts.store.memoryDir, "archive");
    mkdirSync(archiveDir, { recursive: true });
    const src = path.join(opts.store.memoryDir, `${archive.name}.md`);
    const dst = path.join(archiveDir, `${archive.name}.md`);
    if (existsSync(src)) {
      renameSync(src, dst);
      modified++;
    }
  }

  // Rebuild index if modified
  if (modified > 0) {
    opts.store.buildIndex();
  }

  return { modified, plan };
}

/** Parse the LLM's JSON response into a structured plan. */
function parseReflectionPlan(text: string): ReflectionPlan {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { merges: [], archive: [], conflicts: [] };

  try {
    const parsed = JSON.parse(match[0]) as {
      merges?: Array<{ keep?: string; remove?: string[]; reason?: string }>;
      archive?: Array<{ name?: string; reason?: string }>;
      conflicts?: Array<{ a?: string; b?: string; reason?: string }>;
    };

    return {
      merges: (parsed.merges ?? [])
        .filter((m) => m.keep && m.remove?.length)
        .map((m) => ({
          keep: m.keep!,
          remove: m.remove!,
          reason: m.reason ?? "",
        })),
      archive: (parsed.archive ?? [])
        .filter((a) => a.name)
        .map((a) => ({
          name: a.name!,
          reason: a.reason ?? "",
        })),
      conflicts: (parsed.conflicts ?? [])
        .filter((c) => c.a && c.b)
        .map((c) => ({
          a: c.a!,
          b: c.b!,
          reason: c.reason ?? "",
        })),
    };
  } catch {
    return { merges: [], archive: [], conflicts: [] };
  }
}

/** Merge two content strings without duplicating shared text. */
function mergeContent(keeper: string, removed: string): string {
  if (!removed.trim()) return keeper;
  if (keeper.includes(removed.trim())) return keeper;
  return `${keeper.trim()}\n\n---\n\nFrom merged entry:\n\n${removed.trim()}`;
}

/** Merge two readonly arrays without duplicates. */
function mergeArrays<T>(a: readonly T[] | undefined, b: readonly T[] | undefined): T[] {
  const set = new Set(a ?? []);
  if (b) for (const item of b) set.add(item);
  return [...set];
}
