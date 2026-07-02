/**
 * 消息内容构建器：将 Paw 内部的消息格式转换为各 LLM 提供商的原生格式
 *
 * ## 是什么
 * 提供两个核心函数：
 * - `buildOpenAiMessageContent`：将 ChatMessage 转为 OpenAI Chat Completions API 的 content 字段
 * - `buildAnthropicUserContent`：将 ChatMessage 转为 Anthropic Messages API 的 content 字段
 *
 * ## 为什么需要
 * Paw 内部使用统一的 ChatMessage 格式（含 attachments 附件），但不同提供商的 API
 * 对多模态内容（文本+图片+文件）的表达方式不同：
 * - OpenAI：`[{type:"text",text:...}, {type:"image_url",image_url:{url:...}}]`
 * - Anthropic：`[{type:"text",text:...}, {type:"image",source:{type:"base64",...}}]`
 *
 * 本模块封装了这些差异，让上游调用方无需关心具体 API 格式。
 *
 * ## 关键设计决策
 * 1. **纯文本优化**：如果没有附件，直接返回字符串而非单元素数组，减少不必要的嵌套
 * 2. **图片检测**：通过 Attachment.type === "image" 判断是否为图片；
 *    非图片附件作为文本嵌入（`[File: name]\ncontent`）
 * 3. **Base64 Data URL 处理**：支持已经是 data: URL 格式的附件内容和裸 base64 字符串
 * 4. **MIME 类型推断**：Anthropic 图片需要明确的 media_type，优先取附件自带的 mimeType，
 *    否则根据文件名后缀推断（jpg/jpeg/gif/webp/png）
 */

import type { Attachment, ChatMessage } from "./types.js";

// ─── OpenAI 类型定义 ───

/** OpenAI content 字段的联合类型：纯文本字符串或多模态 part 数组 */
export type OpenAiContentPart =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "image_url";
      readonly image_url: {
        readonly url: string;
        readonly detail?: "low" | "high" | "auto";
      };
    };

// ─── Anthropic 类型定义 ───

/** Anthropic content 字段的联合类型：文本块或图片块 */
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

// ─── 图片处理辅助函数 ───

/**
 * 将附件转为完整的 Data URL 格式。
 * 如果附件内容已经是 data: 前缀，直接返回；
 * 否则补全 `data:{mime};base64,{content}` 前缀。
 */
function imageDataUrl(att: Attachment): string {
  if (att.content.startsWith("data:")) {
    return att.content;
  }
  const mime = att.mimeType ?? "image/png";
  return `data:${mime};base64,${att.content}`;
}

/**
 * 推断 Anthropic API 所需的图片 media_type。
 * 优先使用附件自带的 mimeType；否则根据文件名后缀推断；
 * 默认 fallback 为 image/png。
 */
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

/**
 * 提取 Anthropic API 所需的裸 base64 图片数据。
 * 如果附件内容是 data: URL，去掉前缀只取 base64 部分；
 * 否则直接返回原始内容（假定已是纯 base64）。
 */
function anthropicImageData(att: Attachment): string {
  const raw = att.content.startsWith("data:")
    ? att.content.split(",", 2)[1] ?? ""
    : att.content;
  return raw;
}

// ─── 公共 API ───

/**
 * 构建 OpenAI Chat Completions API 的 `content` 字段。
 *
 * 逻辑：
 * - 无附件：直接返回纯文本字符串
 * - 有附件：构建多模态 part 数组
 *   - 文本部分（如果有）：`{type:"text", text:...}`
 *   - 图片附件：`{type:"image_url", image_url:{url:..., detail:"high"}}`
 *   - 其他附件：`{type:"text", text:"[File: name]\ncontent"}`
 * - 优化：如果最终只有一个文本 part，回退为纯字符串
 */
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
      // 非图片附件以文本形式嵌入
      parts.push({
        type: "text",
        text: `[File: ${att.name}]\n${att.content}`,
      });
    }
  }

  // 优化：单文本 part 时直接返回字符串，保持 API 载荷简洁
  if (parts.length === 1 && parts[0]?.type === "text") {
    return parts[0].text;
  }
  return parts;
}

/**
 * 构建 Anthropic Messages API 的 `content` 字段。
 *
 * 逻辑与 OpenAI 版本类似，但图片使用 Anthropic 的 source 格式：
 * `{type:"image", source:{type:"base64", media_type:"...", data:"..."}}`
 *
 * 同样支持单文本 block 优化为纯字符串。
 */
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
