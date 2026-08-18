import type { ChatMessage } from "@paw/core";
import {
  type CompletionGateKindV1,
  type EphemeralControlV1,
  parseLegacyCompletionGateProjectionV1,
  parseLegacyProtocolRecoveryProjectionV1,
} from "./context-assembler.js";
import type { ProviderTerminalStateV2 } from "./loop-v2/index.js";
import { parseLoopV2ReadinessFeedbackMarker } from "./loop-v2/index.js";
import type { TurnFlags } from "./orchestrator/types.js";

type CrashSafePendingControlV1 = Extract<
  EphemeralControlV1,
  {
    readonly kind: "readiness" | "protocol_recovery" | "completion_gate";
  }
>;

export interface LoopControlCheckpointV1 {
  readonly schemaVersion: "paw.loop-control.v1";
  readonly providerTerminal?: ProviderTerminalStateV2;
  readonly readiness?: {
    readonly key: string;
    readonly nudges: number;
  };
  readonly pendingControl?: CrashSafePendingControlV1;
  readonly protocolRecovery?: {
    readonly formatErrorNudges?: number;
    readonly noActionNudges?: number;
    readonly hasEverUsedTools?: true;
  };
  readonly completionGates?: {
    readonly autoContinueNudges?: number;
    readonly verifyNudges?: number;
    readonly acceptanceNudges?: number;
    readonly candidateReview?: {
      readonly revision: number;
      readonly nudges: number;
      readonly summaryFingerprint?: string;
    };
  };
  readonly lateGuidance?: {
    readonly contextGuardDelivered?: true;
    readonly implementationDelivered?: true;
    readonly convergenceEvidenceKey?: string;
    readonly maxStepsDelivered?: true;
  };
}

const PROTOCOL_ISSUES = new Set([
  "empty_response",
  "truncated_response",
  "missing_tool_calls",
]);
const CONTROL_KINDS = new Set<CrashSafePendingControlV1["kind"]>([
  "readiness",
  "protocol_recovery",
  "completion_gate",
]);
const COMPLETION_GATE_KINDS = new Set<CompletionGateKindV1>([
  "managed_jobs",
  "pending_work",
  "verification",
  "repair_obligation",
  "semantic_review",
  "verification_probe",
  "candidate_review",
  "acceptance",
]);

/** Rewind starts a new control timeline and must not migrate later markers. */
export function resetLoopControlForRewindV1(
  runId: string,
  lastTurn: number,
): LoopControlCheckpointV1 {
  if (!runId.trim() || !Number.isSafeInteger(lastTurn) || lastTurn < 0) {
    throw new Error("Invalid loop-control rewind boundary");
  }
  return {
    schemaVersion: "paw.loop-control.v1",
    providerTerminal: { runId, lastTurn },
  };
}

/** Persist only cross-crash loop-control facts, not the whole TurnFlags bag. */
export function checkpointLoopControlV1(
  flags: TurnFlags | undefined,
): LoopControlCheckpointV1 | undefined {
  if (!flags) return undefined;
  const readiness =
    flags.loopV2ReadinessFeedbackKey && (flags.loopV2ReadinessNudges ?? 0) > 0
      ? {
          key: flags.loopV2ReadinessFeedbackKey,
          nudges: flags.loopV2ReadinessNudges ?? 0,
        }
      : undefined;
  const pendingControl =
    flags.pendingControl?.kind === "readiness" ||
    flags.pendingControl?.kind === "protocol_recovery" ||
    flags.pendingControl?.kind === "completion_gate"
      ? flags.pendingControl
      : undefined;
  const protocolRecovery =
    (flags.formatErrorNudges ?? 0) > 0 ||
    (flags.noActionNudges ?? 0) > 0 ||
    flags.hasEverUsedTools
      ? {
          ...((flags.formatErrorNudges ?? 0) > 0
            ? { formatErrorNudges: flags.formatErrorNudges }
            : {}),
          ...((flags.noActionNudges ?? 0) > 0
            ? { noActionNudges: flags.noActionNudges }
            : {}),
          ...(flags.hasEverUsedTools
            ? { hasEverUsedTools: true as const }
            : {}),
        }
      : undefined;
  const candidateReview =
    (flags.candidateReviewNudges ?? 0) > 0 &&
    Number.isSafeInteger(flags.candidateReviewRevision) &&
    (flags.candidateReviewRevision ?? -1) >= 0
      ? {
          revision: flags.candidateReviewRevision ?? 0,
          nudges: flags.candidateReviewNudges ?? 0,
          ...(flags.candidateReviewSummaryFingerprint
            ? {
                summaryFingerprint: flags.candidateReviewSummaryFingerprint,
              }
            : {}),
        }
      : undefined;
  const completionGates =
    (flags.autoContinueNudges ?? 0) > 0 ||
    (flags.verifyNudges ?? 0) > 0 ||
    (flags.acceptanceNudges ?? 0) > 0 ||
    candidateReview
      ? {
          ...((flags.autoContinueNudges ?? 0) > 0
            ? { autoContinueNudges: flags.autoContinueNudges }
            : {}),
          ...((flags.verifyNudges ?? 0) > 0
            ? { verifyNudges: flags.verifyNudges }
            : {}),
          ...((flags.acceptanceNudges ?? 0) > 0
            ? { acceptanceNudges: flags.acceptanceNudges }
            : {}),
          ...(candidateReview ? { candidateReview } : {}),
        }
      : undefined;
  const lateGuidance =
    flags._budgetGuardWarned ||
    flags._implementationWarned ||
    flags._convergenceEvidenceKey ||
    flags._maxStepsWarned
      ? {
          ...(flags._budgetGuardWarned
            ? { contextGuardDelivered: true as const }
            : {}),
          ...(flags._implementationWarned
            ? { implementationDelivered: true as const }
            : {}),
          ...(flags._convergenceEvidenceKey
            ? { convergenceEvidenceKey: flags._convergenceEvidenceKey }
            : {}),
          ...(flags._maxStepsWarned
            ? { maxStepsDelivered: true as const }
            : {}),
        }
      : undefined;
  if (
    !flags.providerTerminal &&
    !readiness &&
    !pendingControl &&
    !protocolRecovery &&
    !completionGates &&
    !lateGuidance
  ) {
    return undefined;
  }
  return {
    schemaVersion: "paw.loop-control.v1",
    ...(flags.providerTerminal
      ? { providerTerminal: flags.providerTerminal }
      : {}),
    ...(readiness ? { readiness } : {}),
    ...(pendingControl ? { pendingControl } : {}),
    ...(protocolRecovery ? { protocolRecovery } : {}),
    ...(completionGates ? { completionGates } : {}),
    ...(lateGuidance ? { lateGuidance } : {}),
  };
}

/** Runtime-safe ingress for untyped JSON persisted by core. */
export function parseLoopControlCheckpointV1(
  value: unknown,
): LoopControlCheckpointV1 | undefined {
  if (!isRecord(value) || value.schemaVersion !== "paw.loop-control.v1") {
    return undefined;
  }
  const providerTerminal = parseProviderTerminal(value.providerTerminal);
  if (value.providerTerminal !== undefined && !providerTerminal)
    return undefined;
  const readiness = parseReadiness(value.readiness);
  if (value.readiness !== undefined && !readiness) return undefined;
  const pendingControl = parsePendingControl(value.pendingControl);
  if (value.pendingControl !== undefined && !pendingControl) return undefined;
  const protocolRecovery = parseProtocolRecovery(value.protocolRecovery);
  if (value.protocolRecovery !== undefined && !protocolRecovery)
    return undefined;
  const completionGates = parseCompletionGates(value.completionGates);
  if (value.completionGates !== undefined && !completionGates) return undefined;
  const lateGuidance = parseLateGuidance(value.lateGuidance);
  if (value.lateGuidance !== undefined && !lateGuidance) return undefined;
  if (
    !providerTerminal &&
    !readiness &&
    !pendingControl &&
    !protocolRecovery &&
    !completionGates &&
    !lateGuidance
  )
    return undefined;
  return {
    schemaVersion: "paw.loop-control.v1",
    ...(providerTerminal ? { providerTerminal } : {}),
    ...(readiness ? { readiness } : {}),
    ...(pendingControl ? { pendingControl } : {}),
    ...(protocolRecovery ? { protocolRecovery } : {}),
    ...(completionGates ? { completionGates } : {}),
    ...(lateGuidance ? { lateGuidance } : {}),
  };
}

/** New snapshots win; old readiness markers are consumed once for migration. */
export function restoreLoopControlFlagsV1(input: {
  readonly runId: string;
  readonly startTurn: number;
  readonly value: unknown;
  readonly legacyMessages: readonly ChatMessage[];
  readonly legacyCandidateReview?: {
    readonly mutationRevision: number;
    readonly summaryFingerprint?: string;
  };
  readonly allowLegacyReadiness?: boolean;
}): Partial<
  Pick<
    TurnFlags,
    | "providerTerminal"
    | "loopV2ReadinessFeedbackKey"
    | "loopV2ReadinessNudges"
    | "pendingControl"
    | "formatErrorNudges"
    | "noActionNudges"
    | "hasEverUsedTools"
    | "autoContinueNudges"
    | "verifyNudges"
    | "acceptanceNudges"
    | "candidateReviewNudges"
    | "candidateReviewRevision"
    | "candidateReviewSummaryFingerprint"
    | "_budgetGuardWarned"
    | "_implementationWarned"
    | "_convergenceEvidenceKey"
    | "_maxStepsWarned"
  >
> {
  const checkpoint = parseLoopControlCheckpointV1(input.value);
  if (input.value !== undefined && !checkpoint) {
    throw new Error("Invalid loop-control checkpoint");
  }
  if (checkpoint) {
    if (
      checkpoint.providerTerminal &&
      (checkpoint.providerTerminal.runId !== input.runId ||
        checkpoint.providerTerminal.lastTurn !== input.startTurn)
    ) {
      throw new Error("Loop-control provider cursor does not match AppState");
    }
    const restored: Partial<TurnFlags> = {
      ...(checkpoint.providerTerminal
        ? { providerTerminal: checkpoint.providerTerminal }
        : {}),
      ...(checkpoint.readiness
        ? {
            loopV2ReadinessFeedbackKey: checkpoint.readiness.key,
            loopV2ReadinessNudges: checkpoint.readiness.nudges,
          }
        : {}),
      ...(checkpoint.pendingControl
        ? { pendingControl: checkpoint.pendingControl }
        : {}),
      ...(checkpoint.protocolRecovery?.formatErrorNudges
        ? {
            formatErrorNudges: checkpoint.protocolRecovery.formatErrorNudges,
          }
        : {}),
      ...(checkpoint.protocolRecovery?.noActionNudges
        ? { noActionNudges: checkpoint.protocolRecovery.noActionNudges }
        : {}),
      ...(checkpoint.protocolRecovery?.hasEverUsedTools
        ? { hasEverUsedTools: true }
        : {}),
      ...(checkpoint.completionGates?.autoContinueNudges
        ? {
            autoContinueNudges: checkpoint.completionGates.autoContinueNudges,
          }
        : {}),
      ...(checkpoint.completionGates?.verifyNudges
        ? { verifyNudges: checkpoint.completionGates.verifyNudges }
        : {}),
      ...(checkpoint.completionGates?.acceptanceNudges
        ? { acceptanceNudges: checkpoint.completionGates.acceptanceNudges }
        : {}),
      ...(checkpoint.completionGates?.candidateReview
        ? {
            candidateReviewNudges:
              checkpoint.completionGates.candidateReview.nudges,
            candidateReviewRevision:
              checkpoint.completionGates.candidateReview.revision,
            ...(checkpoint.completionGates.candidateReview.summaryFingerprint
              ? {
                  candidateReviewSummaryFingerprint:
                    checkpoint.completionGates.candidateReview
                      .summaryFingerprint,
                }
              : {}),
          }
        : {}),
      ...(checkpoint.lateGuidance?.contextGuardDelivered
        ? { _budgetGuardWarned: true }
        : {}),
      ...(checkpoint.lateGuidance?.implementationDelivered
        ? { _implementationWarned: true }
        : {}),
      ...(checkpoint.lateGuidance?.convergenceEvidenceKey
        ? {
            _convergenceEvidenceKey:
              checkpoint.lateGuidance.convergenceEvidenceKey,
          }
        : {}),
      ...(checkpoint.lateGuidance?.maxStepsDelivered
        ? { _maxStepsWarned: true }
        : {}),
    };
    // c3a/c2 snapshots already have a provider/protocol checkpoint while the
    // not-yet-consumed completion gate still lives at the durable tail. Keep
    // the authoritative checkpoint and migrate that one tail marker only when
    // the newer snapshot has neither a pending control nor completion state.
    if (!checkpoint.pendingControl && !checkpoint.completionGates) {
      const legacyCompletionGate = parseLegacyCompletionGateProjectionV1(
        input.legacyMessages,
        input.legacyCandidateReview,
      );
      if (legacyCompletionGate) {
        return { ...restored, ...legacyCompletionGate };
      }
    }
    return restored;
  }
  const legacyProtocolRecovery = parseLegacyProtocolRecoveryProjectionV1(
    input.legacyMessages,
  );
  if (legacyProtocolRecovery) return legacyProtocolRecovery;
  const legacyCompletionGate = parseLegacyCompletionGateProjectionV1(
    input.legacyMessages,
    input.legacyCandidateReview,
  );
  if (legacyCompletionGate) return legacyCompletionGate;
  if (input.allowLegacyReadiness === false) return {};
  const legacyReadiness = [...input.legacyMessages]
    .reverse()
    .map((message) => parseLoopV2ReadinessFeedbackMarker(message.content))
    .find((state) => state !== undefined);
  return legacyReadiness
    ? {
        loopV2ReadinessFeedbackKey: legacyReadiness.key,
        loopV2ReadinessNudges: legacyReadiness.nudges,
      }
    : {};
}

function parseProviderTerminal(
  value: unknown,
): ProviderTerminalStateV2 | undefined {
  if (!isRecord(value) || typeof value.runId !== "string") return undefined;
  if (!value.runId.trim() || !Number.isSafeInteger(value.lastTurn))
    return undefined;
  if ((value.lastTurn as number) < 0) return undefined;
  if (
    value.pendingProtocolIssue !== undefined &&
    (typeof value.pendingProtocolIssue !== "string" ||
      !PROTOCOL_ISSUES.has(value.pendingProtocolIssue))
  ) {
    return undefined;
  }
  return {
    runId: value.runId,
    lastTurn: value.lastTurn as number,
    ...(typeof value.pendingProtocolIssue === "string"
      ? {
          pendingProtocolIssue:
            value.pendingProtocolIssue as ProviderTerminalStateV2["pendingProtocolIssue"],
        }
      : {}),
  };
}

function parseReadiness(
  value: unknown,
): LoopControlCheckpointV1["readiness"] | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.key !== "string" || !/^[a-f0-9]{64}$/.test(value.key)) {
    return undefined;
  }
  if (value.nudges !== 1) {
    return undefined;
  }
  return { key: value.key, nudges: value.nudges as number };
}

function parsePendingControl(
  value: unknown,
): CrashSafePendingControlV1 | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.kind !== "string" ||
    !CONTROL_KINDS.has(value.kind as CrashSafePendingControlV1["kind"]) ||
    typeof value.text !== "string" ||
    !value.text.trim() ||
    value.text.length > 20_000
  ) {
    return undefined;
  }
  if (value.kind === "completion_gate") {
    if (
      typeof value.gate !== "string" ||
      !COMPLETION_GATE_KINDS.has(value.gate as CompletionGateKindV1)
    ) {
      return undefined;
    }
    return {
      kind: "completion_gate",
      gate: value.gate as CompletionGateKindV1,
      text: value.text,
    };
  }
  if (value.gate !== undefined) return undefined;
  return {
    kind: value.kind as "readiness" | "protocol_recovery",
    text: value.text,
  };
}

function parseProtocolRecovery(
  value: unknown,
): LoopControlCheckpointV1["protocolRecovery"] | undefined {
  if (!isRecord(value)) return undefined;
  const formatErrorNudges = parseBoundedCounter(value.formatErrorNudges, 2);
  const noActionNudges = parseBoundedCounter(value.noActionNudges, 10_000);
  const hasEverUsedTools = value.hasEverUsedTools === true ? true : undefined;
  if (
    value.formatErrorNudges !== undefined &&
    formatErrorNudges === undefined
  ) {
    return undefined;
  }
  if (value.noActionNudges !== undefined && noActionNudges === undefined) {
    return undefined;
  }
  if (value.hasEverUsedTools !== undefined && hasEverUsedTools === undefined) {
    return undefined;
  }
  if (
    formatErrorNudges === undefined &&
    noActionNudges === undefined &&
    hasEverUsedTools === undefined
  ) {
    return undefined;
  }
  return {
    ...(formatErrorNudges !== undefined ? { formatErrorNudges } : {}),
    ...(noActionNudges !== undefined ? { noActionNudges } : {}),
    ...(hasEverUsedTools ? { hasEverUsedTools } : {}),
  };
}

function parseCompletionGates(
  value: unknown,
): LoopControlCheckpointV1["completionGates"] | undefined {
  if (!isRecord(value)) return undefined;
  const autoContinueNudges = parseBoundedCounter(value.autoContinueNudges, 3);
  const verifyNudges = parseBoundedCounter(value.verifyNudges, 2);
  const acceptanceNudges = parseBoundedCounter(value.acceptanceNudges, 2);
  const candidateReview = parseCandidateReviewGate(value.candidateReview);
  if (
    (value.autoContinueNudges !== undefined &&
      autoContinueNudges === undefined) ||
    (value.verifyNudges !== undefined && verifyNudges === undefined) ||
    (value.acceptanceNudges !== undefined && acceptanceNudges === undefined) ||
    (value.candidateReview !== undefined && candidateReview === undefined)
  ) {
    return undefined;
  }
  if (
    autoContinueNudges === undefined &&
    verifyNudges === undefined &&
    acceptanceNudges === undefined &&
    candidateReview === undefined
  ) {
    return undefined;
  }
  return {
    ...(autoContinueNudges !== undefined ? { autoContinueNudges } : {}),
    ...(verifyNudges !== undefined ? { verifyNudges } : {}),
    ...(acceptanceNudges !== undefined ? { acceptanceNudges } : {}),
    ...(candidateReview ? { candidateReview } : {}),
  };
}

function parseCandidateReviewGate(
  value: unknown,
):
  | NonNullable<
      NonNullable<LoopControlCheckpointV1["completionGates"]>["candidateReview"]
    >
  | undefined {
  if (!isRecord(value)) return undefined;
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0) {
    return undefined;
  }
  const nudges = parseBoundedCounter(value.nudges, 2);
  if (!nudges) return undefined;
  const summaryFingerprint =
    typeof value.summaryFingerprint === "string" &&
    /^[a-f0-9]{64}$/.test(value.summaryFingerprint)
      ? value.summaryFingerprint
      : undefined;
  if (
    value.summaryFingerprint !== undefined &&
    summaryFingerprint === undefined
  ) {
    return undefined;
  }
  return {
    revision: value.revision as number,
    nudges,
    ...(summaryFingerprint ? { summaryFingerprint } : {}),
  };
}

function parseLateGuidance(
  value: unknown,
): LoopControlCheckpointV1["lateGuidance"] | undefined {
  if (!isRecord(value)) return undefined;
  const contextGuardDelivered =
    value.contextGuardDelivered === true ? true : undefined;
  const implementationDelivered =
    value.implementationDelivered === true ? true : undefined;
  const maxStepsDelivered = value.maxStepsDelivered === true ? true : undefined;
  const convergenceEvidenceKey =
    typeof value.convergenceEvidenceKey === "string" &&
    /^r(?:0|[1-9]\d*):(?:missing|stale|passed|code_failed|harness_failed):(?:current|stale)$/.test(
      value.convergenceEvidenceKey,
    )
      ? value.convergenceEvidenceKey
      : undefined;
  if (
    (value.contextGuardDelivered !== undefined && !contextGuardDelivered) ||
    (value.implementationDelivered !== undefined && !implementationDelivered) ||
    (value.maxStepsDelivered !== undefined && !maxStepsDelivered) ||
    (value.convergenceEvidenceKey !== undefined && !convergenceEvidenceKey)
  ) {
    return undefined;
  }
  if (
    !contextGuardDelivered &&
    !implementationDelivered &&
    !maxStepsDelivered &&
    !convergenceEvidenceKey
  ) {
    return undefined;
  }
  return {
    ...(contextGuardDelivered ? { contextGuardDelivered } : {}),
    ...(implementationDelivered ? { implementationDelivered } : {}),
    ...(convergenceEvidenceKey ? { convergenceEvidenceKey } : {}),
    ...(maxStepsDelivered ? { maxStepsDelivered } : {}),
  };
}

function parseBoundedCounter(value: unknown, max: number): number | undefined {
  return Number.isSafeInteger(value) &&
    (value as number) >= 1 &&
    (value as number) <= max
    ? (value as number)
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
