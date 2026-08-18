import type { ChatMessage } from "@paw/core";
import {
  type EphemeralControlV1,
  parseLegacyProtocolRecoveryProjectionV1,
} from "./context-assembler.js";
import type { ProviderTerminalStateV2 } from "./loop-v2/index.js";
import { parseLoopV2ReadinessFeedbackMarker } from "./loop-v2/index.js";
import type { TurnFlags } from "./orchestrator/types.js";

type CrashSafePendingControlV1 = Extract<
  EphemeralControlV1,
  { readonly kind: "readiness" | "protocol_recovery" }
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
}

const PROTOCOL_ISSUES = new Set([
  "empty_response",
  "truncated_response",
  "missing_tool_calls",
]);
const CONTROL_KINDS = new Set<CrashSafePendingControlV1["kind"]>([
  "readiness",
  "protocol_recovery",
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
    flags.pendingControl?.kind === "protocol_recovery"
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
  if (
    !flags.providerTerminal &&
    !readiness &&
    !pendingControl &&
    !protocolRecovery
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
  if (!providerTerminal && !readiness && !pendingControl && !protocolRecovery)
    return undefined;
  return {
    schemaVersion: "paw.loop-control.v1",
    ...(providerTerminal ? { providerTerminal } : {}),
    ...(readiness ? { readiness } : {}),
    ...(pendingControl ? { pendingControl } : {}),
    ...(protocolRecovery ? { protocolRecovery } : {}),
  };
}

/** New snapshots win; old readiness markers are consumed once for migration. */
export function restoreLoopControlFlagsV1(input: {
  readonly runId: string;
  readonly startTurn: number;
  readonly value: unknown;
  readonly legacyMessages: readonly ChatMessage[];
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
    return {
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
    };
  }
  const legacyProtocolRecovery = parseLegacyProtocolRecoveryProjectionV1(
    input.legacyMessages,
  );
  if (legacyProtocolRecovery) return legacyProtocolRecovery;
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
  return {
    kind: value.kind as CrashSafePendingControlV1["kind"],
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
