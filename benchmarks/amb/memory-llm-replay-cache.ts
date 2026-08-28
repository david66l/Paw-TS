import { createHash } from "node:crypto";

export const PAW_AMB_MEMORY_LLM_REPLAY_CACHE_POLICY_V1 =
  "paw.amb-memory-llm-replay-cache.v1:exact-request" as const;

export interface AmbMemoryLlmReplayCacheKeyInputV1 {
  readonly purpose: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly promptHash: string;
  readonly maxTokens: number;
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
        thinking: "disabled",
        maxTokens: input.maxTokens,
      }),
    )
    .digest("hex");
}
