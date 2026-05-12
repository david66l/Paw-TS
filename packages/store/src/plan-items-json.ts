import { type PlanItem, PlanItemStatus, createPlanItem } from "./plan-item.js";

const STATUS_SET = new Set<string>(Object.values(PlanItemStatus));

function isPlanItemStatus(s: string): s is PlanItem["status"] {
  return STATUS_SET.has(s);
}

/**
 * Best-effort parse of `PlanUpdateAction.new_items` JSON into {@link PlanItem}s.
 * Skips entries missing required `id` / `task_id` (or camelCase `taskId`).
 */
export function planItemsFromUnknown(items: readonly unknown[]): PlanItem[] {
  const out: PlanItem[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      continue;
    }
    const o = raw as Record<string, unknown>;
    const id = typeof o.id === "string" ? o.id : "";
    const taskId =
      typeof o.task_id === "string"
        ? o.task_id
        : typeof o.taskId === "string"
          ? o.taskId
          : "";
    if (!id || !taskId) {
      continue;
    }
    const statusRaw = typeof o.status === "string" ? o.status : "";
    const status =
      statusRaw && isPlanItemStatus(statusRaw)
        ? statusRaw
        : PlanItemStatus.PENDING;

    const dependsRaw = o.depends_on ?? o.dependsOn;
    const depends_on = Array.isArray(dependsRaw)
      ? dependsRaw.filter((x): x is string => typeof x === "string")
      : [];

    let assigned_run_id: string | null = null;
    if (o.assigned_run_id === null) {
      assigned_run_id = null;
    } else if (typeof o.assigned_run_id === "string") {
      assigned_run_id = o.assigned_run_id;
    } else if (o.assignedRunId === null) {
      assigned_run_id = null;
    } else if (typeof o.assignedRunId === "string") {
      assigned_run_id = o.assignedRunId;
    }

    let note: string | null = null;
    if (o.note === null) {
      note = null;
    } else if (typeof o.note === "string") {
      note = o.note;
    }

    out.push(
      createPlanItem({
        id,
        task_id: taskId,
        status,
        depends_on,
        assigned_run_id,
        note,
      }),
    );
  }
  return out;
}
