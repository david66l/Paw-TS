import { type JsonValue, hashCanonicalJsonV1 } from "./canonical.js";
import type {
  MemoryEvidenceClosureAuditorV1,
  MemoryEvidenceClosureVerdictV1,
} from "./evidence-closure-auditor.js";
import {
  PAW_MEMORY_EVIDENCE_CANDIDATE_FUSION_VERSION_V2,
  PAW_MEMORY_EVIDENCE_NOTEBOOK_POLICY_VERSION_V1,
  rankMemoryEvidenceCandidatesV2,
} from "./evidence-first.js";
import {
  type MemoryEvidenceQueryIntentV3,
  type MemoryEvidenceQueryPlannerV3,
  type MemoryEvidenceRequirementV3,
  classifyMemoryEvidenceQueryV3,
  needsCertifiedAssistantDialogueCandidateV1,
} from "./evidence-query-planner.js";
import { resolveEvidencePass } from "./evidence-resolution-pass.js";
import {
  abortError,
  boundedInteger,
  boundedQuery,
  createRootEvidenceRequirement,
  filterEvidenceSearchResultForRole,
  hasDeterministicDirectCertificate,
  isAbort,
  selectedNotebookEvidence,
  validateMemoryEvidenceQueryPlanBoundary,
} from "./evidence-resolver-helpers.js";
import type { MemoryEvidenceSupportSelectorV1 } from "./evidence-support-selector.js";
import {
  DEFAULT_MEMORY_SOURCE_LOCAL_EVIDENCE_BUDGET_V1,
  type MemorySourceLocalEvidenceBudgetV1,
  type MemorySourceLocalEvidenceHydratorV1,
  type MemorySourceLocalEvidenceLocatorV1,
} from "./source-local-evidence-locator.js";

import {
  type MemoryEvidenceIndexV1,
  type MemoryEvidenceResolutionV1,
  PAW_MEMORY_EVIDENCE_RESOLVER_VERSION_V1,
} from "./evidence-resolution-contracts.js";

export * from "./evidence-resolution-contracts.js";

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
  readonly sourceLocalLocator?: MemorySourceLocalEvidenceLocatorV1;
  readonly sourceLocalHydrator?: MemorySourceLocalEvidenceHydratorV1;
  readonly sourceLocalBudget?: MemorySourceLocalEvidenceBudgetV1;
  readonly evidenceTimeUpperBound?: string;
  readonly closureAuditor?: MemoryEvidenceClosureAuditorV1;
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
  return Object.freeze({
    resolverVersion: PAW_MEMORY_EVIDENCE_RESOLVER_VERSION_V1,
    async resolve(query: string, signal: AbortSignal) {
      const value = boundedQuery(query);
      let intent: MemoryEvidenceQueryIntentV3 =
        classifyMemoryEvidenceQueryV3(value);
      const certifiedAssistantDialogueCandidate =
        intent.roleConstraint === "user" &&
        needsCertifiedAssistantDialogueCandidateV1(value);
      const primaryUnfiltered = await input.index.search(value, signal);
      const primary = filterEvidenceSearchResultForRole(
        primaryUnfiltered,
        intent.roleConstraint,
      );
      const primaryFusion = rankMemoryEvidenceCandidatesV2({
        lists: primary.lists,
        maxSources,
        maxEvidencePerSource,
      });
      const directCertificateStatus: MemoryEvidenceResolutionV1["directCertificateStatus"] =
        intent.needsPlanning
          ? "not_applicable"
          : hasDeterministicDirectCertificate(
                value,
                primary.hits,
                primaryFusion.sources.map((source) => source.sourceId),
                intent.roleConstraint === "assistant",
              )
            ? "deterministic_direct"
            : "missing";
      let requirements: readonly MemoryEvidenceRequirementV3[] = [];
      let plannerStatus: MemoryEvidenceResolutionV1["plannerStatus"] =
        intent.needsPlanning ? "fallback" : "not_needed";
      const shouldPlan =
        input.planner !== undefined &&
        (intent.needsPlanning ||
          directCertificateStatus !== "deterministic_direct");
      if (shouldPlan && input.planner) {
        try {
          const plan = await input.planner.plan(value, signal, {
            force: !intent.needsPlanning,
          });
          validateMemoryEvidenceQueryPlanBoundary({
            plan,
            intent,
            plannerVersion: input.planner.plannerVersion,
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
        }
      }
      // An empty requirement set must not bypass semantic verification. Bind
      // the original question as one root requirement and run the same support
      // gate used by decomposed queries, including deterministic direct hits.
      if (requirements.length === 0 && input.supportSelector) {
        requirements = Object.freeze([
          createRootEvidenceRequirement(value, intent),
        ]);
      }
      const expansiveEvidence =
        intent.answerShape === "aggregate" ||
        intent.temporalMode === "history" ||
        intent.temporalMode === "range";
      const pass = await resolveEvidencePass({
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
        directCertificateStatus,
        sourceLocalLocator: input.sourceLocalLocator,
        sourceLocalHydrator: input.sourceLocalHydrator,
        sourceLocalBudget:
          input.sourceLocalBudget ??
          DEFAULT_MEMORY_SOURCE_LOCAL_EVIDENCE_BUDGET_V1,
        certifiedAssistantDialogueCandidate,
        evidenceTimeUpperBound: input.evidenceTimeUpperBound,
        signal,
      });
      let closureAuditStatus: MemoryEvidenceResolutionV1["closureAuditStatus"] =
        input.closureAuditor ? "not_needed" : "not_configured";
      let closureVerdict: MemoryEvidenceClosureVerdictV1 | undefined;
      const closureRepairCount: 0 | 1 = 0;
      let closureAuditRevision: string | undefined;
      const shouldAudit =
        input.closureAuditor !== undefined &&
        requirements.length > 0 &&
        pass.notebook.coverage.every((item) => item.status === "covered") &&
        (intent.roleConstraint !== "user" ||
          intent.temporalMode !== "any" ||
          intent.answerShape !== "lookup" ||
          requirements.length > 1 ||
          (directCertificateStatus === "missing" &&
            pass.fusion.sources.length > 1));
      if (shouldAudit && input.closureAuditor) {
        const selectedEvidence = selectedNotebookEvidence(
          pass.requirementHits,
          pass.notebook,
        );
        try {
          const audit = await input.closureAuditor.audit(
            {
              query: value,
              intent,
              requirements,
              selectedEvidence,
              maxMissingRequirements: Math.min(2, 4 - requirements.length),
            },
            signal,
          );
          closureAuditStatus = "completed";
          // The old model-driven repair loop is intentionally audit-only. It
          // must not perform retrieval or alter source fusion; source-local
          // evidence now enters solely through the independent locator port.
          closureVerdict =
            audit.verdict === "repair" ? "insufficient" : audit.verdict;
          closureAuditRevision = audit.auditRevision;
        } catch (error) {
          if (signal.aborted || isAbort(error)) throw abortError();
          closureAuditStatus = "fallback";
        }
      }
      const {
        fusion,
        degradedChannels,
        supportSelectorStatus,
        supportSelectionRevision,
        supportAssessments,
        sourceLocalization,
        notebook,
        packetSources,
      } = pass;
      const revisionBody = {
        resolverVersion: PAW_MEMORY_EVIDENCE_RESOLVER_VERSION_V1,
        indexVersion: input.index.indexVersion,
        fusionVersion: PAW_MEMORY_EVIDENCE_CANDIDATE_FUSION_VERSION_V2,
        notebookVersion: PAW_MEMORY_EVIDENCE_NOTEBOOK_POLICY_VERSION_V1,
        intent,
        directCertificateStatus,
        plannerStatus,
        supportSelectorStatus,
        closureAuditStatus,
        closureVerdict,
        closureRepairCount,
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
        requirements: requirements.map(({ searchText, ...requirement }) => ({
          ...requirement,
          searchTextHash: hashCanonicalJsonV1(searchText as JsonValue),
        })),
        sources: fusion.sources.map((source) => ({
          sourceId: source.sourceId,
          evidenceRefs: source.evidence.map((item) => item.evidenceRef),
        })),
        coverage: notebook.coverage,
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
        directCertificateStatus,
        plannerStatus,
        supportSelectorStatus,
        closureAuditStatus,
        ...(closureVerdict === undefined ? {} : { closureVerdict }),
        closureRepairCount,
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
        requirements,
        sources: fusion.sources,
        primaryHits: primary.hits,
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
