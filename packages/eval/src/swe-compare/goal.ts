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
    "Do not access the network, fetch remotes, inspect upstream branches/commits, or search for an existing solution.",
    "Make a minimal change. Do not modify unrelated files or any test files.",
    "When a fix requires accepting more inputs (URLs, formats, codes), expand the existing behavior rather than replacing it with a stricter validator. Inputs the old code accepted must still be accepted unless the task explicitly says to reject them.",
    "After editing, run the narrowest relevant tests that are feasible in this environment.",
    "Finish only after inspecting the final diff and reporting the verification performed.",
    failToPass.length > 0
      ? `These tests currently fail and must pass after your fix. Test names describe behavior, not which function to modify — do not change a function just because its name appears here. Verify by running tests.\n${failToPass.map((name) => `- ${name}`).join("\n")}`
      : "No explicit FAIL_TO_PASS identifiers are available; locate the narrowest relevant existing test.",
    passToPass.length > 0
      ? `Regression tests that must remain passing (read-only):\n${passToPass
          .map((name) => `- ${name}`)
          .join("\n")}`
      : "",
    "",
    probe.problem_statement,
  ]
    .filter(Boolean)
    .join("\n");
}
