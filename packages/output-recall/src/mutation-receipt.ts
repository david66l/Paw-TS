import type { JsonValue } from "@paw/protocol";
import type { ToolObservationProjectionInputV1 } from "@paw/runtime";

export const MUTATION_RECEIPT_POLICY_V1 = "paw.mutation-receipt.v1" as const;

/** Model view only: retain the exact receipt and diagnostics, archive its diff. */
export function projectMutationReceiptV1(
  observation: ToolObservationProjectionInputV1,
  maxCharsPerRecall: number,
): JsonValue | undefined {
  const raw = observation.value;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Readonly<Record<string, JsonValue>>;
  if (
    !["workspace_write_file", "workspace_edit_file"].includes(
      observation.tool,
    ) ||
    observation.status !== "completed" ||
    observation.isError ||
    observation.payload.kind !== "artifact_ref" ||
    value.changed !== true ||
    typeof value.path !== "string" ||
    typeof value.diff !== "string" ||
    "diffRecall" in value ||
    "error" in value
  )
    return undefined;

  const { diff, ...receipt } = value;
  const projected = {
    ...receipt,
    diffRecall: {
      policyVersion: MUTATION_RECEIPT_POLICY_V1,
      chars: diff.length,
      tool: "context_recall",
      id: observation.payload.artifactRef,
      part: "chunk",
      offset: 0,
      limit: maxCharsPerRecall,
      instruction:
        "Recorded diff is in this original tool result. Recall only if needed; use offset for later chunks.",
    },
  };
  // A reference must save meaningful space; small receipts remain byte-identical.
  return JSON.stringify(value).length - JSON.stringify(projected).length >= 256
    ? projected
    : undefined;
}
