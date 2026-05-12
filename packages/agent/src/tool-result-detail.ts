import type { ToolRunResult } from "@paw/harness";

const MAX_DETAIL_CHARS = 6000;
const MAX_FILE_LINES = 64;
const MAX_LIST_FILES = 50;

/**
 * Human-readable detail for TUI / logs. Best-effort from tool payload; trimmed.
 */
export function formatToolResultEventDetail(
  tr: ToolRunResult,
): string | undefined {
  const p = tr.payload;
  if (p === null || typeof p !== "object") {
    return tr.ok ? undefined : tr.summary;
  }

  if (!tr.ok) {
    if ("error" in p) {
      return String((p as { error: unknown }).error).slice(0, MAX_DETAIL_CHARS);
    }
    return tr.summary;
  }

  if (
    "content" in p &&
    typeof (p as { content?: unknown }).content === "string"
  ) {
    const c = (p as { content: string }).content;
    return c
      .split("\n")
      .slice(0, MAX_FILE_LINES)
      .join("\n")
      .slice(0, MAX_DETAIL_CHARS);
  }

  if ("files" in p && Array.isArray((p as { files?: unknown }).files)) {
    const files = (p as { files: string[] }).files;
    return files.slice(0, MAX_LIST_FILES).join("\n").slice(0, MAX_DETAIL_CHARS);
  }

  if (typeof (p as { exit_code?: unknown }).exit_code === "number") {
    const ex = (p as { exit_code: number }).exit_code;
    const out =
      typeof (p as { stdout?: unknown }).stdout === "string"
        ? (p as { stdout: string }).stdout
        : "";
    const err =
      typeof (p as { stderr?: unknown }).stderr === "string"
        ? (p as { stderr: string }).stderr
        : "";
    const parts = [`exit ${ex}`];
    if (out) {
      parts.push(out);
    }
    if (err) {
      parts.push(`stderr: ${err}`);
    }
    return parts.join("\n").slice(0, MAX_DETAIL_CHARS);
  }

  if ("matches" in p && Array.isArray((p as { matches?: unknown }).matches)) {
    const mm = (
      p as {
        matches: Array<{ path?: string; line?: number; text?: string }>;
      }
    ).matches;
    const lines = mm.slice(0, 40).map((m) => {
      const loc = `${m.path ?? "?"}:${m.line ?? "?"}`;
      const snippet = String(m.text ?? "").slice(0, 200);
      return `${loc}: ${snippet}`;
    });
    return lines.join("\n").slice(0, MAX_DETAIL_CHARS);
  }

  if (
    typeof (p as { bytes_written?: unknown }).bytes_written === "number" &&
    (p as { bytes_written: number }).bytes_written >= 0
  ) {
    const path =
      typeof (p as { path?: unknown }).path === "string"
        ? (p as { path: string }).path
        : "";
    const b = (p as { bytes_written: number }).bytes_written;
    const line = path ? `${path}\n${b} bytes written` : `${b} bytes written`;
    return line.slice(0, MAX_DETAIL_CHARS);
  }

  return undefined;
}
