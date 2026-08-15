import type { CompleteTaskInput, MemoryOutcomeContractV1 } from "./types.js";

export type MemoryCompletionDisposition =
  | "cancelled"
  | "verified_success"
  | "unverified_completion"
  | "failed";

function hasCurrentLocalPass(contract: MemoryOutcomeContractV1): boolean {
  if (contract.mutationRevision <= 0) return false;
  if (contract.evidence.mutationRevision !== contract.mutationRevision) {
    return false;
  }
  return contract.evidence.testResults.some(
    (result) =>
      (result.outcome === "passed" ||
        (result.outcome == null && result.passed)) &&
      (result.mutationRevision ?? 0) === contract.mutationRevision,
  );
}

/**
 * Fail-closed bridge from authoritative run completion into memory governance.
 * A completed status or model claim is insufficient: only a current-revision,
 * locally verified pass may enter the verified-success write path.
 */
export function classifyMemoryCompletion(
  input: Pick<CompleteTaskInput, "status" | "outcome">,
): MemoryCompletionDisposition {
  if (input.status === "cancelled") return "cancelled";
  const contract = input.outcome;
  if (!contract) {
    return input.status === "failed" ? "failed" : "unverified_completion";
  }
  if (
    contract.runStatus !== "completed" ||
    contract.completionOutcome === "failed" ||
    contract.completionOutcome === "aborted" ||
    contract.completionOutcome === "incomplete" ||
    contract.completionOutcome === "budget_exhausted"
  ) {
    return "failed";
  }
  if (
    contract.completionOutcome === "verified" &&
    contract.verificationAuthority === "local" &&
    hasCurrentLocalPass(contract)
  ) {
    return "verified_success";
  }
  return "unverified_completion";
}
