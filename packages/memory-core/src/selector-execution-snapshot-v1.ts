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
  /** Host-only receipt for a complete ordinal cohort settlement. */
  readonly ordinalSettlementProof?: MemoryOrdinalSettlementProofV1;
  readonly snapshotRevision: string;
}

export interface MemoryOrdinalSettlementProofV1 {
  readonly proofVersion: "paw.memory-ordinal-settlement-proof.v1";
  readonly constraintRevision: string;
  /** Query-only semantic admission bound before ordinal-specific retrieval. */
  readonly admissionRevision: string;
  readonly cohortRevisions: readonly string[];
  readonly sourceSettlements: readonly Readonly<{
    sourceId: string;
    status: "below" | "unknown" | "winner";
    knownCount: number;
    /** Host-only, content-free reason for a source admission failure. */
    failureCode?: "raw_pair_body_too_large";
    winnerEvidenceRef?: string;
    withinOutputOrdinal?: number;
  }>[];
  readonly globalStatus: "winner" | "missing" | "ambiguous" | "unknown";
  readonly winnerEvidenceRef?: string;
  readonly withinOutputOrdinal?: number;
  readonly authorityScope: "post_settlement_winner_only";
  readonly proofRevision: string;
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
  readonly ordinalSettlementProof?: MemoryOrdinalSettlementProofV1;
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
  validateOrdinalSettlementProof(input.ordinalSettlementProof, {
    groups,
    candidateScopes: input.candidateScopes,
  });

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
    ...(input.ordinalSettlementProof === undefined
      ? {}
      : { ordinalSettlementProof: input.ordinalSettlementProof }),
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
    (assessment.dialogueOrdinalSelection !== undefined &&
      (!/^[a-f0-9]{64}$/u.test(
        assessment.dialogueOrdinalSelection.constraintRevision,
      ) ||
        !Number.isSafeInteger(
          assessment.dialogueOrdinalSelection.withinOutputOrdinal,
        ) ||
        assessment.dialogueOrdinalSelection.withinOutputOrdinal < 1 ||
        assessment.supportingEvidenceRefs.length !== 1)) ||
    assessment.evidenceDispositions?.some(
      (item) =>
        item.requirementId !== assessment.requirementId ||
        !scope.has(item.evidenceRef),
    )
  ) {
    throw namedError("MemorySelectorExecutionSnapshotAssessmentInvalid");
  }
}

function validateOrdinalSettlementProof(
  proof: MemoryOrdinalSettlementProofV1 | undefined,
  input: {
    readonly groups: readonly MemorySelectorExecutionGroupV1[];
    readonly candidateScopes: readonly Readonly<{
      requirementId: string;
      evidenceRefs: readonly string[];
    }>[];
  },
): void {
  if (proof === undefined) return;
  const sourceIds = new Set(
    proof.sourceSettlements.map((item) => item.sourceId),
  );
  const cohortRevisions = new Set(proof.cohortRevisions);
  if (
    proof.proofVersion !== "paw.memory-ordinal-settlement-proof.v1" ||
    !/^[a-f0-9]{64}$/u.test(proof.constraintRevision) ||
    !/^[a-f0-9]{64}$/u.test(proof.admissionRevision) ||
    cohortRevisions.size !== proof.cohortRevisions.length ||
    proof.cohortRevisions.some(
      (revision) => !/^[a-f0-9]{64}$/u.test(revision),
    ) ||
    proof.sourceSettlements.length < 1 ||
    sourceIds.size !== proof.sourceSettlements.length ||
    proof.sourceSettlements.some(
      (item) =>
        !item.sourceId.trim() ||
        !Number.isSafeInteger(item.knownCount) ||
        item.knownCount < 0 ||
        (item.failureCode !== undefined &&
          (item.status !== "unknown" ||
            item.failureCode !== "raw_pair_body_too_large")) ||
        (item.status === "winner" &&
          (!item.winnerEvidenceRef?.trim() ||
            !Number.isSafeInteger(item.withinOutputOrdinal) ||
            (item.withinOutputOrdinal ?? 0) < 1)) ||
        (item.status !== "winner" &&
          (item.winnerEvidenceRef !== undefined ||
            item.withinOutputOrdinal !== undefined)),
    ) ||
    !/^[a-f0-9]{64}$/u.test(proof.proofRevision) ||
    proof.authorityScope !== "post_settlement_winner_only"
  ) {
    throw namedError("MemorySelectorExecutionSnapshotOrdinalProofInvalid");
  }
  const winner = proof.sourceSettlements.filter(
    (item) => item.status === "winner",
  );
  const hasUnknown = proof.sourceSettlements.some(
    (item) => item.status === "unknown",
  );
  const snapshotWinner =
    proof.globalStatus === "winner" ? proof.winnerEvidenceRef : undefined;
  if (
    (proof.globalStatus === "winner" &&
      (winner.length !== 1 ||
        hasUnknown ||
        !snapshotWinner?.trim() ||
        winner[0]?.winnerEvidenceRef !== snapshotWinner ||
        winner[0]?.withinOutputOrdinal !== proof.withinOutputOrdinal)) ||
    (proof.globalStatus === "ambiguous" && winner.length < 2) ||
    (proof.globalStatus === "missing" && (winner.length !== 0 || hasUnknown)) ||
    (proof.globalStatus === "unknown" && (!hasUnknown || winner.length > 1)) ||
    (proof.globalStatus !== "winner" &&
      (proof.winnerEvidenceRef !== undefined ||
        proof.withinOutputOrdinal !== undefined))
  ) {
    throw namedError("MemorySelectorExecutionSnapshotOrdinalProofInvalid");
  }
  const group = input.groups[0];
  const scope = input.candidateScopes[0];
  if (
    input.groups.length !== 1 ||
    !group ||
    !scope ||
    (proof.globalStatus === "winner"
      ? group.status !== "committed" ||
        scope.evidenceRefs.length !== 1 ||
        scope.evidenceRefs[0] !== proof.winnerEvidenceRef
      : group.status !== "failed")
  ) {
    throw namedError("MemorySelectorExecutionSnapshotOrdinalProofInvalid");
  }
  const identity = {
    proofVersion: proof.proofVersion,
    constraintRevision: proof.constraintRevision,
    admissionRevision: proof.admissionRevision,
    cohortRevisions: proof.cohortRevisions,
    sourceSettlements: proof.sourceSettlements,
    globalStatus: proof.globalStatus,
    ...(proof.winnerEvidenceRef === undefined
      ? {}
      : { winnerEvidenceRef: proof.winnerEvidenceRef }),
    ...(proof.withinOutputOrdinal === undefined
      ? {}
      : { withinOutputOrdinal: proof.withinOutputOrdinal }),
    authorityScope: proof.authorityScope,
  };
  if (proof.proofRevision !== hashCanonicalJsonV1(identity as never)) {
    throw namedError("MemorySelectorExecutionSnapshotOrdinalProofInvalid");
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
