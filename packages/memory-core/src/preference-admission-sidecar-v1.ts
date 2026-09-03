import {
  type JsonValue,
  hashCanonicalJsonV1,
  hashTextV1,
} from "./canonical.js";
import type { MemoryEvidenceNotebookHitV1 } from "./evidence-contracts.js";
import {
  type MemoryEvidenceObligationShapeV1,
  compileMemoryEvidenceObligationShapeV1,
  validateMemoryEvidenceObligationsV1,
} from "./evidence-obligation.js";
import {
  type MemoryQueryAnswerOriginV1,
  compileMemoryQueryAnswerOriginV1,
} from "./query-answer-origin.js";
import type {
  MemoryEvidenceBoundTemporalConstraintV1,
  MemoryEvidenceQueryIntentV3,
  MemoryEvidenceRequirementV3,
} from "./query-plan-contracts.js";
import {
  type MemoryStateBindingCertificateValidationInputV1,
  type MemoryStateValidatedObservationV1,
  compileMemoryStateBindingCertificatesV1,
  validateMemoryStateBindingCertificateV1,
} from "./state-binding-certificate-v1.js";
import {
  type MemoryStateBoundObservationV2,
  type MemoryStateSlotSpecV2,
  type MemoryStateSourceLockV2,
  compileMemoryStateSlotsV2,
  compileMemoryStateSourceLockV2,
} from "./state-frame-v2.js";
import {
  type MemoryStateObservationBinderV2,
  type MemoryStateObservationBindingV2,
  validateMemoryStateObservationBindingBoundaryV2,
} from "./state-observation-binder-v2.js";
import {
  type MemoryStateObservationVerificationV2,
  type MemoryStateObservationVerifierV2,
  validateMemoryStateObservationVerificationBoundaryV2,
} from "./state-observation-verifier-v2.js";
import { bindMemoryEvidenceTemporalConstraintV1 } from "./temporal-constraint.js";

export const PAW_MEMORY_PREFERENCE_ADMISSION_SCOPE_POLICY_V1 =
  "paw.memory-preference-admission-scope.v1:locked-user-candidates" as const;
export const PAW_MEMORY_PREFERENCE_ADMISSION_CERTIFICATE_POLICY_V1 =
  "paw.memory-preference-admission-certificate.v1:raw-evidence-dual-channel" as const;
export const PAW_MEMORY_PREFERENCE_ADMISSION_SIDECAR_POLICY_V1 =
  "paw.memory-preference-admission-sidecar.v1:observational-only" as const;

const MAX_ADMISSION_CANDIDATES_V1 = 32;
const MAX_ADMISSION_CANDIDATE_CHARS_V1 = 16_384;
const MAX_ADMISSION_TOTAL_CHARS_V1 = 128 * 1_024;

export interface MemoryPreferenceAdmissionCandidateScopeV1 {
  readonly requirementId: string;
  readonly evidenceRefs: readonly string[];
  readonly candidateScopeRevision: string;
}

export interface MemoryPreferenceAdmissionCandidateV1 {
  readonly sourceId: string;
  readonly evidenceRef: string;
  /** Raw evidence remains present; the certificate is never a replacement. */
  readonly content: string;
  readonly authority: "user_asserted" | "user_confirmed_dialogue";
  readonly sourceKind: "user_input";
  readonly observedAt?: string;
  readonly observedOrder?: number;
  readonly episodeOrder?: number;
  readonly turnOrder?: number;
  readonly eventKey?: string;
  readonly contextEvidenceRefs?: readonly [string];
}

export interface MemoryPreferenceAdmissionScopeSnapshotV1 {
  readonly policyVersion: typeof PAW_MEMORY_PREFERENCE_ADMISSION_SCOPE_POLICY_V1;
  readonly query: string;
  readonly queryDigest: string;
  readonly intent: MemoryEvidenceQueryIntentV3;
  readonly intentRevision: string;
  readonly obligation: MemoryEvidenceObligationShapeV1;
  readonly obligationRevision: string;
  readonly origin: MemoryQueryAnswerOriginV1;
  readonly requirements: readonly MemoryEvidenceRequirementV3[];
  readonly temporalConstraints: readonly MemoryEvidenceBoundTemporalConstraintV1[];
  readonly lockedSourceIds: readonly string[];
  readonly lockedSourceRevision: string;
  readonly candidates: readonly MemoryPreferenceAdmissionCandidateV1[];
  readonly candidateScopes: readonly MemoryPreferenceAdmissionCandidateScopeV1[];
  readonly candidateSetRevision: string;
  readonly slots: readonly MemoryStateSlotSpecV2[];
  readonly sourceLock: MemoryStateSourceLockV2;
  readonly slotScopes: readonly Readonly<{
    slotId: string;
    evidenceRefs: readonly string[];
  }>[];
  readonly scopeRevision: string;
}

export interface MemoryPreferenceAdmissionCertificateV1 {
  readonly policyVersion: typeof PAW_MEMORY_PREFERENCE_ADMISSION_CERTIFICATE_POLICY_V1;
  readonly admissionScopeRevision: string;
  readonly requirementId: string;
  readonly slotId: string;
  readonly slotRevision: string;
  readonly observationId: string;
  readonly bindingRevision: string;
  /** Immutable reverse binding to the exact raw evidence channel. */
  readonly rawEvidenceBinding: Readonly<{
    sourceId: string;
    evidenceRef: string;
    contentDigest: string;
    supportSpanStart: number;
    supportSpanEnd: number;
    supportSpanTextDigest: string;
  }>;
  readonly predicate: Readonly<{
    kind: MemoryStateValidatedObservationV1["observation"]["predicateKind"];
    polarity: MemoryStateValidatedObservationV1["observation"]["polarity"];
    modality: MemoryStateValidatedObservationV1["observation"]["modality"];
  }>;
  readonly verifierVersion: string;
  readonly verificationRevision: string;
  readonly stateBinding: MemoryStateValidatedObservationV1;
  readonly certificateRevision: string;
}

export type MemoryPreferenceAdmissionGroupStatusV1 = "completed" | "fallback";

export interface MemoryPreferenceAdmissionSettlementV1 {
  readonly policyVersion: typeof PAW_MEMORY_PREFERENCE_ADMISSION_SIDECAR_POLICY_V1;
  readonly status: "completed" | "partial" | "fallback";
  readonly admissionScopeRevision: string;
  readonly binderVersion: string;
  readonly verifierVersion: string;
  readonly bindingRevision: string;
  readonly verificationRevision?: string;
  readonly groups: readonly Readonly<{
    groupId: string;
    status: MemoryPreferenceAdmissionGroupStatusV1;
    failureCodes: readonly string[];
  }>[];
  readonly proposedObservations: readonly MemoryStateBoundObservationV2[];
  readonly verification?: MemoryStateObservationVerificationV2;
  readonly certificates: readonly MemoryPreferenceAdmissionCertificateV1[];
  readonly admittedEvidenceRefsByRequirement: readonly Readonly<{
    requirementId: string;
    evidenceRefs: readonly string[];
    certificateRevisions: readonly string[];
  }>[];
  readonly rejectedObservationIds: readonly string[];
  readonly proposedCount: number;
  readonly admittedCount: number;
  readonly rejectedCount: number;
  readonly failureCodes: readonly string[];
  readonly settlementRevision: string;
}

export interface MemoryPreferenceAdmissionSidecarV1 {
  readonly sidecarVersion: typeof PAW_MEMORY_PREFERENCE_ADMISSION_SIDECAR_POLICY_V1;
  observe(
    scope: Readonly<MemoryPreferenceAdmissionScopeSnapshotV1>,
    signal: AbortSignal,
  ): Promise<MemoryPreferenceAdmissionSettlementV1>;
}

export function compileMemoryPreferenceAdmissionScopeSnapshotV1(input: {
  readonly query: string;
  readonly intent: MemoryEvidenceQueryIntentV3;
  readonly origin: MemoryQueryAnswerOriginV1;
  readonly requirements: readonly MemoryEvidenceRequirementV3[];
  readonly temporalConstraints: readonly MemoryEvidenceBoundTemporalConstraintV1[];
  readonly lockedSourceIds: readonly string[];
  readonly candidates: readonly MemoryEvidenceNotebookHitV1[];
  readonly candidateScopes: readonly Readonly<{
    requirementId: string;
    evidenceRefs: readonly string[];
  }>[];
}): MemoryPreferenceAdmissionScopeSnapshotV1 {
  const query = boundedText(
    input.query,
    512,
    "MemoryPreferenceAdmissionQueryInvalid",
  );
  const intent = Object.freeze({ ...input.intent });
  const obligation = compileMemoryEvidenceObligationShapeV1(query, intent);
  if (obligation.obligationKind !== "personalization_context") {
    throw namedError("MemoryPreferenceAdmissionObligationInvalid");
  }
  const expectedOrigin = compileMemoryQueryAnswerOriginV1(query);
  if (
    hashCanonicalJsonV1(expectedOrigin as unknown as JsonValue) !==
    hashCanonicalJsonV1(input.origin as unknown as JsonValue)
  ) {
    throw namedError("MemoryPreferenceAdmissionOriginInvalid");
  }
  if (
    input.requirements.length < 1 ||
    input.requirements.length > 4 ||
    input.temporalConstraints.length !== input.requirements.length ||
    input.candidateScopes.length !== input.requirements.length ||
    input.requirements.some(
      (requirement) => requirement.roleConstraint !== "user",
    )
  ) {
    throw namedError("MemoryPreferenceAdmissionRequirementInvalid");
  }
  validateMemoryEvidenceObligationsV1(obligation, input.requirements);

  const requirements = Object.freeze(
    input.requirements.map((requirement) =>
      Object.freeze({
        ...requirement,
        ...(requirement.roleCandidates === undefined
          ? {}
          : { roleCandidates: Object.freeze([...requirement.roleCandidates]) }),
        ...(requirement.dependsOnRequirementIds === undefined
          ? {}
          : {
              dependsOnRequirementIds: Object.freeze([
                ...requirement.dependsOnRequirementIds,
              ]),
            }),
        ...(requirement.temporalConstraint === undefined
          ? {}
          : {
              temporalConstraint: Object.freeze({
                ...requirement.temporalConstraint,
              }),
            }),
      }),
    ),
  );
  const temporalConstraints = Object.freeze(
    input.temporalConstraints.map((temporal, index) => {
      const requirement = requirements[index];
      if (!requirement) {
        throw namedError("MemoryPreferenceAdmissionTemporalInvalid");
      }
      const expected = bindMemoryEvidenceTemporalConstraintV1({
        query,
        queryEnvelopeMode: intent.temporalMode,
        leafMode: requirement.temporalMode,
        ...(requirement.temporalConstraint === undefined
          ? {}
          : { constraint: requirement.temporalConstraint }),
        ...(temporal.evidenceTimeUpperBound === null
          ? {}
          : { evidenceTimeUpperBound: temporal.evidenceTimeUpperBound }),
        applyQueryScope:
          requirement.temporalMode !== "any" ||
          (requirements.length === 1 && intent.temporalMode === "range"),
      });
      if (
        hashCanonicalJsonV1(expected as unknown as JsonValue) !==
        hashCanonicalJsonV1(temporal as unknown as JsonValue)
      ) {
        throw namedError("MemoryPreferenceAdmissionTemporalInvalid");
      }
      return expected;
    }),
  );

  const lockedSourceIds = Object.freeze([...input.lockedSourceIds]);
  const lockedSources = new Set(lockedSourceIds);
  if (
    lockedSourceIds.length < 1 ||
    lockedSourceIds.length > 16 ||
    lockedSources.size !== lockedSourceIds.length ||
    lockedSourceIds.some((sourceId) => !sourceId.trim())
  ) {
    throw namedError("MemoryPreferenceAdmissionSourceLockInvalid");
  }

  if (input.candidates.length > MAX_ADMISSION_CANDIDATES_V1) {
    throw namedError("MemoryPreferenceAdmissionCandidateInvalid");
  }
  const seenRefs = new Set<string>();
  let totalChars = 0;
  const candidates = Object.freeze(
    input.candidates.map((candidate): MemoryPreferenceAdmissionCandidateV1 => {
      const contextEvidenceRefs = candidate.contextEvidenceRefs;
      if (
        !lockedSources.has(candidate.sourceId) ||
        !candidate.sourceId.trim() ||
        !candidate.evidenceRef.trim() ||
        seenRefs.has(candidate.evidenceRef) ||
        !candidate.content.trim() ||
        candidate.content.length > MAX_ADMISSION_CANDIDATE_CHARS_V1 ||
        candidate.sourceKind !== "user_input" ||
        (candidate.authority !== "user_asserted" &&
          candidate.authority !== "user_confirmed_dialogue") ||
        (contextEvidenceRefs !== undefined &&
          (contextEvidenceRefs.length !== 1 ||
            contextEvidenceRefs[0] !== candidate.evidenceRef))
      ) {
        throw namedError("MemoryPreferenceAdmissionCandidateInvalid");
      }
      totalChars += candidate.content.length;
      if (totalChars > MAX_ADMISSION_TOTAL_CHARS_V1) {
        throw namedError("MemoryPreferenceAdmissionCandidateInvalid");
      }
      seenRefs.add(candidate.evidenceRef);
      return Object.freeze({
        sourceId: candidate.sourceId,
        evidenceRef: candidate.evidenceRef,
        content: candidate.content,
        authority: candidate.authority,
        sourceKind: "user_input" as const,
        ...(candidate.observedAt === undefined
          ? {}
          : { observedAt: candidate.observedAt }),
        ...(candidate.observedOrder === undefined
          ? {}
          : { observedOrder: candidate.observedOrder }),
        ...(candidate.episodeOrder === undefined
          ? {}
          : { episodeOrder: candidate.episodeOrder }),
        ...(candidate.turnOrder === undefined
          ? {}
          : { turnOrder: candidate.turnOrder }),
        ...(candidate.eventKey === undefined
          ? {}
          : { eventKey: candidate.eventKey }),
        ...(contextEvidenceRefs === undefined
          ? {}
          : {
              contextEvidenceRefs: Object.freeze([
                candidate.evidenceRef,
              ]) as readonly [string],
            }),
      });
    }),
  );
  const candidateByRef = new Map(
    candidates.map((candidate) => [candidate.evidenceRef, candidate]),
  );
  const requirementById = new Map(
    requirements.map((requirement) => [requirement.requirementId, requirement]),
  );
  if (requirementById.size !== requirements.length) {
    throw namedError("MemoryPreferenceAdmissionRequirementInvalid");
  }
  const seenScopes = new Set<string>();
  const scopedRefs = new Set<string>();
  const candidateScopes = Object.freeze(
    input.candidateScopes.map((scope, index) => {
      const expectedRequirement = requirements[index];
      if (
        !expectedRequirement ||
        scope.requirementId !== expectedRequirement.requirementId ||
        seenScopes.has(scope.requirementId) ||
        new Set(scope.evidenceRefs).size !== scope.evidenceRefs.length ||
        scope.evidenceRefs.some(
          (evidenceRef) => !candidateByRef.has(evidenceRef),
        )
      ) {
        throw namedError("MemoryPreferenceAdmissionCandidateScopeInvalid");
      }
      seenScopes.add(scope.requirementId);
      for (const evidenceRef of scope.evidenceRefs) scopedRefs.add(evidenceRef);
      const evidenceRefs = Object.freeze([...scope.evidenceRefs]);
      return Object.freeze({
        requirementId: scope.requirementId,
        evidenceRefs,
        candidateScopeRevision: hashCanonicalJsonV1({
          schemaVersion: "paw.memory-selector-candidate-scope.v1",
          requirementId: scope.requirementId,
          evidenceRefs,
        } as JsonValue),
      });
    }),
  );
  if (candidates.some((candidate) => !scopedRefs.has(candidate.evidenceRef))) {
    throw namedError("MemoryPreferenceAdmissionCandidateScopeInvalid");
  }

  const origin = Object.freeze({
    ...expectedOrigin,
    features: Object.freeze({ ...expectedOrigin.features }),
  });
  const temporalByRequirement = new Map(
    requirements.map((requirement, index) => [
      requirement.requirementId,
      temporalConstraints[index] as MemoryEvidenceBoundTemporalConstraintV1,
    ]),
  );
  const slots = compileMemoryStateSlotsV2({
    query,
    intent,
    requirements,
    origin,
    temporalConstraints: temporalByRequirement,
  });
  if (slots.some((slot) => slot.roleConstraint !== "user")) {
    throw namedError("MemoryPreferenceAdmissionAuthorityInvalid");
  }
  const sourceLock = compileMemoryStateSourceLockV2(
    candidates.map((candidate) =>
      Object.freeze({
        sourceId: candidate.sourceId,
        evidenceRef: candidate.evidenceRef,
        content: candidate.content,
        authority: candidate.authority,
        role: "user" as const,
        ...(candidate.observedAt === undefined
          ? {}
          : { observedAt: candidate.observedAt }),
        ...(candidate.episodeOrder === undefined
          ? {}
          : { episodeOrder: candidate.episodeOrder }),
        ...(candidate.turnOrder === undefined
          ? {}
          : { turnOrder: candidate.turnOrder }),
        ...(candidate.eventKey === undefined
          ? {}
          : { eventKey: candidate.eventKey }),
      }),
    ),
  );
  const scopeByRequirement = new Map(
    candidateScopes.map((scope) => [scope.requirementId, scope.evidenceRefs]),
  );
  const slotScopes = Object.freeze(
    slots.map((slot) =>
      Object.freeze({
        slotId: slot.slotId,
        evidenceRefs: Object.freeze([
          ...(scopeByRequirement.get(slot.requirementId) ?? []),
        ]),
      }),
    ),
  );

  const queryDigest = hashTextV1(query);
  const intentRevision = hashCanonicalJsonV1(intent as unknown as JsonValue);
  const obligationRevision = hashCanonicalJsonV1(
    obligation as unknown as JsonValue,
  );
  const lockedSourceRevision = hashCanonicalJsonV1({
    schemaVersion: "paw.memory-locked-source-set.v1",
    lockedSourceIds,
  } as JsonValue);
  const candidateSetRevision = hashCanonicalJsonV1({
    schemaVersion: "paw.memory-preference-admission-candidate-set.v1",
    candidates: candidates.map((candidate) => ({
      sourceId: candidate.sourceId,
      evidenceRef: candidate.evidenceRef,
      contentDigest: hashTextV1(candidate.content),
      authority: candidate.authority,
      sourceKind: candidate.sourceKind,
      observedAt: candidate.observedAt ?? null,
      observedOrder: candidate.observedOrder ?? null,
      episodeOrder: candidate.episodeOrder ?? null,
      turnOrder: candidate.turnOrder ?? null,
      eventKey: candidate.eventKey ?? null,
      contextEvidenceRefs: candidate.contextEvidenceRefs ?? null,
    })),
    candidateScopes: candidateScopes.map((scope) => ({
      requirementId: scope.requirementId,
      candidateScopeRevision: scope.candidateScopeRevision,
    })),
  } as JsonValue);
  const scopeIdentity = {
    policyVersion: PAW_MEMORY_PREFERENCE_ADMISSION_SCOPE_POLICY_V1,
    queryDigest,
    intentRevision,
    obligationRevision,
    originRevision: origin.originRevision,
    lockedSourceRevision,
    candidateSetRevision,
    requirementRevisions: requirements.map((requirement) =>
      hashCanonicalJsonV1(requirement as unknown as JsonValue),
    ),
    temporalBindingRevisions: temporalConstraints.map(
      (temporal) => temporal.bindingRevision,
    ),
    slotRevisions: slots.map((slot) => slot.slotRevision),
    sourceLockDigest: sourceLock.sourceLockDigest,
  };
  return Object.freeze({
    policyVersion: PAW_MEMORY_PREFERENCE_ADMISSION_SCOPE_POLICY_V1,
    query,
    queryDigest,
    intent,
    intentRevision,
    obligation,
    obligationRevision,
    origin,
    requirements,
    temporalConstraints,
    lockedSourceIds,
    lockedSourceRevision,
    candidates,
    candidateScopes,
    candidateSetRevision,
    slots,
    sourceLock,
    slotScopes,
    scopeRevision: hashCanonicalJsonV1(scopeIdentity as JsonValue),
  });
}

export function validateMemoryPreferenceAdmissionScopeSnapshotV1(
  candidate: Readonly<MemoryPreferenceAdmissionScopeSnapshotV1>,
): MemoryPreferenceAdmissionScopeSnapshotV1 {
  const expected = compileMemoryPreferenceAdmissionScopeSnapshotV1({
    query: candidate.query,
    intent: candidate.intent,
    origin: candidate.origin,
    requirements: candidate.requirements,
    temporalConstraints: candidate.temporalConstraints,
    lockedSourceIds: candidate.lockedSourceIds,
    candidates: candidate.candidates,
    candidateScopes: candidate.candidateScopes,
  });
  if (
    hashCanonicalJsonV1(expected as unknown as JsonValue) !==
    hashCanonicalJsonV1(candidate as unknown as JsonValue)
  ) {
    throw namedError("MemoryPreferenceAdmissionScopeBoundaryInvalid");
  }
  return expected;
}

export function createMemoryPreferenceAdmissionSidecarV1(input: {
  readonly binder: MemoryStateObservationBinderV2;
  readonly verifier: MemoryStateObservationVerifierV2;
}): MemoryPreferenceAdmissionSidecarV1 {
  if (
    !input.binder?.binderVersion.trim() ||
    !input.verifier?.verifierVersion.trim()
  ) {
    throw namedError("MemoryPreferenceAdmissionPortInvalid");
  }
  return Object.freeze({
    sidecarVersion: PAW_MEMORY_PREFERENCE_ADMISSION_SIDECAR_POLICY_V1,
    async observe(
      candidateScope: Readonly<MemoryPreferenceAdmissionScopeSnapshotV1>,
      signal: AbortSignal,
    ): Promise<MemoryPreferenceAdmissionSettlementV1> {
      const scope =
        validateMemoryPreferenceAdmissionScopeSnapshotV1(candidateScope);
      if (signal.aborted) throw abortError();
      const bindingRequest = Object.freeze({
        query: scope.query,
        slots: scope.slots,
        sourceLock: scope.sourceLock,
        slotScopes: scope.slotScopes,
      });
      const binding = validateMemoryStateObservationBindingBoundaryV2({
        binder: input.binder,
        request: bindingRequest,
        result: await input.binder.bind(bindingRequest, signal),
      });
      if (signal.aborted) throw abortError();
      const completedGroupIds = new Set(
        binding.groups
          .filter((group) => group.status === "completed")
          .map((group) => group.groupId),
      );
      const proposedObservations = Object.freeze(
        binding.groups.flatMap((group) =>
          group.status === "completed" ? group.observations : [],
        ),
      );
      let verification: MemoryStateObservationVerificationV2 | undefined;
      let validated: readonly MemoryStateValidatedObservationV1[] =
        Object.freeze([]);
      if (proposedObservations.length > 0) {
        const verificationRequest = Object.freeze({
          query: scope.query,
          slots: scope.slots.filter((slot) =>
            completedGroupIds.has(slot.groupId),
          ),
          sourceLock: scope.sourceLock,
          proposedObservations,
        });
        verification = validateMemoryStateObservationVerificationBoundaryV2({
          verifier: input.verifier,
          request: verificationRequest,
          result: await input.verifier.verify(verificationRequest, signal),
        });
        if (signal.aborted) throw abortError();
        validated = compileMemoryStateBindingCertificatesV1({
          ...verificationRequest,
          verification,
        });
      }
      return compileSettlement({
        scope,
        binderVersion: input.binder.binderVersion,
        verifierVersion: input.verifier.verifierVersion,
        binding,
        proposedObservations,
        ...(verification === undefined ? {} : { verification }),
        validated,
      });
    },
  });
}

export function validateMemoryPreferenceAdmissionSettlementV1(input: {
  readonly scope: Readonly<MemoryPreferenceAdmissionScopeSnapshotV1>;
  readonly settlement: Readonly<MemoryPreferenceAdmissionSettlementV1>;
}): MemoryPreferenceAdmissionSettlementV1 {
  const scope = validateMemoryPreferenceAdmissionScopeSnapshotV1(input.scope);
  const verification = input.settlement.verification;
  let validated: readonly MemoryStateValidatedObservationV1[] = Object.freeze(
    [],
  );
  if (input.settlement.proposedObservations.length > 0) {
    if (!verification) {
      throw namedError("MemoryPreferenceAdmissionSettlementInvalid");
    }
    const completedGroupIds = new Set(
      input.settlement.groups
        .filter((group) => group.status === "completed")
        .map((group) => group.groupId),
    );
    const validationInput: MemoryStateBindingCertificateValidationInputV1 = {
      query: scope.query,
      slots: scope.slots.filter((slot) => completedGroupIds.has(slot.groupId)),
      sourceLock: scope.sourceLock,
      proposedObservations: input.settlement.proposedObservations,
      verification,
    };
    validated = input.settlement.certificates.map((certificate) =>
      validateMemoryStateBindingCertificateV1(
        certificate.stateBinding,
        validationInput,
      ),
    );
  } else if (verification || input.settlement.certificates.length > 0) {
    throw namedError("MemoryPreferenceAdmissionSettlementInvalid");
  }
  const binding: MemoryStateObservationBindingV2 = Object.freeze({
    binderVersion: input.settlement.binderVersion,
    bindingRevision: input.settlement.bindingRevision,
    groups: Object.freeze(
      input.settlement.groups.map((group) =>
        Object.freeze({
          groupId: group.groupId,
          status: group.status,
          observations: Object.freeze(
            input.settlement.proposedObservations.filter(
              (observation) =>
                observation.slotId &&
                scope.slots.find((slot) => slot.slotId === observation.slotId)
                  ?.groupId === group.groupId,
            ),
          ),
          failureCodes: group.failureCodes,
        }),
      ),
    ),
  });
  const expected = compileSettlement({
    scope,
    binderVersion: input.settlement.binderVersion,
    verifierVersion: input.settlement.verifierVersion,
    binding,
    proposedObservations: input.settlement.proposedObservations,
    ...(verification === undefined ? {} : { verification }),
    validated,
  });
  if (
    hashCanonicalJsonV1(expected as unknown as JsonValue) !==
    hashCanonicalJsonV1(input.settlement as unknown as JsonValue)
  ) {
    throw namedError("MemoryPreferenceAdmissionSettlementInvalid");
  }
  return expected;
}

function compileSettlement(input: {
  readonly scope: MemoryPreferenceAdmissionScopeSnapshotV1;
  readonly binderVersion: string;
  readonly verifierVersion: string;
  readonly binding: MemoryStateObservationBindingV2;
  readonly proposedObservations: readonly MemoryStateBoundObservationV2[];
  readonly verification?: MemoryStateObservationVerificationV2;
  readonly validated: readonly MemoryStateValidatedObservationV1[];
}): MemoryPreferenceAdmissionSettlementV1 {
  const slotById = new Map(
    input.scope.slots.map((slot) => [slot.slotId, slot]),
  );
  const candidateByRef = new Map(
    input.scope.candidates.map((candidate) => [
      candidate.evidenceRef,
      candidate,
    ]),
  );
  const certificates = Object.freeze(
    input.validated.map((stateBinding) => {
      const slot = slotById.get(stateBinding.observation.slotId);
      const rawCandidate = candidateByRef.get(
        stateBinding.observation.evidenceRef,
      );
      const supportSpan = stateBinding.certificate.claimBinding.supportSpan;
      if (
        !slot ||
        !rawCandidate ||
        stateBinding.certificate.evidenceBinding.sourceId !==
          rawCandidate.sourceId ||
        stateBinding.certificate.evidenceBinding.contentDigest !==
          hashTextV1(rawCandidate.content)
      ) {
        throw namedError("MemoryPreferenceAdmissionCertificateInvalid");
      }
      const identity = {
        policyVersion: PAW_MEMORY_PREFERENCE_ADMISSION_CERTIFICATE_POLICY_V1,
        admissionScopeRevision: input.scope.scopeRevision,
        requirementId: slot.requirementId,
        slotId: slot.slotId,
        slotRevision: slot.slotRevision,
        observationId: stateBinding.observation.observationId,
        bindingRevision: stateBinding.observation.bindingRevision,
        rawEvidenceBinding: {
          sourceId: rawCandidate.sourceId,
          evidenceRef: rawCandidate.evidenceRef,
          contentDigest: hashTextV1(rawCandidate.content),
          supportSpanStart: supportSpan.start,
          supportSpanEnd: supportSpan.end,
          supportSpanTextDigest: supportSpan.textDigest,
        },
        predicate: {
          kind: stateBinding.observation.predicateKind,
          polarity: stateBinding.observation.polarity,
          modality: stateBinding.observation.modality,
        },
        verifierVersion:
          stateBinding.certificate.semanticAttestation.verifierVersion,
        verificationRevision:
          stateBinding.certificate.semanticAttestation.verificationRevision,
        stateBinding,
      };
      return Object.freeze({
        ...identity,
        certificateRevision: hashCanonicalJsonV1(
          identity as unknown as JsonValue,
        ),
      });
    }),
  );
  const admittedEvidenceRefsByRequirement = Object.freeze(
    input.scope.requirements.map((requirement) => {
      const matching = certificates.filter(
        (certificate) =>
          certificate.requirementId === requirement.requirementId,
      );
      return Object.freeze({
        requirementId: requirement.requirementId,
        evidenceRefs: Object.freeze([
          ...new Set(
            matching.map(
              (certificate) => certificate.rawEvidenceBinding.evidenceRef,
            ),
          ),
        ]),
        certificateRevisions: Object.freeze(
          matching.map((certificate) => certificate.certificateRevision),
        ),
      });
    }),
  );
  const groups = Object.freeze(
    input.binding.groups.map((group) =>
      Object.freeze({
        groupId: group.groupId,
        status: group.status,
        failureCodes: Object.freeze([...group.failureCodes]),
      }),
    ),
  );
  const completedGroupCount = groups.filter(
    (group) => group.status === "completed",
  ).length;
  const status: MemoryPreferenceAdmissionSettlementV1["status"] =
    completedGroupCount === groups.length
      ? "completed"
      : completedGroupCount > 0
        ? "partial"
        : "fallback";
  const rejectedObservationIds = Object.freeze([
    ...(input.verification?.rejectedObservationIds ?? []),
  ]);
  const failureCodes = Object.freeze([
    ...new Set(groups.flatMap((group) => group.failureCodes)),
  ]);
  const identity = {
    policyVersion: PAW_MEMORY_PREFERENCE_ADMISSION_SIDECAR_POLICY_V1,
    status,
    admissionScopeRevision: input.scope.scopeRevision,
    binderVersion: input.binderVersion,
    verifierVersion: input.verifierVersion,
    bindingRevision: input.binding.bindingRevision,
    ...(input.verification === undefined
      ? {}
      : { verificationRevision: input.verification.verificationRevision }),
    groups,
    proposedObservations: Object.freeze([...input.proposedObservations]),
    ...(input.verification === undefined
      ? {}
      : { verification: input.verification }),
    certificates,
    admittedEvidenceRefsByRequirement,
    rejectedObservationIds,
    proposedCount: input.proposedObservations.length,
    admittedCount: certificates.length,
    rejectedCount: rejectedObservationIds.length,
    failureCodes,
  };
  return Object.freeze({
    ...identity,
    settlementRevision: hashCanonicalJsonV1({
      policyVersion: identity.policyVersion,
      status: identity.status,
      admissionScopeRevision: identity.admissionScopeRevision,
      binderVersion: identity.binderVersion,
      verifierVersion: identity.verifierVersion,
      bindingRevision: identity.bindingRevision,
      verificationRevision: input.verification?.verificationRevision ?? null,
      groups: identity.groups,
      proposedBindings: input.proposedObservations.map((observation) => ({
        observationId: observation.observationId,
        bindingRevision: observation.bindingRevision,
      })),
      certificateRevisions: certificates.map(
        (certificate) => certificate.certificateRevision,
      ),
      rejectedObservationIds,
      failureCodes,
    } as JsonValue),
  });
}

function boundedText(value: unknown, max: number, errorName: string): string {
  if (typeof value !== "string") throw namedError(errorName);
  const normalized = value.trim().replace(/\s+/gu, " ");
  if (!normalized || normalized.length > max) throw namedError(errorName);
  return normalized;
}

function abortError(): Error {
  const error = new Error("Aborted");
  error.name = "AbortError";
  return error;
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}
