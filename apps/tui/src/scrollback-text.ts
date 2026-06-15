import {
  parseAgentActionFromModelText,
  parseAgentActionsFromModelText,
} from "@paw/agent";

/** Strip tool JSON / thinking tags; expand final_answer summary for scrollback. */
export function stripAssistantTextForScrollback(text: string): string {
  const withoutTags = text
    .replace(/<overview>[\s\S]*?<\/overview>/gi, "")
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .trim();

  const finalAction = parseAgentActionFromModelText(withoutTags);
  if (finalAction?.type === "final_answer") {
    return finalAction.summary.trim();
  }

  return parseAgentActionsFromModelText(withoutTags).text.trim().replace(/\n{3,}/g, "\n\n");
}
