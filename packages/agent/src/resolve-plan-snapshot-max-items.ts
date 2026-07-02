/**
 * 从 `.paw/settings.local.json` 读取可选的 plan_snapshot_max_items。
 * ================================================================
 *
 * 控制计划快照中最多展示的条目数。
 * 返回 undefined 时 orchestrator 使用 @paw/store 的默认值（64 条）。
 */

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
 * 读取可选的 `plan_snapshot_max_items` 配置。
 *
 * @returns 计划快照最大条目数，或 undefined（使用默认值 64）
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
