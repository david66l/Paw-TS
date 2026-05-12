/**
 * Auto memory — persists extracted facts across sessions.
 *
 * Files live at `~/.paw/projects/{hash}/memory/{name}.md`.
 * Each file has YAML frontmatter: name, description, type.
 * A `MEMORY.md` index is auto-generated.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface AutoMemoryEntry {
  readonly name: string;
  readonly description: string;
  readonly type: "user" | "feedback" | "project" | "reference";
  readonly content: string;
}

function projectHash(workspaceRoot: string): string {
  return createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 16);
}

function defaultMemoryDir(workspaceRoot: string): string {
  return path.join(homedir(), ".paw", "projects", projectHash(workspaceRoot), "memory");
}

/** Simple frontmatter parser — handles `key: value` lines only. */
function parseFrontmatter(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = text.split("\n");
  for (const line of lines) {
    const m = line.match(/^([^:]+):\s*(.*)$/);
    if (m) {
      result[m[1]!.trim()] = m[2]!.trim();
    }
  }
  return result;
}

function stringifyFrontmatter(data: Record<string, string>): string {
  const lines = Object.entries(data).map(([k, v]) => `${k}: ${v}`);
  return ["---", ...lines, "---"].join("\n");
}

export class AutoMemoryStore {
  private readonly memoryDir: string;

  constructor(opts: { workspaceRoot: string; memoryDir?: string }) {
    this.memoryDir = opts.memoryDir ?? defaultMemoryDir(opts.workspaceRoot);
  }

  /** List all memory entries. */
  list(): AutoMemoryEntry[] {
    if (!existsSync(this.memoryDir)) return [];
    return readdirSync(this.memoryDir)
      .filter((f) => f.endsWith(".md") && f !== "MEMORY.md")
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
      const content = fmMatch[2]!.trim();
      const type = fm["type"] as AutoMemoryEntry["type"];
      if (!fm["name"] || !fm["description"] || !isValidType(type)) return null;
      return {
        name: fm["name"],
        description: fm["description"],
        type,
        content,
      };
    } catch {
      return null;
    }
  }

  /** Save a memory entry.  Does not rebuild the index — call {@link buildIndex} when done. */
  save(entry: AutoMemoryEntry): void {
    const file = path.join(this.memoryDir, `${entry.name}.md`);
    mkdirSync(this.memoryDir, { recursive: true });
    const fm = stringifyFrontmatter({
      name: entry.name,
      description: entry.description,
      type: entry.type,
    });
    writeFileSync(file, `${fm}\n\n${entry.content}\n`, "utf-8");
  }

  /** Delete a memory entry.  Does not rebuild the index — call {@link buildIndex} when done. */
  delete(name: string): void {
    const file = path.join(this.memoryDir, `${name}.md`);
    if (existsSync(file)) {
      rmSync(file);
    }
  }

  /** Generate MEMORY.md index from all entries. */
  buildIndex(): string {
    const entries = this.list();
    const lines = [
      "# Memory Index",
      "",
      "| Name | Type | Description |",
      "|------|------|-------------|",
      ...entries.map((e) => `| ${e.name} | ${e.type} | ${e.description} |`),
      "",
    ];
    const index = lines.join("\n");
    const indexPath = path.join(this.memoryDir, "MEMORY.md");
    writeFileSync(indexPath, index, "utf-8");
    return index;
  }
}

function isValidType(t: string): t is AutoMemoryEntry["type"] {
  return t === "user" || t === "feedback" || t === "project" || t === "reference";
}
