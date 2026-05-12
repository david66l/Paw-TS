/**
 * Compression agent — forks a sub-agent to generate a conversation summary.
 *
 * Uses the existing {@link SubAgentLauncher} so the summary runs in an
 * isolated orchestrator with its own context manager.
 */

import type { SessionMemory } from "@paw/core";
import type { SubAgentLauncher } from "@paw/harness";

export interface CompressionAgentResult {
  /** The markdown summary text that replaces compressed history. */
  readonly summary: string;
  /** Structured session memory extracted from the conversation. */
  readonly sessionMemory: SessionMemory;
}

/**
 * Fork a sub-agent to summarize a conversation segment.
 *
 * The sub-agent receives a prompt with the conversation history and
 * returns a structured markdown summary.  The summary is parsed into
 * both a compact context message and a {@link SessionMemory} object.
 */
export async function runCompressionAgent(
  launcher: SubAgentLauncher,
  prompt: string,
  runId: string,
): Promise<CompressionAgentResult> {
  const goal = `Compress the following conversation into a structured summary.\n\n${prompt}\n\nRespond with ONLY a markdown document containing these sections:\n## Active Task\n## Goal\n## Progress\n## Key Decisions\n## Relevant Files\n## Errors & Fixes\n## Next Steps\n## Pending Questions`;

  const result = await launcher.launch(goal, 3);

  const summary = result.result ?? "";

  // Parse the summary into a SessionMemory object
  const sessionMemory = parseSummaryToSessionMemory(summary, runId);

  return { summary, sessionMemory };
}

function parseSummaryToSessionMemory(
  summary: string,
  runId: string,
): SessionMemory {
  const sections = parseMarkdownSections(summary);

  return {
    session: runId,
    project: "", // filled in by caller
    updatedAt: Date.now(),
    task: sections["active task"],
    currentState: sections["progress"],
    filesAndFunctions: sections["relevant files"]
      ?.split("\n")
      .filter((l) => l.trim().startsWith("- ") || l.trim().startsWith("`"))
      .map((l) => l.trim()),
    keyDecisions: sections["key decisions"]
      ?.split("\n")
      .filter((l) => l.trim().startsWith("- "))
      .map((l) => l.trim().slice(2)),
    errorsAndFixes: sections["errors & fixes"]
      ?.split("\n")
      .filter((l) => l.trim().startsWith("- "))
      .map((l) => l.trim().slice(2)),
    relevantContext:
      sections["next steps"] || sections["pending questions"]
        ? `Next Steps:\n${sections["next steps"] ?? ""}\n\nPending Questions:\n${sections["pending questions"] ?? ""}`
        : undefined,
  };
}

function parseMarkdownSections(text: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const lines = text.split("\n");
  let currentHeading: string | null = null;
  const currentLines: string[] = [];

  for (const line of lines) {
    const headingMatch = line.match(/^##\s+(.+)$/i);
    if (headingMatch) {
      if (currentHeading) {
        sections[currentHeading.toLowerCase()] = currentLines.join("\n").trim();
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
