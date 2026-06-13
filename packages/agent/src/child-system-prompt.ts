/**
 * Lightweight system prompt for child (sub-) agents.
 * Uses SharedContext (~2k budget) instead of the full Paw system prompt.
 */

import type { SharedContext } from "./orchestrator/types.js";

function bulletLines(items: readonly string[]): string {
  return items.map((s) => `- ${s}`).join("\n");
}

export function buildChildSystemPrompt(opts: {
  readonly sharedContext: SharedContext;
  readonly toolCatalog: string;
  readonly workspaceRoot: string;
}): string {
  const ctx = opts.sharedContext;
  const parts: string[] = [ctx.role, "", "# Task", ctx.task];

  if (ctx.facts.length > 0) {
    parts.push("", "# Context from parent", bulletLines(ctx.facts));
  }
  if (ctx.constraints.length > 0) {
    parts.push("", "# Constraints", bulletLines(ctx.constraints));
  }
  if (ctx.artifacts.length > 0) {
    parts.push("", "# Artifacts");
    for (const a of ctx.artifacts) {
      const label = a.path ?? a.type;
      parts.push(`## ${label}\n${a.content.slice(0, 4_000)}`);
    }
  }
  if (ctx.state.completed.length > 0 || ctx.state.pending.length > 0) {
    parts.push("", "# Progress");
    if (ctx.state.completed.length > 0) {
      parts.push("Completed:", bulletLines(ctx.state.completed));
    }
    if (ctx.state.pending.length > 0) {
      parts.push("Pending:", bulletLines(ctx.state.pending));
    }
  }
  if (ctx.parentConclusions && ctx.parentConclusions.length > 0) {
    parts.push("", "# Parent conclusions");
    for (const c of ctx.parentConclusions) {
      parts.push(`- (${c.confidence}) ${c.conclusion}`);
    }
  }

  parts.push("", "# Output format", ctx.outputFormat);
  parts.push(
    "",
    "# Tools",
    "Use workspace tools via JSON lines or native tool calling.",
    opts.toolCatalog.length > 4_000
      ? `${opts.toolCatalog.slice(0, 4_000)}\n...(truncated)`
      : opts.toolCatalog,
    "",
    `Workspace: ${opts.workspaceRoot}`,
  );

  return parts.join("\n");
}
