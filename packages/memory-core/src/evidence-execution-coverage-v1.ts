import { hashCanonicalJsonV1 } from "./canonical.js";
import type { MemoryEvidenceNotebookV1 } from "./evidence-contracts.js";
import type {
  MemoryEvidenceBoundTemporalConstraintV1,
  MemoryEvidenceQueryIntentV3,
  MemoryEvidenceRequirementV3,
} from "./query-plan-contracts.js";
import type { MemorySelectorExecutionSnapshotV1 } from "./selector-execution-snapshot-v1.js";

export const PAW_MEMORY_EVIDENCE_EXECUTION_COVERAGE_POLICY_V1 =
  "paw.memory-evidence-execution-coverage.v2:operation-specific-proof" as const;

export type MemoryEvidenceExecutionCompletionBasisV1 =
  | "finite_endpoint_exact"
  | "frontier_complete"
  | "bounded_window_lookup"
  | "closed_world_collection"
  | "legacy_closed_world";

export interface MemoryEvidenceExecutionRequirementCoverageV1 {
  readonly requirementId: string;
  readonly requirementRevision: string;
  readonly temporalBindingRevision: string;
  readonly windowRevision: string;
  readonly completionBasis: MemoryEvidenceExecutionCompletionBasisV1;
  readonly status: "closed" | "open";
  readonly selectedEvidenceCount: number;
  readonly independentEvidenceCount: number;
  readonly closureEvidenceCount: number;
  /** Minimum count under the requirement's declared closure semantics. */
  readonly minimumEvidence: number;
  readonly supportingEvidenceSetRevision: string;
  readonly selectedEvidenceSetRevision: string;
  /** Exact set the binder must materialize: selected plus retained history. */
  readonly executableAdmissionEvidenceCount: number;
  readonly executableAdmissionEvidenceSetRevision: string;
  /** Binds the exact notebook row, including historical and unresolved refs. */
  readonly notebookCoverageRevision: string;
  readonly reasonCodes: readonly (
    | "selector_group_uncommitted"
    | "selector_requirement_unassessed"
    | "selector_candidate_partition_incomplete"
    | "notebook_admission_partition_incomplete"
    | "supporting_evidence_missing"
    | "notebook_requirement_open"
    | "notebook_unresolved_peer"
    | "notebook_budget_omission"
    | "notebook_coverage_count_inconsistent"
    | "minimum_evidence_unsatisfied"
    | "selected_evidence_not_supported"
    | "closure_audit_not_passed"
  )[];
  readonly proofRevision: string;
}

export interface MemoryEvidenceExecutionCoverageCertificateV1 {
  readonly policyVersion: typeof PAW_MEMORY_EVIDENCE_EXECUTION_COVERAGE_POLICY_V1;
  readonly status: "closed" | "open";
  readonly selectorSnapshotRevision: string;
  readonly notebookPolicyVersion: string;
  readonly closureAuditRevision: string | null;
  readonly requirements: readonly MemoryEvidenceExecutionRequirementCoverageV1[];
  readonly certificateRevision: string;
}

export interface MemoryEvidenceExecutionCoverageCompilationInputV1 {
  readonly intent: MemoryEvidenceQueryIntentV3;
  readonly requirements: readonly MemoryEvidenceRequirementV3[];
  readonly temporalConstraints: readonly MemoryEvidenceBoundTemporalConstraintV1[];
  readonly selectorSnapshot: MemorySelectorExecutionSnapshotV1;
  readonly notebook: MemoryEvidenceNotebookV1;
  readonly closureAuditStatus:
    | "not_needed"
    | "not_configured"
    | "completed"
    | "fallback";
  readonly closureVerdict?: "pass" | "repair" | "insufficient";
  readonly closureAuditRevision?: string;
}

/**
 * Compiles a content-free closed-world proof from three independent gates:
 * post-authority selector commitment, notebook cardinality, and a passing
 * semantic closure audit. `coverageMode=all` alone is never a certificate.
 */
export function compileMemoryEvidenceExecutionCoverageCertificateV1(
  input: MemoryEvidenceExecutionCoverageCompilationInputV1,
): MemoryEvidenceExecutionCoverageCertificateV1 {
  const executionByRequirement = new Map(
    input.selectorSnapshot.groups.flatMap((group) =>
      group.requirements.map(
        (requirement) =>
          [
            requirement.requirementId,
            { groupStatus: group.status, requirement },
          ] as const,
      ),
    ),
  );
  const notebookByRequirement = new Map(
    input.notebook.coverage.map((coverage) => [
      coverage.requirementId,
      coverage,
    ]),
  );
  const temporalByRequirement = new Map(
    input.requirements.map((requirement, index) => [
      requirement.requirementId,
      input.temporalConstraints[index],
    ]),
  );
  if (
    input.requirements.length < 1 ||
    input.requirements.length > 4 ||
    executionByRequirement.size !== input.requirements.length ||
    notebookByRequirement.size !== input.requirements.length ||
    temporalByRequirement.size !== input.requirements.length ||
    input.temporalConstraints.length !== input.requirements.length ||
    input.requirements.some(
      (requirement) =>
        !executionByRequirement.has(requirement.requirementId) ||
        !notebookByRequirement.has(requirement.requirementId) ||
        !temporalByRequirement.get(requirement.requirementId),
    )
  ) {
    throw namedError("MemoryEvidenceExecutionCoverageInputInvalid");
  }
  const closurePassed =
    input.closureAuditStatus === "completed" &&
    input.closureVerdict === "pass" &&
    Boolean(input.closureAuditRevision?.trim());
  const requirements = Object.freeze(
    input.requirements.map((requirement) => {
      const execution = executionByRequirement.get(requirement.requirementId);
      const coverage = notebookByRequirement.get(requirement.requirementId);
      const temporal = temporalByRequirement.get(requirement.requirementId);
      if (
        !execution ||
        !coverage ||
        !temporal ||
        execution.requirement.requirementRevision !==
          hashCanonicalJsonV1(requirement as never) ||
        execution.requirement.temporalBindingRevision !==
          temporal.bindingRevision
      ) {
        throw namedError("MemoryEvidenceExecutionCoverageInputInvalid");
      }
      const completionBasis = executionCompletionBasis(
        input.intent,
        requirement,
        temporal,
      );
      const supporting = new Set(
        execution.requirement.assessment?.supportingEvidenceRefs ?? [],
      );
      const minimumEvidence = requirement.minimumEvidence ?? 1;
      const reasons: MemoryEvidenceExecutionRequirementCoverageV1["reasonCodes"][number][] =
        [];
      if (execution.groupStatus !== "committed") {
        reasons.push("selector_group_uncommitted");
      }
      if (execution.requirement.status !== "assessed") {
        reasons.push("selector_requirement_unassessed");
      }
      if (!execution.requirement.assessmentPartitionComplete) {
        reasons.push("selector_candidate_partition_incomplete");
      }
      if (supporting.size === 0) reasons.push("supporting_evidence_missing");
      if (coverage.status !== "covered")
        reasons.push("notebook_requirement_open");
      if (coverage.unresolvedEvidenceRefs.length > 0) {
        reasons.push("notebook_unresolved_peer");
      }
      const notebookInputRefs = new Set(coverage.inputEvidenceRefs ?? []);
      const budgetOmittedRefs = new Set(
        coverage.budgetOmittedEvidenceRefs ?? [],
      );
      const admission = coverage.admission ?? [];
      const notebookAdmissionRefs = new Set(
        admission.map((item) => item.evidenceRef),
      );
      const admittedSelectedRefs = new Set(
        admission
          .filter(
            (item) =>
              item.disposition === "selected" ||
              item.disposition === "selected_unresolved",
          )
          .map((item) => item.evidenceRef),
      );
      const admittedSelectedIndependenceIdentities = new Set(
        admission
          .filter(
            (item) =>
              item.disposition === "selected" ||
              item.disposition === "selected_unresolved",
          )
          .map((item) => item.independenceIdentityRevision),
      );
      const admittedHistoricalRefs = new Set(
        admission
          .filter((item) => item.disposition === "historical")
          .map((item) => item.evidenceRef),
      );
      const admittedUnresolvedRefs = new Set(
        admission
          .filter((item) => item.disposition === "selected_unresolved")
          .map((item) => item.evidenceRef),
      );
      const admittedBudgetOmittedRefs = new Set(
        admission
          .filter((item) => item.disposition === "budget_omitted")
          .map((item) => item.evidenceRef),
      );
      const admittedRejectedRefs = new Set(
        admission
          .filter((item) => item.disposition === "rejected")
          .map((item) => item.evidenceRef),
      );
      const admissionIsExact =
        coverage.inputEvidenceRefs !== undefined &&
        coverage.budgetOmittedEvidenceRefs !== undefined &&
        coverage.admission !== undefined &&
        hasUniqueNonEmptyRefs(coverage.inputEvidenceRefs) &&
        hasUniqueNonEmptyRefs(coverage.selectedEvidenceRefs) &&
        hasUniqueNonEmptyRefs(coverage.historicalEvidenceRefs) &&
        hasUniqueNonEmptyRefs(coverage.unresolvedEvidenceRefs) &&
        hasUniqueNonEmptyRefs(coverage.budgetOmittedEvidenceRefs) &&
        admission.length === notebookAdmissionRefs.size &&
        admission.every(
          (item) =>
            item.evidenceRef.trim().length > 0 &&
            item.independenceIdentityRevision.trim().length > 0 &&
            new Set([
              "selected",
              "selected_unresolved",
              "historical",
              "budget_omitted",
              "rejected",
            ]).has(item.disposition),
        ) &&
        sameSet(notebookAdmissionRefs, notebookInputRefs) &&
        sameSet(admittedSelectedRefs, new Set(coverage.selectedEvidenceRefs)) &&
        sameSet(
          admittedHistoricalRefs,
          new Set(coverage.historicalEvidenceRefs),
        ) &&
        sameSet(
          admittedUnresolvedRefs,
          new Set(coverage.unresolvedEvidenceRefs),
        ) &&
        sameSet(admittedBudgetOmittedRefs, budgetOmittedRefs) &&
        admittedRejectedRefs.size === 0 &&
        coverage.independentEvidenceCount ===
          admittedSelectedIndependenceIdentities.size;
      if (
        !admissionIsExact ||
        !sameSet(notebookInputRefs, supporting) ||
        coverage.budgetOmittedHitCount === undefined
      ) {
        reasons.push("notebook_admission_partition_incomplete");
      }
      if (
        coverage.budgetOmittedHitCount === undefined ||
        coverage.budgetOmittedHitCount !== budgetOmittedRefs.size ||
        budgetOmittedRefs.size > 0
      ) {
        reasons.push("notebook_budget_omission");
      }
      const expectedClosureEvidenceCount =
        requirement.coverageMode === "convergent"
          ? coverage.independentEvidenceCount
          : coverage.selectedEvidenceRefs.length;
      if (
        coverage.selectedHitCount !== coverage.selectedEvidenceRefs.length ||
        coverage.independentEvidenceCount < 0 ||
        coverage.independentEvidenceCount >
          coverage.selectedEvidenceRefs.length ||
        coverage.closureEvidenceCount !== expectedClosureEvidenceCount
      ) {
        reasons.push("notebook_coverage_count_inconsistent");
      }
      // The notebook defines closureEvidenceCount per operation: only
      // convergent claims use independent episodes; all/history/aggregate and
      // finite operands use the number of retained facts.
      if (coverage.closureEvidenceCount < minimumEvidence) {
        reasons.push("minimum_evidence_unsatisfied");
      }
      if (
        coverage.selectedEvidenceRefs.some(
          (evidenceRef) => !supporting.has(evidenceRef),
        )
      ) {
        reasons.push("selected_evidence_not_supported");
      }
      // frontier_complete remains audit-backed until a post-binder frontier
      // certificate can prove an exact candidate partition and comparable
      // maxima. Only finite endpoints and one bounded lookup may close without
      // claiming the whole source history is exhausted.
      if (
        completionBasis !== "finite_endpoint_exact" &&
        completionBasis !== "bounded_window_lookup" &&
        !closurePassed
      ) {
        reasons.push("closure_audit_not_passed");
      }
      const reasonCodes = Object.freeze([...new Set(reasons)]);
      const supportingEvidenceSetRevision = hashCanonicalJsonV1({
        schemaVersion: "paw.memory-supporting-evidence-set.v1",
        evidenceRefs: Object.freeze([...supporting].sort()),
      } as never);
      const selectedEvidenceSetRevision = hashCanonicalJsonV1({
        schemaVersion: "paw.memory-selected-evidence-set.v1",
        evidenceRefs: Object.freeze([...coverage.selectedEvidenceRefs].sort()),
      } as never);
      const executableAdmissionEvidenceRefs = new Set([
        ...coverage.selectedEvidenceRefs,
        ...coverage.historicalEvidenceRefs,
      ]);
      const executableAdmissionEvidenceSetRevision = hashCanonicalJsonV1({
        schemaVersion: "paw.memory-executable-admission-evidence-set.v1",
        evidenceRefs: Object.freeze(
          [...executableAdmissionEvidenceRefs].sort(),
        ),
      } as never);
      const notebookCoverageRevision = hashCanonicalJsonV1({
        schemaVersion: "paw.memory-notebook-coverage-row.v1",
        coverage,
      } as never);
      const windowRevision = hashCanonicalJsonV1({
        schemaVersion: "paw.memory-requirement-window.v1",
        requirementId: requirement.requirementId,
        temporalBindingRevision: execution.requirement.temporalBindingRevision,
      } as never);
      const identity = {
        requirementId: requirement.requirementId,
        requirementRevision: execution.requirement.requirementRevision,
        temporalBindingRevision: execution.requirement.temporalBindingRevision,
        windowRevision,
        completionBasis,
        status:
          reasonCodes.length === 0 ? ("closed" as const) : ("open" as const),
        selectedEvidenceCount: coverage.selectedEvidenceRefs.length,
        independentEvidenceCount: coverage.independentEvidenceCount,
        closureEvidenceCount: coverage.closureEvidenceCount,
        minimumEvidence,
        supportingEvidenceSetRevision,
        selectedEvidenceSetRevision,
        executableAdmissionEvidenceCount: executableAdmissionEvidenceRefs.size,
        executableAdmissionEvidenceSetRevision,
        notebookCoverageRevision,
        reasonCodes,
      };
      return Object.freeze({
        ...identity,
        proofRevision: hashCanonicalJsonV1(identity as never),
      });
    }),
  );
  const identity = {
    policyVersion: PAW_MEMORY_EVIDENCE_EXECUTION_COVERAGE_POLICY_V1,
    status: requirements.every((requirement) => requirement.status === "closed")
      ? ("closed" as const)
      : ("open" as const),
    selectorSnapshotRevision: input.selectorSnapshot.snapshotRevision,
    notebookPolicyVersion: input.notebook.policyVersion,
    closureAuditRevision: closurePassed
      ? (input.closureAuditRevision as string)
      : null,
    requirements,
  };
  return Object.freeze({
    ...identity,
    certificateRevision: hashCanonicalJsonV1(identity as never),
  });
}

export function validateMemoryEvidenceExecutionCoverageCertificateV1(
  certificate: MemoryEvidenceExecutionCoverageCertificateV1,
): void {
  if (
    certificate.policyVersion !==
      PAW_MEMORY_EVIDENCE_EXECUTION_COVERAGE_POLICY_V1 ||
    !certificate.selectorSnapshotRevision.trim() ||
    certificate.requirements.length < 1 ||
    certificate.requirements.length > 4 ||
    new Set(certificate.requirements.map((item) => item.requirementId)).size !==
      certificate.requirements.length
  ) {
    throw namedError("MemoryEvidenceExecutionCoverageCertificateInvalid");
  }
  for (const requirement of certificate.requirements) {
    const { proofRevision, ...identity } = requirement;
    if (
      !requirement.requirementId.trim() ||
      !requirement.requirementRevision.trim() ||
      !requirement.temporalBindingRevision.trim() ||
      !requirement.windowRevision.trim() ||
      !new Set<MemoryEvidenceExecutionCompletionBasisV1>([
        "finite_endpoint_exact",
        "frontier_complete",
        "bounded_window_lookup",
        "closed_world_collection",
        "legacy_closed_world",
      ]).has(requirement.completionBasis) ||
      !requirement.supportingEvidenceSetRevision.trim() ||
      !requirement.selectedEvidenceSetRevision.trim() ||
      !requirement.executableAdmissionEvidenceSetRevision.trim() ||
      !requirement.notebookCoverageRevision.trim() ||
      !Number.isInteger(requirement.selectedEvidenceCount) ||
      requirement.selectedEvidenceCount < 0 ||
      !Number.isInteger(requirement.executableAdmissionEvidenceCount) ||
      requirement.executableAdmissionEvidenceCount < 0 ||
      !Number.isInteger(requirement.independentEvidenceCount) ||
      requirement.independentEvidenceCount < 0 ||
      !Number.isInteger(requirement.closureEvidenceCount) ||
      requirement.closureEvidenceCount < 0 ||
      !Number.isInteger(requirement.minimumEvidence) ||
      requirement.minimumEvidence < 1 ||
      new Set(requirement.reasonCodes).size !==
        requirement.reasonCodes.length ||
      requirement.status !==
        (requirement.reasonCodes.length === 0 ? "closed" : "open") ||
      hashCanonicalJsonV1({
        schemaVersion: "paw.memory-requirement-window.v1",
        requirementId: requirement.requirementId,
        temporalBindingRevision: requirement.temporalBindingRevision,
      } as never) !== requirement.windowRevision ||
      hashCanonicalJsonV1(identity as never) !== proofRevision
    ) {
      throw namedError("MemoryEvidenceExecutionCoverageCertificateInvalid");
    }
  }
  const { certificateRevision, ...identity } = certificate;
  if (
    certificate.status !==
      (certificate.requirements.every(
        (requirement) => requirement.status === "closed",
      )
        ? "closed"
        : "open") ||
    hashCanonicalJsonV1(identity as never) !== certificateRevision
  ) {
    throw namedError("MemoryEvidenceExecutionCoverageCertificateInvalid");
  }
}

function executionCompletionBasis(
  intent: MemoryEvidenceQueryIntentV3,
  requirement: MemoryEvidenceRequirementV3,
  temporal: MemoryEvidenceBoundTemporalConstraintV1,
): MemoryEvidenceExecutionCompletionBasisV1 {
  if (temporal.durationRequest) return "finite_endpoint_exact";
  if (
    requirement.temporalMode === "history" ||
    requirement.coverageMode === "all" ||
    requirement.coverageMode === "convergent" ||
    intent.answerShape === "aggregate"
  ) {
    return "closed_world_collection";
  }
  if (
    requirement.temporalMode === "latest" ||
    requirement.temporalMode === "as_of"
  ) {
    return "frontier_complete";
  }
  if (
    temporal.queryScopeInterval &&
    (requirement.temporalMode === "range" ||
      requirement.temporalMode === "any") &&
    (intent.answerShape === "lookup" || intent.answerShape === "compare")
  ) {
    return "bounded_window_lookup";
  }
  return "legacy_closed_world";
}

function sameSet(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): boolean {
  return left.size === right.size && [...left].every((item) => right.has(item));
}

function hasUniqueNonEmptyRefs(refs: readonly string[]): boolean {
  return (
    refs.every((evidenceRef) => evidenceRef.trim().length > 0) &&
    new Set(refs).size === refs.length
  );
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}
