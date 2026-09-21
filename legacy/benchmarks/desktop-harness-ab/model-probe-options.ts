export const probeVariants = {
  "max-native": { effort: "max", outputFloor: null },
  "high-native": { effort: "high", outputFloor: null },
  "max-32768": { effort: "max", outputFloor: 32768 },
} as const;

export type ProbeVariant = keyof typeof probeVariants;

/** Experimental wire override only. Keep small auxiliary requests unchanged. */
export function applyProbeRequest(
  body: Record<string, unknown>,
  variant: ProbeVariant,
): Record<string, unknown> {
  if (body.model !== "glm-5.3-flash")
    throw new Error("Probe only supports the selected GLM-5.3-Flash model");
  const config = probeVariants[variant];
  if (!config) throw new Error("Unknown probe variant");
  const boundedAuxiliary =
    typeof body.max_tokens === "number" && body.max_tokens < 8192;
  return {
    ...body,
    ...(!boundedAuxiliary ? { reasoning_effort: config.effort } : {}),
    ...(config.outputFloor !== null &&
    typeof body.max_tokens === "number" &&
    body.max_tokens >= 8192
      ? { max_tokens: Math.max(body.max_tokens, config.outputFloor) }
      : {}),
  };
}
