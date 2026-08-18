import { MAX_STEPS_WARNING } from "@paw/core";

import type { EphemeralControlV1 } from "../context-assembler.js";
import type { TurnFlags } from "../orchestrator/types.js";
import type { TaskState } from "../task-state.js";
import {
  convergenceEvidenceKey,
  convergenceGuidance,
  implementationGuidance,
} from "./convergence.js";
import type { VerificationPolicy } from "./verification-gate.js";

export type LoopGuidanceReceiptV1 =
  | { readonly kind: "context_guard" }
  | { readonly kind: "implementation" }
  | { readonly kind: "convergence"; readonly evidenceKey: string }
  | { readonly kind: "max_steps" };

export interface LoopGuidanceCandidateV1 {
  readonly control: Extract<
    EphemeralControlV1,
    { readonly kind: "status" | "progress" }
  >;
  readonly receipt: LoopGuidanceReceiptV1;
}

export interface DeriveLoopGuidanceInputV1 {
  readonly state: TaskState;
  readonly flags: TurnFlags;
  readonly turn: number;
  readonly maxSteps: number;
  readonly historyUsed: number;
  readonly historyBudget: number;
  readonly verificationPolicy?: VerificationPolicy;
}

/**
 * Derive request-only closeout guidance without mutating delivery receipts.
 * A provider failure therefore derives the same candidate again on resume.
 */
export function deriveLoopGuidanceCandidatesV1(
  input: DeriveLoopGuidanceInputV1,
): readonly LoopGuidanceCandidateV1[] {
  const candidates: LoopGuidanceCandidateV1[] = [];
  const turnsRemaining = input.maxSteps - input.turn;
  if (
    turnsRemaining <= 3 &&
    turnsRemaining > 0 &&
    input.turn >= 5 &&
    !input.flags._maxStepsWarned
  ) {
    candidates.push({
      control: { kind: "progress", text: MAX_STEPS_WARNING },
      receipt: { kind: "max_steps" },
    });
  }

  const evidenceKey = convergenceEvidenceKey(input.state);
  if (input.flags._convergenceEvidenceKey !== evidenceKey) {
    const text = convergenceGuidance(
      input.state,
      turnsRemaining,
      input.maxSteps,
      input.verificationPolicy,
    );
    if (text) {
      candidates.push({
        control: { kind: "progress", text },
        receipt: { kind: "convergence", evidenceKey },
      });
    }
  }

  if (!input.flags._implementationWarned) {
    const text = implementationGuidance(
      input.state,
      input.turn + 1,
      input.maxSteps,
    );
    if (text) {
      candidates.push({
        control: { kind: "progress", text },
        receipt: { kind: "implementation" },
      });
    }
  }

  if (
    input.historyUsed > input.historyBudget &&
    !input.flags._budgetGuardWarned
  ) {
    candidates.push({
      control: {
        kind: "status",
        text: `[Context guard] History budget exhausted (${input.historyUsed} / ${input.historyBudget} tokens). New tool outputs will be truncated and archived as [archived id=N] references — use context.recall to restore the full text when needed. Prefer short commands and targeted reads.`,
      },
      receipt: { kind: "context_guard" },
    });
  }
  return candidates;
}

/** Record only a control that a successful provider response consumed. */
export function applyLoopGuidanceReceiptV1(
  flags: TurnFlags,
  receipt: LoopGuidanceReceiptV1,
): TurnFlags {
  switch (receipt.kind) {
    case "context_guard":
      return { ...flags, _budgetGuardWarned: true };
    case "implementation":
      return { ...flags, _implementationWarned: true };
    case "convergence":
      return { ...flags, _convergenceEvidenceKey: receipt.evidenceKey };
    case "max_steps":
      return { ...flags, _maxStepsWarned: true };
  }
}
