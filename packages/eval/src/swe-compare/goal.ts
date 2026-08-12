import type { SweBenchLiteInstance } from "../swe-exp/agent-types.js";

/**
 * Provider-neutral coding task used by both Paw and Claude Code.
 * Gold patch/test patch are intentionally outside this function's data flow.
 */
export function buildSweCompareGoal(probe: SweBenchLiteInstance): string {
  const failToPass = probe.FAIL_TO_PASS?.filter(Boolean) ?? [];
  const passToPass = probe.PASS_TO_PASS?.filter(Boolean) ?? [];
  return [
    "Fix the bug described below so that the relevant tests pass.",
    "Work directly in the checked-out repository and modify existing tracked source files.",
    "Do not create helper scripts or patch files. Do not only describe a solution.",
    "Make a minimal change. Do not modify unrelated files or any test files.",
    "After editing, run the narrowest relevant tests that are feasible in this environment.",
    "Finish only after inspecting the final diff and reporting the verification performed.",
    failToPass.length > 0
      ? `External FAIL_TO_PASS acceptance tests (read-only; run these when feasible):\n${failToPass.map((name) => `- ${name}`).join("\n")}`
      : "No explicit FAIL_TO_PASS identifiers are available; locate the narrowest relevant existing test.",
    passToPass.length > 0
      ? `Regression tests that must remain passing (read-only):\n${passToPass
          .slice(0, 20)
          .map((name) => `- ${name}`)
          .join("\n")}`
      : "",
    "",
    probe.problem_statement,
  ]
    .filter(Boolean)
    .join("\n");
}
