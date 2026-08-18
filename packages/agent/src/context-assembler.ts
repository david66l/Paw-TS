import type { ChatMessage } from "@paw/core";

/** Durable transcript is the only portion allowed to survive save/resume. */
export interface DurableContextV1 {
  readonly messages: readonly ChatMessage[];
}

/** Typed host facts rendered for one request without mutating the transcript. */
export type HostStateFactV1 =
  | {
      readonly kind: "task_brief";
      readonly currentObjective: string;
      readonly stage?: string;
      readonly openItems?: readonly string[];
    }
  | { readonly kind: "constraints"; readonly items: readonly string[] }
  | { readonly kind: "current_hypothesis"; readonly text: string }
  | { readonly kind: "key_observations"; readonly items: readonly string[] }
  | { readonly kind: "relevant_memory"; readonly items: readonly string[] };

/** At most one host control projection is admitted to a model request. */
export type EphemeralControlV1 =
  | { readonly kind: "status"; readonly text: string }
  | { readonly kind: "progress"; readonly text: string }
  | { readonly kind: "test_warden"; readonly text: string }
  | { readonly kind: "readiness"; readonly text: string }
  | { readonly kind: "protocol_recovery"; readonly text: string };

export interface AssembleModelContextInputV1 {
  readonly durable: DurableContextV1;
  readonly hostState?: readonly HostStateFactV1[];
  readonly control?: EphemeralControlV1;
}

/**
 * The sole primary agent-turn request assembly boundary.
 *
 * Host state and control are projections: they are rendered into the returned
 * request only and never written back to ContextManager/AppState. Callers must
 * build once and reuse the same array for eval capture and model invocation.
 */
export function assembleModelContextV1(
  input: AssembleModelContextInputV1,
): readonly ChatMessage[] {
  const messages = input.durable.messages.map((message) => ({ ...message }));
  if (input.hostState && input.hostState.length > 0) {
    messages.push({
      role: "user",
      content: renderHostStateV1(input.hostState),
    });
  }
  if (input.control) {
    messages.push({
      role: "user",
      content: `[Ephemeral Control v1]\nkind: ${input.control.kind}\n${input.control.text}`,
    });
  }
  return messages;
}

function renderHostStateV1(facts: readonly HostStateFactV1[]): string {
  const lines = ["[Host State v1]"];
  for (const fact of facts) {
    switch (fact.kind) {
      case "task_brief":
        lines.push(`current_objective: ${fact.currentObjective}`);
        if (fact.stage) lines.push(`stage: ${fact.stage}`);
        if (fact.openItems && fact.openItems.length > 0) {
          lines.push("open_items:");
          lines.push(...fact.openItems.map((item) => `- ${item}`));
        }
        break;
      case "constraints":
        lines.push("constraints:");
        lines.push(...fact.items.map((item) => `- ${item}`));
        break;
      case "current_hypothesis":
        lines.push(`current_hypothesis: ${fact.text}`);
        break;
      case "key_observations":
        lines.push("key_observations:");
        lines.push(...fact.items.map((item) => `- ${item}`));
        break;
      case "relevant_memory":
        lines.push("relevant_memory:");
        lines.push(...fact.items.map((item) => `- ${item}`));
        break;
    }
  }
  return lines.join("\n");
}
