import { hashCanonicalJsonV1 } from "./canonical.js";
import type { MemoryEvidenceNotebookV1 } from "./evidence-contracts.js";
import type { MemoryEvidenceRequirementV3 } from "./query-plan-contracts.js";
import type { MemorySelectorExecutionSnapshotV1 } from "./selector-execution-snapshot-v1.js";

export const PAW_MEMORY_EVIDENCE_EXECUTION_COVERAGE_POLICY_V1 =
  "paw.memory-evidence-execution-coverage.v1:selector-notebook-closure-proof" as const;

export interface MemoryEvidenceExecutionRequirementCoverageV1 {
  readonly requirementId: string;
  readonly requirementRevision: string;
  readonly temporalBindingRevision: string;
  readonly windowRevision: string;
  readonly status: "closed" | "open";
  readonly selectedEvidenceCount: number;
  readonly independentEvidenceCount: number;
  readonly closureEvidenceCount: number;
  readonly minimumIndependentEvidence: number;
  readonly supportingEvidenceSetRevision: string;
  readonly selectedEvidenceSetRevision: string;
  /** Binds the exact notebook row, including historical and unresolved refs. */
  readonly notebookCoverageRevision: string;
  readonly reasonCodes: readonly (
    | "selector_group_uncommitted"
    | "selector_requirement_unassessed"
    | "supporting_evidence_missing"
    | "notebook_requirement_open"
    | "notebook_unresolved_peer"
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

/**
 * Compiles a content-free closed-world proof from three independent gates:
 * post-authority selector commitment, notebook cardinality, and a passing
 * semantic closure audit. `coverageMode=all` alone is never a certificate.
 */
export function compileMemoryEvidenceExecutionCoverageCertificateV1(input: {
  readonly requirements: readonly MemoryEvidenceRequirementV3[];
  readonly selectorSnapshot: MemorySelectorExecutionSnapshotV1;
  readonly notebook: MemoryEvidenceNotebookV1;
  readonly closureAuditStatus:
    | "not_needed"
    | "not_configured"
    | "completed"
    | "fallback";
  readonly closureVerdict?: "pass" | "repair" | "insufficient";
  readonly closureAuditRevision?: string;
}): MemoryEvidenceExecutionCoverageCertificateV1 {
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
  if (
    input.requirements.length < 1 ||
    input.requirements.length > 4 ||
    executionByRequirement.size !== input.requirements.length ||
    notebookByRequirement.size !== input.requirements.length ||
    input.requirements.some(
      (requirement) =>
        !executionByRequirement.has(requirement.requirementId) ||
        !notebookByRequirement.has(requirement.requirementId),
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
      if (!execution || !coverage) {
        throw namedError("MemoryEvidenceExecutionCoverageInputInvalid");
      }
      const supporting = new Set(
        execution.requirement.assessment?.supportingEvidenceRefs ?? [],
      );
      const minimumIndependentEvidence = requirement.minimumEvidence ?? 1;
      const reasons: MemoryEvidenceExecutionRequirementCoverageV1["reasonCodes"][number][] =
        [];
      if (execution.groupStatus !== "committed") {
        reasons.push("selector_group_uncommitted");
      }
      if (execution.requirement.status !== "assessed") {
        reasons.push("selector_requirement_unassessed");
      }
      if (supporting.size === 0) reasons.push("supporting_evidence_missing");
      if (coverage.status !== "covered")
        reasons.push("notebook_requirement_open");
      if (coverage.unresolvedEvidenceRefs.length > 0) {
        reasons.push("notebook_unresolved_peer");
      }
      if (coverage.independentEvidenceCount < minimumIndependentEvidence) {
        reasons.push("minimum_evidence_unsatisfied");
      }
      if (
        coverage.selectedEvidenceRefs.some(
          (evidenceRef) => !supporting.has(evidenceRef),
        )
      ) {
        reasons.push("selected_evidence_not_supported");
      }
      if (!closurePassed) reasons.push("closure_audit_not_passed");
      const reasonCodes = Object.freeze([...new Set(reasons)]);
      const supportingEvidenceSetRevision = hashCanonicalJsonV1({
        schemaVersion: "paw.memory-supporting-evidence-set.v1",
        evidenceRefs: Object.freeze([...supporting].sort()),
      } as never);
      const selectedEvidenceSetRevision = hashCanonicalJsonV1({
        schemaVersion: "paw.memory-selected-evidence-set.v1",
        evidenceRefs: Object.freeze([...coverage.selectedEvidenceRefs].sort()),
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
        status:
          reasonCodes.length === 0 ? ("closed" as const) : ("open" as const),
        selectedEvidenceCount: coverage.selectedEvidenceRefs.length,
        independentEvidenceCount: coverage.independentEvidenceCount,
        closureEvidenceCount: coverage.closureEvidenceCount,
        minimumIndependentEvidence,
        supportingEvidenceSetRevision,
        selectedEvidenceSetRevision,
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
      !requirement.supportingEvidenceSetRevision.trim() ||
      !requirement.selectedEvidenceSetRevision.trim() ||
      !requirement.notebookCoverageRevision.trim() ||
      !Number.isInteger(requirement.selectedEvidenceCount) ||
      requirement.selectedEvidenceCount < 0 ||
      !Number.isInteger(requirement.independentEvidenceCount) ||
      requirement.independentEvidenceCount < 0 ||
      !Number.isInteger(requirement.closureEvidenceCount) ||
      requirement.closureEvidenceCount < 0 ||
      !Number.isInteger(requirement.minimumIndependentEvidence) ||
      requirement.minimumIndependentEvidence < 1 ||
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

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}
