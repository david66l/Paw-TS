import path from "node:path";
import type { ToolFileChange } from "@paw/core";

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

/** Project committed tool evidence; never read the possibly changed working tree. */
export function desktopFileChanges(
  payload: unknown,
  args: unknown,
  workspaceRoot: string,
): ToolFileChange[] {
  const value = record(payload);
  const rows = Array.isArray(value.results) ? value.results : [value];
  return rows.flatMap((raw) => {
    const row = record(raw);
    if (
      row.ok === false ||
      row.changed === false ||
      typeof row.path !== "string"
    )
      return [];
    if (
      typeof row.linesAdded !== "number" &&
      typeof row.linesRemoved !== "number"
    )
      return [];
    const file = (
      path.isAbsolute(row.path)
        ? path.relative(workspaceRoot, row.path)
        : row.path
    ).replace(/\\/g, "/");
    const patch = record(args).patch;
    let diff = typeof row.diff === "string" ? row.diff : undefined;
    if (!diff && typeof patch === "string") {
      const sections = patch.split(/(?=^--- )/m);
      diff = sections.find((section) => {
        const headers = [...section.matchAll(/^(?:---|\+\+\+) (.+)$/gm)];
        return headers.some(
          (match) => match[1]?.trim().replace(/^[ab]\//, "") === file,
        );
      });
    }
    return [
      {
        path: file,
        added: typeof row.linesAdded === "number" ? row.linesAdded : 0,
        removed: typeof row.linesRemoved === "number" ? row.linesRemoved : 0,
        ...(diff ? { diff } : {}),
      },
    ];
  });
}
