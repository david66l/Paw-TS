import type { AgentToolCallAction } from "@paw/core";
import type { TaskState } from "../task-state.js";
import { isVerificationCommand, verificationOutcome } from "../task-state.js";
import type { VerificationPolicy } from "./verification-gate.js";

const SOURCE_MUTATION_TOOLS = new Set([
  "workspace.write_file",
  "workspace.edit_file",
  "workspace.apply_patch",
  "workspace.notebook_edit",
]);

const CONTROL_STATE_TOOLS = new Set([
  "workspace.todo_write",
  "workspace.acceptance_update",
]);

function isDiffInspection(call: AgentToolCallAction): boolean {
  if (call.tool === "workspace.git_diff") return true;
  if (call.tool !== "workspace.run_shell") return false;
  const command =
    typeof call.args.command === "string" ? call.args.command : "";
  return /(?:^|[;&|]\s*)git\s+diff(?:\s|$)/i.test(command);
}

function isInvestigationCall(call: AgentToolCallAction): boolean {
  if (CONTROL_STATE_TOOLS.has(call.tool)) return false;
  if (SOURCE_MUTATION_TOOLS.has(call.tool)) return false;
  if (call.tool !== "workspace.run_shell") return !isDiffInspection(call);
  const command =
    typeof call.args.command === "string" ? call.args.command : "";
  return !isVerificationCommand(command) && !isDiffInspection(call);
}

function shellCallsSince(
  state: TaskState,
  revision: number | undefined,
): number {
  const current = state.shellCommandRevision ?? state.commandsRun.length;
  return Math.max(0, current - (revision ?? current));
}

export function isEditRecoveryRead(
  call: AgentToolCallAction,
  state: TaskState,
): boolean {
  return (
    call.tool === "workspace.read_file" &&
    typeof call.args.path === "string" &&
    !!state.editRecoveryPath &&
    call.args.path === state.editRecoveryPath
  );
}

/**
 * Permit one successful exact re-read after the no-mutation midpoint. The
 * model may refresh a previously observed source region before editing, but it
 * cannot turn this escape hatch into another browsing phase.
 */
export function isConvergenceRefreshRead(
  call: AgentToolCallAction,
  state: TaskState,
  turn: number,
  maxSteps: number,
): boolean {
  if (
    call.tool !== "workspace.read_file" ||
    typeof call.args.path !== "string" ||
    (state.mutationRevision ?? 0) !== 0 ||
    turn < Math.ceil(maxSteps * 0.5) ||
    state.filesRead.length + state.commandsRun.length < 3 ||
    !state.filesRead.includes(call.args.path)
  ) {
    return false;
  }
  const counts = state.fileReadCounts ?? {};
  return !state.filesRead.some((path) => (counts[path] ?? 1) > 1);
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
      : verificationOutcome(latest);
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
  verificationPolicy?: VerificationPolicy,
): string | null {
  if (!goalLikelyRequiresImplementation(state.goal)) return null;
  if (isEditRecoveryRead(call, state)) return null;
  if (isConvergenceRefreshRead(call, state, turn, maxSteps)) return null;
  const revision = state.mutationRevision ?? 0;
  if (
    revision === 0 &&
    turn >= Math.ceil(maxSteps * 0.5) &&
    state.filesRead.length + state.commandsRun.length >= 3 &&
    isInvestigationCall(call)
  ) {
    return "[LoopPolicy:implementation_required] The task is past its midpoint with substantial investigation but no recorded source change. This additional investigation is deferred. Make the smallest plausible product-source edit from the evidence already gathered, or run an existing narrow test that directly discriminates the candidate.";
  }
  if (revision === 0) return null;
  const latest = state.testResults.at(-1);
  const currentVerification = latest?.mutationRevision === revision;
  if (!currentVerification && isInvestigationCall(call)) {
    const directChecks = shellCallsSince(
      state,
      state.mutationShellCommandRevision,
    );
    if (call.tool === "workspace.run_shell" && directChecks < 2) return null;
    return "[LoopPolicy:verify_current_revision] The current source revision has no fresh verification. Broad investigation is deferred; run the narrowest existing repository test or direct acceptance command now.";
  }
  if (
    latest &&
    currentVerification &&
    verificationOutcome(latest) === "code_failed"
  ) {
    if (isInvestigationCall(call)) {
      const diagnosticCalls = shellCallsSince(
        state,
        latest.shellCommandRevision,
      );
      if (call.tool === "workspace.run_shell" && diagnosticCalls < 2) {
        return null;
      }
      return "[LoopPolicy:fix_current_failure] The current source revision has a failing code verification. Broad investigation is deferred; use the retained failure evidence to edit the implementation or rerun a narrower diagnostic test.";
    }
    return null;
  }
  if (
    latest &&
    currentVerification &&
    verificationOutcome(latest) === "harness_failed" &&
    isInvestigationCall(call)
  ) {
    if (verificationPolicy?.authority === "external") {
      if ((state.diffInspectedRevision ?? 0) !== revision) {
        if (isDiffInspection(call)) return null;
        return "[LoopPolicy:inspect_external_diff] Local verification could not execute and the trusted external verifier will make the authoritative acceptance decision. Further harness construction is deferred. Inspect the final diff for scope and accidental files now.";
      }
      return "[LoopPolicy:deliver_external] Local verification could not execute, but the current product revision has an inspected final diff and a trusted external verifier is configured. Deliver final_answer now, report the local harness failure honestly, and do not claim tests passed.";
    }
    const recoveryCalls = shellCallsSince(state, latest.shellCommandRevision);
    if (call.tool === "workspace.run_shell" && recoveryCalls < 4) return null;
    return "[LoopPolicy:recover_verification_harness] The last verification did not execute because its harness or environment failed; this is not evidence that the code is wrong. Repository browsing is deferred. Repair the local test invocation/environment with a bounded shell action, then rerun verification; after four recovery commands, edit or retry a concrete acceptance command instead of continuing environment exploration.";
  }
  if (turn <= maxSteps - convergenceWindow(maxSteps)) return null;
  if (
    latest &&
    verificationOutcome(latest) === "passed" &&
    currentVerification &&
    (state.diffInspectedRevision ?? 0) !== revision &&
    !isDiffInspection(call) &&
    isInvestigationCall(call)
  ) {
    return "[LoopPolicy:inspect_final_diff] Verification passes for the current source revision. Additional investigation is deferred until you inspect the final diff for scope and accidental changes.";
  }
  if (
    latest &&
    verificationOutcome(latest) === "passed" &&
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
  verificationPolicy?: VerificationPolicy,
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
  } else if (verificationOutcome(latest) === "harness_failed") {
    next =
      verificationPolicy?.authority === "external"
        ? (state.diffInspectedRevision ?? 0) === revision
          ? "Local verification could not execute, and a trusted external verifier is configured. Deliver final_answer now with an honest local-verification caveat; do not claim tests passed."
          : "Local verification could not execute, and a trusted external verifier is configured. Stop building replacement harnesses and inspect the final product diff now."
        : "The last verification did not execute because the harness or environment failed. Repair the invocation with a bounded diagnostic, then rerun it; do not treat infrastructure failure as a code assertion failure.";
  } else if (verificationOutcome(latest) === "code_failed") {
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
