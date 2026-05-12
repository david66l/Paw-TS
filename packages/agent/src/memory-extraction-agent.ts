/**
 * Memory extraction agent — forks a sub-agent to analyze recent messages
 * and extract persistent memory entries.
 *
 * Runs non-blocking in the background after each turn.
 */

import type { AutoMemoryEntry } from "@paw/core";
import type { SubAgentLauncher } from "@paw/harness";

export interface MemoryExtractionResult {
  readonly entries: readonly AutoMemoryEntry[];
}

/**
 * Fork a sub-agent to extract memories from recent conversation messages.
 *
 * The sub-agent receives a prompt with the recent conversation and
 * returns structured memory entries to persist.
 */
export async function extractMemories(
  launcher: SubAgentLauncher,
  conversationText: string,
): Promise<MemoryExtractionResult> {
  const goal = `Analyze the following conversation and extract any facts that should be remembered for future sessions.

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

  const result = await launcher.launch(goal, 3);

  const entries = parseMemoryEntries(result.result ?? "");

  return { entries };
}

function parseMemoryEntries(text: string): AutoMemoryEntry[] {
  if (text.trim().toLowerCase().includes("no memories to extract")) {
    return [];
  }

  const entries: AutoMemoryEntry[] = [];
  const sections = text.split(/^##\s+/m).slice(1); // skip text before first heading

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
        const t = typeMatch[1]!.trim().toLowerCase();
        if (t === "user" || t === "feedback" || t === "project" || t === "reference") {
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
