import { hashCanonicalJsonV1 } from "./canonical.js";

/**
 * A separate, source-locked temporal lane.  It deliberately has no dependency
 * on notebooks, evidence ranking, state binding, or reader projection: a
 * temporal certificate may be added by an adapter, but it can never alter the
 * evidence packet that produced the baseline answer.
 */
export const PAW_MEMORY_TEMPORAL_EVENT_LEDGER_POLICY_V1 =
  "paw.memory-temporal-event-ledger.v1:source-locked-certificate-only" as const;

export type MemoryTemporalEventLedgerRejectedReasonV1 =
  | "invalid_input"
  | "source_lock_mismatch"
  | "candidate_set_mismatch"
  | "invalid_evidence_address"
  | "operator_operand_mismatch"
  | "time_basis_unavailable"
  | "reference_time_invalid"
  | "end_before_start";

export type MemoryTemporalEventLedgerOperatorV1 =
  | "duration_between"
  | "elapsed_since"
  | "order_events"
  | "first_event"
  | "latest_event";

export type MemoryTemporalEventLedgerUnitV1 = "day" | "week" | "month" | "year";

export interface MemoryTemporalEventTimeIntervalV1 {
  readonly lower: string;
  readonly upper: string;
  readonly precision: "instant" | "day" | "year";
}

/**
 * The product default is semantic event time.  A source-observation timeline
 * is explicitly opt-in for datasets or products where session chronology is
 * itself the task's declared time basis; it is never silently treated as event
 * time.
 */
export type MemoryTemporalEventLedgerTimePolicyV1 =
  | Readonly<{ kind: "semantic_event_time" }>
  | Readonly<{
      kind: "source_observation_timeline";
      timelinePolicyRevision: string;
    }>;

export interface MemoryTemporalEventLedgerCandidateV1 {
  readonly evidenceRef: string;
  readonly sourceId: string;
  /** Untrusted source text, retained only to validate selected exact spans. */
  readonly content: string;
  readonly observedAt?: string;
  readonly episodeOrder?: number;
  readonly turnOrder?: number;
  readonly eventTimeInterval?: MemoryTemporalEventTimeIntervalV1;
}

export interface MemoryTemporalEventLedgerEvidenceAddressV1 {
  readonly evidenceRef: string;
  readonly sourceId: string;
  readonly span: Readonly<{
    readonly start: number;
    readonly end: number;
    readonly text: string;
  }>;
}

/**
 * This is model/selecter output, not a certificate.  The host verifies every
 * address, clock choice, and calculation before exposing its derived result.
 */
export interface MemoryTemporalEventLedgerProposalV1 {
  readonly operator: MemoryTemporalEventLedgerOperatorV1;
  readonly operands: readonly MemoryTemporalEventLedgerEvidenceAddressV1[];
  readonly unit?: MemoryTemporalEventLedgerUnitV1;
}

export interface MemoryTemporalEventLedgerRequestV1 {
  readonly query: string;
  /** Host-owned query cutoff; every source candidate must predate it. */
  readonly queryTimeCutoff: string;
  readonly lockedSourceIds: readonly string[];
  readonly timePolicy: MemoryTemporalEventLedgerTimePolicyV1;
  readonly candidates: readonly MemoryTemporalEventLedgerCandidateV1[];
  readonly proposal: MemoryTemporalEventLedgerProposalV1;
}

export interface MemoryTemporalEventLedgerOperandCertificateV1 {
  readonly evidenceRef: string;
  readonly sourceId: string;
  readonly span: MemoryTemporalEventLedgerEvidenceAddressV1["span"];
  readonly candidateRevision: string;
  readonly observedAt?: string;
  readonly episodeOrder?: number;
  readonly turnOrder?: number;
  readonly eventTimeInterval?: MemoryTemporalEventTimeIntervalV1;
}

export interface MemoryTemporalEventLedgerCertificateV1 {
  readonly policyVersion: typeof PAW_MEMORY_TEMPORAL_EVENT_LEDGER_POLICY_V1;
  readonly queryRevision: string;
  readonly queryTimeCutoff: string;
  readonly sourceLockRevision: string;
  readonly candidateSetRevision: string;
  readonly timePolicy: MemoryTemporalEventLedgerTimePolicyV1;
  readonly operator: MemoryTemporalEventLedgerOperatorV1;
  readonly operands: readonly MemoryTemporalEventLedgerOperandCertificateV1[];
  readonly derived: Readonly<{
    readonly kind: "duration" | "ordering";
    readonly unit?: MemoryTemporalEventLedgerUnitV1;
    readonly value?: number;
    readonly referenceTime?: string;
    readonly orderedEvidenceRefs?: readonly string[];
    readonly selectedEvidenceRef?: string;
  }>;
  readonly certificateRevision: string;
}

export type MemoryTemporalEventLedgerBuildResultV1 =
  | Readonly<{
      status: "certified";
      certificate: MemoryTemporalEventLedgerCertificateV1;
    }>
  | Readonly<{
      status: "rejected";
      rejectedReason: MemoryTemporalEventLedgerRejectedReasonV1;
    }>;

/**
 * Compiles a deterministic certificate without mutating or reading the shared
 * evidence packet.  Rejection is deliberate: callers must append nothing to a
 * reader prompt when this function does not return `certified`.
 */
export function buildMemoryTemporalEventLedgerCertificateV1(
  input: MemoryTemporalEventLedgerRequestV1,
): MemoryTemporalEventLedgerBuildResultV1 {
  try {
    return Object.freeze({
      status: "certified" as const,
      certificate: compileCertificate(input),
    });
  } catch (error) {
    return Object.freeze({
      status: "rejected" as const,
      rejectedReason: rejectionReason(error),
    });
  }
}

/** Rebuilds the host-owned certificate from immutable request data. */
export function validateMemoryTemporalEventLedgerCertificateV1(input: {
  readonly request: MemoryTemporalEventLedgerRequestV1;
  readonly certificate: MemoryTemporalEventLedgerCertificateV1;
}): boolean {
  const result = buildMemoryTemporalEventLedgerCertificateV1(input.request);
  return (
    result.status === "certified" && same(result.certificate, input.certificate)
  );
}

function compileCertificate(
  input: MemoryTemporalEventLedgerRequestV1,
): MemoryTemporalEventLedgerCertificateV1 {
  if (
    !input.query.trim() ||
    !isTimestamp(input.queryTimeCutoff) ||
    input.lockedSourceIds.length === 0
  ) {
    reject("invalid_input");
  }
  if (
    new Set(input.lockedSourceIds).size !== input.lockedSourceIds.length ||
    input.lockedSourceIds.some((sourceId) => !sourceId.trim())
  ) {
    reject("source_lock_mismatch");
  }
  if (
    !input.timePolicy.kind ||
    (input.timePolicy.kind === "source_observation_timeline" &&
      !input.timePolicy.timelinePolicyRevision.trim())
  ) {
    reject("invalid_input");
  }
  const sourceLockRevision = hashCanonicalJsonV1({
    schemaVersion: "paw.memory-temporal-event-ledger-source-lock.v1",
    lockedSourceIds: Object.freeze([...input.lockedSourceIds]),
  } as never);
  const candidateByEvidenceRef = validateCandidates(
    input.candidates,
    new Set(input.lockedSourceIds),
    input.queryTimeCutoff,
  );
  const candidateSetRevision = compileCandidateSetRevision(input.candidates);
  const operands = compileOperands(input, candidateByEvidenceRef);
  validateOperator(input.proposal, operands.length);
  const derived = compileDerived(input, operands);
  const identity = {
    policyVersion: PAW_MEMORY_TEMPORAL_EVENT_LEDGER_POLICY_V1,
    queryRevision: hashCanonicalJsonV1({
      schemaVersion: "paw.memory-temporal-event-ledger-query.v1",
      query: input.query,
    } as never),
    queryTimeCutoff: new Date(input.queryTimeCutoff).toISOString(),
    sourceLockRevision,
    candidateSetRevision,
    timePolicy: input.timePolicy,
    operator: input.proposal.operator,
    operands,
    derived,
  };
  return Object.freeze({
    ...identity,
    certificateRevision: hashCanonicalJsonV1(identity as never),
  });
}

function validateCandidates(
  candidates: readonly MemoryTemporalEventLedgerCandidateV1[],
  lockedSourceIds: ReadonlySet<string>,
  queryTimeCutoff: string,
): ReadonlyMap<string, MemoryTemporalEventLedgerCandidateV1> {
  if (candidates.length === 0) reject("candidate_set_mismatch");
  const byEvidenceRef = new Map<string, MemoryTemporalEventLedgerCandidateV1>();
  for (const candidate of candidates) {
    if (
      !candidate.evidenceRef.trim() ||
      !candidate.sourceId.trim() ||
      !lockedSourceIds.has(candidate.sourceId) ||
      byEvidenceRef.has(candidate.evidenceRef)
    ) {
      reject("candidate_set_mismatch");
    }
    if (
      candidate.observedAt !== undefined &&
      (!isTimestamp(candidate.observedAt) ||
        Date.parse(candidate.observedAt) > Date.parse(queryTimeCutoff))
    ) {
      reject("candidate_set_mismatch");
    }
    if (
      candidate.eventTimeInterval !== undefined &&
      !validInterval(candidate.eventTimeInterval)
    ) {
      reject("candidate_set_mismatch");
    }
    if (
      (candidate.episodeOrder !== undefined &&
        !Number.isSafeInteger(candidate.episodeOrder)) ||
      (candidate.turnOrder !== undefined &&
        !Number.isSafeInteger(candidate.turnOrder))
    ) {
      reject("candidate_set_mismatch");
    }
    byEvidenceRef.set(candidate.evidenceRef, candidate);
  }
  return byEvidenceRef;
}

function compileCandidateSetRevision(
  candidates: readonly MemoryTemporalEventLedgerCandidateV1[],
): string {
  return hashCanonicalJsonV1({
    schemaVersion: "paw.memory-temporal-event-ledger-candidates.v1",
    candidates: [...candidates]
      .map((candidate) => ({
        ...candidate,
        contentRevision: hashCanonicalJsonV1({
          schemaVersion: "paw.memory-temporal-event-ledger-content.v1",
          content: candidate.content,
        } as never),
      }))
      .sort((left, right) => left.evidenceRef.localeCompare(right.evidenceRef)),
  } as never);
}

function compileOperands(
  input: MemoryTemporalEventLedgerRequestV1,
  candidateByEvidenceRef: ReadonlyMap<
    string,
    MemoryTemporalEventLedgerCandidateV1
  >,
): readonly MemoryTemporalEventLedgerOperandCertificateV1[] {
  if (input.proposal.operands.length === 0) reject("operator_operand_mismatch");
  const seen = new Set<string>();
  return Object.freeze(
    input.proposal.operands.map((address) => {
      const candidate = candidateByEvidenceRef.get(address.evidenceRef);
      if (
        !candidate ||
        candidate.sourceId !== address.sourceId ||
        seen.has(address.evidenceRef) ||
        !validAddress(address, candidate)
      ) {
        reject("invalid_evidence_address");
      }
      seen.add(address.evidenceRef);
      const identity = {
        evidenceRef: candidate.evidenceRef,
        sourceId: candidate.sourceId,
        content: candidate.content,
        observedAt: candidate.observedAt ?? null,
        episodeOrder: candidate.episodeOrder ?? null,
        turnOrder: candidate.turnOrder ?? null,
        eventTimeInterval: candidate.eventTimeInterval ?? null,
      };
      return Object.freeze({
        evidenceRef: candidate.evidenceRef,
        sourceId: candidate.sourceId,
        span: Object.freeze({ ...address.span }),
        candidateRevision: hashCanonicalJsonV1(identity as never),
        ...(candidate.observedAt === undefined
          ? {}
          : { observedAt: candidate.observedAt }),
        ...(candidate.episodeOrder === undefined
          ? {}
          : { episodeOrder: candidate.episodeOrder }),
        ...(candidate.turnOrder === undefined
          ? {}
          : { turnOrder: candidate.turnOrder }),
        ...(candidate.eventTimeInterval === undefined
          ? {}
          : { eventTimeInterval: candidate.eventTimeInterval }),
      });
    }),
  );
}

function validAddress(
  address: MemoryTemporalEventLedgerEvidenceAddressV1,
  candidate: MemoryTemporalEventLedgerCandidateV1,
): boolean {
  const { start, end, text } = address.span;
  return (
    Number.isSafeInteger(start) &&
    Number.isSafeInteger(end) &&
    start >= 0 &&
    end > start &&
    end <= candidate.content.length &&
    text.trim().length > 0 &&
    candidate.content.slice(start, end) === text
  );
}

function validateOperator(
  proposal: MemoryTemporalEventLedgerProposalV1,
  operandCount: number,
): void {
  const requiresUnit = new Set<MemoryTemporalEventLedgerOperatorV1>([
    "duration_between",
    "elapsed_since",
  ]);
  if (
    (proposal.operator === "duration_between" && operandCount !== 2) ||
    (proposal.operator === "elapsed_since" && operandCount !== 1) ||
    (new Set(["order_events", "first_event", "latest_event"]).has(
      proposal.operator,
    ) &&
      operandCount < 2) ||
    (requiresUnit.has(proposal.operator) && proposal.unit === undefined) ||
    (!requiresUnit.has(proposal.operator) && proposal.unit !== undefined)
  ) {
    reject("operator_operand_mismatch");
  }
}

function compileDerived(
  input: MemoryTemporalEventLedgerRequestV1,
  operands: readonly MemoryTemporalEventLedgerOperandCertificateV1[],
): MemoryTemporalEventLedgerCertificateV1["derived"] {
  const intervals = operands.map((operand) =>
    intervalFor(operand, input.timePolicy),
  );
  if (intervals.some((interval) => interval === undefined)) {
    reject("time_basis_unavailable");
  }
  const resolvedIntervals =
    intervals as readonly MemoryTemporalEventTimeIntervalV1[];
  if (
    input.proposal.operator === "duration_between" ||
    input.proposal.operator === "elapsed_since"
  ) {
    const start = resolvedIntervals[0];
    const end =
      input.proposal.operator === "elapsed_since"
        ? referenceInterval(input.queryTimeCutoff)
        : resolvedIntervals[1];
    if (!start || !end) reject("reference_time_invalid");
    if (Date.parse(end.lower) <= Date.parse(start.lower)) {
      reject("end_before_start");
    }
    return Object.freeze({
      kind: "duration" as const,
      unit: input.proposal.unit,
      value: durationValue(
        start.lower,
        end.lower,
        input.proposal.unit as MemoryTemporalEventLedgerUnitV1,
      ),
      ...(input.proposal.operator === "elapsed_since"
        ? { referenceTime: end.lower }
        : {}),
    });
  }
  const ordered = [...operands]
    .map((operand, index) => ({
      operand,
      interval: resolvedIntervals[index] as MemoryTemporalEventTimeIntervalV1,
    }))
    .sort(compareOperandTimeline);
  const selected =
    input.proposal.operator === "latest_event"
      ? ordered.at(-1)
      : input.proposal.operator === "first_event"
        ? ordered[0]
        : undefined;
  return Object.freeze({
    kind: "ordering" as const,
    orderedEvidenceRefs: Object.freeze(
      ordered.map((entry) => entry.operand.evidenceRef),
    ),
    ...(selected === undefined
      ? {}
      : { selectedEvidenceRef: selected.operand.evidenceRef }),
  });
}

function intervalFor(
  operand: MemoryTemporalEventLedgerOperandCertificateV1,
  policy: MemoryTemporalEventLedgerTimePolicyV1,
): MemoryTemporalEventTimeIntervalV1 | undefined {
  if (policy.kind === "semantic_event_time") {
    return operand.eventTimeInterval === undefined
      ? undefined
      : normalizeInterval(operand.eventTimeInterval);
  }
  if (
    operand.observedAt === undefined ||
    operand.episodeOrder === undefined ||
    operand.turnOrder === undefined
  ) {
    return undefined;
  }
  const lower = new Date(operand.observedAt).toISOString();
  return Object.freeze({
    lower,
    upper: new Date(Date.parse(lower) + 1).toISOString(),
    precision: "instant" as const,
  });
}

function referenceInterval(
  referenceTime: string,
): MemoryTemporalEventTimeIntervalV1 {
  if (!isTimestamp(referenceTime)) reject("reference_time_invalid");
  const lower = new Date(referenceTime).toISOString();
  return Object.freeze({
    lower,
    upper: new Date(Date.parse(lower) + 1).toISOString(),
    precision: "instant" as const,
  });
}

function durationValue(
  start: string,
  end: string,
  unit: MemoryTemporalEventLedgerUnitV1,
): number {
  const startDate = new Date(start);
  const endDate = new Date(end);
  const days = (endDate.getTime() - startDate.getTime()) / 86_400_000;
  if (unit === "day") return days;
  if (unit === "week") return days / 7;
  if (unit === "month") return completedCalendarMonths(startDate, endDate);
  return completedCalendarYears(startDate, endDate);
}

function completedCalendarMonths(start: Date, end: Date): number {
  let months =
    (end.getUTCFullYear() - start.getUTCFullYear()) * 12 +
    end.getUTCMonth() -
    start.getUTCMonth();
  if (end.getUTCDate() < start.getUTCDate()) months -= 1;
  return months;
}

function completedCalendarYears(start: Date, end: Date): number {
  let years = end.getUTCFullYear() - start.getUTCFullYear();
  if (
    end.getUTCMonth() < start.getUTCMonth() ||
    (end.getUTCMonth() === start.getUTCMonth() &&
      end.getUTCDate() < start.getUTCDate())
  ) {
    years -= 1;
  }
  return years;
}

function compareOperandTimeline(
  left: Readonly<{
    operand: MemoryTemporalEventLedgerOperandCertificateV1;
    interval: MemoryTemporalEventTimeIntervalV1;
  }>,
  right: Readonly<{
    operand: MemoryTemporalEventLedgerOperandCertificateV1;
    interval: MemoryTemporalEventTimeIntervalV1;
  }>,
): number {
  return (
    Date.parse(left.interval.lower) - Date.parse(right.interval.lower) ||
    (left.operand.episodeOrder ?? -1) - (right.operand.episodeOrder ?? -1) ||
    (left.operand.turnOrder ?? -1) - (right.operand.turnOrder ?? -1) ||
    left.operand.evidenceRef.localeCompare(right.operand.evidenceRef)
  );
}

function validInterval(interval: MemoryTemporalEventTimeIntervalV1): boolean {
  return (
    isTimestamp(interval.lower) &&
    isTimestamp(interval.upper) &&
    Date.parse(interval.upper) > Date.parse(interval.lower)
  );
}

function normalizeInterval(
  interval: MemoryTemporalEventTimeIntervalV1,
): MemoryTemporalEventTimeIntervalV1 {
  return Object.freeze({
    lower: new Date(interval.lower).toISOString(),
    upper: new Date(interval.upper).toISOString(),
    precision: interval.precision,
  });
}

function isTimestamp(value: string): boolean {
  return value.trim().length > 0 && Number.isFinite(Date.parse(value));
}

function reject(reason: MemoryTemporalEventLedgerRejectedReasonV1): never {
  const error = new Error(reason);
  error.name = `MemoryTemporalEventLedgerRejected:${reason}`;
  throw error;
}

function rejectionReason(
  error: unknown,
): MemoryTemporalEventLedgerRejectedReasonV1 {
  if (error instanceof Error) {
    const match = /^MemoryTemporalEventLedgerRejected:(.+)$/u.exec(error.name);
    if (match) return match[1] as MemoryTemporalEventLedgerRejectedReasonV1;
  }
  return "invalid_input";
}

function same(left: unknown, right: unknown): boolean {
  return (
    hashCanonicalJsonV1(left as never) === hashCanonicalJsonV1(right as never)
  );
}
