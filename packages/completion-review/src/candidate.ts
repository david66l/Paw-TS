import { createHash } from "node:crypto";
import type { JsonValue, ToolSettlementStatusV1 } from "@paw/protocol";

export type CompletionReviewEvidenceOutcomeV1 =
  "passed" | "failed" | "indeterminate";

export type CompletionReviewVerificationKindV1 =
  "test" | "build" | "lint" | "typecheck" | "none";

export interface CompletionReviewToolEvidenceV1 {
  readonly callId: string;
  readonly tool: string;
  readonly executionStatus: ToolSettlementStatusV1;
  readonly outcome: CompletionReviewEvidenceOutcomeV1;
  readonly verificationKind: CompletionReviewVerificationKindV1;
  readonly verificationTarget?: string;
  readonly args: JsonValue;
  readonly summary: string;
  readonly afterLatestMutation: boolean;
  readonly isError?: boolean;
  readonly exitCode?: number;
  readonly timedOut?: boolean;
}

export interface CompletionReviewCandidateV1 {
  readonly candidateHash: string;
  readonly sourceThroughSeq: number;
  readonly goal: string;
  readonly assistantText: string;
  readonly changedPaths: readonly string[];
  readonly mutationCount: number;
  readonly hasUnknownMutationPath: boolean;
  readonly toolEvidence: readonly CompletionReviewToolEvidenceV1[];
}

export interface CreateCompletionReviewCandidateInputV1 extends Omit<
  CompletionReviewCandidateV1,
  "candidateHash"
> {}

export function createCompletionReviewCandidateV1(
  input: CreateCompletionReviewCandidateInputV1,
): CompletionReviewCandidateV1 {
  if (
    !Number.isSafeInteger(input.sourceThroughSeq) ||
    input.sourceThroughSeq <= 0
  ) {
    throw new Error("Completion review source boundary is invalid");
  }
  if (!input.goal.trim() || !input.assistantText.trim()) {
    throw new Error("Completion review candidate text is empty");
  }
  if (!Number.isSafeInteger(input.mutationCount) || input.mutationCount < 0) {
    throw new Error("Completion review mutation count is invalid");
  }
  const changedPaths = uniqueStrings(input.changedPaths, "changed path");
  const toolEvidence = Object.freeze(
    input.toolEvidence.map((item) => freezeEvidence(item)),
  );
  const value = Object.freeze({
    sourceThroughSeq: input.sourceThroughSeq,
    goal: input.goal,
    assistantText: input.assistantText,
    changedPaths,
    mutationCount: input.mutationCount,
    hasUnknownMutationPath: input.hasUnknownMutationPath,
    toolEvidence,
  });
  const candidateHash = createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
  return Object.freeze({ candidateHash, ...value });
}

function freezeEvidence(
  value: CompletionReviewToolEvidenceV1,
): CompletionReviewToolEvidenceV1 {
  if (!value.callId.trim() || !value.tool.trim() || !value.summary.trim()) {
    throw new Error("Completion review tool evidence is invalid");
  }
  if (
    !["completed", "failed", "cancelled", "unknown", "rejected"].includes(
      value.executionStatus,
    )
  ) {
    throw new Error("Completion review tool status is invalid");
  }
  if (
    !(["passed", "failed", "indeterminate"] as const).includes(value.outcome)
  ) {
    throw new Error("Completion review tool outcome is invalid");
  }
  if (
    !(["test", "build", "lint", "typecheck", "none"] as const).includes(
      value.verificationKind,
    )
  ) {
    throw new Error("Completion review verification kind is invalid");
  }
  if (
    value.verificationTarget !== undefined &&
    !value.verificationTarget.trim()
  ) {
    throw new Error("Completion review verification target is invalid");
  }
  if (
    value.exitCode !== undefined &&
    (!Number.isSafeInteger(value.exitCode) || value.exitCode < 0)
  ) {
    throw new Error("Completion review exit code is invalid");
  }
  return Object.freeze({
    callId: value.callId,
    tool: value.tool,
    executionStatus: value.executionStatus,
    outcome: value.outcome,
    verificationKind: value.verificationKind,
    ...(value.verificationTarget === undefined
      ? {}
      : { verificationTarget: singleLine(value.verificationTarget) }),
    args: cloneJson(value.args),
    summary: singleLine(value.summary).slice(0, 2_000),
    afterLatestMutation: value.afterLatestMutation,
    ...(value.isError === undefined ? {} : { isError: value.isError }),
    ...(value.exitCode === undefined ? {} : { exitCode: value.exitCode }),
    ...(value.timedOut === undefined ? {} : { timedOut: value.timedOut }),
  });
}

function uniqueStrings(
  values: readonly string[],
  label: string,
): readonly string[] {
  const normalized = values.map((value) => value.trim()).filter(Boolean);
  if (normalized.length !== values.length) {
    throw new Error(`Completion review ${label} is invalid`);
  }
  return Object.freeze([...new Set(normalized)].sort());
}

function cloneJson<T extends JsonValue>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
