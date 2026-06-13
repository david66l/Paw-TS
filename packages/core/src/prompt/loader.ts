/**
 * Prompt loader — resolves the base system prompt based on model provider.
 * Each .txt file is a self-contained system prompt tuned for a specific model family.
 *
 * Pattern adopted from OpenCode's session/prompt/ system (per-model .txt files).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const PROMPT_DIR = join(import.meta.dirname ?? join(process.cwd(), "packages/core/src/prompt"));

/** Resolve the base system prompt for a given model ID. */
export function resolveBasePrompt(modelId?: string): string {
  const file = selectPromptFile(modelId);
  try {
    return readFileSync(join(PROMPT_DIR, file), "utf-8").trim();
  } catch {
    // Fallback to default if model-specific file is missing
    if (file !== "default.txt") {
      try {
        return readFileSync(join(PROMPT_DIR, "default.txt"), "utf-8").trim();
      } catch {
        return ""; // caller should handle empty prompt
      }
    }
    return "";
  }
}

/** Select the prompt file based on model ID heuristics. */
function selectPromptFile(modelId?: string): string {
  if (!modelId) return "default.txt";

  const id = modelId.toLowerCase();

  if (id.includes("deepseek")) return "deepseek.txt";
  if (id.includes("qwen")) return "deepseek.txt";    // Qwen shares DeepSeek's prompt (similar behavior)
  if (id.includes("claude") || id.includes("anthropic")) return "default.txt";
  if (id.includes("gpt") || id.includes("openai")) return "default.txt";

  return "default.txt";
}
