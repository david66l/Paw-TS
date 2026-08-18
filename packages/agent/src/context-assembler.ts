import type { ChatMessage } from "@paw/core";

/** Durable transcript is the only portion allowed to survive save/resume. */
export interface DurableContextV1 {
  readonly messages: readonly ChatMessage[];
}

/**
 * Typed host facts rendered in a canonical order for one request.
 *
 * A fixed shape prevents duplicate fact kinds and unstable prompt ordering.
 * The original user request is deliberately absent: it belongs only to the
 * durable transcript. `currentObjective` is therefore a current next step,
 * never a copy of the original goal.
 */
export interface HostStateV1 {
  readonly taskBrief?: {
    readonly currentObjective?: string;
    readonly stage?: string;
    readonly openItems?: readonly string[];
  };
  readonly constraints?: readonly string[];
  readonly taskProgress?: string;
  readonly relevantMemory?: string;
  readonly relevantCode?: readonly {
    readonly path: string;
    readonly reason: string;
    readonly symbols?: readonly string[];
  }[];
  readonly status?: string;
}

/** At most one host control projection is admitted to a model request. */
export type EphemeralControlV1 =
  | { readonly kind: "status"; readonly text: string }
  | { readonly kind: "progress"; readonly text: string }
  | { readonly kind: "test_warden"; readonly text: string }
  | { readonly kind: "readiness"; readonly text: string }
  | { readonly kind: "protocol_recovery"; readonly text: string };

const CONTROL_PRIORITY_V1: Readonly<
  Record<EphemeralControlV1["kind"], number>
> = {
  status: 0,
  progress: 1,
  test_warden: 2,
  readiness: 3,
  protocol_recovery: 4,
};

/** Deterministically admit at most one control projection for a request. */
export function selectEphemeralControlV1(
  candidates: readonly (EphemeralControlV1 | undefined)[],
): EphemeralControlV1 | undefined {
  let selected: EphemeralControlV1 | undefined;
  for (const candidate of candidates) {
    if (!candidate?.text.trim()) continue;
    if (
      !selected ||
      CONTROL_PRIORITY_V1[candidate.kind] > CONTROL_PRIORITY_V1[selected.kind]
    ) {
      selected = candidate;
    }
  }
  return selected;
}

export interface AssembleModelContextInputV1 {
  readonly durable: DurableContextV1;
  readonly hostState?: HostStateV1;
  readonly control?: EphemeralControlV1;
}

const LEGACY_HOST_PROJECTION_PREFIXES = [
  "[Context Package]",
  "[Status Snapshot v1]",
] as const;
const LEGACY_CONTROL_PROJECTION_PATTERNS = [
  /^\[ProgressAdvice:(?:inspect_gap|hypothesis_stale|safety_line)\] /,
  /^\[TestWarden\] (?:No Python test files detected;|Attempted:|Pre-flight:|No existing tests are linked to the changed files;|\d+ impacted test file\(s\) all passed\.|\d+\/\d+ impacted test file\(s\) FAILED:)/,
] as const;

/** Remove only host/control formats Paw itself durably injected before P0.3. */
export function stripLegacyContextProjectionsV1(
  messages: readonly ChatMessage[],
): readonly ChatMessage[] {
  return messages.filter((message) => !isLegacyContextProjection(message));
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
  const messages = stripLegacyContextProjectionsV1(input.durable.messages).map(
    (message) => ({ ...message }),
  );
  if (input.hostState && hasHostStateV1(input.hostState)) {
    const hostMessage: ChatMessage = {
      role: "user",
      content: renderHostStateV1(input.hostState),
    };
    // Keep the latest real input/observation as the attention tail. This also
    // preserves an atomic native tool-turn envelope because insertion happens
    // between messages, never inside one. Explicit control is appended below.
    let leadingSystemMessages = 0;
    while (messages[leadingSystemMessages]?.role === "system") {
      leadingSystemMessages += 1;
    }
    const insertionIndex = Math.max(leadingSystemMessages, messages.length - 1);
    messages.splice(insertionIndex, 0, hostMessage);
  }
  if (input.control) {
    messages.push({
      role: "user",
      content: `[Ephemeral Control v1]\nkind: ${input.control.kind}\n${input.control.text}`,
    });
  }
  return messages;
}

function isLegacyContextProjection(message: ChatMessage): boolean {
  if (message.role !== "user") return false;
  return (
    LEGACY_HOST_PROJECTION_PREFIXES.some(
      (prefix) =>
        message.content === prefix || message.content.startsWith(`${prefix}\n`),
    ) ||
    LEGACY_CONTROL_PROJECTION_PATTERNS.some((pattern) =>
      pattern.test(message.content),
    )
  );
}

function hasHostStateV1(state: HostStateV1): boolean {
  return Boolean(
    state.taskBrief ||
      state.constraints?.length ||
      state.taskProgress?.trim() ||
      state.relevantMemory?.trim() ||
      state.relevantCode?.length ||
      state.status?.trim(),
  );
}

function renderHostStateV1(state: HostStateV1): string {
  const lines = ["[Host State v1]"];
  const brief = state.taskBrief;
  if (brief) {
    lines.push("[Task Brief]");
    if (brief.currentObjective?.trim()) {
      lines.push(`current_objective: ${brief.currentObjective.trim()}`);
    }
    if (brief.stage?.trim()) lines.push(`stage: ${brief.stage.trim()}`);
    if (brief.openItems && brief.openItems.length > 0) {
      lines.push("open_items:");
      lines.push(...brief.openItems.map((item) => `- ${item}`));
    }
  }
  if (state.constraints && state.constraints.length > 0) {
    lines.push("[Constraints]");
    lines.push(...state.constraints.map((item) => `- ${item}`));
  }
  if (state.taskProgress?.trim()) {
    lines.push(state.taskProgress.trim());
  }
  if (state.relevantMemory?.trim()) {
    lines.push("[Relevant Memory]");
    lines.push(state.relevantMemory.trim());
  }
  if (state.relevantCode && state.relevantCode.length > 0) {
    lines.push("[Relevant Code]");
    for (const block of state.relevantCode) {
      lines.push(`- ${block.path}: ${block.reason}`);
      if (block.symbols?.length) {
        lines.push(`  symbols=${block.symbols.slice(0, 8).join(", ")}`);
      }
    }
  }
  if (state.status?.trim()) {
    lines.push(state.status.trim());
  }
  return lines.join("\n");
}
