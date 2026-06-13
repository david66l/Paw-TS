/**
 * Memory extraction — single model call to analyze conversation and extract entries.
 */

import type { AutoMemoryEntry } from "@paw/core";
import type { LanguageModel } from "@paw/models";

import { completeAuxiliaryTask } from "./auxiliary-complete.js";

export interface MemoryExtractionResult {
  readonly entries: readonly AutoMemoryEntry[];
  /** Entries rejected by the sensitive-info scanner (available for audit). */
  readonly rejected: readonly RejectedEntry[];
}

export interface RejectedEntry {
  readonly entry: AutoMemoryEntry;
  readonly reason: string;
}

// ── Sensitive-info scanner ──────────────────────────────────────

const SENSITIVE_PATTERNS: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly label: string;
}> = [
  // More-specific patterns first (sk-ant-… before generic sk-…)
  { pattern: /sk-ant-[A-Za-z0-9_\-]{20,}/, label: "Anthropic API key (sk-ant-…)" },
  { pattern: /sk-[A-Za-z0-9_\-]{20,}/, label: "OpenAI API key (sk-…)" },
  { pattern: /Bearer\s+[A-Za-z0-9_\-\.]{20,}/, label: "Bearer token" },
  { pattern: /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----/, label: "private key block" },
  { pattern: /password\s*[:=]\s*["']?\S+["']?/i, label: "password assignment" },
  { pattern: /secret_key\s*[:=]\s*["']?\S+["']?/i, label: "secret_key assignment" },
  { pattern: /api[_-]?key\s*[:=]\s*["']?\S{8,}["']?/i, label: "API key assignment" },
  { pattern: /token\s*[:=]\s*["']?ghp_[A-Za-z0-9_]{20,}["']?/, label: "GitHub personal access token" },
  { pattern: /token\s*[:=]\s*["']?gho_[A-Za-z0-9_]{20,}["']?/, label: "GitHub OAuth token" },
  { pattern: /\.npmrc\b.*_authToken\s*=/i, label: ".npmrc authToken reference" },
  { pattern: /eyJ[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}/, label: "JWT token" },
  { pattern: /xox[bpras]-[A-Za-z0-9_\-]{10,}/, label: "Slack token" },
  { pattern: /access_key\s*[:=]\s*["']?\S{8,}["']?/i, label: "access_key assignment" },
];

/** Scan memory content for sensitive patterns.  Returns the first rejection reason or null. */
export function scanForSensitiveInfo(entry: AutoMemoryEntry): string | null {
  const haystack = [entry.name, entry.description, entry.content].join("\n");
  for (const { pattern, label } of SENSITIVE_PATTERNS) {
    if (pattern.test(haystack)) {
      return `matched sensitive pattern: ${label}`;
    }
  }
  // Also block plain-text credential keywords in content (but not in name/description).
  const contentLower = entry.content.toLowerCase();
  const credKeywords = ["password", "secret", "credential", "private key"];
  for (const kw of credKeywords) {
    if (contentLower.includes(kw)) {
      // Only flag if it looks like an assignment, not mere discussion
      if (/\w+\s*[:=]\s*["']?\S{8,}["']?/.test(entry.content)) {
        return `possible credential in content: keyword "${kw}" near assignment`;
      }
    }
  }
  return null;
}

function sanitizeMemoryEntries(
  entries: readonly AutoMemoryEntry[],
): { safe: AutoMemoryEntry[]; rejected: RejectedEntry[] } {
  const safe: AutoMemoryEntry[] = [];
  const rejected: RejectedEntry[] = [];
  for (const entry of entries) {
    const reason = scanForSensitiveInfo(entry);
    if (reason) {
      rejected.push({ entry, reason });
    } else {
      safe.push(entry);
    }
  }
  return { safe, rejected };
}

// ── Extraction ──────────────────────────────────────────────────

const EXTRACTION_SYSTEM = `You analyze coding-agent conversations and extract facts worth remembering across future sessions. Output markdown entry blocks only.`;

function buildExtractionUser(conversationText: string): string {
  return `Analyze the following conversation and extract any facts that should be remembered for future sessions.

Focus on:
- User preferences (coding style, conventions, tools they prefer)
- Project-specific knowledge (architecture decisions, tech stack)
- Feedback or corrections the user gave
- Important context about the current task

Respond with ONLY a markdown document containing memory entries in this format:

## Entry 1
- **Name**: short_id_without_spaces
- **Type**: user | feedback | project | reference
- **Description**: One-line description
- **Content**: Detailed content to remember

## Entry 2
...

If there is nothing worth remembering, respond with "No memories to extract."

## Conversation

${conversationText}`;
}

/**
 * Extract persistent memories via one cheap completion (no sub-agent orchestrator).
 * All extracted entries are scanned for sensitive information before returning;
 * rejected entries are available in the result for audit/logging.
 */
export async function extractMemories(
  model: LanguageModel,
  conversationText: string,
  signal?: AbortSignal,
): Promise<MemoryExtractionResult> {
  const text = await completeAuxiliaryTask({
    model,
    system: EXTRACTION_SYSTEM,
    user: buildExtractionUser(conversationText),
    signal,
  });

  const raw = parseMemoryEntries(text);
  const { safe, rejected } = sanitizeMemoryEntries(raw);
  return { entries: safe, rejected };
}

function parseMemoryEntries(text: string): AutoMemoryEntry[] {
  if (text.trim().toLowerCase().includes("no memories to extract")) {
    return [];
  }

  const entries: AutoMemoryEntry[] = [];
  const sections = text.split(/^##\s+/m).slice(1);

  for (const section of sections) {
    const lines = section.split("\n");
    const heading = lines[0]?.trim();
    if (!heading || heading.toLowerCase().startsWith("conversation")) continue;

    let name = "";
    let type: AutoMemoryEntry["type"] = "reference";
    let description = "";
    const contentLines: string[] = [];
    let inContent = false;

    for (const line of lines.slice(1)) {
      const nameMatch = line.match(/^-\s*\*\*Name\*\*:\s*([^\s:]+)/i);
      const typeMatch = line.match(/^-\s*\*\*Type\*\*:\s*(.+)$/i);
      const descMatch = line.match(/^-\s*\*\*Description\*\*:\s*(.+)$/i);
      const contentStart = line.match(/^-\s*\*\*Content\*\*:\s*(.*)$/i);

      if (nameMatch) {
        name = nameMatch[1]!.trim().replace(/\s+/g, "_").toLowerCase();
      } else if (typeMatch) {
        const t = typeMatch[1]?.trim().toLowerCase();
        if (
          t === "user" ||
          t === "feedback" ||
          t === "project" ||
          t === "reference"
        ) {
          type = t;
        }
      } else if (descMatch) {
        description = descMatch[1]!.trim();
      } else if (contentStart) {
        inContent = true;
        if (contentStart[1]) contentLines.push(contentStart[1]);
      } else if (inContent && line.trim()) {
        contentLines.push(line);
      }
    }

    if (name && description) {
      entries.push({
        name,
        type,
        description,
        content: contentLines.join("\n").trim(),
      });
    }
  }

  return entries;
}
