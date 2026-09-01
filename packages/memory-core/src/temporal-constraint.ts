import { type JsonValue, hashCanonicalJsonV1 } from "./canonical.js";
import {
  type MemoryEvidenceBoundTemporalConstraintV1,
  type MemoryEvidenceBoundTemporalWindowV2,
  type MemoryEvidenceDurationRequestV1,
  type MemoryEvidenceTemporalConstraintV1,
  type MemoryEvidenceTemporalIntervalV2,
  type MemoryEvidenceTemporalModeV3,
  PAW_MEMORY_EVIDENCE_TEMPORAL_COMPATIBILITY_VERSION_V1,
  PAW_MEMORY_EVIDENCE_TEMPORAL_CONSTRAINT_VERSION_V1,
} from "./query-plan-contracts.js";

/**
 * Versioned compatibility matrix for answer-level temporal envelopes and
 * leaf-level retrieval operations. It authorizes an operation only; it never
 * authorizes a model-provided timestamp, anchor, or interval.
 *
 * `any`, `history`, and `latest` are broad evidence envelopes. `range` cannot
 * admit unbounded history, and `as_of` cannot admit an unanchored latest-state
 * operation. Both exclusions fail closed until a deterministic interval
 * compiler can prove the narrower binding.
 */
const LEAF_TEMPORAL_COMPATIBILITY_V1: Readonly<
  Record<
    MemoryEvidenceTemporalModeV3,
    ReadonlySet<MemoryEvidenceTemporalModeV3>
  >
> = Object.freeze({
  any: modes("any", "latest", "as_of", "history", "range"),
  latest: modes("any", "latest", "as_of", "history", "range"),
  as_of: modes("any", "as_of", "history", "range"),
  history: modes("any", "latest", "as_of", "history", "range"),
  range: modes("any", "latest", "as_of", "range"),
});
const TEMPORAL_CONSTRAINT_KEYS_V1 = Object.freeze([
  "anchorPolicy",
  "compatibilityVersion",
  "constraintRevision",
  "constraintVersion",
  "intervalPolicy",
  "mode",
  "queryEnvelopeMode",
  "queryRevision",
]);

export function memoryEvidenceLeafTemporalModeAllowedV1(
  queryEnvelopeMode: MemoryEvidenceTemporalModeV3,
  leafMode: MemoryEvidenceTemporalModeV3,
): boolean {
  return (
    LEAF_TEMPORAL_COMPATIBILITY_V1[queryEnvelopeMode]?.has(leafMode) === true
  );
}

export function compileMemoryEvidenceTemporalConstraintV1(input: {
  readonly query: string;
  readonly queryEnvelopeMode: MemoryEvidenceTemporalModeV3;
  readonly leafMode: MemoryEvidenceTemporalModeV3;
}): MemoryEvidenceTemporalConstraintV1 {
  const query = boundedQuery(input.query);
  if (
    !memoryEvidenceLeafTemporalModeAllowedV1(
      input.queryEnvelopeMode,
      input.leafMode,
    )
  ) {
    throw namedError("MemoryEvidenceTemporalConstraintIncompatible");
  }
  const policy = temporalPolicy(input.leafMode);
  const identity = {
    constraintVersion: PAW_MEMORY_EVIDENCE_TEMPORAL_CONSTRAINT_VERSION_V1,
    compatibilityVersion: PAW_MEMORY_EVIDENCE_TEMPORAL_COMPATIBILITY_VERSION_V1,
    mode: input.leafMode,
    queryEnvelopeMode: input.queryEnvelopeMode,
    ...policy,
    queryRevision: hashCanonicalJsonV1(query as JsonValue),
  } as const;
  return Object.freeze({
    ...identity,
    constraintRevision: hashCanonicalJsonV1(identity as unknown as JsonValue),
  });
}

export function validateMemoryEvidenceTemporalConstraintV1(input: {
  readonly query: string;
  readonly queryEnvelopeMode: MemoryEvidenceTemporalModeV3;
  readonly leafMode: MemoryEvidenceTemporalModeV3;
  readonly constraint: MemoryEvidenceTemporalConstraintV1;
}): void {
  const expected = compileMemoryEvidenceTemporalConstraintV1(input);
  if (
    Object.keys(input.constraint).sort().join("\0") !==
      TEMPORAL_CONSTRAINT_KEYS_V1.join("\0") ||
    expected.constraintRevision !== input.constraint.constraintRevision ||
    expected.constraintVersion !== input.constraint.constraintVersion ||
    expected.compatibilityVersion !== input.constraint.compatibilityVersion ||
    expected.mode !== input.constraint.mode ||
    expected.queryEnvelopeMode !== input.constraint.queryEnvelopeMode ||
    expected.anchorPolicy !== input.constraint.anchorPolicy ||
    expected.intervalPolicy !== input.constraint.intervalPolicy ||
    expected.queryRevision !== input.constraint.queryRevision
  ) {
    throw namedError("MemoryEvidenceTemporalConstraintInvalid");
  }
}

export function bindMemoryEvidenceTemporalConstraintV1(input: {
  readonly query: string;
  readonly queryEnvelopeMode: MemoryEvidenceTemporalModeV3;
  readonly leafMode: MemoryEvidenceTemporalModeV3;
  readonly constraint?: MemoryEvidenceTemporalConstraintV1;
  readonly evidenceTimeUpperBound?: string;
}): MemoryEvidenceBoundTemporalConstraintV1 {
  const constraint =
    input.constraint ?? compileMemoryEvidenceTemporalConstraintV1(input);
  validateMemoryEvidenceTemporalConstraintV1({
    ...input,
    constraint,
  });
  const evidenceTimeUpperBound = normalizeCutoff(input.evidenceTimeUpperBound);
  const window = compileMemoryEvidenceBoundTemporalWindowV2({
    query: input.query,
    mode: input.leafMode,
    evidenceTimeUpperBound,
  });
  const durationRequest = compileMemoryEvidenceDurationRequestV1(
    input.query,
    evidenceTimeUpperBound ?? undefined,
  );
  const identity = {
    ...constraint,
    evidenceTimeUpperBound,
    window,
    durationRequest,
  } as const;
  return Object.freeze({
    ...identity,
    bindingRevision: hashCanonicalJsonV1(identity as unknown as JsonValue),
  });
}

/** Host-only binding: the planner never authors timestamps or intervals. */
export function compileMemoryEvidenceBoundTemporalWindowV2(input: {
  readonly query: string;
  readonly mode: MemoryEvidenceTemporalModeV3;
  readonly evidenceTimeUpperBound: string | null;
}): MemoryEvidenceBoundTemporalWindowV2 {
  const query = boundedQuery(input.query);
  const cutoff = input.evidenceTimeUpperBound;
  if (input.mode === "any") {
    return Object.freeze({ kind: "unbounded", evidenceCutoff: cutoff });
  }
  if (input.mode === "latest") {
    return Object.freeze({
      kind: "latest_before",
      cutoff,
      clockPolicy: "event_then_observed_if_uniform",
    });
  }
  if (input.mode === "history") {
    return Object.freeze({
      kind: "history_through",
      cutoff,
      clockPolicy: "event_then_observed_if_uniform",
    });
  }
  const intervals = extractExplicitQueryIntervals(query);
  const relative = cutoff ? relativeQueryInterval(query, cutoff) : null;
  if (input.mode === "as_of") {
    return Object.freeze({
      kind: "as_of",
      anchor: relative ?? intervals[0] ?? null,
      cutoff,
      inclusion: "through_end",
      clockPolicy: "event_then_observed_if_uniform",
    });
  }
  return Object.freeze({
    kind: "range",
    interval: relative ?? combineRangeIntervals(intervals),
    cutoff,
    inclusion: "overlaps",
    clockPolicy: "event_then_observed_if_uniform",
  });
}

export function compileMemoryEvidenceDurationRequestV1(
  query: string,
  evidenceTimeUpperBound?: string,
): MemoryEvidenceDurationRequestV1 | null {
  const value = boundedQuery(query);
  const explicitEndpointPair =
    /\bbetween\b.{1,96}\band\b|\bfrom\b.{1,96}\bto\b/iu.test(value) ||
    /从.{1,64}到.{1,64}(?:多久|多长|多少(?:天|周|个月|月|年))|(?:两者|二者|两个事件|两次).{0,32}(?:相隔|间隔)/u.test(
      value,
    );
  if (
    !explicitEndpointPair &&
    /\b(?:combined|in\s+total|altogether|total)\b|(?:总共|合计|一共|加起来|总计)/iu.test(
      value,
    )
  ) {
    return null;
  }
  if (
    !/(?:\bhow\s+long\b|\bhow\s+many\s+(?:days?|weeks?|months?|years?)\b.{0,96}\b(?:ago|elapsed|passed|take|between|since|from|when)\b|\b(?:time|days?|weeks?|months?|years?)\s+(?:passed|elapsed)\b|\bduration\b|多久|多少(?:天|周|个月|月|年).{0,48}(?:前|过去|经过|花了|耗时|相隔|间隔|从|到|当时)|相隔|间隔)/iu.test(
      value,
    )
  ) {
    return null;
  }
  const unit = /(?:\bdays?\b|多少天)/iu.test(value)
    ? ("day" as const)
    : /(?:\bweeks?\b|多少周)/iu.test(value)
      ? ("week" as const)
      : /(?:\bmonths?\b|多少(?:个月|月))/iu.test(value)
        ? ("month" as const)
        : /(?:\byears?\b|多少年)/iu.test(value)
          ? ("year" as const)
          : ("auto" as const);
  const endpointPolicy = durationUsesQueryAnchor(value)
    ? ("evidence_to_query_anchor" as const)
    : ("between_evidence" as const);
  const queryAnchor =
    endpointPolicy === "evidence_to_query_anchor"
      ? normalizeCutoff(evidenceTimeUpperBound)
      : null;
  const endpointContract =
    endpointPolicy === "evidence_to_query_anchor"
      ? Object.freeze({
          kind: "evidence_to_host_anchor" as const,
          evidenceEndpointCount: 1 as const,
          groupPolicy: "union_bound_operands" as const,
          anchorRevision: hashCanonicalJsonV1({
            schemaVersion: "paw.memory-duration-query-anchor.v1",
            queryAnchor,
          } as unknown as JsonValue),
        })
      : Object.freeze({
          kind: "distinct_evidence_pair" as const,
          evidenceEndpointCount: 2 as const,
          groupPolicy: "union_bound_operands" as const,
          distinctness: "distinct_event_identity" as const,
          ordering: durationEndpointOrdering(value),
        });
  const identity = {
    basis: "calendar" as const,
    unit,
    endpointPolicy,
    endpointContract,
    queryAnchor,
    calendarTimeZone: "UTC" as const,
  };
  return Object.freeze({
    ...identity,
    requestRevision: hashCanonicalJsonV1(identity as unknown as JsonValue),
  });
}

function durationEndpointOrdering(
  query: string,
): "chronological" | "semantic_start_end_unbound" {
  return /\bfrom\b.{1,96}\bto\b/iu.test(query) ||
    /从.{1,64}到.{1,64}(?:多久|多长|多少(?:天|周|个月|月|年))/u.test(query)
    ? "semantic_start_end_unbound"
    : "chronological";
}

function durationUsesQueryAnchor(query: string): boolean {
  const explicitPair =
    /\bbetween\b.{1,96}\band\b|\bfrom\b.{1,96}\bto\b/iu.test(query) ||
    /从.{1,64}到.{1,64}(?:多久|多长|多少(?:天|周|个月|月|年))|(?:两者|二者|两个事件|两次).{0,32}(?:相隔|间隔)/u.test(
      query,
    );
  if (explicitPair) return false;
  return (
    /\bhow\s+long\s+ago\b|\bhow\s+many\s+(?:days?|weeks?|months?|years?)\s+ago\b|\b(?:how\s+long|how\s+many\s+(?:days?|weeks?|months?|years?))\b.{0,96}\bsince\b|\b(?:time|days?|weeks?|months?|years?)\s+(?:passed|elapsed)\s+since\b|\bsince\b.{0,96}\b(?:until\s+now|to\s+date)\b/iu.test(
      query,
    ) ||
    /(?:距今|多久前|多少(?:天|周|个月|月|年)前|到现在|至今|自.{0,64}以来).{0,32}(?:多久|多长|多少(?:天|周|个月|月|年))?/u.test(
      query,
    )
  );
}

export function assertMemoryEvidenceTemporalConstraintIdentityV1(
  constraint: MemoryEvidenceTemporalConstraintV1,
): void {
  const identity = {
    constraintVersion: constraint.constraintVersion,
    compatibilityVersion: constraint.compatibilityVersion,
    mode: constraint.mode,
    queryEnvelopeMode: constraint.queryEnvelopeMode,
    anchorPolicy: constraint.anchorPolicy,
    intervalPolicy: constraint.intervalPolicy,
    queryRevision: constraint.queryRevision,
  };
  if (
    Object.keys(constraint).sort().join("\0") !==
      TEMPORAL_CONSTRAINT_KEYS_V1.join("\0") ||
    constraint.constraintVersion !==
      PAW_MEMORY_EVIDENCE_TEMPORAL_CONSTRAINT_VERSION_V1 ||
    constraint.compatibilityVersion !==
      PAW_MEMORY_EVIDENCE_TEMPORAL_COMPATIBILITY_VERSION_V1 ||
    !memoryEvidenceLeafTemporalModeAllowedV1(
      constraint.queryEnvelopeMode,
      constraint.mode,
    ) ||
    hashCanonicalJsonV1(identity as unknown as JsonValue) !==
      constraint.constraintRevision
  ) {
    throw namedError("MemoryEvidenceTemporalConstraintInvalid");
  }
}

function temporalPolicy(mode: MemoryEvidenceTemporalModeV3): Readonly<{
  anchorPolicy: "none" | "query_cutoff" | "query_derived_anchor";
  intervalPolicy:
    | "unbounded"
    | "latest_at_or_before_cutoff"
    | "state_at_query_derived_anchor"
    | "history_through_cutoff"
    | "query_derived_range";
}> {
  switch (mode) {
    case "any":
      return Object.freeze({
        anchorPolicy: "none",
        intervalPolicy: "unbounded",
      });
    case "latest":
      return Object.freeze({
        anchorPolicy: "query_cutoff",
        intervalPolicy: "latest_at_or_before_cutoff",
      });
    case "as_of":
      return Object.freeze({
        anchorPolicy: "query_derived_anchor",
        intervalPolicy: "state_at_query_derived_anchor",
      });
    case "history":
      return Object.freeze({
        anchorPolicy: "query_cutoff",
        intervalPolicy: "history_through_cutoff",
      });
    case "range":
      return Object.freeze({
        anchorPolicy: "query_derived_anchor",
        intervalPolicy: "query_derived_range",
      });
  }
}

function modes(
  ...values: MemoryEvidenceTemporalModeV3[]
): ReadonlySet<MemoryEvidenceTemporalModeV3> {
  return new Set(values);
}

function extractExplicitQueryIntervals(
  query: string,
): readonly MemoryEvidenceTemporalIntervalV2[] {
  const intervals: MemoryEvidenceTemporalIntervalV2[] = [];
  for (const match of query.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/gu)) {
    const interval = strictUtcDay(
      Number(match[1]),
      Number(match[2]),
      Number(match[3]),
    );
    if (interval) intervals.push(interval);
  }
  for (const match of query.matchAll(
    /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,)?\s+(\d{4})\b/giu,
  )) {
    const month = monthNumber(match[1] ?? "");
    const interval = month
      ? strictUtcDay(Number(match[3]), month, Number(match[2]))
      : null;
    if (interval) intervals.push(interval);
  }
  const yearCue =
    /\b(?:as\s+of|in|during|between|from|to|since|before|after)\s+((?:19|20)\d{2})\b/giu;
  for (const match of query.matchAll(yearCue)) {
    const year = Number(match[1]);
    intervals.push(yearInterval(year));
  }
  const unique = new Map(
    intervals.map((interval) => [
      `${interval.lower}\0${interval.upper}`,
      interval,
    ]),
  );
  return Object.freeze([...unique.values()]);
}

function combineRangeIntervals(
  intervals: readonly MemoryEvidenceTemporalIntervalV2[],
): MemoryEvidenceTemporalIntervalV2 | null {
  if (intervals.length === 0) return null;
  if (intervals.length === 1) return intervals[0] ?? null;
  const lower = [...intervals].map((interval) => interval.lower).sort()[0];
  const upper = [...intervals]
    .map((interval) => interval.upper)
    .sort()
    .at(-1);
  if (!lower || !upper) return null;
  return Object.freeze({
    lower,
    upper,
    precision: intervals.every((interval) => interval.precision === "day")
      ? ("day" as const)
      : ("year" as const),
  });
}

function relativeQueryInterval(
  query: string,
  cutoff: string,
): MemoryEvidenceTemporalIntervalV2 | null {
  const anchor = new Date(cutoff);
  const cutoffDay = new Date(
    Date.UTC(
      anchor.getUTCFullYear(),
      anchor.getUTCMonth(),
      anchor.getUTCDate(),
    ),
  );
  if (/\blast\s+weekend\b|上个周末|上周末/iu.test(query)) {
    const day = cutoffDay.getUTCDay();
    const daysSinceMonday = (day + 6) % 7;
    const currentMonday = addUtcDays(cutoffDay, -daysSinceMonday);
    const upper = currentMonday;
    const lower = addUtcDays(upper, -2);
    return dayInterval(lower, upper);
  }
  if (/\blast\s+month\b|上个月/iu.test(query)) {
    const upper = new Date(
      Date.UTC(cutoffDay.getUTCFullYear(), cutoffDay.getUTCMonth(), 1),
    );
    const lower = new Date(
      Date.UTC(upper.getUTCFullYear(), upper.getUTCMonth() - 1, 1),
    );
    return dayInterval(lower, upper);
  }
  if (/\blast\s+week\b|上周/iu.test(query)) {
    return dayInterval(addUtcDays(cutoffDay, -7), cutoffDay);
  }
  const past =
    /\b(?:past|last)\s+(\d{1,3})\s+(days?|weeks?)\b/iu.exec(query) ??
    /过去\s*(\d{1,3})\s*(天|周)/u.exec(query);
  if (past) {
    const count = Number(past[1]);
    const unit = (past[2] ?? "").toLocaleLowerCase("en-US");
    const days = unit.startsWith("week") || unit === "周" ? count * 7 : count;
    if (Number.isSafeInteger(days) && days > 0) {
      return dayInterval(addUtcDays(cutoffDay, -days), cutoffDay);
    }
  }
  const ago =
    /\b(\d{1,3})\s+(days?|weeks?)\s+ago\b/iu.exec(query) ??
    /(\d{1,3})\s*(天|周)前/u.exec(query);
  if (ago) {
    const count = Number(ago[1]);
    const unit = (ago[2] ?? "").toLocaleLowerCase("en-US");
    const days = unit.startsWith("week") || unit === "周" ? count * 7 : count;
    if (Number.isSafeInteger(days) && days > 0) {
      const lower = addUtcDays(cutoffDay, -days);
      return dayInterval(lower, addUtcDays(lower, 1));
    }
  }
  return null;
}

function strictUtcDay(
  year: number,
  month: number,
  day: number,
): MemoryEvidenceTemporalIntervalV2 | null {
  if (
    !Number.isSafeInteger(year) ||
    !Number.isSafeInteger(month) ||
    !Number.isSafeInteger(day) ||
    year < 1 ||
    year > 9998 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return null;
  }
  const lower = new Date(Date.UTC(year, month - 1, day));
  if (
    lower.getUTCFullYear() !== year ||
    lower.getUTCMonth() !== month - 1 ||
    lower.getUTCDate() !== day
  ) {
    return null;
  }
  return dayInterval(lower, addUtcDays(lower, 1));
}

function yearInterval(year: number): MemoryEvidenceTemporalIntervalV2 {
  return Object.freeze({
    lower: new Date(Date.UTC(year, 0, 1)).toISOString(),
    upper: new Date(Date.UTC(year + 1, 0, 1)).toISOString(),
    precision: "year",
  });
}

function dayInterval(
  lower: Date,
  upper: Date,
): MemoryEvidenceTemporalIntervalV2 {
  return Object.freeze({
    lower: lower.toISOString(),
    upper: upper.toISOString(),
    precision: "day",
  });
}

function addUtcDays(value: Date, days: number): Date {
  return new Date(value.getTime() + days * 86_400_000);
}

function monthNumber(value: string): number | undefined {
  return new Map<string, number>([
    ["jan", 1],
    ["january", 1],
    ["feb", 2],
    ["february", 2],
    ["mar", 3],
    ["march", 3],
    ["apr", 4],
    ["april", 4],
    ["may", 5],
    ["jun", 6],
    ["june", 6],
    ["jul", 7],
    ["july", 7],
    ["aug", 8],
    ["august", 8],
    ["sep", 9],
    ["september", 9],
    ["oct", 10],
    ["october", 10],
    ["nov", 11],
    ["november", 11],
    ["dec", 12],
    ["december", 12],
  ]).get(value.toLocaleLowerCase("en-US"));
}

function normalizeCutoff(value: string | undefined): string | null {
  if (value === undefined) return null;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/u.exec(
      value,
    );
  if (!match) {
    throw namedError("MemoryEvidenceTemporalCutoffInvalid");
  }
  const timestamp = Date.parse(value);
  const canonical = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${(match[7] ?? "0").padEnd(3, "0")}Z`;
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString() !== canonical
  ) {
    throw namedError("MemoryEvidenceTemporalCutoffInvalid");
  }
  return new Date(timestamp).toISOString();
}

function boundedQuery(query: string): string {
  const value = query.trim().replace(/\s+/gu, " ");
  if (!value || value.length > 512) {
    throw namedError("MemoryEvidenceTemporalConstraintQueryInvalid");
  }
  return value;
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}
