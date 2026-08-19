import { canonicalJson, sha256Canonical } from "./canonical.js";
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

export interface CandidateSourceSnapshotV2 extends CandidateSnapshotV2 {
  readonly content: string;
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
  readonly beforeContentRefs: Readonly<Record<string, string | null>>;
  readonly afterContentRefs: Readonly<Record<string, string | null>>;
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

export interface CandidateReviewPayloadV2 {
  readonly input: CandidateInputV2;
  readonly candidateInputHash: string;
  readonly goal: string;
  /** How the reviewer must interpret local verification records. */
  readonly verificationContext: Readonly<{
    readonly authority: "local" | "external" | "not_required";
    readonly localEvidenceRole:
      | "delivery_authority"
      | "diagnostic_not_acceptance"
      | "not_required";
    readonly externalVerification: "pending" | "not_configured";
  }>;
  /** Baseline-to-terminal artifact derived from the complete mutation journal. */
  readonly terminalPatch: Readonly<{
    readonly patch: string;
    readonly patchHash: string;
    readonly changedPaths: readonly string[];
  }>;
  readonly mutationPatches: readonly Readonly<{
    readonly callId: string;
    readonly mutationRevision: number;
    readonly patch: string;
  }>[];
  readonly snapshots: readonly CandidateSourceSnapshotV2[];
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
  | "verification_scope_missing"
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
  readonly verificationAuthority?: "local" | "external" | "not_required";
  readonly requiredVerificationScopes?: readonly string[];
  /** @deprecated Use verificationAuthority. */
  readonly requireAuthoritativeVerification?: boolean;
}

export interface CandidateReadinessV2 {
  readonly disposition: "ready_for_review" | "needs_work" | "blocked";
  readonly readyForSemanticReview: boolean;
  readonly gaps: readonly CandidateReadinessGapV2[];
  /** External authority is never marked satisfied by the implementing model. */
  readonly pendingExternalCriterionIds: readonly string[];
  readonly currentAuthoritativeVerificationIds: readonly string[];
  readonly localVerification:
    | "not_required"
    | "missing"
    | "passed"
    | "code_failed"
    | "harness_failed";
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
  readonly reasonCode?:
    | "reviewer_error"
    | "reviewer_protocol_invalid"
    | "reviewer_interrupted";
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

export type SemanticReviewerV2 = (
  payload: CandidateReviewPayloadV2,
) => Promise<unknown>;

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
      beforeContentRefs: sortRecord(mutation.beforeContentRefs),
      afterContentRefs: sortRecord(mutation.afterContentRefs),
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
      .map((snapshot) => ({
        path: snapshot.path,
        contentHash: snapshot.contentHash,
      }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  };
}

export function candidateInputHashV2(input: CandidateInputV2): string {
  return sha256Canonical(input);
}

export function candidateSnapshotHashV2(content: string): string {
  return sha256Canonical(content);
}

export function buildCandidateReviewPayloadV2(
  state: WorkingDecisionStateV2,
  snapshots: readonly CandidateSourceSnapshotV2[],
  terminalPatch: CandidateReviewPayloadV2["terminalPatch"],
  verificationAuthority: CandidateReadinessPolicyV2["verificationAuthority"] = "local",
): CandidateReviewPayloadV2 {
  for (const snapshot of snapshots) {
    if (candidateSnapshotHashV2(snapshot.content) !== snapshot.contentHash) {
      throw new Error(`Candidate snapshot hash mismatch: ${snapshot.path}`);
    }
  }
  const input = buildCandidateInputV2(state, snapshots);
  if (!terminalPatch.patch.trim()) {
    throw new Error("Candidate terminal patch must not be empty");
  }
  if (sha256Canonical(terminalPatch.patch) !== terminalPatch.patchHash) {
    throw new Error("Candidate terminal patch hash mismatch");
  }
  const changedPaths = sortedUnique(terminalPatch.changedPaths);
  if (
    changedPaths.length === 0 ||
    changedPaths.length !== terminalPatch.changedPaths.length
  ) {
    throw new Error("Candidate terminal patch changed paths are invalid");
  }
  return {
    input,
    candidateInputHash: candidateInputHashV2(input),
    goal: state.goal?.verbatim ?? "",
    verificationContext: {
      authority: verificationAuthority ?? "local",
      localEvidenceRole:
        verificationAuthority === "external"
          ? "diagnostic_not_acceptance"
          : verificationAuthority === "not_required"
            ? "not_required"
            : "delivery_authority",
      externalVerification:
        verificationAuthority === "external" ? "pending" : "not_configured",
    },
    terminalPatch: {
      patch: terminalPatch.patch,
      patchHash: terminalPatch.patchHash,
      changedPaths,
    },
    mutationPatches: Object.values(state.mutations)
      .sort(compareMutations)
      .map((mutation) => ({
        callId: mutation.callId,
        mutationRevision: mutation.mutationRevision,
        patch: mutation.patch,
      })),
    snapshots: snapshots
      .map((snapshot) => ({ ...snapshot }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  };
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
  const verificationAuthority =
    policy.verificationAuthority ??
    (policy.requireAuthoritativeVerification === false || !requireMutation
      ? "not_required"
      : "local");
  const requireVerification = verificationAuthority !== "not_required";

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
  // A genuinely read-only candidate has no patch to reconstruct. Once any
  // mutation exists (required or incidental), the artifact becomes mandatory.
  const artifactRequired = requireMutation || currentRevision > 0;
  if (artifactRequired && !artifact.reconstructible) {
    gaps.push({
      code: "artifact_unreconstructible",
      message: "The candidate patch cannot be reconstructed from the journal.",
    });
  }
  if (artifactRequired && artifact.crossCheck === "mismatch") {
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
  const codeFailures = authoritative.filter(
    (verification) => verification.outcome === "code_failed",
  );
  const harnessFailures = authoritative.filter(
    (verification) => verification.outcome === "harness_failed",
  );
  const requiredScopes = sortedUnique(
    policy.requiredVerificationScopes?.filter((scope) => scope.trim()) ?? [],
  );
  const missingScopes = requiredScopes.filter(
    (scope) =>
      !authoritativePasses.some((verification) =>
        verificationCoversScope(verification, scope),
      ),
  );
  const harnessBlockedScopes = missingScopes.filter((scope) =>
    harnessFailures.some((verification) =>
      verificationCoversScope(verification, scope),
    ),
  );
  const localVerification: CandidateReadinessV2["localVerification"] =
    !requireVerification
      ? "not_required"
      : codeFailures.length > 0
        ? "code_failed"
        : missingScopes.length === 0 && authoritativePasses.length > 0
          ? "passed"
          : harnessFailures.length > 0
            ? "harness_failed"
            : "missing";
  if (requireVerification) {
    if (codeFailures.length > 0) {
      // A local-authority failure is a delivery blocker. With external
      // authority it remains an explicit diagnostic fact, but cannot decide
      // the acceptance contract owned by the configured external verifier.
      if (verificationAuthority === "local") {
        gaps.push({
          code: "verification_code_failed",
          evidenceRefs: codeFailures.map((verification) => verification.id),
          message: "Current authoritative verification reports a code failure.",
        });
      }
    } else if (
      missingScopes.length > 0 &&
      harnessBlockedScopes.length === missingScopes.length &&
      verificationAuthority === "local"
    ) {
      gaps.push({
        code: "verification_unavailable",
        evidenceRefs: harnessFailures.map((verification) => verification.id),
        message: `Required verification scopes are unavailable because the harness failed: ${missingScopes.join(", ")}.`,
      });
    } else if (
      missingScopes.length > 0 &&
      !(
        verificationAuthority === "external" &&
        harnessBlockedScopes.length === missingScopes.length
      )
    ) {
      gaps.push({
        code: "verification_scope_missing",
        message: `Required verification scopes lack a current authoritative pass: ${missingScopes.join(", ")}.`,
      });
    } else if (
      requiredScopes.length === 0 &&
      authoritativePasses.length === 0 &&
      harnessFailures.length > 0 &&
      verificationAuthority === "local"
    ) {
      gaps.push({
        code: "verification_unavailable",
        evidenceRefs: harnessFailures.map((verification) => verification.id),
        message:
          "Current authoritative verification is unavailable because the harness failed.",
      });
    } else if (
      requiredScopes.length === 0 &&
      authoritativePasses.length === 0 &&
      harnessFailures.length === 0
    ) {
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
    localVerification,
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
  payload: CandidateReviewPayloadV2,
  reviewer: SemanticReviewerV2,
): Promise<SemanticReviewOnceResultV2> {
  assertReviewPayloadIdentity(payload);
  const inputHash = payload.candidateInputHash;
  const reviewKey = semanticReviewKeyV2(
    payload.input.mutationRevision,
    inputHash,
  );
  const recorded = ledger.records[reviewKey];
  if (recorded) {
    const validated = validateSemanticReviewRecordV2(recorded, payload);
    return {
      reviewKey,
      review: validated.review,
      reused: true,
      ledger,
    };
  }

  let record: SemanticReviewRecordV2;
  try {
    const raw = await reviewer(payload);
    const review = parseSemanticReviewV2(raw, payload);
    record = { reviewKey, review, completion: "completed" };
  } catch (error) {
    const protocolInvalid = error instanceof SemanticReviewProtocolError;
    record = {
      reviewKey,
      review: partialReview(
        inputHash,
        payload.input.mutationRevision,
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

/** Strictly revalidates one persisted review record against its candidate. */
export function validateSemanticReviewRecordV2(
  value: unknown,
  payload: CandidateReviewPayloadV2,
): SemanticReviewRecordV2 {
  assertReviewPayloadIdentity(payload);
  if (!isRecord(value)) {
    throw new Error("Semantic review record must be an object");
  }
  const reviewKey = semanticReviewKeyV2(
    payload.input.mutationRevision,
    payload.candidateInputHash,
  );
  if (value.reviewKey !== reviewKey) {
    throw new Error("Semantic review record key mismatch");
  }

  let normalized: SemanticReviewRecordV2;
  if (value.completion === "completed") {
    if (value.reasonCode !== undefined) {
      throw new Error("Completed semantic review cannot have a reason code");
    }
    normalized = {
      reviewKey,
      review: parseSemanticReviewV2(value.review, payload),
      completion: "completed",
    };
  } else if (value.completion === "protocol_partial") {
    if (
      value.reasonCode !== "reviewer_error" &&
      value.reasonCode !== "reviewer_protocol_invalid" &&
      value.reasonCode !== "reviewer_interrupted"
    ) {
      throw new Error("Partial semantic review reason code is invalid");
    }
    normalized = {
      reviewKey,
      review: partialReview(
        payload.candidateInputHash,
        payload.input.mutationRevision,
        value.reasonCode === "reviewer_protocol_invalid"
          ? "Reviewer returned an invalid structured verdict."
          : value.reasonCode === "reviewer_interrupted"
            ? "Reviewer invocation was interrupted before a durable result."
            : "Reviewer did not complete.",
      ),
      completion: "protocol_partial",
      reasonCode: value.reasonCode,
    };
  } else {
    throw new Error("Semantic review completion is invalid");
  }
  if (canonicalJson(value) !== canonicalJson(normalized)) {
    throw new Error("Semantic review record is not canonical");
  }
  return normalized;
}

/**
 * Converts a durable invocation claim without a settled verdict into a
 * deterministic partial record. The caller must not invoke the model again.
 */
export function createInterruptedSemanticReviewRecordV2(
  payload: CandidateReviewPayloadV2,
): SemanticReviewRecordV2 {
  assertReviewPayloadIdentity(payload);
  const reviewKey = semanticReviewKeyV2(
    payload.input.mutationRevision,
    payload.candidateInputHash,
  );
  return {
    reviewKey,
    review: partialReview(
      payload.candidateInputHash,
      payload.input.mutationRevision,
      "Reviewer invocation was interrupted before a durable result.",
    ),
    completion: "protocol_partial",
    reasonCode: "reviewer_interrupted",
  };
}

class SemanticReviewProtocolError extends Error {}

function parseSemanticReviewV2(
  value: unknown,
  payload: CandidateReviewPayloadV2,
): SemanticReviewV2 {
  const expectedHash = payload.candidateInputHash;
  const expectedRevision = payload.input.mutationRevision;
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
  const findings = value.findings.map((finding) =>
    parseFinding(finding, payload),
  );
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

function parseFinding(
  value: unknown,
  payload: CandidateReviewPayloadV2,
): SemanticReviewFindingV2 {
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
  const criterionIds = new Set(
    payload.input.criteria.map((criterion) => criterion.id),
  );
  const invariantIds = new Set(
    payload.input.invariants.map((invariant) => invariant.id),
  );
  if (
    typeof value.criterionId === "string" &&
    !criterionIds.has(value.criterionId)
  ) {
    throw new SemanticReviewProtocolError(
      `Review finding refers to unknown criterion: ${value.criterionId}`,
    );
  }
  if (
    typeof value.invariantId === "string" &&
    !invariantIds.has(value.invariantId)
  ) {
    throw new SemanticReviewProtocolError(
      `Review finding refers to unknown invariant: ${value.invariantId}`,
    );
  }
  const visibleEvidenceRefs = new Set([
    ...payload.mutationPatches.map((mutation) => `mutation:${mutation.callId}`),
    ...payload.input.changedPublicSurface.map(
      (surface) => `surface:${surface.id}`,
    ),
    ...payload.input.currentVerification.map((verification) => verification.id),
    ...payload.snapshots.map((snapshot) => `snapshot:${snapshot.path}`),
  ]);
  const unknownEvidenceRefs = value.evidenceRefs.filter(
    (reference) => !visibleEvidenceRefs.has(reference),
  );
  if (unknownEvidenceRefs.length > 0) {
    throw new SemanticReviewProtocolError(
      `Review finding refers to evidence outside its payload: ${unknownEvidenceRefs.join(", ")}`,
    );
  }
  const visibleFiles = new Set([
    ...payload.input.mutationJournal.flatMap((mutation) => mutation.paths),
    ...payload.snapshots.map((snapshot) => snapshot.path),
  ]);
  if (typeof value.file === "string" && !visibleFiles.has(value.file)) {
    throw new SemanticReviewProtocolError(
      `Review finding refers to a file outside its payload: ${value.file}`,
    );
  }
  const referencesPublicSurface = value.evidenceRefs.some((reference) => {
    if (!reference.startsWith("surface:")) return false;
    const surfaceId = reference.slice("surface:".length);
    return payload.input.changedPublicSurface.some(
      (surface) => surface.id === surfaceId,
    );
  });
  if (
    value.severity === "blocking" &&
    referencesPublicSurface &&
    (typeof value.minimalAlternative !== "string" ||
      !value.minimalAlternative.trim())
  ) {
    throw new SemanticReviewProtocolError(
      "Blocking public-surface findings must compare a minimal alternative",
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

function assertReviewPayloadIdentity(payload: CandidateReviewPayloadV2): void {
  const expectedEvidenceRole =
    payload.verificationContext.authority === "external"
      ? "diagnostic_not_acceptance"
      : payload.verificationContext.authority === "not_required"
        ? "not_required"
        : payload.verificationContext.authority === "local"
          ? "delivery_authority"
          : undefined;
  if (payload.verificationContext.localEvidenceRole !== expectedEvidenceRole) {
    throw new Error("Candidate review verification context is invalid");
  }
  if (
    payload.verificationContext.externalVerification !==
    (payload.verificationContext.authority === "external"
      ? "pending"
      : "not_configured")
  ) {
    throw new Error("Candidate review external verification state is invalid");
  }
  const expectedHash = candidateInputHashV2(payload.input);
  if (payload.candidateInputHash !== expectedHash) {
    throw new Error("Candidate review payload identity hash mismatch");
  }
  if (
    !payload.terminalPatch.patch.trim() ||
    sha256Canonical(payload.terminalPatch.patch) !==
      payload.terminalPatch.patchHash ||
    sortedUnique(payload.terminalPatch.changedPaths).length !==
      payload.terminalPatch.changedPaths.length
  ) {
    throw new Error("Candidate review payload terminal patch mismatch");
  }
  const patchByCallId = new Map(
    payload.mutationPatches.map((mutation) => [mutation.callId, mutation]),
  );
  if (patchByCallId.size !== payload.input.mutationJournal.length) {
    throw new Error("Candidate review payload mutation set is incomplete");
  }
  for (const mutation of payload.input.mutationJournal) {
    const material = patchByCallId.get(mutation.callId);
    if (
      !material ||
      material.mutationRevision !== mutation.mutationRevision ||
      sha256Canonical(material.patch) !== mutation.patchHash
    ) {
      throw new Error(
        `Candidate review payload patch mismatch: ${mutation.callId}`,
      );
    }
  }
  const snapshotByPath = new Map(
    payload.snapshots.map((snapshot) => [snapshot.path, snapshot]),
  );
  if (snapshotByPath.size !== payload.input.snapshotHashes.length) {
    throw new Error("Candidate review payload snapshot set is incomplete");
  }
  for (const snapshot of payload.input.snapshotHashes) {
    const material = snapshotByPath.get(snapshot.path);
    if (
      !material ||
      material.contentHash !== snapshot.contentHash ||
      candidateSnapshotHashV2(material.content) !== snapshot.contentHash
    ) {
      throw new Error(
        `Candidate review payload snapshot mismatch: ${snapshot.path}`,
      );
    }
  }
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
          Object.hasOwn(mutation.afterHashes, path) &&
          Object.hasOwn(mutation.beforeContentRefs, path) &&
          Object.hasOwn(mutation.afterContentRefs, path),
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

function verificationCoversScope(
  verification: VerificationRecordV2,
  requiredScope: string,
): boolean {
  return verification.scope.some(
    (scope) => scope === "*" || scope === requiredScope,
  );
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
