/**
 * @mention 解析 — 从用户输入中解析 @path 引用并读取文件作为附件。
 * ==============================================================
 *
 * 支持格式：@file.txt、@"file with spaces.txt"、@'file name.txt'
 *
 * 解析流程：
 * 1. 提取所有 @ 引用（双引号 > 单引号 > 无引号）
 * 2. 解析路径（展开 ~，检查工作区边界）
 * 3. 图片文件 → base64 编码为 image 附件
 * 4. 文本文件 → 读取内容为 file 附件
 * 5. 从原文中移除 @ 引用语法 → 返回 strippedText
 *
 * 面试要点：
 * - 为什么图片用 base64？LLM vision API 需要 base64 编码的图片数据
 * - 工作区边界检查：防止 @/etc/passwd 读取系统文件
 */

import fs from "node:fs";
import path from "node:path";

import { readWorkspaceFile } from "./files/read.js";

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

function imageMimeType(filePath: string): string | undefined {
  return IMAGE_MIME_BY_EXT[path.extname(filePath).toLowerCase()];
}

export interface MentionAttachment {
  readonly type: "image" | "file";
  readonly name: string;
  readonly content: string;
  readonly mimeType?: string;
}

export interface MentionResult {
  readonly strippedText: string;
  readonly attachments: readonly MentionAttachment[];
  readonly notFound: readonly string[];
}

/**
 * Extract @-mentioned paths from text.
 * Patterns:
 *   @file.txt         — unquoted, stops at whitespace
 *   @"file name.txt" — quoted, supports spaces
 *   @'file name.txt' — single-quoted
 */
export function extractAtMentions(text: string): string[] {
  const mentions: string[] = [];
  // Double-quoted: @"..."
  const doubleQuoted = /@"([^"]+)"/g;
  for (const m of text.matchAll(doubleQuoted)) {
    if (m[1]) mentions.push(m[1]);
  }
  // Single-quoted: @'...'
  const singleQuoted = /@'([^']+)'/g;
  for (const m of text.matchAll(singleQuoted)) {
    if (m[1]) mentions.push(m[1]);
  }
  // Unquoted: @path (must be preceded by whitespace or start of string)
  // We process the text with quoted matches already removed to avoid double-counting
  const remaining = text.replace(doubleQuoted, "").replace(singleQuoted, "");
  const unquoted = /(?:^|\s)@([\w./~_-]+)/g;
  for (const m of remaining.matchAll(unquoted)) {
    if (m[1]) mentions.push(m[1]);
  }
  return [...new Set(mentions)]; // deduplicate
}

/** Remove @-mention syntax from text, leaving plain description. */
export function stripAtMentions(text: string): string {
  return text
    .replace(/@"[^"]+"/g, "")
    .replace(/@'[^']+'/g, "")
    .replace(/@[\w./~_-]+/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Resolve @-mentioned paths to file attachments.
 * Paths are resolved relative to workspaceRoot.
 */
export function resolveMentions(
  workspaceRoot: string,
  text: string,
): MentionResult {
  const mentions = extractAtMentions(text);
  const attachments: MentionAttachment[] = [];
  const notFound: string[] = [];

  for (const raw of mentions) {
    // Normalize path: expand ~, resolve relative to workspaceRoot
    let rel = raw;
    if (rel.startsWith("~")) {
      rel = rel.replace("~", process.env.HOME || ".");
    }
    // Security: prevent escaping workspaceRoot
    const target = path.resolve(workspaceRoot, rel);
    if (!target.startsWith(path.resolve(workspaceRoot))) {
      notFound.push(`${raw} (outside workspace)`);
      continue;
    }
    if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) {
      notFound.push(raw);
      continue;
    }
    const mimeType = imageMimeType(target);
    if (mimeType) {
      const data = fs.readFileSync(target);
      attachments.push({
        type: "image",
        name: rel,
        content: data.toString("base64"),
        mimeType,
      });
      continue;
    }
    const result = readWorkspaceFile(workspaceRoot, rel);
    if (result.error || result.content === undefined) {
      notFound.push(raw);
      continue;
    }
    attachments.push({
      type: "file",
      name: rel,
      content: result.content,
    });
  }

  return {
    strippedText: stripAtMentions(text),
    attachments,
    notFound,
  };
}
