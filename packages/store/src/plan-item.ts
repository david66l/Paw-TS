/**
 * Plan slice — aligned with Python `paw.store.schemas.PlanItem` / `PlanItemStatus`
 * (architecture v2 §8.3).
 */

export const PlanItemStatus = {
  PENDING: "pending",
  RUNNING: "running",
  COMPLETED: "completed",
  BLOCKED: "blocked",
  SKIPPED: "skipped",
  FAILED: "failed",
} as const;

export type PlanItemStatus =
  (typeof PlanItemStatus)[keyof typeof PlanItemStatus];

/** One row in a workflow plan (ids are plan-line ids; `task_id` links to work units). */
export type PlanItem = {
  id: string;
  task_id: string;
  status: PlanItemStatus;
  depends_on: string[];
  assigned_run_id: string | null;
  note: string | null;
};

export function createPlanItem(partial: {
  readonly id: string;
  readonly task_id: string;
  readonly status?: PlanItemStatus;
  readonly depends_on?: readonly string[];
  readonly assigned_run_id?: string | null;
  readonly note?: string | null;
}): PlanItem {
  return {
    id: partial.id,
    task_id: partial.task_id,
    status: partial.status ?? PlanItemStatus.PENDING,
    depends_on: partial.depends_on ? [...partial.depends_on] : [],
    assigned_run_id: partial.assigned_run_id ?? null,
    note: partial.note ?? null,
  };
}
