import { readSetting } from "./settings.js";

function parsePlanSnapshotMaxItems(value: unknown): number | undefined {
  if (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0
  ) {
    return value;
  }
  return undefined;
}

/**
 * Reads optional `plan_snapshot_max_items` from `.paw/settings.local.json`.
 * Returns `undefined` when missing or unreadable so the orchestrator uses the
 * `@paw/store` default (64 rows).
 */
export function resolvePlanSnapshotMaxItems(
  workspaceRoot: string,
): number | undefined {
  return readSetting(
    workspaceRoot,
    (s) => s.plan_snapshot_max_items,
    undefined,
    parsePlanSnapshotMaxItems,
  );
}
