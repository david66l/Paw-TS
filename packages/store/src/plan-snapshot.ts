import type { Plan } from "./plan.js";

/** Default cap on {@link PlanSnapshotPayload.items} rows to limit prompt growth. */
export const DEFAULT_PLAN_SNAPSHOT_MAX_ITEMS = 64;

export type PlanSnapshotOptions = {
  /**
   * Max plan rows included in `items`.
   * - `undefined`: use {@link DEFAULT_PLAN_SNAPSHOT_MAX_ITEMS}
   * - `0`: no limit (include every row)
   */
  readonly maxItems?: number;
};

type PlanSnapshotRow = {
  readonly id: string;
  readonly task_id: string;
  readonly status: string;
  readonly depends_on: readonly string[];
  readonly note: string | null;
};

/**
 * Serializable view of a {@link Plan} for model / UI context (orchestrator user turn).
 */
export type PlanSnapshotPayload = {
  readonly workflow_id: string;
  readonly revision: number;
  readonly items: ReadonlyArray<PlanSnapshotRow>;
  /** Total rows in the plan (may exceed `items.length` when truncated). */
  readonly items_total: number;
  /** True when `items` is a prefix of the full plan only. */
  readonly truncated: boolean;
  /** Next runnable row per dependency order, or null if none. */
  readonly next_pending: {
    readonly id: string;
    readonly task_id: string;
  } | null;
  /** True when every row is completed or skipped. */
  readonly all_complete: boolean;
};

function resolveMaxItems(options?: PlanSnapshotOptions): number {
  if (options?.maxItems === 0) {
    return Number.POSITIVE_INFINITY;
  }
  if (
    typeof options?.maxItems === "number" &&
    options.maxItems > 0 &&
    Number.isFinite(options.maxItems)
  ) {
    return options.maxItems;
  }
  return DEFAULT_PLAN_SNAPSHOT_MAX_ITEMS;
}

export function planToSnapshotPayload(
  plan: Plan,
  options?: PlanSnapshotOptions,
): PlanSnapshotPayload {
  const maxItems = resolveMaxItems(options);
  const next = plan.nextPending();
  const mapped: PlanSnapshotRow[] = plan.items.map((i) => ({
    id: i.id,
    task_id: i.task_id,
    status: i.status,
    depends_on: i.depends_on,
    note: i.note,
  }));
  const items_total = mapped.length;
  const truncated =
    Number.isFinite(maxItems) && items_total > maxItems && maxItems >= 1;
  const items =
    truncated && Number.isFinite(maxItems)
      ? mapped.slice(0, Math.floor(maxItems))
      : mapped;

  return {
    workflow_id: plan.workflow_id,
    revision: plan.revision,
    items,
    items_total,
    truncated,
    next_pending: next ? { id: next.id, task_id: next.task_id } : null,
    all_complete: plan.allComplete,
  };
}
