/**
 * Persist large or evicted tool results to disk (Claude Code–style recovery path).
 *
 * Full content → `.paw/sessions/{runId}/tool-results/{id}.txt`
 * Context message → header + `<persisted-output>` preview + filepath.
 */

import fs from "node:fs";
import path from "node:path";

export const PERSISTED_OUTPUT_OPEN = "<persisted-output>";
export const PERSISTED_OUTPUT_CLOSE = "</persisted-output>";
export const PREVIEW_SIZE_BYTES = 2_000;
export const DEFAULT_KEEP_RECENT_TOOLS = 5;
/** Phase A: persist when tool result exceeds this many UTF-16 code units (Claude ~50K chars). */
export const DEFAULT_MAX_TOOL_OUTPUT_BYTES = 50_000;

export function getToolResultsDir(
  workspaceRoot: string,
  runId: string,
): string {
  const safe = runId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(workspaceRoot, ".paw", "sessions", safe, "tool-results");
}

export function isPersistedToolResult(content: string): boolean {
  return content.includes(PERSISTED_OUTPUT_OPEN);
}

export function generatePreview(
  content: string,
  maxBytes: number = PREVIEW_SIZE_BYTES,
): { preview: string; hasMore: boolean } {
  if (content.length <= maxBytes) {
    return { preview: content, hasMore: false };
  }
  const truncated = content.slice(0, maxBytes);
  const lastNewline = truncated.lastIndexOf("\n");
  const preview =
    lastNewline > maxBytes * 0.5
      ? truncated.slice(0, lastNewline)
      : truncated;
  return { preview, hasMore: true };
}

export function persistToolResultToDisk(
  toolResultsDir: string,
  id: string,
  content: string,
): string {
  fs.mkdirSync(toolResultsDir, { recursive: true });
  const safeId = id.replace(/[^a-zA-Z0-9._-]/g, "_");
  const filepath = path.join(toolResultsDir, `${safeId}.txt`);
  fs.writeFileSync(filepath, content, "utf8");
  return filepath;
}

export function buildPersistedToolResultContent(opts: {
  readonly tool: string;
  readonly ok: boolean;
  readonly summary: string;
  readonly filepath: string;
  readonly originalSize: number;
  readonly fullBody: string;
}): string {
  const { preview, hasMore } = generatePreview(opts.fullBody);
  const status = opts.ok ? "completed" : "failed";
  const sizeKb = (opts.originalSize / 1024).toFixed(1);
  let body = `${PERSISTED_OUTPUT_OPEN}\n`;
  body += `Output saved to disk (${sizeKb} KB). Full output: ${opts.filepath}\n\n`;
  body += `Preview (first ${PREVIEW_SIZE_BYTES} bytes):\n`;
  body += preview;
  if (hasMore) body += "\n...\n";
  body += `\n${PERSISTED_OUTPUT_CLOSE}`;
  return `[Tool ${opts.tool} ${status}]\n${opts.summary}\n${body}`;
}

export function toolResultExceedsLimits(
  content: string,
  maxBytes: number = DEFAULT_MAX_TOOL_OUTPUT_BYTES,
): boolean {
  if (isPersistedToolResult(content)) return false;
  return content.length > maxBytes;
}
