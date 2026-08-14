import { sha256Canonical } from "./canonical.js";
import {
  type BehavioralInvariantV2,
  type ChangeSurfaceRecordV2,
  LOOP_V2_SCHEMA_VERSION,
  type MutationJournalEntryV2,
  type RiskRecordV2,
  type SemanticCriterionV2,
  type VerificationRecordV2,
  type WorkingDecisionStateV2,
} from "./schema.js";

export interface CandidateSnapshotV2 {
  readonly path: string;
  readonly contentHash: string;
}

export interface CandidateArtifactEvidenceV2 {
  /** The journal can be replayed into the candidate patch without Git. */
  readonly reconstructible: boolean;
  /** Independent Git cross-check. Unavailable is not a semantic failure. */
  readonly crossCheck: "matched" | "unavailable" | "mismatch";
  readonly artifactRef?: string;
}

export interface CandidateMutationInputV2 {
  readonly seq: number;
  readonly callId: string;
  readonly mutationRevision: number;
  readonly paths: readonly string[];
  readonly beforeHashes: Readonly<Record<string, string | null>>;
  readonly afterHashes: Readonly<Record<string, string | null>>;
  readonly patchHash: string;
  readonly workspaceEffect: MutationJournalEntryV2["workspaceEffect"];
}

/**
 * The semantic candidate identity. It deliberately excludes proposed final
 * prose and the implementing model's hidden deliberation.
 */
export interface CandidateInputV2 {
  readonly schemaVersion: typeof LOOP_V2_SCHEMA_VERSION;
  readonly goalSourceHash: string;
  readonly mutationRevision: number;
  readonly criteria: readonly SemanticCriterionV2[];
  readonly invariants: readonly BehavioralInvariantV2[];
  readonly mutationJournal: readonly CandidateMutationInputV2[];
  readonly currentPatchHash: string;
  readonly changedPublicSurface: readonly ChangeSurfaceRecordV2[];
  readonly currentVerification: readonly VerificationRecordV2[];
  readonly unresolvedRisks: readonly RiskRecordV2[];
  readonly snapshotHashes: readonly CandidateSnapshotV2[];
}

export type CandidateReadinessGapCodeV2 =
  | "goal_missing"
  | "product_mutation_missing"
  | "journal_incomplete"
  | "artifact_unreconstructible"
  | "artifact_cross_check_mismatch"
  | "criterion_pending"
  | "criterion_stale"
  | "criterion_evidence_missing"
  | "criterion_evidence_unknown"
  | "criterion_blocked"
  | "verification_missing"
  | "verification_code_failed"
  | "verification_unavailable"
  | "blocking_risk";

export interface CandidateReadinessGapV2 {
  readonly code: CandidateReadinessGapCodeV2;
  readonly message: string;
  readonly criterionId?: string;
  readonly evidenceRefs?: readonly string[];
  readonly riskId?: string;
}

export interface CandidateReadinessPolicyV2 {
  readonly requireProductMutation?: boolean;
  readonly requireAuthoritativeVerification?: boolean;
}

export interface CandidateReadinessV2 {
  readonly disposition: "ready_for_review" | "needs_work" | "blocked";
  readonly readyForSemanticReview: boolean;
  readonly gaps: readonly CandidateReadinessGapV2[];
  /** External authority is never marked satisfied by the implementing model. */
  readonly pendingExternalCriterionIds: readonly string[];
  readonly currentAuthoritativeVerificationIds: readonly string[];
}

export interface SemanticReviewFindingV2 {
  readonly severity: "blocking" | "warning";
  readonly criterionId?: string;
  readonly invariantId?: string;
  readonly file?: string;
  readonly line?: number;
  readonly observedChange: string;
  readonly risk: string;
  readonly minimalAlternative?: string;
  readonly evidenceRefs: readonly string[];
}

export interface SemanticReviewV2 {
  readonly candidateInputHash: string;
  readonly mutationRevision: number;
  readonly verdict: "pass" | "fail" | "partial";
  readonly findings: readonly SemanticReviewFindingV2[];
}

export interface SemanticReviewRecordV2 {
  readonly reviewKey: string;
  readonly review: SemanticReviewV2;
  readonly completion: "completed" | "protocol_partial";
  readonly reasonCode?: "reviewer_error" | "reviewer_protocol_invalid";
}

export interface SemanticReviewLedgerV2 {
  readonly records: Readonly<Record<string, SemanticReviewRecordV2>>;
}

export interface SemanticReviewOnceResultV2 {
  readonly reviewKey: string;
  readonly review: SemanticReviewV2;
  readonly reused: boolean;
  readonly ledger: SemanticReviewLedgerV2;
}

export type SemanticReviewerV2 = (input: CandidateInputV2) => Promise<unknown>;

export function buildCandidateInputV2(
  state: WorkingDecisionStateV2,
  snapshots: readonly CandidateSnapshotV2[],
): CandidateInputV2 {
  if (!state.goal) {
    throw new Error("Cannot build a candidate input before task.started");
  }
  assertSnapshots(snapshots);

  const mutationJournal = Object.values(state.mutations)
    .sort(compareMutations)
    .map((mutation) => ({
      seq: mutation.seq,
      callId: mutation.callId,
      mutationRevision: mutation.mutationRevision,
      paths: sortedUnique(mutation.paths),
      beforeHashes: sortRecord(mutation.beforeHashes),
      afterHashes: sortRecord(mutation.afterHashes),
      patchHash: sha256Canonical(mutation.patch),
      workspaceEffect: mutation.workspaceEffect,
    }));

  return {
    schemaVersion: LOOP_V2_SCHEMA_VERSION,
    goalSourceHash: state.goal.sourceHash,
    mutationRevision: state.currentMutationRevision,
    criteria: Object.values(state.criteria)
      .filter((criterion) => criterion.status !== "superseded")
      .map(normalizeCriterion)
      .sort(compareById),
    invariants: Object.values(state.invariants)
      .filter((invariant) => invariant.status !== "superseded")
      .map(normalizeInvariant)
      .sort(compareById),
    mutationJournal,
    currentPatchHash: sha256Canonical(
      mutationJournal.map((mutation) => ({
        mutationRevision: mutation.mutationRevision,
        patchHash: mutation.patchHash,
      })),
    ),
    changedPublicSurface: Object.values(state.changeSurface)
      .filter(
        (surface) =>
          surface.mutationRevision === state.currentMutationRevision &&
          surface.visibility !== "internal",
      )
      .map(normalizeChangeSurface)
      .sort(compareById),
    currentVerification: Object.values(state.verification)
      .filter(
        (verification) =>
          verification.mutationRevision === state.currentMutationRevision,
      )
      .map(normalizeVerification)
      .sort(compareById),
    unresolvedRisks: Object.values(state.risks)
      .filter((risk) => risk.status === "open")
      .map(normalizeRisk)
      .sort(compareById),
    snapshotHashes: snapshots
      .map((snapshot) => ({ ...snapshot }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  };
}

export function candidateInputHashV2(input: CandidateInputV2): string {
  return sha256Canonical(input);
}

export function semanticReviewKeyV2(
  mutationRevision: number,
  candidateInputHash: string,
): string {
  if (!Number.isSafeInteger(mutationRevision) || mutationRevision < 0) {
    throw new Error("Semantic review mutationRevision must be non-negative");
  }
  if (!candidateInputHash.trim()) {
    throw new Error("Semantic review candidateInputHash must not be empty");
  }
  return sha256Canonical({
    policy: "loop-v2-semantic-review-key-v1",
    mutationRevision,
    candidateInputHash,
  });
}

export function evaluateCandidateReadinessV2(
  state: WorkingDecisionStateV2,
  artifact: CandidateArtifactEvidenceV2,
  policy: CandidateReadinessPolicyV2 = {},
): CandidateReadinessV2 {
  const gaps: CandidateReadinessGapV2[] = [];
  const currentRevision = state.currentMutationRevision;
  const requireMutation = policy.requireProductMutation ?? true;
  const requireVerification =
    policy.requireAuthoritativeVerification ?? requireMutation;

  if (!state.goal) {
    gaps.push({ code: "goal_missing", message: "Task goal is not recorded." });
  }

  const mutations = Object.values(state.mutations).sort(compareMutations);
  if (
    requireMutation &&
    !mutations.some((mutation) => mutation.workspaceEffect === "product")
  ) {
    gaps.push({
      code: "product_mutation_missing",
      message: "No product mutation is present in the mutation journal.",
    });
  }
  if (!journalIsComplete(mutations, currentRevision)) {
    gaps.push({
      code: "journal_incomplete",
      message: "Mutation journal revisions are not contiguous and complete.",
    });
  }
  if (!artifact.reconstructible) {
    gaps.push({
      code: "artifact_unreconstructible",
      message: "The candidate patch cannot be reconstructed from the journal.",
    });
  }
  if (artifact.crossCheck === "mismatch") {
    gaps.push({
      code: "artifact_cross_check_mismatch",
      message: "The reconstructed candidate and Git cross-check disagree.",
    });
  }

  const knownEvidenceIds = new Set([
    ...Object.values(state.evidence).map((evidence) => evidence.id),
    ...Object.values(state.verification).map((verification) => verification.id),
  ]);
  const pendingExternalCriterionIds: string[] = [];
  for (const criterion of Object.values(state.criteria).sort(compareById)) {
    if (criterion.status === "superseded") continue;
    if (criterion.authority === "external") {
      pendingExternalCriterionIds.push(criterion.id);
      continue;
    }
    if (criterion.mutationRevision < currentRevision) {
      gaps.push({
        code: "criterion_stale",
        criterionId: criterion.id,
        evidenceRefs: criterion.evidenceRefs,
        message: `Criterion ${criterion.id} was evaluated at r${criterion.mutationRevision}, not current r${currentRevision}.`,
      });
      continue;
    }
    if (criterion.status === "blocked") {
      gaps.push({
        code: "criterion_blocked",
        criterionId: criterion.id,
        evidenceRefs: criterion.evidenceRefs,
        message: `Criterion ${criterion.id} has an explicit current-revision blocker.`,
      });
      continue;
    }
    if (criterion.status !== "satisfied") {
      gaps.push({
        code: "criterion_pending",
        criterionId: criterion.id,
        evidenceRefs: criterion.evidenceRefs,
        message: `Criterion ${criterion.id} is not satisfied at the current revision.`,
      });
      continue;
    }
    if (criterion.evidenceRefs.length === 0) {
      gaps.push({
        code: "criterion_evidence_missing",
        criterionId: criterion.id,
        message: `Criterion ${criterion.id} is marked satisfied without evidence.`,
      });
      continue;
    }
    const unknown = criterion.evidenceRefs.filter(
      (reference) => !knownEvidenceIds.has(reference),
    );
    if (unknown.length > 0) {
      gaps.push({
        code: "criterion_evidence_unknown",
        criterionId: criterion.id,
        evidenceRefs: unknown,
        message: `Criterion ${criterion.id} refers to unknown evidence.`,
      });
    }
  }

  const currentVerification = Object.values(state.verification).filter(
    (verification) => verification.mutationRevision === currentRevision,
  );
  const authoritative = currentVerification.filter(
    (verification) => verification.authoritative,
  );
  const authoritativePasses = authoritative.filter(
    (verification) => verification.outcome === "passed",
  );
  if (requireVerification) {
    const codeFailures = authoritative.filter(
      (verification) => verification.outcome === "code_failed",
    );
    const harnessFailures = authoritative.filter(
      (verification) => verification.outcome === "harness_failed",
    );
    if (codeFailures.length > 0) {
      gaps.push({
        code: "verification_code_failed",
        evidenceRefs: codeFailures.map((verification) => verification.id),
        message: "Current authoritative verification reports a code failure.",
      });
    } else if (authoritativePasses.length === 0 && harnessFailures.length > 0) {
      gaps.push({
        code: "verification_unavailable",
        evidenceRefs: harnessFailures.map((verification) => verification.id),
        message:
          "Current authoritative verification is unavailable because the harness failed.",
      });
    } else if (authoritativePasses.length === 0) {
      gaps.push({
        code: "verification_missing",
        message: "No current authoritative verification pass is recorded.",
      });
    }
  }

  for (const risk of Object.values(state.risks).sort(compareById)) {
    if (risk.status === "open" && risk.severity === "blocking") {
      gaps.push({
        code: "blocking_risk",
        riskId: risk.id,
        evidenceRefs: risk.evidenceRefs,
        message: `Blocking risk ${risk.id} remains unresolved.`,
      });
    }
  }

  const blocked = gaps.some((gap) =>
    [
      "criterion_blocked",
      "verification_unavailable",
      "artifact_unreconstructible",
    ].includes(gap.code),
  );
  return {
    disposition:
      gaps.length === 0
        ? "ready_for_review"
        : blocked
          ? "blocked"
          : "needs_work",
    readyForSemanticReview: gaps.length === 0,
    gaps,
    pendingExternalCriterionIds,
    currentAuthoritativeVerificationIds: authoritativePasses.map(
      (verification) => verification.id,
    ),
  };
}

export function createSemanticReviewLedgerV2(): SemanticReviewLedgerV2 {
  return { records: {} };
}

/**
 * Calls the independent reviewer at most once for a semantic candidate. A
 * thrown error or malformed protocol is durably converted to one partial
 * result, so retry prose cannot create an unbounded reviewer loop.
 */
export async function reviewCandidateOnceV2(
  ledger: SemanticReviewLedgerV2,
  input: CandidateInputV2,
  reviewer: SemanticReviewerV2,
): Promise<SemanticReviewOnceResultV2> {
  const inputHash = candidateInputHashV2(input);
  const reviewKey = semanticReviewKeyV2(input.mutationRevision, inputHash);
  const recorded = ledger.records[reviewKey];
  if (recorded) {
    return {
      reviewKey,
      review: recorded.review,
      reused: true,
      ledger,
    };
  }

  let record: SemanticReviewRecordV2;
  try {
    const raw = await reviewer(input);
    const review = parseSemanticReviewV2(
      raw,
      inputHash,
      input.mutationRevision,
    );
    record = { reviewKey, review, completion: "completed" };
  } catch (error) {
    const protocolInvalid = error instanceof SemanticReviewProtocolError;
    record = {
      reviewKey,
      review: partialReview(
        inputHash,
        input.mutationRevision,
        protocolInvalid
          ? "Reviewer returned an invalid structured verdict."
          : "Reviewer did not complete.",
      ),
      completion: "protocol_partial",
      reasonCode: protocolInvalid
        ? "reviewer_protocol_invalid"
        : "reviewer_error",
    };
  }
  const nextLedger = {
    records: { ...ledger.records, [reviewKey]: record },
  };
  return {
    reviewKey,
    review: record.review,
    reused: false,
    ledger: nextLedger,
  };
}

class SemanticReviewProtocolError extends Error {}

function parseSemanticReviewV2(
  value: unknown,
  expectedHash: string,
  expectedRevision: number,
): SemanticReviewV2 {
  if (!isRecord(value)) {
    throw new SemanticReviewProtocolError("Semantic review must be an object");
  }
  if (
    value.candidateInputHash !== expectedHash ||
    value.mutationRevision !== expectedRevision ||
    !["pass", "fail", "partial"].includes(String(value.verdict)) ||
    !Array.isArray(value.findings)
  ) {
    throw new SemanticReviewProtocolError(
      "Semantic review identity is invalid",
    );
  }
  const findings = value.findings.map(parseFinding);
  if (
    value.verdict === "pass" &&
    findings.some((finding) => finding.severity === "blocking")
  ) {
    throw new SemanticReviewProtocolError(
      "A passing review cannot contain blocking findings",
    );
  }
  if (
    value.verdict === "fail" &&
    !findings.some((finding) => finding.severity === "blocking")
  ) {
    throw new SemanticReviewProtocolError(
      "A failing review must contain a blocking finding",
    );
  }
  return {
    candidateInputHash: expectedHash,
    mutationRevision: expectedRevision,
    verdict: value.verdict as SemanticReviewV2["verdict"],
    findings,
  };
}

function parseFinding(value: unknown): SemanticReviewFindingV2 {
  if (!isRecord(value)) {
    throw new SemanticReviewProtocolError("Review finding must be an object");
  }
  if (
    (value.severity !== "blocking" && value.severity !== "warning") ||
    typeof value.observedChange !== "string" ||
    !value.observedChange.trim() ||
    typeof value.risk !== "string" ||
    !value.risk.trim() ||
    !Array.isArray(value.evidenceRefs) ||
    !value.evidenceRefs.every((reference) => typeof reference === "string")
  ) {
    throw new SemanticReviewProtocolError("Review finding fields are invalid");
  }
  if (
    value.severity === "blocking" &&
    typeof value.criterionId !== "string" &&
    typeof value.invariantId !== "string"
  ) {
    throw new SemanticReviewProtocolError(
      "Blocking findings must bind a criterion or invariant",
    );
  }
  if (value.severity === "blocking" && value.evidenceRefs.length === 0) {
    throw new SemanticReviewProtocolError(
      "Blocking findings must bind visible evidence",
    );
  }
  return {
    severity: value.severity,
    ...(typeof value.criterionId === "string"
      ? { criterionId: value.criterionId }
      : {}),
    ...(typeof value.invariantId === "string"
      ? { invariantId: value.invariantId }
      : {}),
    ...(typeof value.file === "string" ? { file: value.file } : {}),
    ...(typeof value.line === "number" && Number.isSafeInteger(value.line)
      ? { line: value.line }
      : {}),
    observedChange: value.observedChange,
    risk: value.risk,
    ...(typeof value.minimalAlternative === "string"
      ? { minimalAlternative: value.minimalAlternative }
      : {}),
    evidenceRefs: [...value.evidenceRefs] as string[],
  };
}

function partialReview(
  candidateInputHash: string,
  mutationRevision: number,
  risk: string,
): SemanticReviewV2 {
  return {
    candidateInputHash,
    mutationRevision,
    verdict: "partial",
    findings: [
      {
        severity: "warning",
        observedChange: "Independent semantic review is incomplete.",
        risk,
        evidenceRefs: [],
      },
    ],
  };
}

function journalIsComplete(
  mutations: readonly MutationJournalEntryV2[],
  currentRevision: number,
): boolean {
  if (mutations.length !== currentRevision) return false;
  return mutations.every(
    (mutation, index) =>
      mutation.mutationRevision === index + 1 &&
      mutation.paths.length > 0 &&
      mutation.paths.every(
        (path) =>
          Object.hasOwn(mutation.beforeHashes, path) &&
          Object.hasOwn(mutation.afterHashes, path),
      ) &&
      mutation.patch.trim().length > 0,
  );
}

function assertSnapshots(snapshots: readonly CandidateSnapshotV2[]): void {
  const paths = new Set<string>();
  for (const snapshot of snapshots) {
    if (!snapshot.path.trim() || !snapshot.contentHash.trim()) {
      throw new Error(
        "Candidate snapshot path and contentHash must not be empty",
      );
    }
    if (paths.has(snapshot.path)) {
      throw new Error(`Duplicate candidate snapshot path: ${snapshot.path}`);
    }
    paths.add(snapshot.path);
  }
}

function normalizeCriterion(
  criterion: SemanticCriterionV2,
): SemanticCriterionV2 {
  return {
    ...criterion,
    evidenceRefs: sortedUnique(criterion.evidenceRefs),
  };
}

function normalizeInvariant(
  invariant: BehavioralInvariantV2,
): BehavioralInvariantV2 {
  return {
    ...invariant,
    evidenceRefs: sortedUnique(invariant.evidenceRefs),
  };
}

function normalizeChangeSurface(
  surface: ChangeSurfaceRecordV2,
): ChangeSurfaceRecordV2 {
  return {
    ...surface,
    observables: sortedUnique(surface.observables),
    criterionIds: sortedUnique(surface.criterionIds),
  };
}

function normalizeVerification(
  verification: VerificationRecordV2,
): VerificationRecordV2 {
  return {
    ...verification,
    argv: [...verification.argv],
    scope: sortedUnique(verification.scope),
  };
}

function normalizeRisk(risk: RiskRecordV2): RiskRecordV2 {
  return { ...risk, evidenceRefs: sortedUnique(risk.evidenceRefs) };
}

function compareMutations(
  left: MutationJournalEntryV2,
  right: MutationJournalEntryV2,
): number {
  return left.mutationRevision - right.mutationRevision || left.seq - right.seq;
}

function compareById<T extends { readonly id: string }>(
  left: T,
  right: T,
): number {
  return left.id.localeCompare(right.id);
}

function sortedUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function sortRecord<T>(record: Readonly<Record<string, T>>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
