import type { TaskState } from "../task-state.js";
import {
  type AcceptanceReadinessItem,
  acceptanceReadiness,
} from "../task-state.js";

export type AcceptanceGateDecision =
  | { readonly ok: true; readonly items: readonly AcceptanceReadinessItem[] }
  | {
      readonly ok: false;
      readonly mode: "action_required" | "blocked";
      readonly items: readonly AcceptanceReadinessItem[];
      readonly message: string;
    };

/** Final-answer gate for the durable, revision-scoped acceptance ledger. */
export function checkAcceptanceCriteria(
  state: TaskState,
): AcceptanceGateDecision {
  const items = acceptanceReadiness(state);
  const blocked = items.filter((item) => item.readiness === "blocked");
  if (blocked.length > 0) {
    return {
      ok: false,
      mode: "blocked",
      items: blocked,
      message: `[AcceptanceGate] Cannot declare completion: ${formatItems(blocked)}. Report the blocker honestly or update the criterion only when its state genuinely changes.`,
    };
  }

  const unresolved = items.filter(
    (item) => item.readiness === "pending" || item.readiness === "stale",
  );
  if (unresolved.length > 0) {
    return {
      ok: false,
      mode: "action_required",
      items: unresolved,
      message: `[AcceptanceGate] Before final_answer, resolve ${formatItems(unresolved)}. Verify each observable condition against the current code revision, then use acceptance_update with concrete evidence. Do not mark an item satisfied from memory or intention.`,
    };
  }

  return { ok: true, items };
}

function formatItems(items: readonly AcceptanceReadinessItem[]): string {
  const visible = items
    .slice(0, 5)
    .map(
      (item) =>
        `${item.criterion.id} [${item.readiness}] ${item.criterion.text}`,
    );
  const remainder = items.length - visible.length;
  return `${visible.join("; ")}${remainder > 0 ? `; +${remainder} more` : ""}`;
}
