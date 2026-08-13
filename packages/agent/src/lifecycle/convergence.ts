import type { TaskState } from "../task-state.js";

export function convergenceWindow(maxSteps: number): number {
  return Math.min(12, Math.max(4, Math.ceil(maxSteps * 0.2)));
}

export function goalLikelyRequiresImplementation(goal: string): boolean {
  return /\b(?:fix|implement|add|change|modify|update|refactor|build|create|remove)\b|修复|实现|新增|修改|更新|重构|删除|构建/i.test(
    goal,
  );
}

export function implementationGuidance(
  state: TaskState,
  turn: number,
  maxSteps: number,
): string | null {
  if (
    (state.mutationRevision ?? 0) > 0 ||
    !goalLikelyRequiresImplementation(state.goal) ||
    turn < Math.ceil(maxSteps * 0.5) ||
    state.filesRead.length + state.commandsRun.length < 3
  ) {
    return null;
  }
  return "[Implementation checkpoint] Half of the available model turns have been used without a recorded source change. Consolidate the evidence already gathered into the smallest plausible implementation now. Prefer editing the product source and running an existing narrow test; do not spend the remaining run building a separate verification harness unless the repository has no usable test path.";
}

export function convergenceEvidenceKey(state: TaskState): string {
  const revision = state.mutationRevision ?? 0;
  const latest = state.testResults.at(-1);
  const verification = !latest
    ? "missing"
    : latest.mutationRevision !== revision
      ? "stale"
      : latest.passed
        ? "passed"
        : "failed";
  const diff =
    (state.diffInspectedRevision ?? 0) === revision ? "current" : "stale";
  return `r${revision}:${verification}:${diff}`;
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
      "Run the narrowest high-signal acceptance or regression test against the current source revision. Prefer an existing repository test or a direct command; do not build and debug a separate helper harness. Do not rely on a test that predates the latest edit.";
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
