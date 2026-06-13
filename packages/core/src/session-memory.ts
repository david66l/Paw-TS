/**
 * Session memory — structured markdown persistence for conversation context.
 *
 * Files live at `~/.paw/projects/{hash}/session-memory/{sessionId}.md`.
 * Format: YAML frontmatter + Markdown body.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface SessionMemory {
  readonly session: string;
  readonly project: string;
  readonly updatedAt: number;
  readonly task?: string;
  readonly currentState?: string;
  readonly filesAndFunctions?: readonly string[];
  readonly keyDecisions?: readonly string[];
  readonly errorsAndFixes?: readonly string[];
  readonly relevantContext?: string;
}

function projectHash(workspaceRoot: string): string {
  return createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 16);
}

function defaultSessionsDir(workspaceRoot: string): string {
  return path.join(
    homedir(),
    ".paw",
    "projects",
    projectHash(workspaceRoot),
    "session-memory",
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

export class SessionMemoryStore {
  private readonly sessionsDir: string;

  constructor(opts: { workspaceRoot: string; sessionsDir?: string }) {
    this.sessionsDir =
      opts.sessionsDir ?? defaultSessionsDir(opts.workspaceRoot);
  }

  load(sessionId: string): SessionMemory | null {
    const file = path.join(this.sessionsDir, `${sessionId}.md`);
    if (!existsSync(file)) return null;
    const text = readFileSync(file, "utf-8");
    return this.fromMarkdown(text);
  }

  save(sessionId: string, memory: SessionMemory): void {
    const file = path.join(this.sessionsDir, `${sessionId}.md`);
    mkdirSync(this.sessionsDir, { recursive: true });
    writeFileSync(file, this.toMarkdown(memory), "utf-8");
  }

  loadLatest(): SessionMemory | null {
    return this.listRecent(1)[0] ?? null;
  }

  /** Most recently updated sessions, newest first. */
  listRecent(limit = 5): SessionMemory[] {
    if (!existsSync(this.sessionsDir) || limit <= 0) return [];
    const files = readdirSync(this.sessionsDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => {
        const fp = path.join(this.sessionsDir, f);
        return { path: fp, mtime: statSync(fp).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit);

    const memories: SessionMemory[] = [];
    for (const file of files) {
      const text = readFileSync(file.path, "utf-8");
      const memory = this.fromMarkdown(text);
      if (memory) memories.push(memory);
    }
    return memories;
  }

  toMarkdown(memory: SessionMemory): string {
    const fm: Record<string, string> = {
      session: memory.session,
      project: memory.project,
      updatedAt: String(memory.updatedAt),
    };

    const sections: string[] = [];
    if (memory.task) {
      sections.push(`## Task\n${memory.task}`);
    }
    if (memory.currentState) {
      sections.push(`## Current State\n${memory.currentState}`);
    }
    if (memory.filesAndFunctions?.length) {
      sections.push(
        `## Files & Functions\n${memory.filesAndFunctions.join("\n")}`,
      );
    }
    if (memory.keyDecisions?.length) {
      sections.push(
        `## Key Decisions\n${memory.keyDecisions.map((d) => `- ${d}`).join("\n")}`,
      );
    }
    if (memory.errorsAndFixes?.length) {
      sections.push(
        `## Errors & Fixes\n${memory.errorsAndFixes.map((e) => `- ${e}`).join("\n")}`,
      );
    }
    if (memory.relevantContext) {
      sections.push(`## Relevant Context\n${memory.relevantContext}`);
    }

    const body =
      sections.length > 0 ? `# Session Memory\n\n${sections.join("\n\n")}` : "";
    return `${stringifyFrontmatter(fm)}\n\n${body}\n`;
  }

  fromMarkdown(text: string): SessionMemory | null {
    const fmMatch = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (!fmMatch) return null;
    const fm = parseFrontmatter(fmMatch[1]!);
    const body = fmMatch[2]!;

    const session = fm.session;
    const project = fm.project;
    const updatedAt = Number(fm.updatedAt);
    if (!session || !project || Number.isNaN(updatedAt)) return null;

    const sections = this.parseSections(body);

    return {
      session,
      project,
      updatedAt,
      task: sections.task,
      currentState: sections["current state"],
      filesAndFunctions: sections["files & functions"]
        ?.split("\n")
        .filter(Boolean),
      keyDecisions: sections["key decisions"]
        ?.split("\n")
        .filter((l) => l.startsWith("- "))
        .map((l) => l.slice(2)),
      errorsAndFixes: sections["errors & fixes"]
        ?.split("\n")
        .filter((l) => l.startsWith("- "))
        .map((l) => l.slice(2)),
      relevantContext: sections["relevant context"],
    };
  }

  private parseSections(body: string): Record<string, string> {
    const sections: Record<string, string> = {};
    const lines = body.split("\n");
    let currentHeading: string | null = null;
    const currentLines: string[] = [];

    for (const line of lines) {
      const headingMatch = line.match(/^##\s+(.+)$/i);
      if (headingMatch) {
        if (currentHeading) {
          sections[currentHeading.toLowerCase()] = currentLines
            .join("\n")
            .trim();
        }
        currentHeading = headingMatch[1]!;
        currentLines.length = 0;
      } else if (currentHeading) {
        currentLines.push(line);
      }
    }
    if (currentHeading) {
      sections[currentHeading.toLowerCase()] = currentLines.join("\n").trim();
    }
    return sections;
  }
}
