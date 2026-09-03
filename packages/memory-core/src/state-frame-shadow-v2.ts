import { hashCanonicalJsonV1 } from "./canonical.js";
import {
  type MemoryDialogueCertificateRegistryV1,
  validateMemoryDialogueCertificateRegistryV1,
} from "./dialogue-certificate.js";
import type { MemoryEvidenceNotebookHitV1 } from "./evidence-contracts.js";
import type {
  MemoryEvidenceExecutionCoverageCertificateV1,
  MemoryEvidenceExecutionCoverageCompilationInputV1,
} from "./evidence-execution-coverage-v1.js";
import {
  type MemoryEvidenceExecutionProgramV1,
  compileMemoryEvidenceExecutionProgramV1,
} from "./evidence-execution-program-v1.js";
import {
  type MemoryEvidenceExecutionResultV1,
  executeMemoryEvidenceProgramV1,
} from "./evidence-execution-runtime-v1.js";
import {
  type MemoryEvidenceReaderProjectionBuildResultV1,
  buildMemoryEvidenceReaderProjectionV1,
} from "./evidence-reader-projection-v1.js";
import type { MemoryQueryAnswerOriginV1 } from "./query-answer-origin.js";
import type {
  MemoryEvidenceBoundTemporalConstraintV1,
  MemoryEvidenceQueryIntentV3,
  MemoryEvidenceRequirementV3,
} from "./query-plan-contracts.js";
import type { MemorySelectorExecutionSnapshotV1 } from "./selector-execution-snapshot-v1.js";
import {
  type MemoryStateBindingCertificateValidationInputV1,
  type MemoryStateValidatedObservationV1,
  PAW_MEMORY_STATE_BINDING_CERTIFICATE_POLICY_V1,
  compileMemoryStateBindingCertificatesV1,
} from "./state-binding-certificate-v1.js";
import {
  type MemoryResolvedStateFrameV2,
  type MemoryStateBoundObservationV2,
  type MemoryStateSourceLockItemV2,
  compileMemoryStateSlotsV2,
  compileMemoryStateSourceLockV2,
  resolveMemoryStateFrameV2,
} from "./state-frame-v2.js";
import {
  type MemoryStateMechanicalBindingSummaryV1,
  PAW_MEMORY_STATE_MECHANICAL_BINDING_PROFILE_POLICY_V1,
  compileMemoryStateMechanicalBindingProfilesV1,
  summarizeMemoryStateMechanicalBindingProfilesV1,
} from "./state-mechanical-binding-profile-v1.js";
import {
  type MemoryStateObservationBinderV2,
  validateMemoryStateObservationBindingBoundaryV2,
} from "./state-observation-binder-v2.js";
import {
  type MemoryStateObservationVerifierV2,
  validateMemoryStateObservationVerificationBoundaryV2,
} from "./state-observation-verifier-v2.js";

export const PAW_MEMORY_STATE_FRAME_SHADOW_POLICY_V2 =
  "paw.memory-state-frame-shadow.v2:locked-fair-materialization" as const;

export interface MemoryStateFrameShadowResultV2 {
  readonly policyVersion: typeof PAW_MEMORY_STATE_FRAME_SHADOW_POLICY_V2;
  readonly status: "completed" | "partial" | "fallback";
  readonly binderVersion: string;
  readonly verifierVersion: string;
  readonly bindingRevision?: string;
  readonly verificationRevision?: string;
  readonly bindingCertificatePolicyVersion: typeof PAW_MEMORY_STATE_BINDING_CERTIFICATE_POLICY_V1;
  readonly bindingCertificateCount: number;
  readonly mechanicalBindingProfilePolicyVersion: typeof PAW_MEMORY_STATE_MECHANICAL_BINDING_PROFILE_POLICY_V1;
  readonly mechanicalBindingSummary: MemoryStateMechanicalBindingSummaryV1;
  readonly stateShadowAuditRevision?: string;
  readonly frame?: MemoryResolvedStateFrameV2;
  /** Shadow-only typed DAG; never participates in the formal resolution hash. */
  readonly executionProgram?: MemoryEvidenceExecutionProgramV1;
  readonly executionResult?: MemoryEvidenceExecutionResultV1;
  /** Fail-closed shadow packet; adapters must opt in before reader injection. */
  readonly readerProjectionBuild?: MemoryEvidenceReaderProjectionBuildResultV1;
  readonly groupCount: number;
  readonly committedGroupCount: number;
  readonly failedGroupCount: number;
  readonly selectorGroupCount: number;
  readonly selectorCommittedGroupCount: number;
  readonly selectorFailedGroupCount: number;
  readonly unassessedRequirementCount: number;
  readonly slotCount: number;
  readonly completeSlotCount: number;
  readonly partialSlotCount: number;
  readonly missingSlotCount: number;
  readonly conflictSlotCount: number;
  readonly sourceLockItemCount: number;
  readonly proposedObservationCount: number;
  readonly validatedObservationCount: number;
  readonly rejectedObservationCount: number;
  readonly unsupportedCompleteSlotCount: number;
  readonly unsupportedDerivedOperationCount: number;
  readonly assistantValidatedObservationCount: number;
  readonly uncertifiedAssistantValidatedObservationCount: number;
}

export async function buildMemoryStateFrameShadowV2(input: {
  readonly binder: MemoryStateObservationBinderV2;
  readonly verifier: MemoryStateObservationVerifierV2;
  readonly query: string;
  readonly intent: MemoryEvidenceQueryIntentV3;
  readonly requirements: readonly MemoryEvidenceRequirementV3[];
  readonly origin: MemoryQueryAnswerOriginV1;
  readonly temporalConstraints: readonly MemoryEvidenceBoundTemporalConstraintV1[];
  readonly requirementHits: readonly (readonly MemoryEvidenceNotebookHitV1[])[];
  /** Post-authority group transaction state; flat assessments are insufficient. */
  readonly selectorExecutionSnapshot: MemorySelectorExecutionSnapshotV1;
  readonly lockedSourceIds: readonly string[];
  readonly dialogueCertificateRegistry: MemoryDialogueCertificateRegistryV1;
  readonly executionCoverageCertificate?: MemoryEvidenceExecutionCoverageCertificateV1;
  readonly executionCoverageValidationContext?: MemoryEvidenceExecutionCoverageCompilationInputV1;
  readonly signal: AbortSignal;
}): Promise<MemoryStateFrameShadowResultV2> {
  if (
    input.requirements.length !== input.temporalConstraints.length ||
    input.requirements.length !== input.requirementHits.length ||
    (input.executionCoverageCertificate === undefined) !==
      (input.executionCoverageValidationContext === undefined) ||
    input.selectorExecutionSnapshot.originRevision !==
      input.origin.originRevision ||
    input.selectorExecutionSnapshot.lockedSourceRevision !==
      hashCanonicalJsonV1({
        schemaVersion: "paw.memory-locked-source-set.v1",
        lockedSourceIds: Object.freeze([...input.lockedSourceIds]),
      } as never)
  ) {
    throw namedError("MemoryStateFrameShadowInputInvalid");
  }
  const temporalConstraints = new Map(
    input.requirements.map((requirement, index) => {
      const temporal = input.temporalConstraints[index];
      if (!temporal) throw namedError("MemoryStateFrameShadowInputInvalid");
      return [requirement.requirementId, temporal] as const;
    }),
  );
  validateMemoryDialogueCertificateRegistryV1(
    input.dialogueCertificateRegistry,
  );
  if (
    input.dialogueCertificateRegistry.originRevision !==
      input.origin.originRevision ||
    input.dialogueCertificateRegistry.lockedSourceIds.length !==
      input.lockedSourceIds.length ||
    input.dialogueCertificateRegistry.lockedSourceIds.some(
      (sourceId, index) => sourceId !== input.lockedSourceIds[index],
    )
  ) {
    throw namedError("MemoryStateFrameShadowCertificateInvalid");
  }
  const certificateByAssistantRef = new Map(
    input.dialogueCertificateRegistry.certificates.map((certificate) => [
      certificate.assistant.evidenceRef,
      certificate,
    ]),
  );
  const executionByRequirement = new Map(
    input.selectorExecutionSnapshot.groups.flatMap((group) =>
      group.requirements.map(
        (requirement) => [requirement.requirementId, requirement] as const,
      ),
    ),
  );
  if (
    executionByRequirement.size !== input.requirements.length ||
    input.requirements.some((requirement, index) => {
      const execution = executionByRequirement.get(requirement.requirementId);
      return (
        !execution ||
        execution.requirementRevision !==
          hashCanonicalJsonV1(requirement as never) ||
        execution.temporalBindingRevision !==
          input.temporalConstraints[index]?.bindingRevision
      );
    })
  ) {
    throw namedError("MemoryStateFrameShadowInputInvalid");
  }
  const stateRequirements = Object.freeze(
    input.requirements.map((requirement) => {
      const execution = executionByRequirement.get(requirement.requirementId);
      return requirement.roleConstraint === "any" && execution?.resolvedRole
        ? Object.freeze({
            ...requirement,
            roleConstraint: execution.resolvedRole,
          })
        : requirement;
    }),
  );
  const supportAssessments = Object.freeze(
    input.selectorExecutionSnapshot.groups.flatMap((group) =>
      group.status === "committed"
        ? group.requirements.flatMap((requirement) =>
            requirement.assessment ? [requirement.assessment] : [],
          )
        : [],
    ),
  );
  // A selector may deliberately leave an `any` role unresolved.  That is a
  // blocked execution leaf, not a structural frame error.  Compile state
  // slots only for requirements whose authority role was proven; the program
  // still retains every requirement and will fail the unresolved read closed.
  const slotRequirements = stateRequirements.filter(
    (requirement) => requirement.roleConstraint !== "any",
  );
  const slots =
    slotRequirements.length === 0
      ? Object.freeze([])
      : compileMemoryStateSlotsV2({
          query: input.query,
          intent: input.intent,
          requirements: slotRequirements,
          origin: input.origin,
          temporalConstraints,
        });
  const lockedSources = new Set(input.lockedSourceIds);
  const supportingRefsByRequirement = new Map(
    supportAssessments.map((assessment) => [
      assessment.requirementId,
      new Set(assessment.supportingEvidenceRefs),
    ]),
  );
  const hitByRef = new Map<string, MemoryEvidenceNotebookHitV1>();
  let totalChars = 0;
  const admittedRequirementIndexes = input.requirements.flatMap(
    (requirement, index) =>
      supportingRefsByRequirement.has(requirement.requirementId) ? [index] : [],
  );
  const maxDepth = Math.max(
    0,
    ...admittedRequirementIndexes.map(
      (index) => input.requirementHits[index]?.length ?? 0,
    ),
  );
  for (let depth = 0; depth < maxDepth && hitByRef.size < 32; depth += 1) {
    for (const requirementIndex of admittedRequirementIndexes) {
      const hits = input.requirementHits[requirementIndex] ?? [];
      const requirement = input.requirements[requirementIndex];
      const rawHit = hits[depth];
      const certificate = rawHit
        ? certificateByAssistantRef.get(rawHit.evidenceRef)
        : undefined;
      const hit =
        rawHit && certificate
          ? Object.freeze({
              ...rawHit,
              sourceId: certificate.sourceId,
              content: certificate.assistant.content,
              authority: "context_only" as const,
              sourceKind: "assistant_output" as const,
              turnOrder: certificate.assistant.turnOrder,
              ...(certificate.assistant.observedAt === undefined
                ? {}
                : { observedAt: certificate.assistant.observedAt }),
              contextEvidenceRefs: Object.freeze([
                certificate.assistant.evidenceRef,
              ]),
            })
          : rawHit;
      if (
        !hit ||
        !requirement ||
        !lockedSources.has(hit.sourceId) ||
        !supportingRefsByRequirement
          .get(requirement.requirementId)
          ?.has(hit.evidenceRef) ||
        (hit.sourceKind !== "user_input" &&
          hit.sourceKind !== "assistant_output")
      ) {
        continue;
      }
      // A source-local conversation bundle can contain neighboring turns with
      // different roles. Until the resolver exposes each hydrated turn as its
      // own immutable content address, binding a span inside that bundle would
      // incorrectly inherit the anchor's role. Only a single addressed turn
      // (or a non-conversation hit without a trace) is eligible here.
      if (
        hit.contextEvidenceRefs !== undefined &&
        (hit.contextEvidenceRefs.length !== 1 ||
          hit.contextEvidenceRefs[0] !== hit.evidenceRef)
      ) {
        continue;
      }
      const previous = hitByRef.get(hit.evidenceRef);
      if (previous) {
        if (
          previous.sourceId !== hit.sourceId ||
          previous.content !== hit.content ||
          previous.authority !== hit.authority ||
          previous.sourceKind !== hit.sourceKind
        ) {
          throw namedError("MemoryStateFrameShadowEvidenceConflict");
        }
        continue;
      }
      if (
        !hit.content.trim() ||
        hit.content.length > 16_384 ||
        totalChars + hit.content.length > 128 * 1_024
      ) {
        continue;
      }
      hitByRef.set(hit.evidenceRef, hit);
      totalChars += hit.content.length;
      if (hitByRef.size >= 32) break;
    }
  }
  const items: MemoryStateSourceLockItemV2[] = [...hitByRef.values()].map(
    (hit) => {
      const certificate = certificateByAssistantRef.get(hit.evidenceRef);
      return Object.freeze({
        sourceId: hit.sourceId,
        evidenceRef: hit.evidenceRef,
        content: hit.content,
        authority: hit.authority,
        role: hit.sourceKind === "assistant_output" ? "assistant" : "user",
        ...(hit.observedAt === undefined ? {} : { observedAt: hit.observedAt }),
        ...(hit.episodeOrder === undefined
          ? {}
          : { episodeOrder: hit.episodeOrder }),
        ...(hit.turnOrder === undefined ? {} : { turnOrder: hit.turnOrder }),
        ...(hit.eventKey === undefined ? {} : { eventKey: hit.eventKey }),
        ...(certificate === undefined
          ? {}
          : {
              certificateRevision: certificate.certificateRevision,
            }),
      });
    },
  );
  const sourceLock = compileMemoryStateSourceLockV2(items);
  const itemByRef = new Map(
    sourceLock.items.map((item) => [item.evidenceRef, item]),
  );
  const requirementById = new Map(
    stateRequirements.map((requirement, index) => [
      requirement.requirementId,
      { requirement, index },
    ]),
  );
  const slotScopes = slots.map((slot) => {
    const entry = requirementById.get(slot.requirementId);
    if (!entry) throw namedError("MemoryStateFrameShadowInputInvalid");
    return Object.freeze({
      slotId: slot.slotId,
      evidenceRefs: Object.freeze(
        (input.requirementHits[entry.index] ?? [])
          .map((hit) => hit.evidenceRef)
          .filter(
            (evidenceRef, index, values) =>
              values.indexOf(evidenceRef) === index &&
              supportingRefsByRequirement
                .get(slot.requirementId)
                ?.has(evidenceRef) === true &&
              itemByRef.get(evidenceRef)?.role === slot.roleConstraint,
          ),
      ),
    });
  });
  const committedSelectorGroups = input.selectorExecutionSnapshot.groups.filter(
    (group) => group.status === "committed",
  );
  type StateGroupExecutionResult = Readonly<{
    settlement: Readonly<{
      groupId: string;
      status: "completed" | "fallback";
      bindingRevision?: string;
      verificationRevision?: string;
      failureCode?: string;
    }>;
    proposedObservations: readonly MemoryStateBoundObservationV2[];
    observations: readonly MemoryStateBoundObservationV2[];
    validatedObservations: readonly MemoryStateValidatedObservationV1[];
    bindingCertificateValidationContext?: MemoryStateBindingCertificateValidationInputV1;
    rejectedObservationIds: readonly string[];
  }>;
  const stateGroupResults = await Promise.all(
    committedSelectorGroups.map(
      async (selectorGroup): Promise<StateGroupExecutionResult> => {
        const groupSlots = slots.filter((slot) =>
          selectorGroup.requirementIds.includes(slot.requirementId),
        );
        const groupSlotScopes = slotScopes.filter((scope) =>
          groupSlots.some((slot) => slot.slotId === scope.slotId),
        );
        const fallback = (
          failureCode: string,
          bindingRevision?: string,
        ): StateGroupExecutionResult =>
          Object.freeze({
            settlement: Object.freeze({
              groupId: selectorGroup.groupId,
              status: "fallback" as const,
              ...(bindingRevision === undefined ? {} : { bindingRevision }),
              failureCode,
            }),
            proposedObservations: Object.freeze([]),
            observations: Object.freeze([]),
            validatedObservations: Object.freeze([]),
            rejectedObservationIds: Object.freeze([]),
          });
        if (
          groupSlots.length !== selectorGroup.requirementIds.length ||
          groupSlotScopes.length !== groupSlots.length ||
          groupSlotScopes.some((scope) => scope.evidenceRefs.length === 0)
        ) {
          return fallback("MemoryStateGroupEvidenceMissing");
        }
        try {
          const bindingRequest = Object.freeze({
            query: input.query,
            slots: Object.freeze(groupSlots),
            sourceLock,
            slotScopes: Object.freeze(groupSlotScopes),
          });
          const binding = validateMemoryStateObservationBindingBoundaryV2({
            binder: input.binder,
            request: bindingRequest,
            result: await input.binder.bind(bindingRequest, input.signal),
          });
          const bindingGroup = binding.groups[0];
          if (
            binding.groups.length !== 1 ||
            !bindingGroup ||
            bindingGroup.groupId !== selectorGroup.groupId ||
            bindingGroup.status !== "completed"
          ) {
            return fallback(
              bindingGroup?.failureCodes[0] ?? "MemoryStateGroupBindingFailed",
              binding.bindingRevision,
            );
          }
          const groupProposals = bindingGroup.observations;
          const verificationRequest = Object.freeze({
            query: input.query,
            slots: Object.freeze(groupSlots),
            sourceLock,
            proposedObservations: groupProposals,
          });
          const verification =
            validateMemoryStateObservationVerificationBoundaryV2({
              verifier: input.verifier,
              request: verificationRequest,
              result: await input.verifier.verify(
                verificationRequest,
                input.signal,
              ),
            });
          const acceptedIds = new Set(verification.acceptedObservationIds);
          const groupObservations = groupProposals.filter((observation) =>
            acceptedIds.has(observation.observationId),
          );
          const groupValidated = compileMemoryStateBindingCertificatesV1({
            query: input.query,
            slots: groupSlots,
            sourceLock,
            proposedObservations: groupProposals,
            verification,
          });
          if (
            groupValidated.length !== groupObservations.length ||
            groupValidated.some(
              (candidate, index) =>
                candidate.observation.observationId !==
                groupObservations[index]?.observationId,
            )
          ) {
            throw namedError(
              "MemoryStateFrameShadowCertificatePartitionInvalid",
            );
          }
          return Object.freeze({
            settlement: Object.freeze({
              groupId: selectorGroup.groupId,
              status: "completed" as const,
              bindingRevision: binding.bindingRevision,
              verificationRevision: verification.verificationRevision,
            }),
            proposedObservations: groupProposals,
            observations: groupObservations,
            validatedObservations: groupValidated,
            bindingCertificateValidationContext: Object.freeze({
              ...verificationRequest,
              verification,
            }),
            rejectedObservationIds: verification.rejectedObservationIds,
          });
        } catch (error) {
          if (input.signal.aborted || errorName(error) === "AbortError") {
            throw error;
          }
          return fallback(stableFailureCode(error));
        }
      },
    ),
  );
  const stateGroupSettlements = stateGroupResults.map(
    (result) => result.settlement,
  );
  const proposedObservations = stateGroupResults.flatMap(
    (result) => result.proposedObservations,
  );
  const observations = stateGroupResults.flatMap(
    (result) => result.observations,
  );
  const validatedObservations = stateGroupResults.flatMap(
    (result) => result.validatedObservations,
  );
  const bindingCertificateValidationContexts = stateGroupResults.flatMap(
    (result) =>
      result.bindingCertificateValidationContext === undefined
        ? []
        : [result.bindingCertificateValidationContext],
  );
  const rejectedObservationIds = stateGroupResults.flatMap(
    (result) => result.rejectedObservationIds,
  );
  const bindingRevision = hashCanonicalJsonV1({
    schemaVersion: "paw.memory-state-group-binding-settlement.v1",
    selectorSnapshotRevision: input.selectorExecutionSnapshot.snapshotRevision,
    groups: stateGroupSettlements.map((group) => ({
      groupId: group.groupId,
      status: group.status,
      bindingRevision: group.bindingRevision ?? null,
      failureCode: group.failureCode ?? null,
    })),
  } as never);
  const verificationRevision = hashCanonicalJsonV1({
    schemaVersion: "paw.memory-state-group-verification-settlement.v1",
    selectorSnapshotRevision: input.selectorExecutionSnapshot.snapshotRevision,
    groups: stateGroupSettlements.map((group) => ({
      groupId: group.groupId,
      status: group.status,
      verificationRevision: group.verificationRevision ?? null,
      failureCode: group.failureCode ?? null,
    })),
  } as never);
  const frame = resolveMemoryStateFrameV2({
    slots,
    observations,
    sourceLock,
  });
  const certifiedFrame = resolveMemoryStateFrameV2({
    slots,
    observations: validatedObservations.map((item) => item.observation),
    sourceLock,
  });
  if (
    hashCanonicalJsonV1(frame as never) !==
    hashCanonicalJsonV1(certifiedFrame as never)
  ) {
    throw namedError("MemoryStateFrameShadowCertifiedFrameMismatch");
  }
  const executionProgram = compileMemoryEvidenceExecutionProgramV1({
    query: input.query,
    intent: input.intent,
    // The selector snapshot is bound to the immutable planner requirements.
    // Late-bound roles authorize execution but must not rewrite that identity;
    // the program reads the effective role from the selector snapshot itself.
    requirements: input.requirements,
    temporalConstraints: input.temporalConstraints,
    selectorSnapshot: input.selectorExecutionSnapshot,
  });
  const executionResult = executeMemoryEvidenceProgramV1({
    program: executionProgram,
    slots,
    frame: certifiedFrame,
    validatedObservations,
    bindingCertificateValidationContexts,
    ...(input.executionCoverageCertificate === undefined
      ? {}
      : {
          coverageCertificate: input.executionCoverageCertificate,
          coverageValidationContext: input.executionCoverageValidationContext,
        }),
  });
  const readerProjectionBuild = buildMemoryEvidenceReaderProjectionV1({
    query: input.query,
    intent: input.intent,
    requirements: input.requirements,
    temporalConstraints: input.temporalConstraints,
    selectorSnapshot: input.selectorExecutionSnapshot,
    lockedSourceIds: input.lockedSourceIds,
    sourceLock,
    program: executionProgram,
    slots,
    frame: certifiedFrame,
    validatedObservations,
    bindingCertificateValidationContexts,
    ...(input.executionCoverageCertificate === undefined
      ? {}
      : {
          coverageCertificate: input.executionCoverageCertificate,
          coverageValidationContext: input.executionCoverageValidationContext,
        }),
    executionResult,
  });
  const mechanicalBindingSummary =
    summarizeMemoryStateMechanicalBindingProfilesV1(
      compileMemoryStateMechanicalBindingProfilesV1({
        slots,
        sourceLock,
        slotScopes,
        validatedObservations,
        frame: certifiedFrame,
      }),
    );
  const stateShadowAuditRevision = hashCanonicalJsonV1({
    policyVersion: PAW_MEMORY_STATE_BINDING_CERTIFICATE_POLICY_V1,
    selectorSnapshotRevision: input.selectorExecutionSnapshot.snapshotRevision,
    stateGroupSettlements,
    frameProgramRevision: frame.programRevision,
    certificateIds: validatedObservations.map(
      (item) => item.certificate.certificateId,
    ),
    mechanicalBindingSummaryRevision: mechanicalBindingSummary.summaryRevision,
  } as never);
  const completeSlotCount = frame.slots.filter(
    (slot) => slot.status === "complete",
  ).length;
  const partialSlotCount = frame.slots.filter(
    (slot) => slot.status === "partial",
  ).length;
  const missingSlotCount = frame.slots.filter(
    (slot) => slot.status === "missing",
  ).length;
  const conflictSlotCount = frame.slots.filter(
    (slot) => slot.status === "conflict",
  ).length;
  const slotById = new Map(slots.map((slot) => [slot.slotId, slot]));
  const unsupportedCompleteSlotCount = frame.slots.filter((resolved) => {
    const slot = slotById.get(resolved.slotId);
    return (
      resolved.status === "complete" &&
      slot !== undefined &&
      (slot.operation === "preserve_history" ||
        (slot.operation === "collect" && slot.coverageMode !== "convergent") ||
        (slot.operation === "resolve_latest" && slot.temporalMode !== "latest"))
    );
  }).length;
  const assistantValidatedObservations = observations.filter(
    (observation) => observation.role === "assistant",
  );
  const uncertifiedAssistantValidatedObservationCount =
    assistantValidatedObservations.filter((observation) => {
      const slot = slotById.get(observation.slotId);
      return (
        slot?.authorityMode === "certified_dialogue_artifact" &&
        !observation.certificateRevision
      );
    }).length;
  const committedGroupCount = stateGroupSettlements.filter(
    (group) => group.status === "completed",
  ).length;
  const failedGroupCount = stateGroupSettlements.length - committedGroupCount;
  const selectorCommittedGroupCount = committedSelectorGroups.length;
  const selectorFailedGroupCount =
    input.selectorExecutionSnapshot.groups.length - selectorCommittedGroupCount;
  const unassessedRequirementCount =
    input.selectorExecutionSnapshot.groups.flatMap((group) =>
      group.requirements.filter(
        (requirement) => requirement.status !== "assessed",
      ),
    ).length;
  const unsupportedDerivedOperationCount = frame.derivedOperations.filter(
    (operation) => operation.status === "unsupported",
  ).length;
  return Object.freeze({
    policyVersion: PAW_MEMORY_STATE_FRAME_SHADOW_POLICY_V2,
    status:
      completeSlotCount === slots.length &&
      failedGroupCount === 0 &&
      selectorFailedGroupCount === 0 &&
      unsupportedDerivedOperationCount === 0
        ? "completed"
        : committedGroupCount > 0
          ? "partial"
          : "fallback",
    binderVersion: input.binder.binderVersion,
    verifierVersion: input.verifier.verifierVersion,
    bindingRevision,
    verificationRevision,
    bindingCertificatePolicyVersion:
      PAW_MEMORY_STATE_BINDING_CERTIFICATE_POLICY_V1,
    bindingCertificateCount: validatedObservations.length,
    mechanicalBindingProfilePolicyVersion:
      PAW_MEMORY_STATE_MECHANICAL_BINDING_PROFILE_POLICY_V1,
    mechanicalBindingSummary,
    stateShadowAuditRevision,
    frame,
    executionProgram,
    executionResult,
    readerProjectionBuild,
    groupCount: stateGroupSettlements.length,
    committedGroupCount,
    failedGroupCount,
    selectorGroupCount: input.selectorExecutionSnapshot.groups.length,
    selectorCommittedGroupCount,
    selectorFailedGroupCount,
    unassessedRequirementCount,
    slotCount: slots.length,
    completeSlotCount,
    partialSlotCount,
    missingSlotCount,
    conflictSlotCount,
    sourceLockItemCount: sourceLock.items.length,
    proposedObservationCount: proposedObservations.length,
    validatedObservationCount: observations.length,
    rejectedObservationCount: rejectedObservationIds.length,
    unsupportedCompleteSlotCount,
    unsupportedDerivedOperationCount,
    assistantValidatedObservationCount: assistantValidatedObservations.length,
    uncertifiedAssistantValidatedObservationCount,
  });
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "MemoryStateGroupFailed";
}

function stableFailureCode(error: unknown): string {
  const name = errorName(error);
  return /^[A-Za-z][A-Za-z0-9_]{0,95}$/u.test(name)
    ? name
    : "MemoryStateGroupFailed";
}
