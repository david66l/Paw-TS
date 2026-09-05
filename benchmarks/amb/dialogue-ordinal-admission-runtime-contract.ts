import { PAW_AMB_MEMORY_LLM_REPLAY_CACHE_POLICY_V1 } from "./memory-llm-replay-cache.js";

export const PAW_AMB_DIALOGUE_ORDINAL_ADMISSION_RESPONSE_FORMAT_V1 =
  "json_object" as const;
export const PAW_AMB_DIALOGUE_ORDINAL_ADMISSION_MAX_OUTPUT_TOKENS_V1 =
  64 as const;
export const PAW_AMB_DIALOGUE_ORDINAL_ADMISSION_CACHE_NAMESPACE_V1 =
  "dialogue-ordinal-admission" as const;

/**
 * The admission receipt is a strict enum protocol. Raw replies that cannot be
 * parsed under this exact protocol are never safe replay material.
 */
export function isStrictAmbDialogueOrdinalAdmissionReplyV1(
  text: string,
): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return false;
  }
  const record = parsed as { classification?: unknown };
  return (
    Object.keys(record).length === 1 &&
    Object.keys(record)[0] === "classification" &&
    (record.classification === "artifact_itself" ||
      record.classification === "artifact_internal_content" ||
      record.classification === "non_direct_or_ambiguous")
  );
}

/**
 * Bound into the ordinal proof via admissionRevision. Any replay or request
 * policy change therefore creates a distinct proof identity.
 */
export function buildAmbDialogueOrdinalAdmissionVersionV1(input: {
  readonly model: string;
  readonly reasoningEffort: string;
}): string {
  return [
    "paw.amb-dialogue-ordinal-admission.v1",
    `model=${input.model}`,
    `reasoning=${input.reasoningEffort}`,
    `cache=${PAW_AMB_DIALOGUE_ORDINAL_ADMISSION_CACHE_NAMESPACE_V1}`,
    `replay=${PAW_AMB_MEMORY_LLM_REPLAY_CACHE_POLICY_V1}`,
    `response_format=${PAW_AMB_DIALOGUE_ORDINAL_ADMISSION_RESPONSE_FORMAT_V1}`,
    `max_tokens=${PAW_AMB_DIALOGUE_ORDINAL_ADMISSION_MAX_OUTPUT_TOKENS_V1}`,
  ].join(":");
}
