/**
 * Extracts `<think>...</think>` reasoning blocks from model content.
 *
 * Some Qwen-family and other reasoning models emit their chain-of-thought
 * inside the normal `content` field as XML-like `<think>` tags instead of
 * using a separate `reasoning_content` field. This helper normalizes such
 * output by moving the think-block content to `thinking` and returning the
 * remaining text as `text`.
 */
export function extractThinkBlocks(text: string): {
  readonly text: string;
  readonly thinking?: string;
} {
  if (!text || !text.toLowerCase().includes("<think")) {
    return { text };
  }

  const thinkRegex = /<think>([\s\S]*?)<\/think>/gi;
  const thinkingParts: string[] = [];
  let match = thinkRegex.exec(text);
  while (match !== null) {
    const content = match[1]?.trim();
    if (content) {
      thinkingParts.push(content);
    }
    match = thinkRegex.exec(text);
  }

  const cleanedText = text.replace(thinkRegex, "").trim();

  return {
    text: cleanedText,
    ...(thinkingParts.length > 0
      ? { thinking: thinkingParts.join("\n\n") }
      : {}),
  };
}
