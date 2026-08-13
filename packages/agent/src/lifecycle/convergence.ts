import type { AgentToolCallAction } from "@paw/core";
import type { TaskState } from "../task-state.js";
import { isVerificationCommand } from "../task-state.js";

const SOURCE_MUTATION_TOOLS = new Set([
  "workspace.write_file",
  "workspace.edit_file",
  "workspace.apply_patch",
  "workspace.notebook_edit",
]);

function isDiffInspection(call: AgentToolCallAction): boolean {
  if (call.tool === "workspace.git_diff") return true;
  if (call.tool !== "workspace.run_shell") return false;
  const command =
    typeof call.args.command === "string" ? call.args.command : "";
  return /(?:^|[;&|]\s*)git\s+diff(?:\s|$)/i.test(command);
}

function isInvestigationCall(call: AgentToolCallAction): boolean {
  if (SOURCE_MUTATION_TOOLS.has(call.tool)) return false;
  if (call.tool !== "workspace.run_shell") return !isDiffInspection(call);
  const command =
    typeof call.args.command === "string" ? call.args.command : "";
  return !isVerificationCommand(command) && !isDiffInspection(call);
}

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
 * Executable phase policy for mutation tasks. Unlike a prompt, a blocked
 * investigation becomes a tool result the model must observe. The policy does
 * not consume or shrink maxSteps, and always permits edits and verification.
 */
export function convergenceToolBlockReason(
  call: AgentToolCallAction,
  state: TaskState,
  turn: number,
  maxSteps: number,
): string | null {
  if (!goalLikelyRequiresImplementation(state.goal)) return null;
  const revision = state.mutationRevision ?? 0;
  if (
    revision === 0 &&
    turn >= Math.ceil(maxSteps * 0.5) &&
    state.filesRead.length + state.commandsRun.length >= 3 &&
    isInvestigationCall(call)
  ) {
    return "[LoopPolicy:implementation_required] The task is past its midpoint with substantial investigation but no recorded source change. This additional investigation is deferred. Make the smallest plausible product-source edit from the evidence already gathered, or run an existing narrow test that directly discriminates the candidate.";
  }
  if (revision === 0 || turn <= maxSteps - convergenceWindow(maxSteps)) {
    return null;
  }
  const latest = state.testResults.at(-1);
  const currentVerification = latest?.mutationRevision === revision;
  if ((!currentVerification || !latest.passed) && isInvestigationCall(call)) {
    return latest && currentVerification
      ? "[LoopPolicy:fix_current_failure] The current source revision has a failing verification. Broad investigation is deferred; use that exact failure to edit the implementation or rerun a narrower diagnostic test."
      : "[LoopPolicy:verify_current_revision] The current source revision has no fresh verification. Broad investigation is deferred; run the narrowest existing repository test or direct acceptance command now.";
  }
  if (
    latest?.passed &&
    currentVerification &&
    (state.diffInspectedRevision ?? 0) !== revision &&
    !isDiffInspection(call) &&
    isInvestigationCall(call)
  ) {
    return "[LoopPolicy:inspect_final_diff] Verification passes for the current source revision. Additional investigation is deferred until you inspect the final diff for scope and accidental changes.";
  }
  if (
    latest?.passed &&
    currentVerification &&
    (state.diffInspectedRevision ?? 0) === revision &&
    isInvestigationCall(call)
  ) {
    return "[LoopPolicy:deliver] The current source revision has fresh passing verification and an inspected final diff. Additional investigation is deferred. Deliver final_answer now, or make a concrete source edit only if you can name a specific unresolved acceptance risk.";
  }
  return null;
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
