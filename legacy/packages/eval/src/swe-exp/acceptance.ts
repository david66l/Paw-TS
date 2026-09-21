import type { RunAcceptanceCriterionSeed } from "@paw/core";

import type { SweBenchLiteInstance } from "./agent-types.js";

/**
 * Compile trusted SWE-bench metadata into lifecycle state. The same test ids
 * stay in the model-visible goal for fairness, but Paw no longer has to parse
 * prose to discover that they are acceptance conditions.
 */
export function buildSweAcceptanceCriteria(
  probe: SweBenchLiteInstance,
): readonly RunAcceptanceCriterionSeed[] {
  const failToPass = probe.FAIL_TO_PASS?.filter(Boolean) ?? [];
  const passToPass = probe.PASS_TO_PASS?.filter(Boolean) ?? [];
  return [
    ...passToPass.map((ref) => ({
      text: `PASS_TO_PASS must remain passing: ${ref}`,
      source: "verification" as const,
      ref,
      verificationAuthority: "external" as const,
    })),
    ...failToPass.map((ref) => ({
      text: `FAIL_TO_PASS must pass: ${ref}`,
      source: "verification" as const,
      ref,
      verificationAuthority: "external" as const,
    })),
  ];
}
