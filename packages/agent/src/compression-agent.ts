/**
 * Compression agent — single model call to generate a conversation summary.
 */

import type { SessionMemory } from "@paw/core";
import { parseMarkdownSections } from "@paw/core";
import type { LanguageModel } from "@paw/models";

import { completeAuxiliaryTask } from "./auxiliary-complete.js";

export interface CompressionAgentResult {
  /** The markdown summary text that replaces compressed history. */
  readonly summary: string;
  /** Structured session memory extracted from the conversation. */
  readonly sessionMemory: SessionMemory;
}

const COMPRESSION_SYSTEM = `You are a context compression assistant. Distill conversation history into structured markdown so the AI can continue without re-reading the full thread. Be concise but preserve actionable information.`;

const COMPRESSION_SECTIONS = `Respond with ONLY a markdown document containing these sections:
## Active Task
## Goal
## Progress
## Key Decisions
## Relevant Files
## Errors & Fixes
## Next Steps
## Pending Questions`;

/**
 * Summarize a conversation segment via one cheap completion (no sub-agent orchestrator).
 */
export async function runCompressionAgent(
  model: LanguageModel,
  prompt: string,
  runId: string,
  signal?: AbortSignal,
): Promise<CompressionAgentResult> {
  const summary = await completeAuxiliaryTask({
    model,
    system: COMPRESSION_SYSTEM,
    user: `${prompt}\n\n${COMPRESSION_SECTIONS}`,
    signal,
  });

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
    project: "",
    updatedAt: Date.now(),
    task: sections["active task"],
    currentState: sections.progress,
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
