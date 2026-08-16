export const LOOP_V2_SCHEMA_VERSION = 2 as const;

export type LoopKernelVersion = "v1" | "v2-shadow" | "v2";

export interface LoopV2Envelope {
  readonly schemaVersion: typeof LOOP_V2_SCHEMA_VERSION;
  readonly runId: string;
  readonly seq: number;
  readonly ts: number;
  readonly event: LoopV2Event;
}

export type LoopV2Event =
  | {
      readonly type: "task.started";
      readonly goal: string;
      readonly sourceHash: string;
    }
  | {
      readonly type: "provider.turn_stopped";
      readonly turn: number;
      readonly empty: boolean;
    }
  | {
      readonly type: "evidence.observed";
      readonly observation: EvidenceObservation;
    }
  | {
      readonly type: "criterion.upserted";
      readonly criterion: SemanticCriterionV2;
    }
  | {
      readonly type: "phase.changed";
      readonly phase: LoopPhaseV2;
    }
  | {
      readonly type: "hypothesis.upserted";
      readonly hypothesis: HypothesisRecordV2;
    }
  | {
      readonly type: "risk.upserted";
      readonly risk: RiskRecordV2;
    }
  | {
      readonly type: "invariant.upserted";
      readonly invariant: BehavioralInvariantV2;
    }
  | {
      readonly type: "change_surface.upserted";
      readonly changeSurface: ChangeSurfaceRecordV2;
    }
  | {
      readonly type: "next_action.updated";
      readonly nextAction?: NextActionV2;
    }
  | {
      readonly type: "mutation.recorded";
      readonly mutation: MutationJournalEntryV2;
    }
  | {
      readonly type: "verification.recorded";
      readonly verification: VerificationRecordV2;
    }
  | {
      readonly type: "candidate.proposed";
      readonly candidate: CandidateRecordV2;
    }
  | {
      readonly type: "context.compacted";
      readonly summarizedSeqThrough: number;
      readonly artifactRefs: readonly string[];
    };

export type EvidenceObservation =
  | ReadEvidenceObservation
  | SearchEvidenceObservation
  | DiagnosticEvidenceObservation;

export interface ReadEvidenceObservation {
  readonly kind: "read";
  readonly path: string;
  /** Zero-based, inclusive line offset. */
  readonly start: number;
  /** Zero-based, exclusive line offset. */
  readonly endExclusive: number;
  readonly contentHash: string;
  /** Product/source revision at which the content was observed. */
  readonly repositoryRevision: string;
  readonly artifactRef?: string;
}

export interface SearchEvidenceObservation {
  readonly kind: "search";
  readonly root: string;
  readonly query: string;
  readonly options?: Readonly<Record<string, unknown>>;
  readonly resultHash: string;
  readonly repositoryRevision: string;
  readonly artifactRef?: string;
}

export interface DiagnosticEvidenceObservation {
  readonly kind: "diagnostic";
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly outcomeSignature: string;
  readonly repositoryRevision: string;
  readonly artifactRef?: string;
}

export interface SemanticCriterionV2 {
  readonly id: string;
  readonly text: string;
  readonly observable: string;
  readonly source: "user_explicit" | "repository_contract" | "external_test_id";
  readonly authority: "agent" | "external";
  readonly status: "pending" | "satisfied" | "blocked" | "superseded";
  readonly evidenceRefs: readonly string[];
  readonly mutationRevision: number;
}

export type LoopPhaseV2 =
  | "discover"
  | "hypothesize"
  | "implement"
  | "verify"
  | "repair"
  | "candidate";

export interface HypothesisRecordV2 {
  readonly id: string;
  readonly statement: string;
  readonly status: "candidate" | "supported" | "rejected" | "superseded";
  readonly supports: readonly string[];
  readonly contradicts: readonly string[];
  readonly falsifier?: string;
  readonly proposedAtSeq: number;
  readonly closedAtSeq?: number;
}

export interface RiskRecordV2 {
  readonly id: string;
  readonly statement: string;
  readonly severity: "blocking" | "warning";
  readonly status: "open" | "resolved" | "accepted";
  readonly evidenceRefs: readonly string[];
}

export interface BehavioralInvariantV2 {
  readonly id: string;
  readonly text: string;
  readonly source: "user_explicit" | "repository_contract";
  readonly authority: "agent" | "external";
  readonly status: "active" | "satisfied" | "superseded";
  readonly evidenceRefs: readonly string[];
  readonly mutationRevision: number;
}

export interface ChangeSurfaceRecordV2 {
  readonly id: string;
  readonly path: string;
  readonly symbol?: string;
  readonly visibility: "public" | "internal" | "unknown";
  readonly observables: readonly string[];
  readonly criterionIds: readonly string[];
  readonly mutationRevision: number;
}

export interface NextActionV2 {
  readonly intent: string;
  readonly closesEvidenceGap?: string;
  readonly falsifiesHypothesis?: string;
}

export interface MutationJournalEntryV2 {
  readonly seq: number;
  readonly callId: string;
  readonly mutationRevision: number;
  readonly paths: readonly string[];
  readonly beforeHashes: Readonly<Record<string, string | null>>;
  readonly afterHashes: Readonly<Record<string, string | null>>;
  readonly beforeContentRefs: Readonly<Record<string, string | null>>;
  readonly afterContentRefs: Readonly<Record<string, string | null>>;
  readonly patch: string;
  readonly workspaceEffect: "product" | "test" | "control" | "unknown";
}

export interface VerificationRecordV2 {
  readonly id: string;
  readonly runner: "pytest" | "unittest" | "bun_test" | "npm_test" | "custom";
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly scope: readonly string[];
  readonly mutationRevision: number;
  readonly outcome: "passed" | "code_failed" | "harness_failed";
  readonly exitCode?: number;
  readonly assertions?: Readonly<{
    readonly passed?: number;
    readonly failed?: number;
    readonly total?: number;
  }>;
  readonly failureClass?: string;
  readonly outputArtifactRef: string;
  readonly authoritative: boolean;
}

export interface CandidateRecordV2 {
  readonly id: string;
  readonly mutationRevision: number;
  readonly candidateInputHash: string;
  readonly proposedAtSeq: number;
  /** Migration provenance; natural_stop_adapter is never explicit intent. */
  readonly source?: "legacy_final_answer" | "natural_stop_adapter";
}

export interface EvidenceRecordV2 {
  readonly id: string;
  readonly fingerprint: string;
  readonly observation: EvidenceObservation;
  readonly firstObservedSeq: number;
  readonly lastObservedSeq: number;
  readonly observationCount: number;
}

export interface ReadCoverageV2 {
  readonly key: string;
  readonly path: string;
  readonly contentHash: string;
  readonly repositoryRevision: string;
  readonly intervals: readonly Readonly<{
    readonly start: number;
    readonly endExclusive: number;
  }>[];
}

export interface ProgressDeltaV2 {
  readonly evidenceAdded: readonly string[];
  readonly hypothesesChanged: readonly string[];
  readonly criteriaChanged: readonly string[];
  readonly mutationsAdded: readonly string[];
  readonly verificationChanged: readonly string[];
  readonly risksChanged: readonly string[];
  readonly userStateChanged: boolean;
  readonly meaningful: boolean;
}

export interface PolicyAdviceV2 {
  readonly kind:
    | "repeat_observed"
    | "evidence_gap"
    | "hypothesis_stale"
    | "verification_due"
    | "candidate_ready"
    | "cost_warning";
  readonly priority: "info" | "warning" | "urgent";
  readonly evidenceRefs: readonly string[];
  readonly message: string;
}

export interface ProgressAdvisorActionV2 {
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly repeatTracking: "tracked" | "transparent";
}

export interface ProgressAdvisorCycleV2 {
  readonly cycle: number;
  readonly projectedThroughSeq: number;
  readonly actions: readonly ProgressAdvisorActionV2[];
  readonly deltas: readonly ProgressDeltaV2[];
}

export interface ProgressAdvisorStateV2 {
  readonly policyVersion: string;
  readonly runId: string;
  readonly lastCycle: number;
  readonly consecutiveNoDeltaCycles: number;
  readonly repeat?: Readonly<{
    readonly key: string;
    readonly tool: string;
    readonly count: number;
  }>;
}

export interface WorkingDecisionStateV2 {
  readonly schemaVersion: typeof LOOP_V2_SCHEMA_VERSION;
  readonly runId: string;
  readonly lastSeq: number;
  readonly goal?: {
    readonly verbatim: string;
    readonly sourceHash: string;
  };
  readonly phase: LoopPhaseV2;
  readonly criteria: Readonly<Record<string, SemanticCriterionV2>>;
  readonly hypotheses: Readonly<Record<string, HypothesisRecordV2>>;
  readonly evidence: Readonly<Record<string, EvidenceRecordV2>>;
  readonly readCoverage: Readonly<Record<string, ReadCoverageV2>>;
  readonly invariants: Readonly<Record<string, BehavioralInvariantV2>>;
  readonly changeSurface: Readonly<Record<string, ChangeSurfaceRecordV2>>;
  readonly risks: Readonly<Record<string, RiskRecordV2>>;
  readonly mutations: Readonly<Record<string, MutationJournalEntryV2>>;
  readonly verification: Readonly<Record<string, VerificationRecordV2>>;
  readonly currentMutationRevision: number;
  readonly currentCandidate?: CandidateRecordV2;
  readonly nextAction?: NextActionV2;
  readonly contextCompactions: number;
  readonly contextArtifactRefs: readonly string[];
}

export interface LoopV2ProjectionStep {
  readonly seq: number;
  readonly eventType: LoopV2Event["type"];
  readonly delta: ProgressDeltaV2;
  readonly decisionStateHash: string;
}

export interface LoopV2Checkpoint {
  readonly schemaVersion: typeof LOOP_V2_SCHEMA_VERSION;
  readonly runId: string;
  readonly lastSeq: number;
  readonly state: WorkingDecisionStateV2;
  readonly projectionHash: string;
}

export function resolveLoopKernelVersion(
  env: Readonly<Record<string, string | undefined>> = process.env,
): LoopKernelVersion {
  const raw = env.PAW_LOOP_KERNEL_VERSION?.trim();
  if (!raw) return "v1";
  if (raw === "v1" || raw === "v2-shadow" || raw === "v2") return raw;
  throw new Error(`Unsupported PAW_LOOP_KERNEL_VERSION: ${raw}`);
}

/**
 * Validate an untrusted JSON value before it reaches the projector.  The
 * projector is intentionally typed, while durable event logs are not.
 */
export function assertLoopV2Envelope(
  value: unknown,
): asserts value is LoopV2Envelope {
  assertRecord(value, "loop v2 envelope");
  assertExact(value.schemaVersion, LOOP_V2_SCHEMA_VERSION, "schemaVersion");
  assertNonEmptyString(value.runId, "runId");
  assertSafeInteger(value.seq, "seq", 1);
  assertFiniteNumber(value.ts, "ts");
  assertRecord(value.event, "event");
  assertNonEmptyString(value.event.type, "event.type");

  switch (value.event.type) {
    case "task.started":
      assertNonEmptyString(value.event.goal, "event.goal");
      assertNonEmptyString(value.event.sourceHash, "event.sourceHash");
      return;
    case "provider.turn_stopped":
      assertSafeInteger(value.event.turn, "event.turn", 1);
      assertBoolean(value.event.empty, "event.empty");
      return;
    case "evidence.observed":
      assertEvidenceObservation(value.event.observation);
      return;
    case "criterion.upserted":
      assertCriterion(value.event.criterion);
      return;
    case "phase.changed":
      assertOneOf(value.event.phase, LOOP_PHASES, "event.phase");
      return;
    case "hypothesis.upserted":
      assertHypothesis(value.event.hypothesis);
      return;
    case "risk.upserted":
      assertRisk(value.event.risk);
      return;
    case "invariant.upserted":
      assertInvariant(value.event.invariant);
      return;
    case "change_surface.upserted":
      assertChangeSurface(value.event.changeSurface);
      return;
    case "next_action.updated":
      if (value.event.nextAction !== undefined) {
        assertNextAction(value.event.nextAction);
      }
      return;
    case "mutation.recorded":
      assertMutation(value.event.mutation);
      return;
    case "verification.recorded":
      assertVerification(value.event.verification);
      return;
    case "candidate.proposed":
      assertCandidate(value.event.candidate);
      return;
    case "context.compacted":
      assertSafeInteger(
        value.event.summarizedSeqThrough,
        "event.summarizedSeqThrough",
        0,
      );
      assertStringArray(value.event.artifactRefs, "event.artifactRefs");
      return;
    default:
      throw new Error(`Unsupported loop v2 event type: ${value.event.type}`);
  }
}

const LOOP_PHASES: readonly LoopPhaseV2[] = [
  "discover",
  "hypothesize",
  "implement",
  "verify",
  "repair",
  "candidate",
];

function assertCriterion(value: unknown): void {
  const label = "event.criterion";
  assertIdRecord(value, label);
  assertNonEmptyString(value.text, `${label}.text`);
  assertNonEmptyString(value.observable, `${label}.observable`);
  assertOneOf(
    value.source,
    ["user_explicit", "repository_contract", "external_test_id"],
    `${label}.source`,
  );
  assertOneOf(value.authority, ["agent", "external"], `${label}.authority`);
  assertOneOf(
    value.status,
    ["pending", "satisfied", "blocked", "superseded"],
    `${label}.status`,
  );
  assertStringArray(value.evidenceRefs, `${label}.evidenceRefs`);
  assertSafeInteger(value.mutationRevision, `${label}.mutationRevision`, 0);
}

function assertHypothesis(value: unknown): void {
  const label = "event.hypothesis";
  assertIdRecord(value, label);
  assertNonEmptyString(value.statement, `${label}.statement`);
  assertOneOf(
    value.status,
    ["candidate", "supported", "rejected", "superseded"],
    `${label}.status`,
  );
  assertStringArray(value.supports, `${label}.supports`);
  assertStringArray(value.contradicts, `${label}.contradicts`);
  assertOptionalString(value.falsifier, `${label}.falsifier`);
  assertSafeInteger(value.proposedAtSeq, `${label}.proposedAtSeq`, 1);
  if (value.closedAtSeq !== undefined) {
    assertSafeInteger(value.closedAtSeq, `${label}.closedAtSeq`, 1);
  }
}

function assertRisk(value: unknown): void {
  const label = "event.risk";
  assertIdRecord(value, label);
  assertNonEmptyString(value.statement, `${label}.statement`);
  assertOneOf(value.severity, ["blocking", "warning"], `${label}.severity`);
  assertOneOf(
    value.status,
    ["open", "resolved", "accepted"],
    `${label}.status`,
  );
  assertStringArray(value.evidenceRefs, `${label}.evidenceRefs`);
}

function assertInvariant(value: unknown): void {
  const label = "event.invariant";
  assertIdRecord(value, label);
  assertNonEmptyString(value.text, `${label}.text`);
  assertOneOf(
    value.source,
    ["user_explicit", "repository_contract"],
    `${label}.source`,
  );
  assertOneOf(value.authority, ["agent", "external"], `${label}.authority`);
  assertOneOf(
    value.status,
    ["active", "satisfied", "superseded"],
    `${label}.status`,
  );
  assertStringArray(value.evidenceRefs, `${label}.evidenceRefs`);
  assertSafeInteger(value.mutationRevision, `${label}.mutationRevision`, 0);
}

function assertChangeSurface(value: unknown): void {
  const label = "event.changeSurface";
  assertIdRecord(value, label);
  assertNonEmptyString(value.path, `${label}.path`);
  assertOptionalString(value.symbol, `${label}.symbol`);
  assertOneOf(
    value.visibility,
    ["public", "internal", "unknown"],
    `${label}.visibility`,
  );
  assertStringArray(value.observables, `${label}.observables`);
  assertStringArray(value.criterionIds, `${label}.criterionIds`);
  assertSafeInteger(value.mutationRevision, `${label}.mutationRevision`, 0);
}

function assertNextAction(value: unknown): void {
  const label = "event.nextAction";
  assertRecord(value, label);
  assertNonEmptyString(value.intent, `${label}.intent`);
  assertOptionalString(value.closesEvidenceGap, `${label}.closesEvidenceGap`);
  assertOptionalString(
    value.falsifiesHypothesis,
    `${label}.falsifiesHypothesis`,
  );
}

function assertMutation(value: unknown): void {
  const label = "event.mutation";
  assertRecord(value, label);
  assertSafeInteger(value.seq, `${label}.seq`, 1);
  assertNonEmptyString(value.callId, `${label}.callId`);
  assertSafeInteger(value.mutationRevision, `${label}.mutationRevision`, 1);
  assertStringArray(value.paths, `${label}.paths`);
  assertHashRecord(value.beforeHashes, `${label}.beforeHashes`);
  assertHashRecord(value.afterHashes, `${label}.afterHashes`);
  assertHashRecord(value.beforeContentRefs, `${label}.beforeContentRefs`);
  assertHashRecord(value.afterContentRefs, `${label}.afterContentRefs`);
  assertNonEmptyString(value.patch, `${label}.patch`);
  assertOneOf(
    value.workspaceEffect,
    ["product", "test", "control", "unknown"],
    `${label}.workspaceEffect`,
  );
}

function assertVerification(value: unknown): void {
  const label = "event.verification";
  assertIdRecord(value, label);
  assertOneOf(
    value.runner,
    ["pytest", "unittest", "bun_test", "npm_test", "custom"],
    `${label}.runner`,
  );
  assertStringArray(value.argv, `${label}.argv`);
  assertNonEmptyString(value.cwd, `${label}.cwd`);
  assertStringArray(value.scope, `${label}.scope`);
  assertSafeInteger(value.mutationRevision, `${label}.mutationRevision`, 0);
  assertOneOf(
    value.outcome,
    ["passed", "code_failed", "harness_failed"],
    `${label}.outcome`,
  );
  if (value.exitCode !== undefined) {
    assertSafeInteger(value.exitCode, `${label}.exitCode`, 0);
  }
  if (value.assertions !== undefined) {
    assertRecord(value.assertions, `${label}.assertions`);
    for (const key of ["passed", "failed", "total"] as const) {
      if (value.assertions[key] !== undefined) {
        assertSafeInteger(
          value.assertions[key],
          `${label}.assertions.${key}`,
          0,
        );
      }
    }
  }
  assertOptionalString(value.failureClass, `${label}.failureClass`);
  assertNonEmptyString(value.outputArtifactRef, `${label}.outputArtifactRef`);
  assertBoolean(value.authoritative, `${label}.authoritative`);
}

function assertCandidate(value: unknown): void {
  const label = "event.candidate";
  assertIdRecord(value, label);
  assertSafeInteger(value.mutationRevision, `${label}.mutationRevision`, 0);
  assertNonEmptyString(value.candidateInputHash, `${label}.candidateInputHash`);
  assertSafeInteger(value.proposedAtSeq, `${label}.proposedAtSeq`, 1);
  if (value.source !== undefined) {
    assertOneOf(
      value.source,
      ["legacy_final_answer", "natural_stop_adapter"],
      `${label}.source`,
    );
  }
}

export function parseLoopV2EventLog(
  serialized: string,
): readonly LoopV2Envelope[] {
  const trimmed = serialized.trim();
  if (!trimmed) return [];
  let values: unknown[];
  if (trimmed.startsWith("[")) {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) {
      throw new Error("Loop v2 JSON event log must be an array");
    }
    values = parsed;
  } else {
    values = trimmed.split(/\r?\n/).map((line, index) => {
      try {
        return JSON.parse(line) as unknown;
      } catch (error) {
        throw new Error(`Invalid loop v2 JSONL at line ${index + 1}`, {
          cause: error,
        });
      }
    });
  }
  const validated: LoopV2Envelope[] = [];
  for (const value of values) {
    assertLoopV2Envelope(value);
    validated.push(value);
  }
  return validated;
}

function assertEvidenceObservation(value: unknown): void {
  assertRecord(value, "event.observation");
  assertNonEmptyString(value.kind, "event.observation.kind");
  assertNonEmptyString(
    value.repositoryRevision,
    "event.observation.repositoryRevision",
  );
  assertOptionalString(value.artifactRef, "event.observation.artifactRef");
  switch (value.kind) {
    case "read":
      assertNonEmptyString(value.path, "event.observation.path");
      assertSafeInteger(value.start, "event.observation.start", 0);
      assertSafeInteger(
        value.endExclusive,
        "event.observation.endExclusive",
        1,
      );
      if (value.endExclusive <= value.start) {
        throw new Error("event.observation.endExclusive must exceed start");
      }
      assertNonEmptyString(value.contentHash, "event.observation.contentHash");
      return;
    case "search":
      assertNonEmptyString(value.root, "event.observation.root");
      assertNonEmptyString(value.query, "event.observation.query");
      assertNonEmptyString(value.resultHash, "event.observation.resultHash");
      if (value.options !== undefined)
        assertRecord(value.options, "event.observation.options");
      return;
    case "diagnostic":
      assertStringArray(value.argv, "event.observation.argv");
      assertNonEmptyString(value.cwd, "event.observation.cwd");
      assertNonEmptyString(
        value.outcomeSignature,
        "event.observation.outcomeSignature",
      );
      return;
    default:
      throw new Error(`Unsupported evidence observation kind: ${value.kind}`);
  }
}

function assertIdRecord(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  assertRecord(value, label);
  assertNonEmptyString(value.id, `${label}.id`);
}

function assertOptionalString(value: unknown, label: string): void {
  if (value !== undefined) assertNonEmptyString(value, label);
}

function assertBoolean(
  value: unknown,
  label: string,
): asserts value is boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
}

function assertOneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): asserts value is T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`${label} must be one of: ${allowed.join(", ")}`);
  }
}

function assertRecord(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function assertNonEmptyString(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function assertSafeInteger(
  value: unknown,
  label: string,
  minimum: number,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(`${label} must be a safe integer >= ${minimum}`);
  }
}

function assertFiniteNumber(
  value: unknown,
  label: string,
): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
}

function assertExact<T>(
  value: unknown,
  expected: T,
  label: string,
): asserts value is T {
  if (value !== expected)
    throw new Error(`${label} must equal ${String(expected)}`);
}

function assertStringArray(
  value: unknown,
  label: string,
): asserts value is string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
}

function assertHashRecord(value: unknown, label: string): void {
  assertRecord(value, label);
  for (const [path, hash] of Object.entries(value)) {
    assertNonEmptyString(path, `${label} key`);
    if (hash !== null) assertNonEmptyString(hash, `${label}.${path}`);
  }
}
