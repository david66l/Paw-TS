import { defaultSettingsPath, loadPawSettingsLocal } from "@paw/settings";

/**
 * Reads optional `plan_snapshot_max_items` from `.paw/settings.local.json`.
 * Returns `undefined` when missing or unreadable so the orchestrator uses the
 * `@paw/store` default (64 rows).
 */
export function resolvePlanSnapshotMaxItems(
  workspaceRoot: string,
): number | undefined {
  try {
    const s = loadPawSettingsLocal(defaultSettingsPath(workspaceRoot));
    const v = s.plan_snapshot_max_items;
    if (
      typeof v === "number" &&
      Number.isFinite(v) &&
      Number.isInteger(v) &&
      v >= 0
    ) {
      return v;
    }
  } catch {
    /* missing or invalid file handled elsewhere when loading full settings */
  }
  return undefined;
}
