import {
  type MemoryEvidenceNotebookHitV1,
  type MemoryEvidenceNotebookRequirementV1,
  type MemoryEvidenceNotebookV1,
  PAW_MEMORY_EVIDENCE_NOTEBOOK_POLICY_VERSION_V1,
} from "./evidence-contracts.js";
import {
  type MemoryEvidenceBindingV1,
  type MemoryEvidenceUseV1,
  classifyMemoryEvidenceUseV1,
  renderMemoryEvidencePacketContractV1,
} from "./evidence-origin.js";
import {
  memoryEvidenceSupportScoreV1,
  projectMemoryEvidenceExcerptV1,
} from "./evidence-text.js";
import {
  inferMemoryStateSemanticsV1,
  resolveMemoryStateObservationsV1,
} from "./state-observation.js";

/**
 * Builds a deterministic, source-attributed notebook after primary source
 * discovery. Supplemental searches may fill evidence gaps inside the selected
 * sources, but can never replace the primary ranking. Context-only assistant
 * text stays closed unless the caller explicitly opens that trust boundary.
 */
export function buildMemoryEvidenceNotebookV1(input: {
  readonly requirements: readonly MemoryEvidenceNotebookRequirementV1[];
  readonly allowedSourceIds: readonly string[];
  readonly maxHitsPerRequirement: number;
  readonly maxChars: number;
  readonly allowContextOnly?: boolean;
}): MemoryEvidenceNotebookV1 {
  if (
    input.requirements.length > 4 ||
    !Number.isSafeInteger(input.maxHitsPerRequirement) ||
    input.maxHitsPerRequirement < 1 ||
    input.maxHitsPerRequirement > 8 ||
    !Number.isSafeInteger(input.maxChars) ||
    input.maxChars < 256 ||
    input.maxChars > 16_384
  ) {
    throw namedError("MemoryEvidenceNotebookBudgetInvalid");
  }
  const allowed = new Set(
    input.allowedSourceIds.map((sourceId) => sourceId.trim()).filter(Boolean),
  );
  const sourceParts = new Map<
    string,
    {
      parts: string[];
      evidenceRefs: string[];
      evidenceBindings: Map<string, MemoryEvidenceUseV1>;
      answerRoles: Set<"current" | "ambiguous" | "supporting">;
    }
  >();
  const coverage: Array<{
    requirementId: string;
    status: "covered" | "partial" | "missing";
    selectedHitCount: number;
    independentEvidenceCount: number;
    closureEvidenceCount: number;
    selectedEvidenceRefs: readonly string[];
    historicalEvidenceRefs: readonly string[];
    unresolvedEvidenceRefs: readonly string[];
  }> = [];
  const seenRequirementIds = new Set<string>();
  const renderedEvidenceRefs = new Set<string>();
  let chars = 0;
  const inputHitCount = input.requirements.reduce(
    (total, requirement) => total + requirement.hits.length,
    0,
  );
  let budgetOmittedHitCount = 0;
  let selectedHitCount = 0;
  const minimumRequirementBudget = Math.max(
    1,
    Math.floor(input.maxChars / Math.max(1, input.requirements.length)),
  );
  const sourceHeader = `${renderMemoryEvidencePacketContractV1()}\n`;
  for (const [
    requirementIndex,
    rawRequirement,
  ] of input.requirements.entries()) {
    const requirementId = rawRequirement.requirementId.trim();
    const label = rawRequirement.label.trim().replace(/\s+/gu, " ");
    const searchText = rawRequirement.searchText.trim().replace(/\s+/gu, " ");
    if (
      !requirementId ||
      requirementId.length > 96 ||
      seenRequirementIds.has(requirementId) ||
      !label ||
      label.length > 192 ||
      !searchText ||
      searchText.length > 192
    ) {
      throw namedError("MemoryEvidenceNotebookRequirementInvalid");
    }
    const minimumEvidence = rawRequirement.minimumEvidence ?? 1;
    if (
      !Number.isSafeInteger(minimumEvidence) ||
      minimumEvidence < 1 ||
      minimumEvidence > 3
    ) {
      throw namedError("MemoryEvidenceNotebookRequirementInvalid");
    }
    // Divide the slot budget by evidence that actually reached this notebook,
    // not by the configured ceiling. Otherwise raising maxHits from 4 to 8 can
    // shrink one selected excerpt below the projector minimum and erase it.
    const targetHits = Math.max(
      1,
      Math.min(
        input.maxHitsPerRequirement,
        new Set(
          rawRequirement.hits
            .map((hit) => hit.evidenceRef.trim())
            .filter(Boolean),
        ).size,
      ),
    );
    const remainingRequirementReserve =
      (input.requirements.length - requirementIndex - 1) *
      minimumRequirementBudget;
    const requirementBudget = Math.max(
      0,
      input.maxChars - chars - remainingRequirementReserve,
    );
    const hitBudget = Math.max(
      192,
      Math.floor(requirementBudget / Math.max(1, targetHits)),
    );
    seenRequirementIds.add(requirementId);
    const selection = rawRequirement.selection ?? "ranked";
    if (selection !== "ranked" && selection !== "latest") {
      throw namedError("MemoryEvidenceNotebookRequirementInvalid");
    }
    const seenRefs = new Set<string>();
    const independentKeys = new Set<string>();
    const selectedRefs: string[] = [];
    let selectedForRequirement = 0;
    let independentForRequirement = 0;
    const requiresIndependentEpisodes =
      rawRequirement.coverageMode === "convergent" ||
      rawRequirement.coverageMode === "all";
    const supportText = `${label} ${searchText}`;
    const roleConstraint = rawRequirement.roleConstraint ?? "user";
    const certifiedDialogueEvidenceRefs = new Set(
      rawRequirement.certifiedDialogueEvidenceRefs ?? [],
    );
    const rankedHits = rawRequirement.hits
      .map((hit, rank) => ({
        hit,
        rank,
        supportScore: memoryEvidenceSupportScoreV1(supportText, hit.content),
      }))
      .sort(
        (left, right) =>
          right.supportScore - left.supportScore || left.rank - right.rank,
      );
    const hasRelevantHit = rankedHits.some((item) => item.supportScore > 0);
    let currentRefs = new Set<string>();
    let ambiguousRefs = new Set<string>();
    let historicalRefs = new Set<string>();
    if (selection === "latest") {
      const eligible = rankedHits.filter(({ hit, supportScore }) => {
        const sourceId = hit.sourceId.trim();
        const evidenceUse = classifyMemoryEvidenceUseV1({
          roleConstraint,
          sourceKind: hit.sourceKind,
          authority: hit.authority,
          dialogueCertified: certifiedDialogueEvidenceRefs.has(hit.evidenceRef),
        });
        return (
          supportScore > 0 &&
          evidenceUse !== undefined &&
          allowed.has(sourceId) &&
          hit.evidenceRef.trim() &&
          hit.content.trim() &&
          (hit.authority !== "context_only" || input.allowContextOnly)
        );
      });
      const resolution = resolveMemoryStateObservationsV1({
        observations: eligible.map(({ hit }) => ({
          ...hit,
          content: projectMemoryEvidenceExcerptV1(
            hit.content,
            searchText,
            8_192,
          ),
          stateKey: requirementId,
          episodeOrder: hit.episodeOrder ?? hit.observedOrder,
          turnOrder: hit.turnOrder,
          ...inferEvidenceStateSemanticsV1(hit.content, searchText),
        })),
        mode: "latest",
        allowContextOnly: input.allowContextOnly,
      });
      currentRefs = new Set(resolution.current.map((item) => item.evidenceRef));
      ambiguousRefs = new Set(
        resolution.ambiguous.map((item) => item.evidenceRef),
      );
      historicalRefs = new Set(
        resolution.history.map((item) => item.evidenceRef),
      );
      const resolutionOrder = new Map(
        [
          ...resolution.current,
          ...resolution.ambiguous,
          ...resolution.history,
        ].map((item, index) => [item.evidenceRef, index] as const),
      );
      rankedHits.sort(
        (left, right) =>
          (resolutionOrder.get(left.hit.evidenceRef) ??
            Number.MAX_SAFE_INTEGER) -
            (resolutionOrder.get(right.hit.evidenceRef) ??
              Number.MAX_SAFE_INTEGER) || left.rank - right.rank,
      );
    }
    for (const { hit: rawHit, supportScore } of rankedHits) {
      if (
        (requiresIndependentEpisodes
          ? independentForRequirement
          : selectedForRequirement) >= targetHits
      ) {
        break;
      }
      const sourceId = rawHit.sourceId.trim();
      const evidenceRef = rawHit.evidenceRef.trim();
      const content = rawHit.content.trim();
      const evidenceUse = classifyMemoryEvidenceUseV1({
        roleConstraint,
        sourceKind: rawHit.sourceKind,
        authority: rawHit.authority,
        dialogueCertified: certifiedDialogueEvidenceRefs.has(evidenceRef),
      });
      if (
        !allowed.has(sourceId) ||
        !evidenceRef ||
        !content ||
        evidenceUse === undefined ||
        (hasRelevantHit && supportScore <= 0) ||
        seenRefs.has(evidenceRef) ||
        (rawHit.authority === "context_only" && !input.allowContextOnly)
      ) {
        continue;
      }
      const independentKey = memoryEvidenceIndependentKey(rawHit);
      if (requiresIndependentEpisodes && independentKeys.has(independentKey)) {
        continue;
      }
      // Latest-state answers receive only the controlling current evidence (or
      // unresolved peers). Superseded observations remain addressable through
      // coverage metadata, but are not rendered as equal-rank model context.
      if (
        selection === "latest" &&
        !currentRefs.has(evidenceRef) &&
        !ambiguousRefs.has(evidenceRef)
      ) {
        continue;
      }
      seenRefs.add(evidenceRef);
      if (renderedEvidenceRefs.has(evidenceRef)) {
        selectedRefs.push(evidenceRef);
        selectedForRequirement += 1;
        independentKeys.add(independentKey);
        independentForRequirement = independentKeys.size;
        continue;
      }
      const observed = rawHit.observedAt?.trim() || "unknown";
      const observedOrder = rawHit.observedOrder;
      const episodeOrder = rawHit.episodeOrder ?? observedOrder;
      const turnOrder = rawHit.turnOrder;
      if (
        [observedOrder, episodeOrder, turnOrder]
          .filter((value): value is number => value !== undefined)
          .some((value) => !Number.isSafeInteger(value) || value < 0)
      ) {
        throw namedError("MemoryEvidenceNotebookHitOrderInvalid");
      }
      const timeline =
        selection === "latest"
          ? currentRefs.has(evidenceRef)
            ? "latest"
            : ambiguousRefs.has(evidenceRef)
              ? "ambiguous"
              : "previous"
          : "ranked";
      const semantics = inferEvidenceStateSemanticsV1(content, searchText);
      const stateSemantics =
        timeline === "latest"
          ? "state=current; relation=controls_current_answer"
          : timeline === "ambiguous"
            ? "state=ambiguous; relation=does_not_override_without_disambiguation"
            : timeline === "previous"
              ? "state=historical; relation=superseded_by_latest_statement"
              : "state=unspecified; relation=supporting_evidence";
      const separatorChars = sourceParts.has(sourceId)
        ? 2
        : sourceHeader.length;
      const requirementLine = `[Requirement: ${label}]`;
      const metadataLine =
        selection === "latest"
          ? `[timeline=${timeline}; ${stateSemantics}; evidence_use=${evidenceUse}; precision=${semantics.valueQualifier}; epistemic=${semantics.epistemicStatus}; authority=${rawHit.authority}; observed=${observed}; episode=${episodeOrder ?? "unknown"}; turn=${turnOrder ?? "unknown"}; evidence=${evidenceRef}]`
          : `[evidence=${evidenceRef}; evidence_use=${evidenceUse}; authority=${rawHit.authority}; observed=${observed}; episode=${episodeOrder ?? "unknown"}; turn=${turnOrder ?? "unknown"}; precision=${semantics.valueQualifier}; epistemic=${semantics.epistemicStatus}]`;
      const fixedChars = requirementLine.length + metadataLine.length + 2;
      const excerptBudget = Math.min(
        hitBudget - fixedChars,
        input.maxChars - chars - separatorChars - fixedChars,
      );
      // The shared excerpt projector has a 128-character lower bound. A
      // metadata-heavy evidence address can leave 64-127 characters even
      // though the notebook itself still has space; skip that hit instead of
      // turning a bounded omission into a resolver-wide failure.
      if (excerptBudget < 128) {
        budgetOmittedHitCount += 1;
        continue;
      }
      const excerpt = projectMemoryEvidenceExcerptV1(
        content,
        searchText,
        excerptBudget,
      );
      const part = [requirementLine, metadataLine, excerpt].join("\n");
      if (chars + separatorChars + part.length > input.maxChars) {
        budgetOmittedHitCount += 1;
        continue;
      }
      const state = sourceParts.get(sourceId) ?? {
        parts: [],
        evidenceRefs: [],
        evidenceBindings: new Map<string, MemoryEvidenceUseV1>(),
        answerRoles: new Set<"current" | "ambiguous" | "supporting">(),
      };
      state.parts.push(part);
      state.evidenceRefs.push(evidenceRef);
      const existingUse = state.evidenceBindings.get(evidenceRef);
      if (existingUse !== undefined && existingUse !== evidenceUse) {
        throw namedError("MemoryEvidenceBindingConflict");
      }
      state.evidenceBindings.set(evidenceRef, evidenceUse);
      state.answerRoles.add(
        timeline === "latest"
          ? "current"
          : timeline === "ambiguous"
            ? "ambiguous"
            : "supporting",
      );
      selectedRefs.push(evidenceRef);
      renderedEvidenceRefs.add(evidenceRef);
      sourceParts.set(sourceId, state);
      chars += separatorChars + part.length;
      selectedForRequirement += 1;
      independentKeys.add(independentKey);
      independentForRequirement = independentKeys.size;
      selectedHitCount += 1;
    }
    coverage.push({
      requirementId,
      status:
        selection === "latest" && ambiguousRefs.size > 0
          ? "partial"
          : (requiresIndependentEpisodes
                ? independentForRequirement
                : selectedForRequirement) >= minimumEvidence
            ? "covered"
            : (requiresIndependentEpisodes
                  ? independentForRequirement
                  : selectedForRequirement) > 0
              ? "partial"
              : "missing",
      selectedHitCount: selectedForRequirement,
      independentEvidenceCount: independentForRequirement,
      closureEvidenceCount: requiresIndependentEpisodes
        ? independentForRequirement
        : selectedForRequirement,
      selectedEvidenceRefs: Object.freeze(selectedRefs),
      historicalEvidenceRefs: Object.freeze([...historicalRefs]),
      unresolvedEvidenceRefs: Object.freeze([...ambiguousRefs]),
    });
  }
  const sources = [...sourceParts.entries()].map(([sourceId, state]) => {
    const text = `${sourceHeader}${state.parts.join("\n\n")}`;
    const evidenceBindings: readonly MemoryEvidenceBindingV1[] = Object.freeze(
      [...state.evidenceBindings].map(([evidenceRef, evidenceUse]) =>
        Object.freeze({ evidenceRef, evidenceUse }),
      ),
    );
    return Object.freeze({
      sourceId,
      text,
      evidenceRefs: Object.freeze([...state.evidenceRefs]),
      evidenceBindings,
      evidenceUses: Object.freeze([
        ...new Set(evidenceBindings.map((binding) => binding.evidenceUse)),
      ]),
      answerRole: singleAnswerRole(state.answerRoles),
    });
  });
  return Object.freeze({
    policyVersion: PAW_MEMORY_EVIDENCE_NOTEBOOK_POLICY_VERSION_V1,
    sources: Object.freeze(sources),
    coverage: Object.freeze(coverage.map((item) => Object.freeze(item))),
    inputHitCount,
    budgetOmittedHitCount,
    selectedHitCount,
    chars: sources.reduce((total, source) => total + source.text.length, 0),
  });
}

function memoryEvidenceIndependentKey(
  hit: MemoryEvidenceNotebookHitV1,
): string {
  const eventKey = hit.eventKey?.trim();
  if (eventKey) return `event:${eventKey}`;
  const sourceId = hit.sourceId.trim();
  const episodeOrder = hit.episodeOrder ?? hit.observedOrder;
  // A source is the safest fallback episode boundary. Treating every turn as
  // independent would let repeated wording from one conversation fake
  // convergence when the adapter cannot provide explicit episode metadata.
  return episodeOrder === undefined
    ? `source:${sourceId}`
    : `source:${sourceId}\0episode:${episodeOrder}`;
}

function inferEvidenceStateSemanticsV1(content: string, searchText: string) {
  // Raw L0 remains immutable and may be much larger than the state reducer's
  // bounded semantic input. Analyze the same query-focused projection that is
  // eligible for the notebook instead of failing the whole read path.
  return inferMemoryStateSemanticsV1(
    projectMemoryEvidenceExcerptV1(content, searchText, 8_192),
  );
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

function singleAnswerRole<T extends string>(
  roles: ReadonlySet<T>,
): T | "mixed" {
  return roles.size === 1 ? (roles.values().next().value ?? "mixed") : "mixed";
}
