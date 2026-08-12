/**
 * VerificationGate — mutations require test evidence (or explicit skip).
 */

import type { TaskState } from "../task-state.js";

export type VerificationDecision =
  | {
      readonly ok: true;
      readonly mode: "no_mutation" | "tests_passed" | "skipped";
      readonly skipVerifyReason?: string;
    }
  | {
      readonly ok: false;
      readonly nudge: string;
    };

const SKIP_VERIFY_RE =
  /\[skip_verify:\s*([^\]]+)\]/i;

/** Marker in goal: coding evals must mutate files before final_answer. */
export const REQUIRE_MUTATION_MARKER = "[require_mutation]";

/**
 * Trusted caller opt-in for tasks where verification genuinely cannot run.
 * The model cannot grant this permission to itself from final_answer alone.
 */
export const ALLOW_SKIP_VERIFY_MARKER = "[allow_skip_verify]";

/** Extract optional skip_verify reason from a final_answer summary. */
export function extractSkipVerifyReason(summary: string): string | undefined {
  const m = summary.match(SKIP_VERIFY_RE);
  return m?.[1]?.trim() || undefined;
}

export function goalRequiresMutation(goal: string): boolean {
  return goal.includes(REQUIRE_MUTATION_MARKER);
}

/**
 * Check whether TaskState has enough verification evidence to complete.
 */
export function checkVerification(
  state: TaskState,
  opts?: { readonly skipVerifyReason?: string },
): VerificationDecision {
  if (state.filesChanged.length === 0) {
    if (goalRequiresMutation(state.goal)) {
      return {
        ok: false,
        nudge:
          "This task requires file changes ([require_mutation]) but none were recorded. Use workspace.edit_file / workspace.apply_patch / workspace.write_file to modify source files, then continue — do not final_answer yet.",
      };
    }
    return { ok: true, mode: "no_mutation" };
  }

  if (
    opts?.skipVerifyReason?.trim() &&
    state.goal.includes(ALLOW_SKIP_VERIFY_MARKER)
  ) {
    return {
      ok: true,
      mode: "skipped",
      skipVerifyReason: opts.skipVerifyReason.trim(),
    };
  }

  const currentRevision = state.mutationRevision ?? 0;
  const latest = state.testResults[state.testResults.length - 1];
  const latestRevision = latest?.mutationRevision ?? 0;
  if (latest?.passed && latestRevision === currentRevision) {
    return { ok: true, mode: "tests_passed" };
  }

  if (latest?.passed && latestRevision < currentRevision) {
    return {
      ok: false,
      nudge: `The last passing verification predates the latest file change (verified revision ${latestRevision}, current revision ${currentRevision}). Re-run the relevant verification after the final edit before final_answer.`,
    };
  }

  if (latest && !latest.passed) {
    return {
      ok: false,
      nudge: `Files were changed but the latest verification failed (${latest.command}). Fix the failure and re-run verification before final_answer.`,
    };
  }

  return {
    ok: false,
    nudge: `Files were changed (${state.filesChanged.slice(0, 5).join(", ")}${state.filesChanged.length > 5 ? ", …" : ""}) but no passing test evidence was recorded. Run the relevant tests (e.g. pytest / npm test), then final_answer. A [skip_verify: <reason>] claim is accepted only when the trusted task input includes ${ALLOW_SKIP_VERIFY_MARKER}.`,
  };
}
