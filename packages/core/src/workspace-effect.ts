/** Shared evidence semantics for progress, verification freshness and completion. */
export function projectWorkspaceEffect(
  tool: string,
  payload: unknown,
  failed = false,
): { changed: boolean | "unknown"; paths: string[] } {
  const record = (v: unknown): Record<string, unknown> =>
    v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const value = record(payload);
  const effect = record(value.workspaceEffect);
  const paths = Array.isArray(effect.paths)
    ? effect.paths.filter((p): p is string => typeof p === "string")
    : [];
  if (effect.changed === true || effect.changed === false || effect.changed === "unknown")
    return { changed: effect.changed, paths };
  if (/(?:run_shell|job_start|job_wait|job_kill|undo)$/.test(tool))
    return { changed: "unknown", paths: [] };
  if (/(?:write_file|edit_file|apply_patch|notebook_edit)$/.test(tool))
    return { changed: !failed, paths: [] };
  if (/(?:delegate|run_agent)$/.test(tool)) {
    const files = Array.isArray(value.changedFiles)
      ? value.changedFiles.filter((p): p is string => typeof p === "string")
      : [];
    return { changed: files.length ? true : "unknown", paths: files };
  }
  return { changed: false, paths: [] };
}
