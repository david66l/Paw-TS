/**
 * Convert Paw {@link ChatMessage} content + attachments to provider-specific payloads.
 */

import type { Attachment, ChatMessage } from "./types.js";

export type OpenAiContentPart =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "image_url";
      readonly image_url: {
        readonly url: string;
        readonly detail?: "low" | "high" | "auto";
      };
    };

export type AnthropicContentBlock =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "image";
      readonly source: {
        readonly type: "base64";
        readonly media_type: string;
        readonly data: string;
      };
    };

function imageDataUrl(att: Attachment): string {
  if (att.content.startsWith("data:")) {
    return att.content;
  }
  const mime = att.mimeType ?? "image/png";
  return `data:${mime};base64,${att.content}`;
}

function anthropicImageMediaType(att: Attachment): string {
  if (att.mimeType && att.mimeType.startsWith("image/")) {
    return att.mimeType;
  }
  const lower = att.name.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
    return "image/jpeg";
  }
  if (lower.endsWith(".gif")) {
    return "image/gif";
  }
  if (lower.endsWith(".webp")) {
    return "image/webp";
  }
  return "image/png";
}

function anthropicImageData(att: Attachment): string {
  const raw = att.content.startsWith("data:")
    ? att.content.split(",", 2)[1] ?? ""
    : att.content;
  return raw;
}

/** OpenAI Chat Completions `content` field (string or multimodal parts). */
export function buildOpenAiMessageContent(
  message: ChatMessage,
): string | OpenAiContentPart[] {
  if (!message.attachments?.length) {
    return message.content;
  }

  const parts: OpenAiContentPart[] = [];
  if (message.content.trim()) {
    parts.push({ type: "text", text: message.content });
  }

  for (const att of message.attachments) {
    if (att.type === "image") {
      parts.push({
        type: "image_url",
        image_url: { url: imageDataUrl(att), detail: "high" },
      });
    } else {
      parts.push({
        type: "text",
        text: `[File: ${att.name}]\n${att.content}`,
      });
    }
  }

  if (parts.length === 1 && parts[0]?.type === "text") {
    return parts[0].text;
  }
  return parts;
}

/** Anthropic Messages API `content` field for a user turn. */
export function buildAnthropicUserContent(
  message: ChatMessage,
): string | AnthropicContentBlock[] {
  if (!message.attachments?.length) {
    return message.content;
  }

  const blocks: AnthropicContentBlock[] = [];
  if (message.content.trim()) {
    blocks.push({ type: "text", text: message.content });
  }

  for (const att of message.attachments) {
    if (att.type === "image") {
      blocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: anthropicImageMediaType(att),
          data: anthropicImageData(att),
        },
      });
    } else {
      blocks.push({
        type: "text",
        text: `[File: ${att.name}]\n${att.content}`,
      });
    }
  }

  if (blocks.length === 1 && blocks[0]?.type === "text") {
    return blocks[0].text;
  }
  return blocks;
}
