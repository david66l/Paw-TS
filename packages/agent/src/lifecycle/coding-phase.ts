import type { AgentToolCallAction } from "@paw/core";

export const CODING_LOCATE_NUDGE_AT = 10;
export const CODING_LOCATE_HARD_LIMIT = 14;
export const CODING_POST_EDIT_NAV_LIMIT = 4;
export const CODING_PHASE_BUDGET_MARKER = "[coding_phase_budget]";

export function goalUsesCodingPhaseBudget(goal: string): boolean {
  return goal.includes(CODING_PHASE_BUDGET_MARKER);
}

const NAVIGATION_TOOLS = new Set([
  "workspace.read_file",
  "workspace.grep",
  "workspace.search",
  "workspace.glob",
  "workspace.list_dir",
  "workspace.git_log",
]);

const EDIT_TOOLS = new Set([
  "workspace.edit_file",
  "workspace.write_file",
  "workspace.apply_patch",
  "workspace.notebook_edit",
]);

export interface CodingPhaseState {
  readonly navigationCalls: number;
  readonly successfulEdits: number;
  readonly postEditNavigationCalls: number;
  readonly verificationCalls: number;
  readonly locateNudged: boolean;
  readonly verifyNudged: boolean;
}

export const EMPTY_CODING_PHASE_STATE: CodingPhaseState = {
  navigationCalls: 0,
  successfulEdits: 0,
  postEditNavigationCalls: 0,
  verificationCalls: 0,
  locateNudged: false,
  verifyNudged: false,
};

export function isCodingNavigationTool(tool: string): boolean {
  return NAVIGATION_TOOLS.has(tool);
}

export function isCodingEditTool(tool: string): boolean {
  return EDIT_TOOLS.has(tool);
}

export function isCodingVerificationCall(call: AgentToolCallAction): boolean {
  if (call.tool !== "workspace.run_shell") return false;
  const command = typeof call.args.command === "string" ? call.args.command : "";
  if (/\b(?:pip3?|uv|npm|pnpm|yarn|bun)\s+(?:install|add|i)\b/i.test(command)) {
    return false;
  }
  return (
    /(?:^|[;&|]\s*)(?:python(?:3)?\s+-m\s+)?pytest\b/i.test(command) ||
    /(?:^|[;&|]\s*)(?:npm|pnpm|yarn|bun)\s+test\b/i.test(command) ||
    /(?:^|[;&|]\s*)(?:npm|pnpm|yarn|bun)\s+run\s+(?:test|check|build|lint|typecheck|e2e|verify)(?::[\w-]+)?\b/i.test(command) ||
    /(?:^|[;&|]\s*)(?:npx\s+)?(?:vitest|jest)\b/i.test(command) ||
    /(?:^|[;&|]\s*)go\s+test\b/i.test(command) ||
    /(?:^|[;&|]\s*)cargo\s+test\b/i.test(command) ||
    /(?:^|[;&|]\s*)tox\b/i.test(command)
  );
}

export function codingPhaseBlockReason(
  call: AgentToolCallAction,
  state: CodingPhaseState,
): string | null {
  if (!isCodingNavigationTool(call.tool)) return null;
  if (
    state.successfulEdits === 0 &&
    state.navigationCalls >= CODING_LOCATE_HARD_LIMIT
  ) {
    return `[CodingPhase:locate_limit] ${CODING_LOCATE_HARD_LIMIT} repository navigation calls were already used without a source edit. Stop searching. State the most likely cause and make the smallest candidate source edit now; run a narrow test afterward.`;
  }
  if (
    state.successfulEdits > 0 &&
    state.verificationCalls === 0 &&
    state.postEditNavigationCalls >= CODING_POST_EDIT_NAV_LIMIT
  ) {
    return `[CodingPhase:verify_limit] A source edit already exists and ${CODING_POST_EDIT_NAV_LIMIT} more navigation calls were used without verification. Stop browsing and run the narrowest relevant test now.`;
  }
  return null;
}

export function advanceCodingPhase(
  state: CodingPhaseState,
  calls: readonly AgentToolCallAction[],
  results: readonly { readonly ok: boolean }[],
): { readonly state: CodingPhaseState; readonly nudges: readonly string[] } {
  let next = { ...state };
  const nudges: string[] = [];
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i]!;
    const result = results[i]!;
    if (isCodingNavigationTool(call.tool) && result.ok) {
      next.navigationCalls += 1;
      if (next.successfulEdits > 0) next.postEditNavigationCalls += 1;
    }
    if (isCodingEditTool(call.tool) && result.ok) {
      next.successfulEdits += 1;
      next.postEditNavigationCalls = 0;
      if (!next.verifyNudged) {
        nudges.push(
          "[CodingPhase:verify] A source edit now exists. Preserve the remaining budget: run the narrowest relevant test next, fix exact failures, then final_answer after a passing verification.",
        );
        next.verifyNudged = true;
      }
    }
    if (isCodingVerificationCall(call)) {
      next.verificationCalls += 1;
      next.postEditNavigationCalls = 0;
    }
  }
  if (
    next.successfulEdits === 0 &&
    next.navigationCalls >= CODING_LOCATE_NUDGE_AT &&
    !next.locateNudged
  ) {
    nudges.push(
      `[CodingPhase:locate] ${next.navigationCalls} repository navigation calls have produced no source edit. Consolidate the evidence into one likely cause and make a minimal candidate edit before the hard limit at ${CODING_LOCATE_HARD_LIMIT}.`,
    );
    next.locateNudged = true;
  }
  return { state: next, nudges };
}
