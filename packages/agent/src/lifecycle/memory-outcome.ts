import type { MemoryOutcomeContractV1 } from "@paw/memory";
import type { TaskState } from "../task-state.js";
import type { CompletionDecision } from "./completion-policy.js";

function verificationAuthority(
  decision: CompletionDecision,
): MemoryOutcomeContractV1["verificationAuthority"] {
  if (decision.outcome === "verified") return "local";
  if (decision.reason === "external_verification_pending") return "external";
  if (decision.evidence.filesChanged.length === 0) return "not_required";
  return "local";
}

/** Builds the only agent→memory terminal contract from lifecycle authority. */
export function memoryOutcomeFromDecision(
  decision: CompletionDecision,
  taskState: TaskState,
): MemoryOutcomeContractV1 {
  return {
    schemaVersion: 1,
    runStatus: decision.status,
    completionOutcome: decision.outcome,
    completionReason: decision.reason,
    verificationAuthority: verificationAuthority(decision),
    mutationRevision: taskState.mutationRevision ?? 0,
    evidence: decision.evidence,
  };
}
