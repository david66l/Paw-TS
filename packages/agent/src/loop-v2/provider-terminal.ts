import type { ScheduledToolCallV2 } from "./tool-scheduler.js";

export type ProviderProtocolIssueV2 =
  | "empty_response"
  | "truncated_response"
  | "missing_tool_calls";

export type ProviderControlActionV2 =
  | "abort"
  | "acceptance_update"
  | "ask_user"
  | "native_tool_errors"
  | "parse_recovery"
  | "plan_update";

export interface ProviderTerminalStateV2 {
  readonly runId: string;
  readonly lastTurn: number;
  readonly pendingProtocolIssue?: ProviderProtocolIssueV2;
}

export interface ProviderResponseV2 {
  readonly runId: string;
  readonly turn: number;
  readonly finishReason?: string;
  readonly visibleText?: string;
  readonly toolCalls: readonly ScheduledToolCallV2[];
  readonly controlAction?: ProviderControlActionV2;
  readonly legacyFinalAnswer?: Readonly<{
    readonly summary: string;
  }>;
}

export type ProviderTerminalDecisionV2 =
  | {
      readonly kind: "dispatch_tools";
      readonly calls: readonly ScheduledToolCallV2[];
    }
  | {
      readonly kind: "candidate_proposed";
      readonly source: "legacy_final_answer";
      readonly visibleText: string;
    }
  | {
      readonly kind: "turn_boundary";
      readonly visibleText: string;
    }
  | {
      readonly kind: "dispatch_control";
      readonly control: ProviderControlActionV2;
    }
  | {
      readonly kind: "recover_protocol";
      readonly issue: ProviderProtocolIssueV2;
      readonly attempt: 1;
    }
  | {
      readonly kind: "incomplete";
      readonly reasonCode:
        | "empty_response"
        | "truncated_response"
        | "missing_tool_calls"
        | "content_filter"
        | "unsupported_finish_reason";
      readonly detail: string;
    };

export interface ProviderTerminalResultV2 {
  readonly state: ProviderTerminalStateV2;
  readonly decision: ProviderTerminalDecisionV2;
}

export function createProviderTerminalStateV2(
  runId: string,
): ProviderTerminalStateV2 {
  if (!runId.trim())
    throw new Error("Provider terminal runId must not be empty");
  return { runId, lastTurn: 0 };
}

/**
 * Normalize one provider response without deciding that the task is complete.
 * Candidate proposals still require deterministic readiness and certification.
 */
export function normalizeProviderResponseV2(
  prior: ProviderTerminalStateV2,
  response: ProviderResponseV2,
): ProviderTerminalResultV2 {
  validateResponse(prior, response);
  const base = { runId: prior.runId, lastTurn: response.turn };
  const finishReason = response.finishReason?.trim().toLowerCase();

  if (finishReason === "length" || finishReason === "max_tokens") {
    return protocolIssue(base, prior, "truncated_response");
  }

  if (response.toolCalls.length > 0) {
    return {
      state: base,
      decision: { kind: "dispatch_tools", calls: [...response.toolCalls] },
    };
  }

  if (response.controlAction !== undefined) {
    const preservesProtocolFault =
      response.controlAction === "native_tool_errors" ||
      response.controlAction === "parse_recovery";
    return {
      state:
        preservesProtocolFault && prior.pendingProtocolIssue !== undefined
          ? { ...base, pendingProtocolIssue: prior.pendingProtocolIssue }
          : base,
      decision: {
        kind: "dispatch_control",
        control: response.controlAction,
      },
    };
  }

  const legacySummary = response.legacyFinalAnswer?.summary.trim();
  if (legacySummary) {
    return {
      state: base,
      decision: {
        kind: "candidate_proposed",
        source: "legacy_final_answer",
        visibleText: legacySummary,
      },
    };
  }

  const visibleText = response.visibleText?.trim();
  if (visibleText && (finishReason === undefined || finishReason === "stop")) {
    return {
      state: base,
      decision: {
        kind: "turn_boundary",
        visibleText,
      },
    };
  }

  if (finishReason === "content_filter") {
    return {
      state: base,
      decision: {
        kind: "incomplete",
        reasonCode: "content_filter",
        detail:
          "Provider stopped because content filtering prevented a usable response.",
      },
    };
  }
  if (finishReason === "tool_calls") {
    return protocolIssue(base, prior, "missing_tool_calls");
  }
  if (finishReason === undefined || finishReason === "stop") {
    return protocolIssue(base, prior, "empty_response");
  }
  return {
    state: base,
    decision: {
      kind: "incomplete",
      reasonCode: "unsupported_finish_reason",
      detail: `Unsupported provider finish reason: ${finishReason}`,
    },
  };
}

function protocolIssue(
  base: Readonly<{ runId: string; lastTurn: number }>,
  prior: ProviderTerminalStateV2,
  issue: ProviderProtocolIssueV2,
): ProviderTerminalResultV2 {
  if (prior.pendingProtocolIssue !== undefined) {
    return {
      state: { ...base, pendingProtocolIssue: issue },
      decision: {
        kind: "incomplete",
        reasonCode: issue,
        detail: `Provider protocol recovery exhausted: ${issue}`,
      },
    };
  }
  return {
    state: { ...base, pendingProtocolIssue: issue },
    decision: { kind: "recover_protocol", issue, attempt: 1 },
  };
}

function validateResponse(
  prior: ProviderTerminalStateV2,
  response: ProviderResponseV2,
): void {
  if (response.runId !== prior.runId) {
    throw new Error(
      `Provider terminal run mismatch: ${prior.runId} != ${response.runId}`,
    );
  }
  const expectedTurn = prior.lastTurn + 1;
  if (!Number.isSafeInteger(response.turn) || response.turn !== expectedTurn) {
    throw new Error(
      `Provider terminal turn must be contiguous; expected ${expectedTurn}, received ${response.turn}`,
    );
  }
  if (
    response.legacyFinalAnswer !== undefined &&
    !response.legacyFinalAnswer.summary.trim()
  ) {
    throw new Error("Legacy final_answer summary must not be empty");
  }
}
