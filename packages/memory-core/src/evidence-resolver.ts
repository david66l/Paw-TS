import { type JsonValue, hashCanonicalJsonV1 } from "./canonical.js";
import {
  type MemoryEvidenceClosureAuditorV1,
  type MemoryEvidenceClosureVerdictV1,
  validateMemoryEvidenceClosureAuditBoundaryV1,
} from "./evidence-closure-auditor.js";
import { compileMemoryEvidenceExecutionCoverageCertificateV1 } from "./evidence-execution-coverage-v1.js";
import {
  PAW_MEMORY_EVIDENCE_CANDIDATE_FUSION_VERSION_V2,
  PAW_MEMORY_EVIDENCE_NOTEBOOK_POLICY_VERSION_V1,
} from "./evidence-first.js";
import {
  compileMemoryEvidenceObligationShapeV1,
  validateMemoryEvidenceObligationsV1,
} from "./evidence-obligation.js";
import {
  type MemoryEvidenceQueryIntentV3,
  type MemoryEvidenceQueryPlannerV3,
  type MemoryEvidenceRequirementV3,
  classifyMemoryEvidenceQueryV3,
  compileMemoryQueryAnswerOriginV1,
  validateMemoryEvidenceQueryPlanOriginV1,
} from "./evidence-query-planner.js";
import { resolveEvidencePass } from "./evidence-resolution-pass.js";
import {
  abortError,
  boundedInteger,
  boundedQuery,
  createRootEvidenceRequirement,
  filterEvidenceSearchResultForRole,
  isAbort,
  mergeEvidenceHits,
  selectedNotebookEvidence,
  validateMemoryEvidenceQueryPlanBoundary,
} from "./evidence-resolver-helpers.js";
import type { MemoryEvidenceSupportSelectorV1 } from "./evidence-support-selector.js";
import {
  DEFAULT_MEMORY_SOURCE_LOCAL_EVIDENCE_BUDGET_V1,
  type MemoryDialoguePredecessorVerifierV1,
  type MemorySourceLocalEvidenceBudgetV1,
  type MemorySourceLocalEvidenceHydratorV1,
  type MemorySourceLocalEvidenceLocatorV1,
} from "./source-local-evidence-locator.js";
import {
  type MemoryStateFrameShadowResultV2,
  buildMemoryStateFrameShadowV2,
} from "./state-frame-shadow-v2.js";
import type { MemoryStateObservationBinderV2 } from "./state-observation-binder-v2.js";
import type { MemoryStateObservationVerifierV2 } from "./state-observation-verifier-v2.js";
import { bindMemoryEvidenceTemporalConstraintV1 } from "./temporal-constraint.js";

import {
  type MemoryEvidenceClosureModeV1,
  type MemoryEvidenceIndexV1,
  type MemoryEvidenceResolutionV1,
  PAW_MEMORY_EVIDENCE_RESOLVER_VERSION_V1,
} from "./evidence-resolution-contracts.js";

export * from "./evidence-resolution-contracts.js";
export {
  PAW_MEMORY_REQUIREMENT_FAIR_ACQUISITION_POLICY_REVISION_V1,
  PAW_MEMORY_REQUIREMENT_FAIR_ACQUISITION_POLICY_VERSION_V1,
  type MemoryRequirementFairAcquisitionReportV1,
} from "./requirement-fair-acquisition.js";

/**
 * Shared plugin-owned evidence pipeline. The caller query and bounded planner
 * requirements participate in capped discovery. Each pass locks its source
 * set; one independently audited repair may drill into those sources but can
 * never introduce a new source. The selector can bind supplied evidence
 * addresses but cannot introduce a source, address, or search of its own.
 */
export function createMemoryEvidenceResolverV1(input: {
  readonly index: MemoryEvidenceIndexV1;
  readonly planner?: MemoryEvidenceQueryPlannerV3;
  readonly supportSelector?: MemoryEvidenceSupportSelectorV1;
  /** Optional proof-carrying state frame. It is observational until a caller explicitly consumes it. */
  readonly stateObservationBinder?: MemoryStateObservationBinderV2;
  /** Independent semantic gate; a binder proposal is never reducer evidence without it. */
  readonly stateObservationVerifier?: MemoryStateObservationVerifierV2;
  readonly sourceLocalLocator?: MemorySourceLocalEvidenceLocatorV1;
  readonly sourceLocalHydrator?: MemorySourceLocalEvidenceHydratorV1;
  readonly dialoguePredecessorVerifier?: MemoryDialoguePredecessorVerifierV1;
  readonly sourceLocalBudget?: MemorySourceLocalEvidenceBudgetV1;
  readonly evidenceTimeUpperBound?: string;
  /**
   * Builds role alternatives from exact dialogue provenance only after source
   * locking. When immutable query origin is an unowned dialogue artifact, the
   * same gate may admit an unfiltered original-query source pointer before the
   * lock; evidence text and support still require locator authorization and an
   * exact certificate. Defaults off.
   */
  readonly evidenceGroundedRoleBinding?: boolean;
  readonly closureAuditor?: MemoryEvidenceClosureAuditorV1;
  /** Defaults to observe so a semantic audit cannot silently rewrite evidence. */
  readonly closureMode?: Exclude<MemoryEvidenceClosureModeV1, "disabled">;
  readonly maxSources?: number;
  /** Exact addresses retained inside each selected source before hydration. */
  readonly maxEvidencePerSource?: number;
  readonly maxHitsPerRequirement?: number;
  readonly maxNotebookChars?: number;
}): Readonly<{
  resolverVersion: typeof PAW_MEMORY_EVIDENCE_RESOLVER_VERSION_V1;
  resolve(
    query: string,
    signal: AbortSignal,
  ): Promise<MemoryEvidenceResolutionV1>;
}> {
  const maxSources = boundedInteger(input.maxSources ?? 8, 1, 16);
  const maxEvidencePerSource = boundedInteger(
    input.maxEvidencePerSource ?? 8,
    1,
    16,
  );
  const maxHitsPerRequirement = boundedInteger(
    input.maxHitsPerRequirement ?? 2,
    1,
    8,
  );
  const maxNotebookChars = boundedInteger(
    input.maxNotebookChars ?? 4_096,
    256,
    16_384,
  );
  if (
    input.closureMode !== undefined &&
    input.closureMode !== "observe" &&
    input.closureMode !== "repair"
  ) {
    throw namedError("MemoryEvidenceClosureModeInvalid");
  }
  const closureMode: MemoryEvidenceClosureModeV1 = input.closureAuditor
    ? (input.closureMode ?? "observe")
    : "disabled";
  return Object.freeze({
    resolverVersion: PAW_MEMORY_EVIDENCE_RESOLVER_VERSION_V1,
    async resolve(query: string, signal: AbortSignal) {
      const value = boundedQuery(query);
      // Query-owned provenance is frozen before any planner normalization. A
      // plan may propose a role graph but cannot rewrite this capability.
      const queryAnswerOrigin = compileMemoryQueryAnswerOriginV1(value);
      let intent: MemoryEvidenceQueryIntentV3 =
        classifyMemoryEvidenceQueryV3(value);
      const primaryUnfiltered = await input.index.search(value, signal);
      let requirements: readonly MemoryEvidenceRequirementV3[] = [];
      let plannerStatus: MemoryEvidenceResolutionV1["plannerStatus"] =
        intent.needsPlanning ? "fallback" : "not_needed";
      let plannerFailureCode: string | undefined;
      const shouldPlan = input.planner !== undefined;
      if (shouldPlan && input.planner) {
        try {
          const plan = await input.planner.plan(value, signal, {
            force: !intent.needsPlanning,
          });
          validateMemoryEvidenceQueryPlanBoundary({
            query: value,
            plan,
            intent,
            plannerVersion: input.planner.plannerVersion,
          });
          validateMemoryEvidenceQueryPlanOriginV1({
            origin: queryAnswerOrigin,
            plan,
          });
          intent = Object.freeze({
            answerShape: plan.answerShape,
            temporalMode: plan.temporalMode,
            roleConstraint: plan.roleConstraint,
            needsPlanning: plan.needsPlanning,
          });
          requirements = plan.requirements;
          plannerStatus = "completed";
        } catch (error) {
          if (signal.aborted || isAbort(error)) throw abortError();
          plannerStatus = "fallback";
          plannerFailureCode = stablePlannerFailureCode(error);
        }
      }
      // Semantic normalization happens before any authority filter or closure
      // contract is compiled. Otherwise a corrected assistant/latest intent
      // would still execute against the stale deterministic user/any lane.
      const obligationShape = compileMemoryEvidenceObligationShapeV1(
        value,
        intent,
      );
      const primary = filterEvidenceSearchResultForRole(
        primaryUnfiltered,
        intent.roleConstraint,
      );
      // An empty requirement set must not bypass semantic verification. Bind
      // the original question as one root requirement and run the same support
      // gate used by decomposed queries, including deterministic direct hits.
      if (requirements.length === 0 && input.supportSelector) {
        requirements = Object.freeze([
          createRootEvidenceRequirement(value, intent, obligationShape),
        ]);
      }
      let obligationStatus: MemoryEvidenceResolutionV1["obligationStatus"] =
        "satisfied";
      try {
        validateMemoryEvidenceObligationsV1(obligationShape, requirements);
      } catch {
        obligationStatus = "fallback";
      }
      const expansiveEvidence =
        intent.answerShape === "aggregate" ||
        intent.temporalMode === "history" ||
        intent.temporalMode === "range";
      let pass = await resolveEvidencePass({
        index: input.index,
        supportSelector: input.supportSelector,
        query: value,
        intent,
        primary,
        primaryUnfiltered,
        requirements,
        maxSources,
        maxEvidencePerSource,
        maxHitsPerRequirement: expansiveEvidence
          ? maxHitsPerRequirement
          : Math.min(4, maxHitsPerRequirement),
        maxNotebookChars: expansiveEvidence
          ? maxNotebookChars
          : Math.min(4_096, maxNotebookChars),
        sourceLocalLocator: input.sourceLocalLocator,
        sourceLocalHydrator: input.sourceLocalHydrator,
        dialoguePredecessorVerifier: input.dialoguePredecessorVerifier,
        sourceLocalBudget:
          input.sourceLocalBudget ??
          DEFAULT_MEMORY_SOURCE_LOCAL_EVIDENCE_BUDGET_V1,
        queryAnswerOrigin,
        evidenceGroundedRoleBinding: input.evidenceGroundedRoleBinding,
        evidenceTimeUpperBound: input.evidenceTimeUpperBound,
        signal,
      });
      let resolvedRequirements = pass.requirements;
      let closureAuditStatus: MemoryEvidenceResolutionV1["closureAuditStatus"] =
        input.closureAuditor ? "not_needed" : "not_configured";
      let closureVerdict: MemoryEvidenceClosureVerdictV1 | undefined;
      let closureDeficiencyCount = 0;
      let closureRepairCount: 0 | 1 = 0;
      let closureRepairMode: MemoryEvidenceResolutionV1["closureRepairMode"] =
        "none";
      let closureAuditRevision: string | undefined;
      let closureAuditFailureCode: string | undefined;
      const shouldAudit =
        input.closureAuditor !== undefined &&
        resolvedRequirements.length > 0 &&
        selectedNotebookEvidence(pass.requirementHits, pass.notebook).length >
          0 &&
        (intent.roleConstraint !== "user" ||
          intent.temporalMode !== "any" ||
          intent.answerShape !== "lookup" ||
          resolvedRequirements.length > 1 ||
          pass.fusion.sources.length > 1);
      if (shouldAudit && input.closureAuditor) {
        const selectedEvidence = selectedNotebookEvidence(
          pass.requirementHits,
          pass.notebook,
        );
        try {
          const auditInput = Object.freeze({
            query: value,
            intent,
            requirements: resolvedRequirements,
            selectedEvidence,
          });
          const audit = validateMemoryEvidenceClosureAuditBoundaryV1({
            audit: await input.closureAuditor.audit(auditInput, signal),
            auditInput,
            auditorVersion: input.closureAuditor.auditorVersion,
          });
          closureAuditStatus = "completed";
          closureAuditRevision = audit.auditRevision;
          closureDeficiencyCount = audit.deficiencies.length;
          closureVerdict = audit.decision === "pass" ? "pass" : "insufficient";
          if (
            audit.decision === "incomplete" &&
            audit.deficiencies.length > 0 &&
            input.planner &&
            closureMode === "repair"
          ) {
            const revisedPlan = await input.planner.plan(value, signal, {
              force: true,
              revision: Object.freeze({
                currentRequirements: requirements,
                deficiencies: audit.deficiencies,
              }),
            });
            validateMemoryEvidenceQueryPlanBoundary({
              query: value,
              plan: revisedPlan,
              intent,
              plannerVersion: input.planner.plannerVersion,
            });
            validateMemoryEvidenceQueryPlanOriginV1({
              origin: queryAnswerOrigin,
              plan: revisedPlan,
            });
            const repairedRequirements = revisedPlan.requirements;
            const seedHits = mergeEvidenceHits(
              pass.requirementHits.flat(),
              primary.hits,
            );
            pass = await resolveEvidencePass({
              index: input.index,
              supportSelector: input.supportSelector,
              query: value,
              intent,
              primary,
              primaryUnfiltered,
              requirements: repairedRequirements,
              maxSources,
              maxEvidencePerSource,
              maxHitsPerRequirement: expansiveEvidence
                ? maxHitsPerRequirement
                : Math.min(4, maxHitsPerRequirement),
              maxNotebookChars: expansiveEvidence
                ? maxNotebookChars
                : Math.min(4_096, maxNotebookChars),
              sourceLocalLocator: input.sourceLocalLocator,
              sourceLocalHydrator: input.sourceLocalHydrator,
              dialoguePredecessorVerifier: input.dialoguePredecessorVerifier,
              sourceLocalBudget:
                input.sourceLocalBudget ??
                DEFAULT_MEMORY_SOURCE_LOCAL_EVIDENCE_BUDGET_V1,
              queryAnswerOrigin,
              evidenceGroundedRoleBinding: input.evidenceGroundedRoleBinding,
              evidenceTimeUpperBound: input.evidenceTimeUpperBound,
              excludedEvidenceRefs: new Set(audit.rejectedEvidenceRefs),
              sourceLock: Object.freeze({
                fusion: pass.fusion,
                degradedChannels: pass.degradedChannels,
                lockedSourceIds: pass.lockedSourceIds,
                seedHits,
                sourceAcquisition: pass.sourceAcquisition,
              }),
              signal,
            });
            requirements = repairedRequirements;
            resolvedRequirements = pass.requirements;
            plannerStatus = "completed";
            plannerFailureCode = undefined;
            obligationStatus = "satisfied";
            closureRepairCount = 1;
            closureRepairMode = "replan";
            const finalSelectedEvidence = selectedNotebookEvidence(
              pass.requirementHits,
              pass.notebook,
            );
            if (finalSelectedEvidence.length === 0) {
              closureVerdict = "insufficient";
              closureAuditRevision = hashCanonicalJsonV1({
                schemaVersion: "paw.memory-evidence-closure-replan.v1",
                initialAuditRevision: audit.auditRevision,
                finalOutcome: "empty_evidence",
              });
            } else {
              const finalAuditInput = Object.freeze({
                query: value,
                intent,
                requirements: resolvedRequirements,
                selectedEvidence: finalSelectedEvidence,
              });
              const finalAudit = validateMemoryEvidenceClosureAuditBoundaryV1({
                audit: await input.closureAuditor.audit(
                  finalAuditInput,
                  signal,
                ),
                auditInput: finalAuditInput,
                auditorVersion: input.closureAuditor.auditorVersion,
              });
              closureVerdict =
                finalAudit.decision === "pass" ? "pass" : "insufficient";
              closureAuditRevision = hashCanonicalJsonV1({
                schemaVersion: "paw.memory-evidence-closure-replan.v1",
                initialAuditRevision: audit.auditRevision,
                finalAuditRevision: finalAudit.auditRevision,
              });
            }
          }
        } catch (error) {
          if (signal.aborted || isAbort(error)) throw abortError();
          if (
            error instanceof Error &&
            /^MemoryEvidenceQueryPlan[A-Za-z0-9]+$/u.test(error.name)
          ) {
            plannerStatus = "fallback";
            plannerFailureCode = stablePlannerFailureCode(error);
          }
          closureAuditStatus = "fallback";
          closureVerdict = "insufficient";
          closureAuditFailureCode = stableClosureAuditFailureCode(error);
        }
      }
      let stateFrameShadow: MemoryStateFrameShadowResultV2 | undefined;
      let stateFrameFailureCode: string | undefined;
      let stateFrameFailureStage:
        | "coverage_certificate"
        | "state_shadow"
        | undefined;
      if (
        input.stateObservationBinder &&
        input.stateObservationVerifier &&
        resolvedRequirements.length > 0
      ) {
        if (!pass.selectorExecutionSnapshot) {
          stateFrameFailureCode = "MemoryStateSelectorExecutionSnapshotMissing";
        } else
          try {
            stateFrameFailureStage = "coverage_certificate";
            const stateFrameTemporalConstraints = resolvedRequirements.map(
              (requirement) =>
                bindMemoryEvidenceTemporalConstraintV1({
                  query: value,
                  queryEnvelopeMode: intent.temporalMode,
                  leafMode: requirement.temporalMode,
                  ...(requirement.temporalConstraint === undefined
                    ? {}
                    : { constraint: requirement.temporalConstraint }),
                  ...(input.evidenceTimeUpperBound === undefined
                    ? {}
                    : {
                        evidenceTimeUpperBound: input.evidenceTimeUpperBound,
                      }),
                  applyQueryScope:
                    requirement.temporalMode !== "any" ||
                    (resolvedRequirements.length === 1 &&
                      intent.temporalMode === "range"),
                }),
            );
            const executionCoverageValidationContext = Object.freeze({
              intent,
              requirements: resolvedRequirements,
              temporalConstraints: stateFrameTemporalConstraints,
              selectorSnapshot: pass.selectorExecutionSnapshot,
              notebook: pass.notebook,
              closureAuditStatus,
              ...(closureVerdict === undefined ? {} : { closureVerdict }),
              ...(closureAuditRevision === undefined
                ? {}
                : { closureAuditRevision }),
            });
            const executionCoverageCertificate =
              compileMemoryEvidenceExecutionCoverageCertificateV1(
                executionCoverageValidationContext,
              );
            stateFrameFailureStage = "state_shadow";
            stateFrameShadow = await buildMemoryStateFrameShadowV2({
              binder: input.stateObservationBinder,
              verifier: input.stateObservationVerifier,
              query: value,
              intent,
              requirements: resolvedRequirements,
              origin: queryAnswerOrigin,
              temporalConstraints: stateFrameTemporalConstraints,
              requirementHits: pass.requirementHits,
              selectorExecutionSnapshot: pass.selectorExecutionSnapshot,
              lockedSourceIds: pass.lockedSourceIds,
              dialogueCertificateRegistry: pass.dialogueCertificateRegistry,
              executionCoverageCertificate,
              executionCoverageValidationContext,
              signal,
            });
            stateFrameFailureStage = undefined;
          } catch (error) {
            if (signal.aborted || isAbort(error)) throw abortError();
            stateFrameFailureCode = stableStateFrameFailureCode(error);
          }
      }
      const {
        fusion,
        sourceAcquisition,
        degradedChannels,
        supportSelectorStatus,
        supportSelectionRevision,
        supportAssessments,
        sourceLocalization,
        notebook,
        requirementEvidence,
        packetSources,
      } = pass;
      const stateFrameTelemetry = stateFrameShadow
        ? Object.freeze({
            groupCount: stateFrameShadow.groupCount,
            committedGroupCount: stateFrameShadow.committedGroupCount,
            failedGroupCount: stateFrameShadow.failedGroupCount,
            selectorGroupCount: stateFrameShadow.selectorGroupCount,
            selectorCommittedGroupCount:
              stateFrameShadow.selectorCommittedGroupCount,
            selectorFailedGroupCount: stateFrameShadow.selectorFailedGroupCount,
            unassessedRequirementCount:
              stateFrameShadow.unassessedRequirementCount,
            slotCount: stateFrameShadow.slotCount,
            completeSlotCount: stateFrameShadow.completeSlotCount,
            partialSlotCount: stateFrameShadow.partialSlotCount,
            missingSlotCount: stateFrameShadow.missingSlotCount,
            conflictSlotCount: stateFrameShadow.conflictSlotCount,
            sourceLockItemCount: stateFrameShadow.sourceLockItemCount,
            proposedObservationCount: stateFrameShadow.proposedObservationCount,
            validatedObservationCount:
              stateFrameShadow.validatedObservationCount,
            rejectedObservationCount: stateFrameShadow.rejectedObservationCount,
            bindingCertificatePolicyVersion:
              stateFrameShadow.bindingCertificatePolicyVersion,
            bindingCertificateCount: stateFrameShadow.bindingCertificateCount,
            mechanicalBindingProfilePolicyVersion:
              stateFrameShadow.mechanicalBindingProfilePolicyVersion,
            mechanicalBindingProfileCount:
              stateFrameShadow.mechanicalBindingSummary.profileCount,
            mechanicallyCompleteBindingCount:
              stateFrameShadow.mechanicalBindingSummary
                .mechanicallyCompleteCount,
            mechanicallyIncompleteBindingCount:
              stateFrameShadow.mechanicalBindingSummary
                .mechanicallyIncompleteCount,
            mechanicalBindingProofFailureCounts:
              stateFrameShadow.mechanicalBindingSummary.proofFailureCounts,
            mechanicalBindingSummaryRevision:
              stateFrameShadow.mechanicalBindingSummary.summaryRevision,
            unsupportedCompleteSlotCount:
              stateFrameShadow.unsupportedCompleteSlotCount,
            unsupportedDerivedOperationCount:
              stateFrameShadow.unsupportedDerivedOperationCount,
            ...(stateFrameShadow.executionResult === undefined ||
            stateFrameShadow.executionProgram === undefined
              ? {}
              : {
                  executionStatus: stateFrameShadow.executionResult.status,
                  executionProgramRevision:
                    stateFrameShadow.executionProgram.programRevision,
                  executionRevision:
                    stateFrameShadow.executionResult.executionRevision,
                  executionCompleteNodeCount:
                    stateFrameShadow.executionResult.completeNodeCount,
                  executionPartialNodeCount:
                    stateFrameShadow.executionResult.partialNodeCount,
                  executionMissingNodeCount:
                    stateFrameShadow.executionResult.missingNodeCount,
                  executionConflictNodeCount:
                    stateFrameShadow.executionResult.conflictNodeCount,
                  executionUnsupportedNodeCount:
                    stateFrameShadow.executionResult.unsupportedNodeCount,
                  executionOperationStatusCounts:
                    summarizeExecutionOperationStatuses(
                      stateFrameShadow.executionResult,
                    ),
                  executionAnswerOperandStatusCounts:
                    summarizeAnswerOperandStatuses(
                      stateFrameShadow.executionProgram,
                      stateFrameShadow.executionResult,
                    ),
                  executionAnswerOperationStatusCounts:
                    summarizeAnswerOperationStatus(
                      stateFrameShadow.executionProgram,
                      stateFrameShadow.executionResult,
                    ),
                  executionReasonCounts: summarizeExecutionReasons(
                    stateFrameShadow.executionResult,
                  ),
                  executionPlanBlockedReasonCounts:
                    summarizeExecutionPlanBlockedReasons(
                      stateFrameShadow.executionProgram,
                    ),
                  ...summarizeExecutionAnswerRequest(
                    stateFrameShadow.executionProgram,
                    stateFrameShadow.executionResult,
                  ),
                  ...(stateFrameShadow.readerProjectionBuild === undefined
                    ? {}
                    : stateFrameShadow.readerProjectionBuild.status ===
                        "projected"
                      ? {
                          executionReaderProjectionStatus: "projected" as const,
                          executionReaderProjectionKind:
                            stateFrameShadow.readerProjectionBuild.projection
                              .payload.kind,
                          executionReaderProjectionCertificateCount:
                            stateFrameShadow.readerProjectionBuild.projection
                              .stateBindingCertificateIds.length,
                        }
                      : {
                          executionReaderProjectionStatus: "rejected" as const,
                          executionReaderProjectionRejectedReason:
                            stateFrameShadow.readerProjectionBuild
                              .rejectedReason,
                          executionReaderProjectionCertificateCount: 0,
                        }),
                  executionReadNodeCompleteCount:
                    stateFrameShadow.executionResult.nodes.filter(
                      (node) =>
                        node.operation === "read_requirement" &&
                        node.status === "complete",
                    ).length,
                  executionReadNodeBlockedCount:
                    stateFrameShadow.executionResult.nodes.filter(
                      (node) =>
                        node.operation === "read_requirement" &&
                        node.status !== "complete",
                    ).length,
                }),
            assistantValidatedObservationCount:
              stateFrameShadow.assistantValidatedObservationCount,
            uncertifiedAssistantValidatedObservationCount:
              stateFrameShadow.uncertifiedAssistantValidatedObservationCount,
          })
        : undefined;
      const stateShadowAuditRevision =
        input.stateObservationBinder === undefined
          ? undefined
          : hashCanonicalJsonV1({
              schemaVersion: "paw.memory-state-shadow-audit.v1",
              status: stateFrameShadow?.status ?? "fallback",
              binderVersion: input.stateObservationBinder.binderVersion,
              verifierVersion:
                input.stateObservationVerifier?.verifierVersion ?? null,
              failureCode: stateFrameFailureCode ?? null,
              bindingRevision: stateFrameShadow?.bindingRevision ?? null,
              verificationRevision:
                stateFrameShadow?.verificationRevision ?? null,
              bindingCertificateAuditRevision:
                stateFrameShadow?.stateShadowAuditRevision ?? null,
              programRevision: stateFrameShadow?.frame?.programRevision ?? null,
              sourceLockDigest:
                stateFrameShadow?.frame?.sourceLockDigest ?? null,
              telemetry: stateFrameTelemetry ?? null,
            } as unknown as JsonValue);
      const revisionBody = {
        resolverVersion: PAW_MEMORY_EVIDENCE_RESOLVER_VERSION_V1,
        indexVersion: input.index.indexVersion,
        fusionVersion: PAW_MEMORY_EVIDENCE_CANDIDATE_FUSION_VERSION_V2,
        notebookVersion: PAW_MEMORY_EVIDENCE_NOTEBOOK_POLICY_VERSION_V1,
        intent,
        plannerStatus,
        ...(plannerFailureCode === undefined ? {} : { plannerFailureCode }),
        obligationShape,
        obligationStatus,
        queryAnswerOrigin,
        sourceAcquisition,
        evidenceTimeUpperBoundRevision:
          input.evidenceTimeUpperBound === undefined
            ? "unbounded"
            : hashCanonicalJsonV1(input.evidenceTimeUpperBound as JsonValue),
        supportSelectorStatus,
        closureAuditStatus,
        closureMode,
        closureVerdict,
        closureDeficiencyCount,
        closureRepairCount,
        closureRepairMode,
        ...(closureAuditFailureCode === undefined
          ? {}
          : { closureAuditFailureCode }),
        supportAssessments,
        sourceLocalization,
        degradedChannels,
        ...(input.supportSelector === undefined
          ? {}
          : { supportSelectorVersion: input.supportSelector.selectorVersion }),
        ...(supportSelectionRevision === undefined
          ? {}
          : { supportSelectionRevision }),
        ...(input.closureAuditor === undefined
          ? {}
          : { closureAuditorVersion: input.closureAuditor.auditorVersion }),
        ...(closureAuditRevision === undefined ? {} : { closureAuditRevision }),
        requirements: resolvedRequirements.map(
          ({ searchText, ...requirement }) => ({
            ...requirement,
            searchTextHash: hashCanonicalJsonV1(searchText as JsonValue),
          }),
        ),
        sources: fusion.sources.map((source) => ({
          sourceId: source.sourceId,
          evidenceRefs: source.evidence.map((item) => item.evidenceRef),
        })),
        coverage: notebook.coverage,
        requirementEvidence,
        packetSources: packetSources.map((source) => ({
          sourceId: source.sourceId,
          evidenceRefs: source.evidenceRefs,
          evidenceBindings: source.evidenceBindings,
          evidenceUses: source.evidenceUses,
        })),
      };
      return Object.freeze({
        resolverVersion: PAW_MEMORY_EVIDENCE_RESOLVER_VERSION_V1,
        indexVersion: input.index.indexVersion,
        intent,
        plannerStatus,
        ...(plannerFailureCode === undefined ? {} : { plannerFailureCode }),
        obligationShape,
        obligationStatus,
        supportSelectorStatus,
        ...(input.stateObservationBinder === undefined
          ? {}
          : {
              stateFrameStatus: stateFrameShadow?.status ?? "fallback",
              stateBinderVersion: input.stateObservationBinder.binderVersion,
              ...(stateShadowAuditRevision === undefined
                ? {}
                : { stateShadowAuditRevision }),
              ...(input.stateObservationVerifier === undefined
                ? {}
                : {
                    stateVerifierVersion:
                      input.stateObservationVerifier.verifierVersion,
                  }),
              ...(stateFrameFailureCode === undefined
                ? {}
                : { stateFrameFailureCode }),
              ...(stateFrameFailureStage === undefined
                ? {}
                : { stateFrameFailureStage }),
              ...(stateFrameShadow?.bindingRevision === undefined
                ? {}
                : { stateBindingRevision: stateFrameShadow.bindingRevision }),
              ...(stateFrameShadow?.verificationRevision === undefined
                ? {}
                : {
                    stateVerificationRevision:
                      stateFrameShadow.verificationRevision,
                  }),
              ...(stateFrameShadow?.frame === undefined
                ? {}
                : { stateFrame: stateFrameShadow.frame }),
              ...(stateFrameShadow?.readerProjectionBuild === undefined
                ? {}
                : {
                    readerProjectionBuild:
                      stateFrameShadow.readerProjectionBuild,
                  }),
              ...(stateFrameTelemetry === undefined
                ? {}
                : { stateFrameTelemetry }),
            }),
        closureAuditStatus,
        closureMode,
        ...(closureVerdict === undefined ? {} : { closureVerdict }),
        closureDeficiencyCount,
        closureRepairCount,
        closureRepairMode,
        ...(closureAuditFailureCode === undefined
          ? {}
          : { closureAuditFailureCode }),
        supportAssessments,
        sourceLocalization,
        degradedChannels,
        ...(input.supportSelector === undefined
          ? {}
          : { supportSelectorVersion: input.supportSelector.selectorVersion }),
        ...(supportSelectionRevision === undefined
          ? {}
          : { supportSelectionRevision }),
        ...(input.closureAuditor === undefined
          ? {}
          : { closureAuditorVersion: input.closureAuditor.auditorVersion }),
        ...(closureAuditRevision === undefined ? {} : { closureAuditRevision }),
        requirements: resolvedRequirements,
        sources: fusion.sources,
        sourceAcquisition,
        primaryHits: primary.hits,
        requirementEvidence,
        packetSources,
        telemetry: fusion.telemetry,
        notebook,
        resolutionRevision: hashCanonicalJsonV1(
          revisionBody as unknown as JsonValue,
        ),
      });
    },
  });
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

function stablePlannerFailureCode(error: unknown): string {
  if (
    error instanceof Error &&
    /^MemoryEvidenceQueryPlan[A-Za-z0-9]+$/u.test(error.name)
  ) {
    return error.name;
  }
  return "MemoryEvidenceQueryPlannerFailed";
}

function stableClosureAuditFailureCode(error: unknown): string {
  if (
    error instanceof Error &&
    /^MemoryEvidenceQueryPlan[A-Za-z0-9]+$/u.test(error.name)
  ) {
    return "MemoryEvidenceClosureReplanFailed";
  }
  if (
    error instanceof Error &&
    /^MemoryEvidenceClosureAudit[A-Za-z0-9]+$/u.test(error.name)
  ) {
    return error.name;
  }
  return "MemoryEvidenceClosureAuditFailed";
}

function stableStateFrameFailureCode(error: unknown): string {
  if (
    error instanceof Error &&
    /^(?:MemoryState|MemoryEvidenceExecution(?:Coverage|Program|Runtime))[A-Za-z0-9]+$/u.test(
      error.name,
    )
  ) {
    return error.name;
  }
  return "MemoryStateFrameFailed";
}

function summarizeExecutionOperationStatuses(
  result: NonNullable<MemoryStateFrameShadowResultV2["executionResult"]>,
): Readonly<Record<string, Readonly<Record<string, number>>>> {
  const output: Record<string, Record<string, number>> = {};
  for (const node of result.nodes) {
    const statuses = output[node.operation] ?? {};
    statuses[node.status] = (statuses[node.status] ?? 0) + 1;
    output[node.operation] = statuses;
  }
  return Object.freeze(
    Object.fromEntries(
      Object.entries(output).map(([operation, statuses]) => [
        operation,
        Object.freeze({ ...statuses }),
      ]),
    ),
  );
}

function summarizeAnswerOperandStatuses(
  program: NonNullable<MemoryStateFrameShadowResultV2["executionProgram"]>,
  result: NonNullable<MemoryStateFrameShadowResultV2["executionResult"]>,
): Readonly<Record<string, Readonly<Record<string, number>>>> {
  const frontier = new Set(program.answerOperandNodeIds);
  const output: Record<string, Record<string, number>> = {};
  for (const node of result.nodes) {
    if (!frontier.has(node.nodeId)) continue;
    const statuses = output[node.operation] ?? {};
    statuses[node.status] = (statuses[node.status] ?? 0) + 1;
    output[node.operation] = statuses;
  }
  return Object.freeze(
    Object.fromEntries(
      Object.entries(output).map(([operation, statuses]) => [
        operation,
        Object.freeze({ ...statuses }),
      ]),
    ),
  );
}

function summarizeAnswerOperationStatus(
  program: NonNullable<MemoryStateFrameShadowResultV2["executionProgram"]>,
  result: NonNullable<MemoryStateFrameShadowResultV2["executionResult"]>,
): Readonly<Record<string, Readonly<Record<string, number>>>> {
  const answer = result.nodes.find(
    (node) => node.nodeId === program.answerNodeId,
  );
  return answer
    ? Object.freeze({
        [answer.operation]: Object.freeze({ [answer.status]: 1 }),
      })
    : Object.freeze({});
}

function summarizeExecutionReasons(
  result: NonNullable<MemoryStateFrameShadowResultV2["executionResult"]>,
): Readonly<Record<string, number>> {
  const output: Record<string, number> = {};
  for (const node of result.nodes) {
    if (node.reason) output[node.reason] = (output[node.reason] ?? 0) + 1;
  }
  return Object.freeze({ ...output });
}

function summarizeExecutionPlanBlockedReasons(
  program: NonNullable<MemoryStateFrameShadowResultV2["executionProgram"]>,
): Readonly<Record<string, number>> {
  const output: Record<string, number> = {};
  for (const node of program.nodes) {
    if (node.blockedReason) {
      output[node.blockedReason] = (output[node.blockedReason] ?? 0) + 1;
    }
  }
  return Object.freeze({ ...output });
}

function summarizeExecutionAnswerRequest(
  program: NonNullable<MemoryStateFrameShadowResultV2["executionProgram"]>,
  result: NonNullable<MemoryStateFrameShadowResultV2["executionResult"]>,
): Readonly<{
  executionAggregateOperator?: string;
  executionAggregationUnit?: string;
  executionAggregateCountBasis?: string;
  executionAggregateMaterializationExact?: boolean;
  executionAggregateMaterializationState?:
    | "exact"
    | "inexact"
    | "not_materialized";
  executionDurationEndpointPolicy?: string;
  executionDurationEndpointContractKind?: string;
  executionDurationEndpointOrdering?: string;
  executionDurationOperandGroupCount?: number;
  executionDurationRawEndpointCount?: number;
  executionDurationDistinctClaimCount?: number;
  executionDurationDistinctEventCount?: number;
  executionDurationEndpointTimeBasisCounts?: Readonly<Record<string, number>>;
  executionDurationEndpointRoleCounts?: Readonly<Record<string, number>>;
  executionDurationStateBindingCertificateCount?: number;
  executionDurationEndpointCertificateMaterialized?: boolean;
  executionDurationClosureBasis?: "closed_endpoint_set" | "not_closed";
  executionPersonalizationCoverageCertificateMaterialized?: boolean;
  executionPersonalizationConstraintCount?: number;
  executionPersonalizationLifecycleCertificateCount?: number;
}> {
  const answer = program.nodes.find(
    (node) => node.nodeId === program.answerNodeId,
  );
  const answerResult = result.nodes.find(
    (node) => node.nodeId === program.answerNodeId,
  );
  const aggregate = answerResult?.values.find(
    (value) => value.kind === "aggregate",
  );
  const duration = answerResult?.values.find(
    (value) => value.kind === "temporal_duration",
  );
  const personalization = answerResult?.values.find(
    (value) => value.kind === "personalization_profile",
  );
  const durationOperandResults = answer
    ? answer.operandNodeIds.flatMap((nodeId) => {
        const operand = result.nodes.find(
          (candidate) => candidate.nodeId === nodeId,
        );
        return operand ? [operand] : [];
      })
    : [];
  const durationRawEndpoints = durationOperandResults.flatMap((operand) =>
    operand.values.filter((value) => value.kind === "observation"),
  );
  if (!answer) return Object.freeze({});
  return Object.freeze({
    ...(answer.aggregateRequest
      ? {
          executionAggregateOperator: answer.aggregateRequest.operator,
          executionAggregationUnit: answer.aggregateRequest.aggregationUnit,
          executionAggregateCountBasis:
            answer.aggregateRequest.countBasis ?? "not_applicable",
          executionAggregateMaterializationState:
            aggregate?.kind === "aggregate"
              ? aggregate.materializationExact
                ? "exact"
                : "inexact"
              : "not_materialized",
          ...(aggregate?.kind === "aggregate"
            ? {
                executionAggregateMaterializationExact:
                  aggregate.materializationExact,
              }
            : {}),
        }
      : {}),
    ...(answer.durationRequest
      ? {
          executionDurationEndpointPolicy:
            answer.durationRequest.endpointPolicy,
          executionDurationEndpointContractKind:
            answer.durationRequest.endpointContract.kind,
          ...(answer.durationRequest.endpointContract.kind ===
          "distinct_evidence_pair"
            ? {
                executionDurationEndpointOrdering:
                  answer.durationRequest.endpointContract.ordering,
              }
            : {}),
          executionDurationOperandGroupCount: answer.operandNodeIds.length,
          executionDurationRawEndpointCount: durationRawEndpoints.length,
          executionDurationDistinctClaimCount: new Set(
            durationRawEndpoints.map((value) => value.claimIdentity),
          ).size,
          executionDurationDistinctEventCount: new Set(
            durationRawEndpoints.flatMap((value) =>
              value.eventIdentity ? [value.eventIdentity] : [],
            ),
          ).size,
          executionDurationEndpointTimeBasisCounts: countStringValues(
            durationRawEndpoints.map((value) => value.eventTimeBasis),
          ),
          executionDurationEndpointRoleCounts: countStringValues(
            durationRawEndpoints.map((value) => value.durationEndpointRole),
          ),
          executionDurationStateBindingCertificateCount: new Set(
            durationRawEndpoints.map(
              (value) => value.stateBindingCertificateId,
            ),
          ).size,
          executionDurationEndpointCertificateMaterialized:
            duration?.kind === "temporal_duration" &&
            duration.endpointCertificateRevision.length > 0,
          executionDurationClosureBasis:
            duration?.kind === "temporal_duration" &&
            duration.endpointCertificateRevision.length > 0
              ? "closed_endpoint_set"
              : "not_closed",
        }
      : {}),
    ...(answer.personalizationRequest
      ? {
          executionPersonalizationCoverageCertificateMaterialized:
            personalization?.kind === "personalization_profile" &&
            Boolean(personalization.coverageCertificateRevision),
          executionPersonalizationConstraintCount:
            personalization?.kind === "personalization_profile"
              ? new Set([
                  ...personalization.explicitPositiveValueIds,
                  ...personalization.explicitNegativeValueIds,
                  ...personalization.goalValueIds,
                  ...personalization.contextualConstraintValueIds,
                ]).size
              : 0,
          executionPersonalizationLifecycleCertificateCount:
            personalization?.kind === "personalization_profile"
              ? (personalization.coverageCertificate?.lifecycleCertificates
                  .length ?? 0)
              : 0,
        }
      : {}),
  });
}

function countStringValues(
  values: readonly string[],
): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return Object.freeze({ ...counts });
}
