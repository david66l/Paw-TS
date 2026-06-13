/**
 * LLM manifest selector for cascade memory retrieval.
 * Reads memory titles/summaries only — no full content injection.
 */

import type { LlmMemorySelectFn } from "@paw/core";
import type { LanguageModel } from "@paw/models";

import { completeAuxiliaryTask } from "./auxiliary-complete.js";

const SELECTOR_SYSTEM =
  "You select project memory entries relevant to a coding task. Respond with JSON only.";

function buildSelectorUser(input: Parameters<LlmMemorySelectFn>[0]): string {
  const lines = [
    "Pick up to 5 memory IDs most relevant to the user's goal.",
    "",
    `Goal: ${input.query.goal}`,
  ];

  if (input.query.errorMessage) {
    lines.push(`Recent error: ${input.query.errorMessage}`);
  }
  if (input.query.recentToolNames && input.query.recentToolNames.length > 0) {
    lines.push(`Recent tools: ${input.query.recentToolNames.join(", ")}`);
  }

  lines.push(
    "",
    "Available memories:",
    input.manifest,
    "",
    'Respond with JSON: {"selected_ids":["id1","id2"]}',
  );
  return lines.join("\n");
}

function parseSelectedIds(text: string): string[] {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return [];

  try {
    const parsed = JSON.parse(match[0]) as { selected_ids?: unknown };
    if (!Array.isArray(parsed.selected_ids)) return [];
    return parsed.selected_ids.filter(
      (id): id is string => typeof id === "string" && id.length > 0,
    );
  } catch {
    return [];
  }
}

export function createLlmMemorySelectFn(
  model: LanguageModel,
  signal?: AbortSignal,
): LlmMemorySelectFn {
  return async (input) => {
    const text = await completeAuxiliaryTask({
      model,
      system: SELECTOR_SYSTEM,
      user: buildSelectorUser(input),
      signal,
    });
    return parseSelectedIds(text);
  };
}

/** @internal */
export function parseLlmMemorySelection(text: string): string[] {
  return parseSelectedIds(text);
}
