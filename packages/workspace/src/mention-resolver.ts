/**
 * @mention resolution — parse `@path` from user input and read files as attachments.
 * Supports: `@file.txt`, `@"file with spaces.txt"`, `@../config.json`
 */

import fs from "node:fs";
import path from "node:path";

import { readWorkspaceFile } from "./local-fs.js";

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
  let remaining = text
    .replace(doubleQuoted, "")
    .replace(singleQuoted, "");
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
