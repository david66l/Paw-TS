import { parseAgentActionFromModelText } from "./parse-agent-action.js";

/**
 * Back-compat: only recognizes a tool-call action from model output.
 * Prefer {@link parseAgentActionFromModelText} for full V2 §8.5 parsing.
 */
export function parseToolCallFromModelText(
  text: string,
): { readonly tool: string; readonly args: unknown } | null {
  const a = parseAgentActionFromModelText(text);
  if (a?.type === "tool_call") {
    return { tool: a.tool, args: a.args };
  }
  return null;
}
