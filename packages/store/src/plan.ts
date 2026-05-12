import {
  type PlanItem,
  type PlanItemStatus,
  PlanItemStatus as S,
} from "./plan-item.js";

/**
 * Ordered collection of tasks with dependencies (V2 §8.3.2).
 * Parity: `paw.agent.planner.Plan`.
 */
export class Plan {
  workflow_id: string;
  items: PlanItem[];
  revision: number;
  last_updated_at: string;

  constructor(
    workflow_id: string,
    items: PlanItem[] = [],
    revision = 0,
    last_updated_at = "",
  ) {
    this.workflow_id = workflow_id;
    this.items = items;
    this.revision = revision;
    this.last_updated_at = last_updated_at;
  }

  addItem(item: PlanItem): void {
    this.items.push(item);
    this.revision += 1;
  }

  updateItemStatus(itemId: string, status: PlanItemStatus): void {
    for (const item of this.items) {
      if (item.id === itemId) {
        item.status = status;
        this.revision += 1;
        return;
      }
    }
  }

  /** Next pending item whose dependencies are all completed. */
  nextPending(): PlanItem | undefined {
    const completed = new Set(
      this.items.filter((i) => i.status === S.COMPLETED).map((i) => i.id),
    );
    for (const item of this.items) {
      if (item.status === S.PENDING) {
        if (item.depends_on.every((dep) => completed.has(dep))) {
          return item;
        }
      }
    }
    return undefined;
  }

  get allComplete(): boolean {
    return this.items.every(
      (i) => i.status === S.COMPLETED || i.status === S.SKIPPED,
    );
  }
}
