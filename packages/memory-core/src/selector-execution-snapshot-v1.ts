import { hashCanonicalJsonV1 } from "./canonical.js";
import {
  PAW_MEMORY_EVIDENCE_SELECTOR_GROUP_POLICY_V1,
  compileMemoryEvidenceSelectorGroupsV1,
} from "./evidence-selector-groups.js";
import type { MemoryEvidenceTriageAssessmentV1 } from "./evidence-support-selector.js";
import type {
  MemoryEvidenceBoundTemporalConstraintV1,
  MemoryEvidenceQueryIntentV3,
  MemoryEvidenceRequirementV3,
} from "./query-plan-contracts.js";

export const PAW_MEMORY_SELECTOR_EXECUTION_SNAPSHOT_POLICY_V1 =
  "paw.memory-selector-execution-snapshot.v2:exact-candidate-partition" as const;

export type MemorySelectorExecutionGroupStatusV1 =
  | "committed"
  | "failed"
  | "blocked";

export type MemorySelectorRequirementExecutionStatusV1 =
  | "assessed"
  | "unassessed_group_failed"
  | "blocked";

export interface MemorySelectorExecutionRequirementV1 {
  readonly requirementId: string;
  readonly requirementRevision: string;
  readonly temporalBindingRevision: string;
  readonly candidateScopeRevision: string;
  readonly candidateEvidenceCount: number;
  readonly assessedEvidenceCount: number;
  readonly assessmentPartitionComplete: boolean;
  readonly status: MemorySelectorRequirementExecutionStatusV1;
  readonly resolvedRole?: "user" | "assistant";
  readonly assessment?: Readonly<MemoryEvidenceTriageAssessmentV1>;
}

export interface MemorySelectorExecutionGroupV1 {
  readonly groupId: string;
  readonly status: MemorySelectorExecutionGroupStatusV1;
  readonly requirementIds: readonly string[];
  readonly failureCodes: readonly string[];
  readonly requirements: readonly MemorySelectorExecutionRequirementV1[];
  readonly groupRevision: string;
}

export interface MemorySelectorExecutionSnapshotV1 {
  readonly policyVersion: typeof PAW_MEMORY_SELECTOR_EXECUTION_SNAPSHOT_POLICY_V1;
  readonly planRevision: string;
  readonly groupPolicyRevision: string;
  readonly selectorVersion: string;
  readonly selectionRevision: string;
  readonly committedAttempt: "augmented" | "baseline" | "none";
  readonly attemptCount: 1 | 2;
  readonly originRevision: string;
  readonly lockedSourceRevision: string;
  readonly groups: readonly MemorySelectorExecutionGroupV1[];
  readonly postAuthorityAssessmentRevision: string;
  readonly snapshotRevision: string;
}

export interface MemorySelectorExecutionGroupInputV1 {
  readonly groupId: string;
  readonly requirementIds: readonly string[];
  readonly status: MemorySelectorExecutionGroupStatusV1;
  readonly assessments: readonly Readonly<MemoryEvidenceTriageAssessmentV1>[];
  readonly failureCodes?: readonly string[];
}

/**
 * Freezes selector settlement as a group-atomic execution snapshot. A failed
 * requirement is represented as unassessed, never as an assessed empty set.
 */
export function compileMemorySelectorExecutionSnapshotV1(input: {
  readonly query: string;
  readonly intent: MemoryEvidenceQueryIntentV3;
  readonly requirements: readonly MemoryEvidenceRequirementV3[];
  readonly temporalConstraints: readonly MemoryEvidenceBoundTemporalConstraintV1[];
  readonly candidateScopes: readonly Readonly<{
    requirementId: string;
    evidenceRefs: readonly string[];
  }>[];
  readonly lockedSourceIds: readonly string[];
  readonly originRevision: string;
  readonly selectorVersion: string;
  readonly selectionRevision: string;
  readonly committedAttempt: "augmented" | "baseline" | "none";
  readonly attemptCount: 1 | 2;
  readonly groups: readonly MemorySelectorExecutionGroupInputV1[];
}): MemorySelectorExecutionSnapshotV1 {
  if (
    !input.query.trim() ||
    !input.originRevision.trim() ||
    !input.selectorVersion.trim() ||
    !input.selectionRevision.trim() ||
    (input.committedAttempt === "none" &&
      input.groups.some((group) => group.status === "committed")) ||
    input.requirements.length < 1 ||
    input.requirements.length > 4 ||
    input.temporalConstraints.length !== input.requirements.length ||
    input.candidateScopes.length !== input.requirements.length ||
    input.groups.length < 1 ||
    new Set(input.lockedSourceIds).size !== input.lockedSourceIds.length
  ) {
    throw namedError("MemorySelectorExecutionSnapshotInputInvalid");
  }
  const requirementById = new Map(
    input.requirements.map((requirement) => [
      requirement.requirementId,
      requirement,
    ]),
  );
  const temporalByRequirement = new Map(
    input.requirements.map((requirement, index) => [
      requirement.requirementId,
      input.temporalConstraints[index],
    ]),
  );
  const scopeByRequirement = new Map(
    input.candidateScopes.map((scope) => [scope.requirementId, scope]),
  );
  if (
    requirementById.size !== input.requirements.length ||
    temporalByRequirement.size !== input.requirements.length ||
    scopeByRequirement.size !== input.requirements.length ||
    input.requirements.some(
      (requirement) =>
        !requirement.requirementId.trim() ||
        !temporalByRequirement.get(requirement.requirementId) ||
        !scopeByRequirement.get(requirement.requirementId),
    )
  ) {
    throw namedError("MemorySelectorExecutionSnapshotInputInvalid");
  }

  const seenGroups = new Set<string>();
  const seenRequirements = new Set<string>();
  const expectedGroups = compileMemoryEvidenceSelectorGroupsV1({
    intent: input.intent,
    requirements: input.requirements,
  });
  if (
    expectedGroups.length !== input.groups.length ||
    input.groups.some(
      (group, index) =>
        group.groupId !== expectedGroups[index]?.groupId ||
        group.requirementIds.length !==
          expectedGroups[index]?.requirementIds.length ||
        group.requirementIds.some(
          (requirementId, requirementIndex) =>
            requirementId !==
            expectedGroups[index]?.requirementIds[requirementIndex],
        ),
    )
  ) {
    throw namedError("MemorySelectorExecutionSnapshotGroupInvalid");
  }
  const groups = input.groups.map((group) => {
    if (
      !group.groupId.trim() ||
      seenGroups.has(group.groupId) ||
      group.requirementIds.length < 1 ||
      new Set(group.requirementIds).size !== group.requirementIds.length ||
      group.requirementIds.some(
        (requirementId) =>
          !requirementById.has(requirementId) ||
          seenRequirements.has(requirementId),
      ) ||
      (group.status === "committed" &&
        group.assessments.length !== group.requirementIds.length) ||
      (group.status !== "committed" && group.assessments.length !== 0)
    ) {
      throw namedError("MemorySelectorExecutionSnapshotGroupInvalid");
    }
    const failureCodes = Object.freeze(
      [...new Set(group.failureCodes ?? [])].sort(),
    );
    if (
      failureCodes.some(
        (code) => !/^[A-Za-z][A-Za-z0-9_]{0,95}$/u.test(code),
      ) ||
      (group.status === "committed" && failureCodes.length > 0)
    ) {
      throw namedError("MemorySelectorExecutionSnapshotGroupInvalid");
    }
    seenGroups.add(group.groupId);
    for (const requirementId of group.requirementIds) {
      seenRequirements.add(requirementId);
    }
    const assessmentByRequirement = new Map(
      group.assessments.map((assessment) => [
        assessment.requirementId,
        assessment,
      ]),
    );
    if (
      assessmentByRequirement.size !== group.assessments.length ||
      group.assessments.some(
        (assessment) =>
          !group.requirementIds.includes(assessment.requirementId),
      )
    ) {
      throw namedError("MemorySelectorExecutionSnapshotGroupInvalid");
    }
    const requirements = Object.freeze(
      group.requirementIds.map((requirementId) => {
        const requirement = requirementById.get(requirementId);
        const temporal = temporalByRequirement.get(requirementId);
        const scope = scopeByRequirement.get(requirementId);
        if (!requirement || !temporal || !scope) {
          throw namedError("MemorySelectorExecutionSnapshotInputInvalid");
        }
        const assessment = assessmentByRequirement.get(requirementId);
        if (group.status === "committed" && !assessment) {
          throw namedError("MemorySelectorExecutionSnapshotGroupInvalid");
        }
        if (assessment) validateAssessment(assessment, scope.evidenceRefs);
        const candidateEvidenceCount = new Set(scope.evidenceRefs).size;
        const assessedEvidenceCount = assessment
          ? new Set([
              ...assessment.supportingEvidenceRefs,
              ...assessment.contradictingEvidenceRefs,
              ...assessment.unknownEvidenceRefs,
            ]).size
          : 0;
        const status: MemorySelectorRequirementExecutionStatusV1 =
          group.status === "committed"
            ? "assessed"
            : group.status === "failed"
              ? "unassessed_group_failed"
              : "blocked";
        const resolvedRole = assessment
          ? resolveAssessmentRole(requirement, assessment)
          : undefined;
        return Object.freeze({
          requirementId,
          requirementRevision: hashCanonicalJsonV1(requirement as never),
          temporalBindingRevision: temporal.bindingRevision,
          candidateScopeRevision: hashCanonicalJsonV1({
            schemaVersion: "paw.memory-selector-candidate-scope.v1",
            requirementId,
            evidenceRefs: Object.freeze([...scope.evidenceRefs]),
          } as never),
          candidateEvidenceCount,
          assessedEvidenceCount,
          assessmentPartitionComplete:
            assessment !== undefined &&
            assessedEvidenceCount === candidateEvidenceCount,
          status,
          ...(resolvedRole === undefined ? {} : { resolvedRole }),
          ...(assessment === undefined ? {} : { assessment }),
        });
      }),
    );
    const identity = {
      groupId: group.groupId,
      status: group.status,
      requirementIds: Object.freeze([...group.requirementIds]),
      failureCodes,
      requirements,
    };
    return Object.freeze({
      ...identity,
      groupRevision: hashCanonicalJsonV1(identity as never),
    });
  });
  if (seenRequirements.size !== input.requirements.length) {
    throw namedError("MemorySelectorExecutionSnapshotGroupInvalid");
  }

  const planRevision = hashCanonicalJsonV1({
    schemaVersion: "paw.memory-query-plan-execution.v1",
    queryRevision: hashCanonicalJsonV1(input.query),
    intent: input.intent,
    requirements: input.requirements,
  } as never);
  const groupPolicyRevision = hashCanonicalJsonV1({
    policyVersion: PAW_MEMORY_EVIDENCE_SELECTOR_GROUP_POLICY_V1,
    groups: groups.map((group) => ({
      groupId: group.groupId,
      requirementIds: group.requirementIds,
    })),
  } as never);
  const lockedSourceRevision = hashCanonicalJsonV1({
    schemaVersion: "paw.memory-locked-source-set.v1",
    lockedSourceIds: Object.freeze([...input.lockedSourceIds]),
  } as never);
  const postAuthorityAssessmentRevision = hashCanonicalJsonV1({
    schemaVersion: "paw.memory-post-authority-assessments.v1",
    groups: groups.map((group) => ({
      groupId: group.groupId,
      status: group.status,
      assessments: group.requirements.flatMap((requirement) =>
        requirement.assessment ? [requirement.assessment] : [],
      ),
    })),
  } as never);
  const identity = {
    policyVersion: PAW_MEMORY_SELECTOR_EXECUTION_SNAPSHOT_POLICY_V1,
    planRevision,
    groupPolicyRevision,
    selectorVersion: input.selectorVersion,
    selectionRevision: input.selectionRevision,
    committedAttempt: input.committedAttempt,
    attemptCount: input.attemptCount,
    originRevision: input.originRevision,
    lockedSourceRevision,
    groups: Object.freeze(groups),
    postAuthorityAssessmentRevision,
  };
  return Object.freeze({
    ...identity,
    snapshotRevision: hashCanonicalJsonV1(identity as never),
  });
}

function validateAssessment(
  assessment: Readonly<MemoryEvidenceTriageAssessmentV1>,
  scopedEvidenceRefs: readonly string[],
): void {
  const scope = new Set(scopedEvidenceRefs);
  const partition = [
    ...assessment.supportingEvidenceRefs,
    ...assessment.contradictingEvidenceRefs,
    ...assessment.unknownEvidenceRefs,
  ];
  if (
    !assessment.requirementId.trim() ||
    new Set(partition).size !== partition.length ||
    partition.some((evidenceRef) => !scope.has(evidenceRef)) ||
    assessment.evidenceDispositions?.some(
      (item) =>
        item.requirementId !== assessment.requirementId ||
        !scope.has(item.evidenceRef),
    )
  ) {
    throw namedError("MemorySelectorExecutionSnapshotAssessmentInvalid");
  }
}

function resolveAssessmentRole(
  requirement: Readonly<MemoryEvidenceRequirementV3>,
  assessment: Readonly<MemoryEvidenceTriageAssessmentV1>,
): "user" | "assistant" | undefined {
  if (requirement.roleConstraint !== "any") return requirement.roleConstraint;
  const supporting = new Set(assessment.supportingEvidenceRefs);
  const roles = new Set(
    (assessment.evidenceDispositions ?? [])
      .filter(
        (item) =>
          item.disposition === "supporting" && supporting.has(item.evidenceRef),
      )
      .map((item) => item.resolvedRole),
  );
  if (roles.has("unknown") || roles.size > 1) {
    throw namedError("MemorySelectorExecutionSnapshotRoleInvalid");
  }
  const role = [...roles][0];
  return role === "user" || role === "assistant" ? role : undefined;
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}
