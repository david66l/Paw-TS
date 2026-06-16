/**
 * Auto memory — persists extracted facts across sessions.
 *
 * Files live at `~/.paw/projects/{hash}/memory/{name}.md`.
 * Each file has YAML frontmatter: name, description, type.
 * A `MEMORY.md` index is auto-generated.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export type MemoryPriority = "high" | "mid" | "low";

export interface AutoMemoryEntry {
  readonly name: string;
  readonly description: string;
  readonly type: "user" | "feedback" | "project" | "reference";
  readonly content: string;
  /** Optional metadata (P3/B1) */
  readonly createdAt?: number;
  readonly updatedAt?: number;
  readonly tags?: readonly string[];
  readonly relatedFiles?: readonly string[];
  /** Base64-encoded Float32Array embedding vector (v1: nomic-embed-text via Ollama). */
  readonly embedding?: string;
  /** Priority tier: high (core), mid (default), low (temp). */
  readonly priority?: MemoryPriority;
  /** Extracted error signatures (error codes, exception names). */
  readonly error_signatures?: readonly string[];
  /** Tools used when this memory was created (MCP tool names, harness functions). */
  readonly tools_used?: readonly string[];
  /** Unix timestamp after which this memory is no longer valid (optional expiry). */
  readonly valid_until?: number;
  /** Related memory names — bidirectional links for traversal. */
  readonly linked_memories?: readonly string[];
}

function projectHash(workspaceRoot: string): string {
  return createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 16);
}

function defaultMemoryDir(workspaceRoot: string): string {
  return path.join(
    homedir(),
    ".paw",
    "projects",
    projectHash(workspaceRoot),
    "memory",
  );
}

/** Simple frontmatter parser — handles `key: value` lines only. */
function parseFrontmatter(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = text.split("\n");
  for (const line of lines) {
    const m = line.match(/^([^:]+):\s*(.*)$/);
    if (m?.[1] && m[2]) {
      result[m[1].trim()] = m[2].trim();
    }
  }
  return result;
}

function stringifyFrontmatter(data: Record<string, string>): string {
  const lines = Object.entries(data).map(([k, v]) => `${k}: ${v}`);
  return ["---", ...lines, "---"].join("\n");
}

export class AutoMemoryStore {
  readonly memoryDir: string;

  constructor(opts: { workspaceRoot: string; memoryDir?: string }) {
    this.memoryDir = opts.memoryDir ?? defaultMemoryDir(opts.workspaceRoot);
  }

  /** List all memory entries. */
  list(): AutoMemoryEntry[] {
    if (!existsSync(this.memoryDir)) return [];
    return readdirSync(this.memoryDir)
      .filter((f) =>
        f.endsWith(".md") &&
        f !== "MEMORY.md" &&
        !f.startsWith("MEMORY-"),
      )
      .map((f) => this.load(path.basename(f, ".md")))
      .filter((e): e is AutoMemoryEntry => e !== null);
  }

  /** Load a single memory entry by name. */
  load(name: string): AutoMemoryEntry | null {
    const file = path.join(this.memoryDir, `${name}.md`);
    if (!existsSync(file)) return null;
    try {
      const text = readFileSync(file, "utf-8");
      const fmMatch = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
      if (!fmMatch) return null;
      const fm = parseFrontmatter(fmMatch[1]!);
      const content = fmMatch[2]?.trim();
      const type = fm.type as AutoMemoryEntry["type"];
      if (!fm.name || !fm.description || !isValidType(type)) return null;
      const createdAt = fm.createdAt ? Number(fm.createdAt) : undefined;
      const updatedAt = fm.updatedAt ? Number(fm.updatedAt) : undefined;
      const embedding = fm.embedding_v1?.trim() || undefined;
      const priority = fm.priority && isValidPriority(fm.priority) ? fm.priority : undefined;
      const tags = fm.tags
        ?.split(",")
        .map((t: string) => t.trim())
        .filter((t: string) => t.length > 0);
      const relatedFiles = fm.relatedFiles
        ?.split(",")
        .map((f: string) => f.trim())
        .filter((f: string) => f.length > 0);
      const errorSignatures = fm.error_signatures
        ?.split(",")
        .map((s: string) => s.trim())
        .filter((s: string) => s.length > 0);
      const toolsUsed = fm.tools_used
        ?.split(",")
        .map((t: string) => t.trim())
        .filter((t: string) => t.length > 0);
      const validUntil = fm.valid_until ? Number(fm.valid_until) : undefined;
      const linked = fm.linked_memories
        ?.split(",")
        .map((l: string) => l.trim())
        .filter((l: string) => l.length > 0);
      return {
        name: fm.name,
        description: fm.description ?? "",
        type,
        content: content ?? "",
        ...(createdAt !== undefined && !Number.isNaN(createdAt)
          ? { createdAt }
          : {}),
        ...(updatedAt !== undefined && !Number.isNaN(updatedAt)
          ? { updatedAt }
          : {}),
        ...(embedding ? { embedding } : {}),
        ...(priority ? { priority } : {}),
        ...(tags && tags.length > 0 ? { tags } : {}),
        ...(relatedFiles && relatedFiles.length > 0 ? { relatedFiles } : {}),
        ...(errorSignatures && errorSignatures.length > 0 ? { error_signatures: errorSignatures } : {}),
        ...(toolsUsed && toolsUsed.length > 0 ? { tools_used: toolsUsed } : {}),
        ...(validUntil !== undefined && !Number.isNaN(validUntil) ? { valid_until: validUntil } : {}),
        ...(linked && linked.length > 0 ? { linked_memories: linked } : {}),
      };
    } catch {
      return null;
    }
  }

  /** Save a memory entry.  Does not rebuild the index — call {@link buildIndex} when done. */
  save(entry: AutoMemoryEntry): void {
    const file = path.join(this.memoryDir, `${entry.name}.md`);
    mkdirSync(this.memoryDir, { recursive: true });
    const fm: Record<string, string> = {
      name: entry.name,
      description: entry.description,
      type: entry.type,
    };
    if (entry.createdAt !== undefined) fm.createdAt = String(entry.createdAt);
    if (entry.updatedAt !== undefined) fm.updatedAt = String(entry.updatedAt);
    if (entry.embedding) fm.embedding_v1 = entry.embedding;
    if (entry.priority) fm.priority = entry.priority;
    if (entry.tags && entry.tags.length > 0) fm.tags = entry.tags.join(", ");
    if (entry.relatedFiles && entry.relatedFiles.length > 0) fm.relatedFiles = entry.relatedFiles.join(", ");
    if (entry.error_signatures && entry.error_signatures.length > 0) fm.error_signatures = entry.error_signatures.join(", ");
    if (entry.tools_used && entry.tools_used.length > 0) fm.tools_used = entry.tools_used.join(", ");
    if (entry.valid_until !== undefined) fm.valid_until = String(entry.valid_until);
    if (entry.linked_memories && entry.linked_memories.length > 0) fm.linked_memories = entry.linked_memories.join(", ");
    const fmStr = stringifyFrontmatter(fm);
    writeFileSync(file, `${fmStr}\n\n${entry.content}\n`, "utf-8");
  }

  /** Delete a memory entry.  Does not rebuild the index — call {@link buildIndex} when done. */
  delete(name: string): void {
    const file = path.join(this.memoryDir, `${name}.md`);
    if (existsSync(file)) {
      rmSync(file);
    }
  }

  /** Read MEMORY.md index, truncated to `maxLines` (default 200). */
  loadIndex(maxLines = 200): string | null {
    const indexPath = path.join(this.memoryDir, "MEMORY.md");
    if (!existsSync(indexPath)) return null;
    try {
      const text = readFileSync(indexPath, "utf-8");
      const lines = text.split("\n");
      if (lines.length <= maxLines) return text.trimEnd();
      return (
        lines.slice(0, maxLines).join("\n") +
        `\n\n(... ${lines.length - maxLines} more index lines omitted; use memory.read for full entries)\n`
      );
    } catch {
      return null;
    }
  }

  /** Upsert: update by name or matching description, else create. */
  upsert(entry: AutoMemoryEntry): "created" | "updated" {
    const existing = this.findSimilar(entry);
    if (existing) {
      const prior = this.load(existing.name);
      this.save({
        // New values take priority; fall back to prior values when new entry
        // doesn't supply them (to avoid overwriting manually-set fields).
        priority: entry.priority ?? prior?.priority,
        tags: entry.tags ?? prior?.tags,
        relatedFiles: entry.relatedFiles ?? prior?.relatedFiles,
        error_signatures: entry.error_signatures ?? prior?.error_signatures,
        tools_used: entry.tools_used ?? prior?.tools_used,
        valid_until: entry.valid_until ?? prior?.valid_until,
        linked_memories: entry.linked_memories ?? prior?.linked_memories,
        embedding: entry.embedding ?? prior?.embedding,
        // Mandatory fields from new entry
        name: existing.name,
        description: entry.description,
        type: entry.type,
        content: entry.content,
        createdAt: prior?.createdAt ?? entry.createdAt,
        updatedAt: entry.updatedAt ?? Date.now(),
      });
      return "updated";
    }
    this.save({
      ...entry,
      createdAt: entry.createdAt ?? Date.now(),
      updatedAt: entry.updatedAt ?? Date.now(),
    });
    return "created";
  }

  /** Find entry by exact name or normalized description match. */
  findSimilar(entry: AutoMemoryEntry): AutoMemoryEntry | null {
    const byName = this.load(entry.name);
    if (byName) return byName;
    const norm = (s: string) => s.trim().toLowerCase();
    const target = norm(entry.description);
    if (!target) return null;
    for (const e of this.list()) {
      if (norm(e.description) === target) return e;
    }
    return null;
  }

  /** Maximum entries per MEMORY shard file. */
  static readonly MAX_SHARD_SIZE = 180;

  /** Generate MEMORY.md index from all entries, archiving expired low-priority ones first. */
  buildIndex(): string {
    // Archive expired low-priority memories first
    const archived = this.archiveExpired(90);
    if (archived > 0) {
      // Rebuild archive's own index so it stays browseable (best-effort)
      const archiveDir = path.join(this.memoryDir, "archive");
      if (existsSync(archiveDir)) {
        try {
          const archiveEntries = readdirSync(archiveDir)
            .filter((f) => f.endsWith(".md") && f !== "MEMORY.md")
            .length;
          writeFileSync(
            path.join(archiveDir, "MEMORY.md"),
            `# Archive Index\n\nArchived entries: ${archiveEntries}\n\n`,
            "utf-8",
          );
        } catch {
          // best-effort
        }
      }
    }

    const entries = this.list();
    const shardCount = Math.ceil(entries.length / AutoMemoryStore.MAX_SHARD_SIZE);

    // Write each shard
    for (let i = 0; i < shardCount; i++) {
      const slice = entries.slice(i * AutoMemoryStore.MAX_SHARD_SIZE, (i + 1) * AutoMemoryStore.MAX_SHARD_SIZE);
      const shardLines = [
        `# Memory Index — Shard ${i + 1}`,
        "",
        "| Name | Type | Priority | Description |",
        "|------|------|----------|-------------|",
        ...slice.map((e) =>
          `| ${e.name} | ${e.type} | ${e.priority ?? "mid"} | ${e.description} |`
        ),
        "",
      ];
      writeFileSync(
        path.join(this.memoryDir, `MEMORY-${i + 1}.md`),
        shardLines.join("\n"),
        "utf-8",
      );
    }

    // Clean up stale shards (when entries shrink below previous shard count)
    const cleaned = this.cleanStaleShards(shardCount);

    // Write master index pointing to shards
    const masterLines = [
      "# Memory Index",
      "",
      `${entries.length} entries across ${shardCount} shard(s)`,
      "",
      ...Array.from({ length: shardCount }, (_, i) => `- [Shard ${i + 1}](MEMORY-${i + 1}.md)`),
      "",
    ];
    const indexPath = path.join(this.memoryDir, "MEMORY.md");
    writeFileSync(indexPath, masterLines.join("\n"), "utf-8");
    return masterLines.join("\n");
  }

  /** Load all index shards concatenated into a single string. */
  loadAllIndexShards(): string | null {
    const indexPath = path.join(this.memoryDir, "MEMORY.md");
    if (!existsSync(indexPath)) return null;

    try {
      // Read master index to discover shards
      const master = readFileSync(indexPath, "utf-8");
      const shardMatches = master.match(/MEMORY-(\d+)\.md/g);
      const shardFiles = shardMatches ?? [];

      if (shardFiles.length === 0) {
        // Fallback: try to read old-style MEMORY.md directly
        const text = readFileSync(indexPath, "utf-8");
        if (text.includes("| Name | Type |")) {
          return text.trimEnd();
        }
        return null;
      }

      const parts: string[] = [];
      for (const shardFile of shardFiles) {
        const shardPath = path.join(this.memoryDir, shardFile);
        if (existsSync(shardPath)) {
          const content = readFileSync(shardPath, "utf-8");
          parts.push(content.trimEnd());
        }
      }
      return parts.length > 0 ? parts.join("\n\n") : null;
    } catch {
      return null;
    }
  }

  /** Clean up shard files that exceed the current shard count. */
  private cleanStaleShards(currentShardCount: number): number {
    let cleaned = 0;
    let i = currentShardCount + 1;
    while (true) {
      const shardPath = path.join(this.memoryDir, `MEMORY-${i}.md`);
      if (existsSync(shardPath)) {
        rmSync(shardPath);
        cleaned++;
        i++;
      } else {
        break;
      }
    }
    return cleaned;
  }

  /**
   * Archive low-priority memories that haven't been updated in `maxAgeDays`.
   * Moves files to `memory/archive/` directory.
   * Returns the count of archived entries.
   */
  archiveExpired(maxAgeDays = 90): number {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    const entries = this.list();
    let count = 0;

    for (const entry of entries) {
      const priority = entry.priority ?? "mid";
      if (priority !== "low") continue;

      const ts = entry.updatedAt ?? entry.createdAt;
      if (ts === undefined || ts > cutoff) continue;

      // Move to archive directory
      const archiveDir = path.join(this.memoryDir, "archive");
      mkdirSync(archiveDir, { recursive: true });
      const src = path.join(this.memoryDir, `${entry.name}.md`);
      const dst = path.join(archiveDir, `${entry.name}.md`);
      if (existsSync(src)) {
        renameSync(src, dst);
        count++;
      }
    }

    return count;
  }
}

function isValidType(t: string): t is AutoMemoryEntry["type"] {
  return (
    t === "user" || t === "feedback" || t === "project" || t === "reference"
  );
}

function isValidPriority(p: string): p is MemoryPriority {
  return p === "high" || p === "mid" || p === "low";
}
