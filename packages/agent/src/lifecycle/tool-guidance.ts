import type {
  EphemeralControlV1,
  ToolGuidanceTopicV1,
} from "../context-assembler.js";

type ToolGuidanceControlV1 = Extract<
  EphemeralControlV1,
  { readonly kind: "tool_guidance" }
>;

function control(
  topic: ToolGuidanceTopicV1,
  parts: readonly string[],
): ToolGuidanceControlV1 | undefined {
  const text = parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n");
  return text ? { kind: "tool_guidance", topic, text } : undefined;
}

/** Admit one post-tool host instruction; tool observations stay durable. */
export function selectToolGuidanceV1(input: {
  readonly recoveryMessage?: string;
  readonly idleFuseTripped?: boolean;
  readonly codingPhaseNudges?: readonly string[];
  readonly repeatToolReminders?: readonly string[];
}): ToolGuidanceControlV1 | undefined {
  if (input.idleFuseTripped && input.recoveryMessage) {
    return control("idle_fuse", [input.recoveryMessage]);
  }
  const coding = control("coding_phase", input.codingPhaseNudges ?? []);
  if (coding) return coding;
  if (input.recoveryMessage) {
    return control("tool_recovery", [input.recoveryMessage]);
  }
  const lastRepeat = input.repeatToolReminders?.at(-1);
  return lastRepeat ? control("repeat_tool", [lastRepeat]) : undefined;
}
