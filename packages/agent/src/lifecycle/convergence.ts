import type { TaskState } from "../task-state.js";

export function convergenceWindow(maxSteps: number): number {
  return Math.min(12, Math.max(4, Math.ceil(maxSteps * 0.2)));
}

/**
 * A soft, evidence-based closeout prompt. It never blocks tools or reduces the
 * configured budget; it only makes the missing completion evidence explicit.
 */
export function convergenceGuidance(
  state: TaskState,
  turnsRemaining: number,
  maxSteps: number,
): string | null {
  const revision = state.mutationRevision ?? 0;
  if (
    revision === 0 ||
    turnsRemaining <= 0 ||
    turnsRemaining > convergenceWindow(maxSteps)
  ) {
    return null;
  }
  const latest = state.testResults.at(-1);
  const currentVerification = latest?.mutationRevision === revision;
  let next: string;
  if (!currentVerification) {
    next =
      "Run the narrowest high-signal acceptance or regression test against the current source revision. Do not rely on a test that predates the latest edit.";
  } else if (!latest.passed) {
    next =
      "Use the exact current test failure to revise the implementation, then rerun that test. Avoid reopening broad repository exploration.";
  } else if ((state.diffInspectedRevision ?? 0) !== revision) {
    next =
      "Inspect the final diff for the current revision. Check scope, accidental files, and whether the implementation actually covers the requested edge cases.";
  } else {
    next =
      "The current revision has passing verification and an inspected diff. Run at most one materially different adversarial check if a concrete risk remains; otherwise deliver final_answer now.";
  }
  return `[Convergence checkpoint] ${turnsRemaining} model turns remain. Preserve the existing solution state and close the loop. ${next}`;
}
