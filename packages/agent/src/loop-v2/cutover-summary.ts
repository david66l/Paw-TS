import type {
  LoopV2AuthorityEligibilityV1,
  LoopV2AuthorityIneligibilityReasonV1,
  LoopV2TerminalComparisonV1,
} from "./live-terminal-artifact.js";

export const LOOP_V2_CUTOVER_SUMMARY_SCHEMA_VERSION = 1 as const;

export interface LoopV2CutoverObservationV1 {
  readonly runId: string;
  readonly terminalComparison: LoopV2TerminalComparisonV1;
  readonly eligibility: LoopV2AuthorityEligibilityV1;
  readonly cutoverReady: boolean;
}

export interface LoopV2CutoverScanFailureV1 {
  readonly runDirectory: string;
  readonly error: string;
}

export interface LoopV2CutoverSummaryV1 {
  readonly schemaVersion: typeof LOOP_V2_CUTOVER_SUMMARY_SCHEMA_VERSION;
  readonly kind: "paw.loop-v2-cutover-summary";
  readonly scannedRuns: number;
  readonly strictRuns: number;
  readonly corruptRuns: number;
  readonly eligibleRuns: number;
  readonly cutoverReadyRuns: number;
  readonly eligibleNotReadyRuns: number;
  readonly v2MorePermissiveRuns: number;
  readonly terminalComparisons: Readonly<
    Record<LoopV2TerminalComparisonV1, number>
  >;
  readonly ineligibilityReasons: Readonly<
    Partial<Record<LoopV2AuthorityIneligibilityReasonV1, number>>
  >;
  readonly eligibleRunIds: readonly string[];
  readonly eligibleNotReadyRunIds: readonly string[];
  readonly v2MorePermissiveRunIds: readonly string[];
  readonly failures: readonly LoopV2CutoverScanFailureV1[];
  /** Evidence gate for creating a controlled flag, never for enabling default v2. */
  readonly controlledCutoverEvidenceReady: boolean;
}

export function summarizeLoopV2CutoverV1(
  observations: readonly LoopV2CutoverObservationV1[],
  failures: readonly LoopV2CutoverScanFailureV1[] = [],
): LoopV2CutoverSummaryV1 {
  const ordered = [...observations].sort((left, right) =>
    left.runId.localeCompare(right.runId),
  );
  const seen = new Set<string>();
  for (const observation of ordered) {
    const runId = observation.runId.trim();
    if (!runId || seen.has(runId)) {
      throw new Error(`Loop v2 cutover summary has invalid runId: ${runId}`);
    }
    seen.add(runId);
    if (!observation.eligibility.eligible && observation.cutoverReady) {
      throw new Error(
        `Ineligible loop v2 run cannot be cutover-ready: ${runId}`,
      );
    }
  }

  const terminalComparisons: Record<LoopV2TerminalComparisonV1, number> = {
    equal: 0,
    legacy_completed_v2_external_pending: 0,
    legacy_more_permissive: 0,
    v2_more_permissive: 0,
    different_noncompletion: 0,
  };
  const reasonCounts = new Map<LoopV2AuthorityIneligibilityReasonV1, number>();
  for (const observation of ordered) {
    terminalComparisons[observation.terminalComparison] += 1;
    for (const reason of observation.eligibility.reasons) {
      reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
    }
  }

  const eligibleRunIds = ordered
    .filter((observation) => observation.eligibility.eligible)
    .map((observation) => observation.runId);
  const eligibleNotReadyRunIds = ordered
    .filter(
      (observation) =>
        observation.eligibility.eligible && !observation.cutoverReady,
    )
    .map((observation) => observation.runId);
  const v2MorePermissiveRunIds = ordered
    .filter(
      (observation) => observation.terminalComparison === "v2_more_permissive",
    )
    .map((observation) => observation.runId);
  const orderedFailures = [...failures]
    .map((failure) => ({
      runDirectory: failure.runDirectory,
      error: failure.error.trim() || "unknown scan failure",
    }))
    .sort((left, right) => left.runDirectory.localeCompare(right.runDirectory));
  const ineligibilityReasons = Object.fromEntries(
    [...reasonCounts.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  ) as Partial<Record<LoopV2AuthorityIneligibilityReasonV1, number>>;
  const cutoverReadyRuns = ordered.filter(
    (observation) => observation.cutoverReady,
  ).length;

  return {
    schemaVersion: LOOP_V2_CUTOVER_SUMMARY_SCHEMA_VERSION,
    kind: "paw.loop-v2-cutover-summary",
    scannedRuns: ordered.length + orderedFailures.length,
    strictRuns: ordered.length,
    corruptRuns: orderedFailures.length,
    eligibleRuns: eligibleRunIds.length,
    cutoverReadyRuns,
    eligibleNotReadyRuns: eligibleNotReadyRunIds.length,
    v2MorePermissiveRuns: v2MorePermissiveRunIds.length,
    terminalComparisons,
    ineligibilityReasons,
    eligibleRunIds,
    eligibleNotReadyRunIds,
    v2MorePermissiveRunIds,
    failures: orderedFailures,
    controlledCutoverEvidenceReady:
      orderedFailures.length === 0 &&
      eligibleRunIds.length > 0 &&
      eligibleNotReadyRunIds.length === 0 &&
      v2MorePermissiveRunIds.length === 0,
  };
}
