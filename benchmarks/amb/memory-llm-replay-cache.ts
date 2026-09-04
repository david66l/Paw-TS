import { createHash } from "node:crypto";

export const PAW_AMB_MEMORY_LLM_REPLAY_CACHE_POLICY_V1 =
  "paw.amb-memory-llm-replay-cache.v2:reasoning-profile" as const;

export const AMB_MEMORY_LLM_REASONING_EFFORTS_V1 = [
  "disabled",
  "low",
  "high",
  "max",
] as const;

export type AmbMemoryLlmReasoningEffortV1 =
  (typeof AMB_MEMORY_LLM_REASONING_EFFORTS_V1)[number];

export function resolveAmbMemoryLlmReasoningEffortV1(
  value?: string,
): AmbMemoryLlmReasoningEffortV1 {
  const normalized = value?.trim().toLowerCase() || "disabled";
  if (
    !AMB_MEMORY_LLM_REASONING_EFFORTS_V1.includes(
      normalized as AmbMemoryLlmReasoningEffortV1,
    )
  ) {
    throw new Error("PAW_AMB_MEMORY_LLM_REASONING_EFFORT is invalid");
  }
  return normalized as AmbMemoryLlmReasoningEffortV1;
}

export function buildAmbMemoryLlmThinkingRequestV1(
  reasoningEffort: AmbMemoryLlmReasoningEffortV1,
): Readonly<Record<string, unknown>> {
  return reasoningEffort === "disabled"
    ? Object.freeze({ thinking: Object.freeze({ type: "disabled" }) })
    : Object.freeze({
        thinking: Object.freeze({ type: "enabled" }),
        reasoning_effort: reasoningEffort,
      });
}

export interface AmbMemoryLlmReplayCacheKeyInputV1 {
  readonly purpose: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly promptHash: string;
  readonly maxTokens: number;
  readonly reasoningEffort: AmbMemoryLlmReasoningEffortV1;
}

/**
 * Keys cached raw model responses by the exact request contract. Runtime source
 * revisions remain provenance metadata, but cannot invalidate an identical
 * deterministic request whose response will be parsed again by current code.
 */
export function buildAmbMemoryLlmReplayCacheKeyV1(
  input: AmbMemoryLlmReplayCacheKeyInputV1,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        policy: PAW_AMB_MEMORY_LLM_REPLAY_CACHE_POLICY_V1,
        purpose: input.purpose,
        model: input.model,
        baseUrl: input.baseUrl,
        promptHash: input.promptHash,
        responseFormat: "json_object",
        temperature: 0,
        thinking:
          input.reasoningEffort === "disabled" ? "disabled" : "enabled",
        reasoningEffort:
          input.reasoningEffort === "disabled" ? null : input.reasoningEffort,
        maxTokens: input.maxTokens,
      }),
    )
    .digest("hex");
}
