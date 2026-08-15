import { CAPABILITY_EXPOSURE_SCHEMA_V1 } from "./capability-exposure.js";

export const CAPABILITY_EXPOSURE_SUMMARY_SCHEMA_V1 =
  "paw.capability-exposure-summary.v1" as const;

export interface CapabilityExposureRunObservationV1 {
  readonly runId: string;
  readonly tracePath: string;
  readonly inventoryEvents: number;
  readonly selectionEvents: number;
  readonly fullToolCount?: number;
  readonly suggestedToolCount?: number;
  readonly fullToolTokens?: number;
  readonly suggestedToolTokens?: number;
  readonly estimatedSavingsTokens?: number;
  readonly hitSelections: number;
  readonly fallbackSelections: number;
  readonly noToolSelections: number;
  readonly outsideSuggestion: readonly string[];
  readonly linkedResult: boolean;
  readonly evidenceClass: "public_benchmark" | "diagnostic";
  readonly instanceId?: string;
  readonly sourceCommit?: string;
  readonly resolved?: boolean;
  readonly resolvedSource?: string;
  readonly valid: boolean;
  readonly issues: readonly string[];
}

export interface CapabilityExposureScanFailureV1 {
  readonly tracePath: string;
  readonly error: string;
}

export interface CapabilityExposureSummaryV1 {
  readonly schemaVersion: typeof CAPABILITY_EXPOSURE_SUMMARY_SCHEMA_V1;
  readonly minimumQualifyingRuns: number;
  readonly scannedRuns: number;
  readonly structurallyValidRuns: number;
  readonly diagnosticRuns: number;
  readonly qualifyingRuns: number;
  readonly invalidRuns: number;
  readonly scanFailures: readonly CapabilityExposureScanFailureV1[];
  readonly inventoryEvents: number;
  readonly selectionEvents: number;
  readonly toolSelections: number;
  readonly hitSelections: number;
  readonly fallbackSelections: number;
  readonly noToolSelections: number;
  readonly fallbackRate: number | null;
  readonly qualifyingToolSelections: number;
  readonly qualifyingFallbackSelections: number;
  readonly qualifyingFallbackRate: number | null;
  readonly meanFullToolCount: number | null;
  readonly meanSuggestedToolCount: number | null;
  readonly meanEstimatedSavingsTokens: number | null;
  readonly outsideSuggestion: readonly {
    readonly tool: string;
    readonly count: number;
  }[];
  readonly qualifyingOutsideSuggestion: readonly {
    readonly tool: string;
    readonly count: number;
  }[];
  readonly linkedResultRuns: number;
  readonly resolvedRuns: number;
  /** Enough clean shadow evidence to design a controlled on/off trial. */
  readonly shadowCoverageReady: boolean;
  /** Shadow traces alone can never establish non-regression. */
  readonly hardActivationReady: false;
  readonly blockers: readonly string[];
  readonly runs: readonly CapabilityExposureRunObservationV1[];
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function stringArray(value: unknown): readonly string[] | undefined {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    return undefined;
  }
  return value;
}

function mean(values: readonly number[]): number | null {
  return values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
}

export function parseCapabilityExposureTraceV1(input: {
  readonly tracePath: string;
  readonly traceRaw: string;
  readonly resultRaw?: string;
}): CapabilityExposureRunObservationV1 {
  const parsed: unknown = JSON.parse(input.traceRaw);
  if (!Array.isArray(parsed)) throw new Error("Trace root must be an array");

  const issues: string[] = [];
  let runId: string | undefined;
  let priorSeq = 0;
  const inventories: JsonRecord[] = [];
  const selections: JsonRecord[] = [];

  for (const [index, envelope] of parsed.entries()) {
    if (!isRecord(envelope) || !isRecord(envelope.event)) {
      issues.push(`event[${index}] is not a run-event envelope`);
      continue;
    }
    if (typeof envelope.runId !== "string" || envelope.runId.length === 0) {
      issues.push(`event[${index}] has no runId`);
    } else if (runId === undefined) {
      runId = envelope.runId;
    } else if (runId !== envelope.runId) {
      issues.push(`event[${index}] changes runId`);
    }
    const seq = finiteNumber(envelope.seq);
    if (seq === undefined || !Number.isInteger(seq) || seq <= priorSeq) {
      issues.push(`event[${index}] has non-monotonic seq`);
    } else {
      priorSeq = seq;
    }
    if (envelope.event.type === "capability.inventory") {
      inventories.push(envelope.event);
    } else if (envelope.event.type === "capability.selection") {
      selections.push(envelope.event);
    }
  }

  if (inventories.length !== 1) {
    issues.push(`expected 1 capability.inventory, found ${inventories.length}`);
  }
  if (selections.length === 0) {
    issues.push("expected at least 1 capability.selection");
  }

  const inventory = inventories[0];
  const fullToolCount = inventory
    ? finiteNumber(inventory.fullToolCount)
    : undefined;
  const suggestedToolCount = inventory
    ? finiteNumber(inventory.suggestedToolCount)
    : undefined;
  const fullToolTokens = inventory
    ? finiteNumber(inventory.fullToolTokens)
    : undefined;
  const suggestedToolTokens = inventory
    ? finiteNumber(inventory.suggestedToolTokens)
    : undefined;
  const estimatedSavingsTokens = inventory
    ? finiteNumber(inventory.estimatedSavingsTokens)
    : undefined;

  if (inventory) {
    if (
      inventory.schemaVersion !== CAPABILITY_EXPOSURE_SCHEMA_V1 ||
      inventory.mode !== "shadow"
    ) {
      issues.push("inventory schema or mode is incompatible");
    }
    if (
      fullToolCount === undefined ||
      suggestedToolCount === undefined ||
      fullToolTokens === undefined ||
      suggestedToolTokens === undefined ||
      estimatedSavingsTokens === undefined
    ) {
      issues.push("inventory counters are incomplete");
    } else if (
      suggestedToolCount > fullToolCount ||
      suggestedToolTokens > fullToolTokens ||
      estimatedSavingsTokens !== fullToolTokens - suggestedToolTokens
    ) {
      issues.push("inventory counters are inconsistent");
    }
  }

  let hitSelections = 0;
  let fallbackSelections = 0;
  let noToolSelections = 0;
  const outsideSuggestion = new Set<string>();
  for (const [index, selection] of selections.entries()) {
    if (
      selection.schemaVersion !== CAPABILITY_EXPOSURE_SCHEMA_V1 ||
      selection.mode !== "shadow"
    ) {
      issues.push(`selection[${index}] schema or mode is incompatible`);
    }
    const actual = stringArray(selection.actualTools);
    const outside = stringArray(selection.outsideSuggestion);
    if (!actual || !outside) {
      issues.push(`selection[${index}] tool lists are invalid`);
      continue;
    }
    if (
      fullToolCount !== undefined &&
      selection.exposedToolCount !== fullToolCount
    ) {
      issues.push(`selection[${index}] exposedToolCount changed`);
    }
    for (const tool of outside) outsideSuggestion.add(tool);
    switch (selection.outcome) {
      case "hit":
        hitSelections += 1;
        if (actual.length === 0 || outside.length !== 0) {
          issues.push(`selection[${index}] hit outcome is inconsistent`);
        }
        break;
      case "fallback":
        fallbackSelections += 1;
        if (outside.length === 0) {
          issues.push(`selection[${index}] fallback has no outside tool`);
        }
        break;
      case "no_tool":
        noToolSelections += 1;
        if (actual.length !== 0 || outside.length !== 0) {
          issues.push(`selection[${index}] no_tool outcome is inconsistent`);
        }
        break;
      default:
        issues.push(`selection[${index}] has unknown outcome`);
    }
  }

  let linkedResult = false;
  let evidenceClass: "public_benchmark" | "diagnostic" = "diagnostic";
  let instanceId: string | undefined;
  let sourceCommit: string | undefined;
  let resolved: boolean | undefined;
  let resolvedSource: string | undefined;
  if (input.resultRaw !== undefined) {
    const result: unknown = JSON.parse(input.resultRaw);
    if (!isRecord(result)) throw new Error("Result root must be an object");
    linkedResult = result.runId === runId;
    if (!linkedResult) issues.push("result runId does not match trace runId");
    if (typeof result.instanceId === "string" && result.instanceId.length > 0) {
      instanceId = result.instanceId;
    }
    if (
      typeof result.sourceCommit === "string" &&
      /^[0-9a-f]{40}$/i.test(result.sourceCommit)
    ) {
      sourceCommit = result.sourceCommit;
    }
    const integrity = isRecord(result.integrity) ? result.integrity : undefined;
    if (
      linkedResult &&
      result.runner === "paw" &&
      instanceId !== undefined &&
      sourceCommit !== undefined &&
      result.artifactStatus === "valid" &&
      integrity?.valid === true
    ) {
      evidenceClass = "public_benchmark";
    }
    if (typeof result.resolved === "boolean") resolved = result.resolved;
    if (typeof result.resolvedSource === "string") {
      resolvedSource = result.resolvedSource;
    }
  }

  return Object.freeze({
    runId: runId ?? "unknown",
    tracePath: input.tracePath,
    inventoryEvents: inventories.length,
    selectionEvents: selections.length,
    fullToolCount,
    suggestedToolCount,
    fullToolTokens,
    suggestedToolTokens,
    estimatedSavingsTokens,
    hitSelections,
    fallbackSelections,
    noToolSelections,
    outsideSuggestion: Object.freeze([...outsideSuggestion].sort()),
    linkedResult,
    evidenceClass,
    instanceId,
    sourceCommit,
    resolved,
    resolvedSource,
    valid: issues.length === 0,
    issues: Object.freeze(issues),
  });
}

export function summarizeCapabilityExposureV1(
  runs: readonly CapabilityExposureRunObservationV1[],
  scanFailures: readonly CapabilityExposureScanFailureV1[] = [],
  minimumQualifyingRuns = 10,
): CapabilityExposureSummaryV1 {
  const minimum = Math.max(1, Math.floor(minimumQualifyingRuns));
  const structurallyValid = runs.filter((run) => run.valid);
  const qualifying = structurallyValid.filter(
    (run) => run.evidenceClass === "public_benchmark",
  );
  const hitSelections = structurallyValid.reduce(
    (sum, run) => sum + run.hitSelections,
    0,
  );
  const fallbackSelections = structurallyValid.reduce(
    (sum, run) => sum + run.fallbackSelections,
    0,
  );
  const noToolSelections = structurallyValid.reduce(
    (sum, run) => sum + run.noToolSelections,
    0,
  );
  const toolSelections = hitSelections + fallbackSelections;
  const qualifyingToolSelections = qualifying.reduce(
    (sum, run) => sum + run.hitSelections + run.fallbackSelections,
    0,
  );
  const qualifyingFallbackSelections = qualifying.reduce(
    (sum, run) => sum + run.fallbackSelections,
    0,
  );
  const outsideCounts = new Map<string, number>();
  const qualifyingOutsideCounts = new Map<string, number>();
  for (const run of structurallyValid) {
    for (const tool of run.outsideSuggestion) {
      outsideCounts.set(tool, (outsideCounts.get(tool) ?? 0) + 1);
      if (run.evidenceClass === "public_benchmark") {
        qualifyingOutsideCounts.set(
          tool,
          (qualifyingOutsideCounts.get(tool) ?? 0) + 1,
        );
      }
    }
  }

  const enoughRuns = qualifying.length >= minimum;
  const cleanScan = scanFailures.length === 0 && runs.every((run) => run.valid);
  const noFallbacks = qualifyingFallbackSelections === 0;
  const shadowCoverageReady = enoughRuns && cleanScan && noFallbacks;
  const blockers: string[] = [];
  if (!enoughRuns) {
    blockers.push(
      `need ${minimum - qualifying.length} more qualifying shadow run(s)`,
    );
  }
  if (!cleanScan) blockers.push("trace scan contains corrupt or invalid runs");
  if (!noFallbacks)
    blockers.push("shadow selector omitted tools used by the model");
  if (shadowCoverageReady) {
    blockers.push(
      "controlled memory-off full-vs-deferred resolved comparison missing",
    );
  } else {
    blockers.push("shadow coverage gate not ready for a controlled trial");
  }

  return Object.freeze({
    schemaVersion: CAPABILITY_EXPOSURE_SUMMARY_SCHEMA_V1,
    minimumQualifyingRuns: minimum,
    scannedRuns: runs.length,
    structurallyValidRuns: structurallyValid.length,
    diagnosticRuns: structurallyValid.length - qualifying.length,
    qualifyingRuns: qualifying.length,
    invalidRuns: runs.length - structurallyValid.length,
    scanFailures: Object.freeze([...scanFailures]),
    inventoryEvents: structurallyValid.reduce(
      (sum, run) => sum + run.inventoryEvents,
      0,
    ),
    selectionEvents: structurallyValid.reduce(
      (sum, run) => sum + run.selectionEvents,
      0,
    ),
    toolSelections,
    hitSelections,
    fallbackSelections,
    noToolSelections,
    fallbackRate:
      toolSelections > 0 ? fallbackSelections / toolSelections : null,
    qualifyingToolSelections,
    qualifyingFallbackSelections,
    qualifyingFallbackRate:
      qualifyingToolSelections > 0
        ? qualifyingFallbackSelections / qualifyingToolSelections
        : null,
    meanFullToolCount: mean(
      structurallyValid.flatMap((run) =>
        run.fullToolCount === undefined ? [] : [run.fullToolCount],
      ),
    ),
    meanSuggestedToolCount: mean(
      structurallyValid.flatMap((run) =>
        run.suggestedToolCount === undefined ? [] : [run.suggestedToolCount],
      ),
    ),
    meanEstimatedSavingsTokens: mean(
      structurallyValid.flatMap((run) =>
        run.estimatedSavingsTokens === undefined
          ? []
          : [run.estimatedSavingsTokens],
      ),
    ),
    outsideSuggestion: Object.freeze(
      [...outsideCounts]
        .map(([tool, count]) => Object.freeze({ tool, count }))
        .sort(
          (left, right) =>
            right.count - left.count || left.tool.localeCompare(right.tool),
        ),
    ),
    qualifyingOutsideSuggestion: Object.freeze(
      [...qualifyingOutsideCounts]
        .map(([tool, count]) => Object.freeze({ tool, count }))
        .sort(
          (left, right) =>
            right.count - left.count || left.tool.localeCompare(right.tool),
        ),
    ),
    linkedResultRuns: qualifying.filter((run) => run.linkedResult).length,
    resolvedRuns: qualifying.filter((run) => run.resolved === true).length,
    shadowCoverageReady,
    hardActivationReady: false,
    blockers: Object.freeze(blockers),
    runs: Object.freeze([...runs]),
  });
}
