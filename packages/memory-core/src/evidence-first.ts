import {
  inferMemoryStateSemanticsV1,
  resolveMemoryStateObservationsV1,
} from "./state-observation.js";

const EVIDENCE_SOURCE_RRF_K = 60;

export const PAW_MEMORY_EVIDENCE_FIRST_POLICY_VERSION_V1 =
  "paw.memory-evidence-first.v1";
export const PAW_MEMORY_EVIDENCE_CANDIDATE_FUSION_VERSION_V2 =
  "paw.memory-evidence-candidate-fusion.v2";
export const PAW_MEMORY_CONVERSATION_BUNDLE_POLICY_VERSION_V1 =
  "paw.memory-conversation-bundle.v2:explicit-assistant-output-recall";
export const PAW_MEMORY_EVIDENCE_NOTEBOOK_POLICY_VERSION_V1 =
  "paw.memory-evidence-notebook.v9:mode-consistent-fair-closure";

export type MemoryEvidenceChannelV1 = "l0" | "l1";

export interface MemoryEvidenceSourceRankListV1 {
  readonly channel: MemoryEvidenceChannelV1;
  readonly weight: number;
  /** Ordered best-first. Duplicates in one channel count only once. */
  readonly sourceIds: readonly string[];
}

export interface RankedMemoryEvidenceSourceV1 {
  readonly sourceId: string;
  readonly score: number;
  readonly channelHits: number;
  readonly channels: readonly MemoryEvidenceChannelV1[];
  readonly bestRank: number;
}

export interface MemoryEvidenceSourceFusionV1 {
  readonly policyVersion: typeof PAW_MEMORY_EVIDENCE_FIRST_POLICY_VERSION_V1;
  readonly sources: readonly RankedMemoryEvidenceSourceV1[];
  readonly telemetry: Readonly<{
    inputListCount: number;
    l0CandidateCount: number;
    l1CandidateCount: number;
    fusedCandidateCount: number;
    dualChannelCount: number;
    returnedCount: number;
  }>;
}

export type MemoryEvidenceAuthorityV2 =
  | "user_asserted"
  | "user_confirmed_dialogue"
  | "context_only"
  | "derived"
  | "mixed";

export type MemoryEvidenceKindV2 =
  | MemoryConversationTurnKindV1
  | "source_chunk"
  | "source_span"
  | "derived_atom";

/**
 * Content-free address used by every retrieval channel. The payload remains in
 * its owning store and is hydrated only after fusion has selected this address.
 */
export interface MemoryEvidenceCandidateV2 {
  readonly candidateId: string;
  readonly sourceId: string;
  readonly evidenceRef: string;
  readonly sourceKind: MemoryEvidenceKindV2;
  readonly authority: MemoryEvidenceAuthorityV2;
  readonly observedAt?: string;
}

export interface MemoryEvidenceCandidateRankListV2 {
  readonly channel: MemoryEvidenceChannelV1;
  readonly retrieverId: string;
  readonly weight: number;
  /** Ordered best-first. Candidate addresses are deduplicated within a list. */
  readonly candidates: readonly MemoryEvidenceCandidateV2[];
}

export interface RankedMemoryEvidenceCandidateV2
  extends MemoryEvidenceCandidateV2 {
  readonly score: number;
  readonly listHits: number;
  readonly channels: readonly MemoryEvidenceChannelV1[];
  readonly bestRank: number;
}

export interface RankedMemoryEvidenceSourceV2 {
  readonly sourceId: string;
  readonly score: number;
  readonly channelHits: number;
  readonly channels: readonly MemoryEvidenceChannelV1[];
  readonly bestRank: number;
  readonly evidence: readonly RankedMemoryEvidenceCandidateV2[];
}

export interface MemoryEvidenceCandidateFusionV2 {
  readonly policyVersion: typeof PAW_MEMORY_EVIDENCE_CANDIDATE_FUSION_VERSION_V2;
  readonly sources: readonly RankedMemoryEvidenceSourceV2[];
  readonly telemetry: Readonly<{
    inputListCount: number;
    l0CandidateCount: number;
    l1CandidateCount: number;
    fusedCandidateCount: number;
    fusedSourceCount: number;
    dualChannelSourceCount: number;
    returnedSourceCount: number;
    returnedEvidenceCount: number;
  }>;
}

export type MemoryConversationTurnKindV1 =
  | "user_input"
  | "assistant_output"
  | "tool_observation"
  | "verification"
  | "outcome"
  | "source_document";

export interface MemoryConversationTurnV1 {
  readonly evidenceRef?: string;
  readonly sourceSeq: number;
  readonly sourceKind: MemoryConversationTurnKindV1;
  readonly content: string;
  readonly hit: boolean;
}

export interface MemoryConversationTurnBundleV1 {
  readonly policyVersion: typeof PAW_MEMORY_CONVERSATION_BUNDLE_POLICY_VERSION_V1;
  readonly text: string;
  readonly hitSeq: number;
  readonly authority:
    | "user_asserted"
    | "user_confirmed_dialogue"
    | "context_only";
  readonly includedTurns: number;
  readonly includedEvidence: readonly Readonly<{
    evidenceRef: string;
    sourceKind: MemoryConversationTurnKindV1;
    turnOrder: number;
  }>[];
  readonly chars: number;
}

export interface SelectedMemoryConversationBundlesV1 {
  readonly text: string;
  readonly selectedBundles: number;
  readonly chars: number;
}

export interface MemoryEvidenceNotebookHitV1 {
  readonly sourceId: string;
  readonly evidenceRef: string;
  readonly content: string;
  readonly authority: MemoryEvidenceAuthorityV2;
  readonly observedAt?: string;
  /** Monotonic order inside one scoped history; disambiguates equal timestamps. */
  readonly observedOrder?: number;
  /** Stable episode/session order, independent of ingestion time. */
  readonly episodeOrder?: number;
  /** Stable turn order inside one episode/session. */
  readonly turnOrder?: number;
  /** Optional stable event identity shared by cross-session restatements. */
  readonly eventKey?: string;
  /** Exact role of the anchor turn when the hit came from conversational L0. */
  readonly sourceKind?: MemoryConversationTurnKindV1;
  /** Exact addresses of bounded neighbors rendered inside this hit. */
  readonly contextEvidenceRefs?: readonly string[];
}

export interface MemoryEvidenceNotebookRequirementV1 {
  readonly requirementId: string;
  readonly label: string;
  readonly searchText: string;
  readonly selection?: "ranked" | "latest";
  readonly relation?: "direct" | "temporal" | "comparative" | "inferred";
  readonly coverageMode?: "any" | "all" | "latest" | "convergent";
  readonly minimumEvidence?: number;
  /** Ordered best-first for this requirement. */
  readonly hits: readonly MemoryEvidenceNotebookHitV1[];
}

export interface MemoryEvidenceNotebookV1 {
  readonly policyVersion: typeof PAW_MEMORY_EVIDENCE_NOTEBOOK_POLICY_VERSION_V1;
  readonly sources: readonly Readonly<{
    sourceId: string;
    text: string;
    evidenceRefs: readonly string[];
    answerRole: "current" | "ambiguous" | "supporting" | "mixed";
  }>[];
  readonly coverage: readonly Readonly<{
    requirementId: string;
    status: "covered" | "partial" | "missing";
    selectedHitCount: number;
    /** Independent episodes satisfying closure; duplicates never inflate it. */
    independentEvidenceCount: number;
    /** Count interpreted by coverageMode and used for the final closure gate. */
    closureEvidenceCount: number;
    /** Exact evidence selected for this requirement, never a packet-wide copy. */
    selectedEvidenceRefs: readonly string[];
    /** Superseded evidence retained for audit, never rendered as answer context. */
    historicalEvidenceRefs: readonly string[];
    /** Unresolved peers that prevent a latest-state requirement from closing. */
    unresolvedEvidenceRefs: readonly string[];
  }>[];
  readonly selectedHitCount: number;
  readonly chars: number;
}

/**
 * Returns true only when the current question explicitly asks about an earlier
 * assistant response or action. Assistant output is not a source of user facts,
 * so ordinary personal-memory questions must remain on the user-grounded path.
 */
export function isAssistantMemoryQueryV1(query: string): boolean {
  const normalized = query.trim().replace(/\s+/gu, " ");
  if (!normalized || normalized.length > 512) return false;
  const explicitAssistantAction =
    /\b(?:what|which|how)\b.{0,80}\b(?:did|have)\s+you\b|\b(?:you|your)\s+(?:said|told|recommended|suggested|wrote|created|generated|showed|booked|scheduled|provided|listed|gave|produced|composed|answered|mentioned|shared|replied|responded|came\s+up\s+with)\b|(?:你(?:之前|上次|此前)?|(?:之前|上次|此前)你)(?:说|告诉|推荐|建议|写|创建|生成|展示|提供|列出|给出|回答|回复|提到|分享|预订|安排)(?:了|过|的)?/iu.test(
      normalized,
    );
  const explicitPriorResponse =
    /\byour\s+(?:previous|earlier|last)\s+(?:response|answer|message|reply)\b|(?:你之前|你上次|你此前)(?:的)?(?:回复|回答|消息)/iu.test(
      normalized,
    );
  const explicitReminder =
    /\bremind\s+me\b.{0,80}\bwhat\s+you\s+(?:said|answered|recommended|suggested|mentioned|provided|listed)\b|提醒我.{0,40}你(?:说|回答|推荐|建议|提到|提供|列出)(?:了|过|的)?/iu.test(
      normalized,
    );
  return explicitAssistantAction || explicitPriorResponse || explicitReminder;
}

/**
 * Packs one lexical L0 hit with its immediate conversational neighbors. Role
 * labels are trust boundaries: assistant text stays context-only, while an
 * adjacent user confirmation remains visible to the reader. Output order is
 * always chronological even though retrieval ranks the hit first.
 */
export function buildMemoryConversationTurnBundleV1(input: {
  readonly turns: readonly MemoryConversationTurnV1[];
  readonly query: string;
  readonly maxChars: number;
}): MemoryConversationTurnBundleV1 {
  if (!Number.isSafeInteger(input.maxChars) || input.maxChars < 256) {
    throw namedError("MemoryConversationTurnBundleBudgetInvalid");
  }
  const query = input.query.trim();
  if (!query || query.length > 512) {
    throw namedError("MemoryConversationTurnBundleQueryInvalid");
  }
  const turns = [
    ...new Map(
      input.turns
        .filter(
          (turn) =>
            Number.isSafeInteger(turn.sourceSeq) &&
            turn.sourceSeq >= 0 &&
            turn.content.trim(),
        )
        .map((turn) => [`${turn.sourceSeq}\0${turn.sourceKind}`, turn]),
    ).values(),
  ].sort(
    (left, right) =>
      left.sourceSeq - right.sourceSeq ||
      left.sourceKind.localeCompare(right.sourceKind),
  );
  const hits = turns.filter((turn) => turn.hit);
  if (hits.length !== 1) {
    throw namedError("MemoryConversationTurnBundleHitInvalid");
  }
  const hit = hits[0];
  if (!hit) throw namedError("MemoryConversationTurnBundleHitInvalid");
  const previousAssistant = turns.some(
    (turn) =>
      turn.sourceKind === "assistant_output" && turn.sourceSeq < hit.sourceSeq,
  );
  const nextUserConfirmation = turns.some(
    (turn) =>
      turn.sourceKind === "user_input" &&
      turn.sourceSeq > hit.sourceSeq &&
      explicitConfirmation(turn.content),
  );
  const authority =
    hit.sourceKind === "user_input"
      ? explicitConfirmation(hit.content) && previousAssistant
        ? "user_confirmed_dialogue"
        : "user_asserted"
      : hit.sourceKind === "assistant_output" && nextUserConfirmation
        ? "user_confirmed_dialogue"
        : "context_only";
  const hitBudget = Math.max(128, Math.floor(input.maxChars * 0.55));
  const neighborBudget = Math.max(
    64,
    Math.floor((input.maxChars - hitBudget) / Math.max(1, turns.length - 1)),
  );
  const queryTerms = conversationTerms(query);
  const parts: string[] = [];
  for (const turn of turns) {
    const relation = turn.hit
      ? "hit"
      : turn.sourceSeq < hit.sourceSeq
        ? "previous"
        : "next";
    const label = `[${turn.sourceKind} ${relation}] `;
    const available = Math.max(
      1,
      (turn.hit ? hitBudget : neighborBudget) - label.length,
    );
    const confirmed =
      turn.sourceKind === "user_input" &&
      turn.sourceSeq > hit.sourceSeq &&
      explicitConfirmation(turn.content);
    const content = confirmed
      ? turn.content.slice(0, available)
      : focusedConversationExcerpt(turn.content, queryTerms, available);
    parts.push(`${label}${content}`);
  }
  const text = parts.join("\n").slice(0, input.maxChars);
  return Object.freeze({
    policyVersion: PAW_MEMORY_CONVERSATION_BUNDLE_POLICY_VERSION_V1,
    text,
    hitSeq: hit.sourceSeq,
    authority,
    includedTurns: turns.length,
    includedEvidence: Object.freeze(
      turns.flatMap((turn) =>
        turn.evidenceRef
          ? [
              Object.freeze({
                evidenceRef: turn.evidenceRef,
                sourceKind: turn.sourceKind,
                turnOrder: turn.sourceSeq,
              }),
            ]
          : [],
      ),
    ),
    chars: text.length,
  });
}

function explicitConfirmation(content: string): boolean {
  return /^(?:user:\s*)?(?:yes|yeah|yep|correct|exactly|right|indeed|是的|对|没错)(?=$|[\s,，。.!！?？:：])/iu.test(
    content.trim(),
  );
}

/** Keeps several independently ranked dialogue hits from one source document. */
export function selectRankedMemoryConversationBundlesV1(input: {
  readonly bundles: readonly string[];
  readonly query: string;
  readonly maxBundles: number;
  readonly maxChars: number;
}): SelectedMemoryConversationBundlesV1 {
  const query = input.query.trim();
  if (
    !query ||
    query.length > 512 ||
    !Number.isSafeInteger(input.maxBundles) ||
    input.maxBundles < 1 ||
    input.maxBundles > 8 ||
    !Number.isSafeInteger(input.maxChars) ||
    input.maxChars < 256
  ) {
    throw namedError("MemoryConversationBundleSelectionBudgetInvalid");
  }
  const bundles = [...new Set(input.bundles.map((item) => item.trim()))]
    .filter(Boolean)
    .slice(0, input.maxBundles);
  if (bundles.length === 0) {
    return Object.freeze({ text: "", selectedBundles: 0, chars: 0 });
  }
  const separator = "\n--- adjacent evidence hit ---\n";
  const contentBudget = Math.max(
    1,
    input.maxChars - separator.length * Math.max(0, bundles.length - 1),
  );
  const perBundle = Math.max(1, Math.floor(contentBudget / bundles.length));
  const queryTerms = conversationTerms(query);
  const text = bundles
    .map((bundle) => focusedConversationExcerpt(bundle, queryTerms, perBundle))
    .join(separator)
    .slice(0, input.maxChars);
  return Object.freeze({
    text,
    selectedBundles: bundles.length,
    chars: text.length,
  });
}

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
    input.maxHitsPerRequirement > 4 ||
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
  let selectedHitCount = 0;
  const minimumRequirementBudget = Math.max(
    1,
    Math.floor(input.maxChars / Math.max(1, input.requirements.length)),
  );
  const sourceHeader =
    "[Evidence notebook: supplemental exact user evidence]\n";
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
    // Closure is a minimum, not a rendering cap. Preserve every bounded hit
    // the semantic selector judged useful so aggregate and temporal synthesis
    // do not lose later operands after the first one or two matches.
    const targetHits = input.maxHitsPerRequirement;
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
        return (
          supportScore > 0 &&
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
      if (
        !allowed.has(sourceId) ||
        !evidenceRef ||
        !content ||
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
          ? `[timeline=${timeline}; ${stateSemantics}; precision=${semantics.valueQualifier}; epistemic=${semantics.epistemicStatus}; authority=${rawHit.authority}; observed=${observed}; episode=${episodeOrder ?? "unknown"}; turn=${turnOrder ?? "unknown"}; evidence=${evidenceRef}]`
          : `[evidence=${evidenceRef}; authority=${rawHit.authority}; observed=${observed}; episode=${episodeOrder ?? "unknown"}; turn=${turnOrder ?? "unknown"}; precision=${semantics.valueQualifier}; epistemic=${semantics.epistemicStatus}]`;
      const fixedChars = requirementLine.length + metadataLine.length + 2;
      const excerptBudget = Math.min(
        hitBudget - fixedChars,
        input.maxChars - chars - separatorChars - fixedChars,
      );
      // The shared excerpt projector has a 128-character lower bound. A
      // metadata-heavy evidence address can leave 64-127 characters even
      // though the notebook itself still has space; skip that hit instead of
      // turning a bounded omission into a resolver-wide failure.
      if (excerptBudget < 128) continue;
      const excerpt = projectMemoryEvidenceExcerptV1(
        content,
        searchText,
        excerptBudget,
      );
      const part = [requirementLine, metadataLine, excerpt].join("\n");
      if (chars + separatorChars + part.length > input.maxChars) continue;
      const state = sourceParts.get(sourceId) ?? {
        parts: [],
        evidenceRefs: [],
        answerRoles: new Set<"current" | "ambiguous" | "supporting">(),
      };
      state.parts.push(part);
      state.evidenceRefs.push(evidenceRef);
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
    return Object.freeze({
      sourceId,
      text,
      evidenceRefs: Object.freeze([...state.evidenceRefs]),
      answerRole: singleAnswerRole(state.answerRoles),
    });
  });
  return Object.freeze({
    policyVersion: PAW_MEMORY_EVIDENCE_NOTEBOOK_POLICY_VERSION_V1,
    sources: Object.freeze(sources),
    coverage: Object.freeze(coverage.map((item) => Object.freeze(item))),
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

/**
 * Fuses independent raw-evidence and derived-index retrieval without making a
 * topic, aspect, or graph membership a prerequisite for source discovery.
 * This function ranks source pointers only; callers must read authoritative L0
 * evidence before presenting content to a model.
 */
export function rankMemoryEvidenceSourcesV1(input: {
  readonly lists: readonly MemoryEvidenceSourceRankListV1[];
  readonly maxSources: number;
}): MemoryEvidenceSourceFusionV1 {
  if (!Number.isSafeInteger(input.maxSources) || input.maxSources < 1) {
    throw namedError("MemoryEvidenceFirstSourceBudgetInvalid");
  }
  const scores = new Map<
    string,
    {
      score: number;
      channels: Set<MemoryEvidenceChannelV1>;
      bestRank: number;
    }
  >();
  const channelCandidates: Record<MemoryEvidenceChannelV1, Set<string>> = {
    l0: new Set<string>(),
    l1: new Set<string>(),
  };
  for (const list of input.lists) {
    if (!Number.isFinite(list.weight) || list.weight <= 0) {
      throw namedError("MemoryEvidenceFirstWeightInvalid");
    }
    const seen = new Set<string>();
    let distinctRank = 0;
    for (const rawSourceId of list.sourceIds) {
      const sourceId = rawSourceId.trim();
      if (!sourceId || seen.has(sourceId)) continue;
      seen.add(sourceId);
      distinctRank += 1;
      channelCandidates[list.channel].add(sourceId);
      const current = scores.get(sourceId) ?? {
        score: 0,
        channels: new Set<MemoryEvidenceChannelV1>(),
        bestRank: Number.POSITIVE_INFINITY,
      };
      current.score += list.weight / (EVIDENCE_SOURCE_RRF_K + distinctRank);
      current.channels.add(list.channel);
      current.bestRank = Math.min(current.bestRank, distinctRank);
      scores.set(sourceId, current);
    }
  }
  const ranked = [...scores.entries()]
    .map(([sourceId, value]) =>
      Object.freeze({
        sourceId,
        score: value.score,
        channelHits: value.channels.size,
        channels: Object.freeze([...value.channels].sort()),
        bestRank: value.bestRank,
      }),
    )
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.channelHits - left.channelHits ||
        left.bestRank - right.bestRank ||
        left.sourceId.localeCompare(right.sourceId),
    );
  const sources = Object.freeze(ranked.slice(0, input.maxSources));
  return Object.freeze({
    policyVersion: PAW_MEMORY_EVIDENCE_FIRST_POLICY_VERSION_V1,
    sources,
    telemetry: Object.freeze({
      inputListCount: input.lists.length,
      l0CandidateCount: channelCandidates.l0.size,
      l1CandidateCount: channelCandidates.l1.size,
      fusedCandidateCount: ranked.length,
      dualChannelCount: ranked.filter((item) => item.channelHits > 1).length,
      returnedCount: sources.length,
    }),
  });
}

/**
 * Fuses exact evidence addresses while ranking source documents by their best
 * hit in each independent retriever. This prevents a long document with many
 * near-duplicate spans from crowding out other sources, without discarding the
 * role, authority, time, or address needed for trustworthy hydration.
 */
export function rankMemoryEvidenceCandidatesV2(input: {
  readonly lists: readonly MemoryEvidenceCandidateRankListV2[];
  readonly maxSources: number;
  readonly maxEvidencePerSource: number;
}): MemoryEvidenceCandidateFusionV2 {
  if (!Number.isSafeInteger(input.maxSources) || input.maxSources < 1) {
    throw namedError("MemoryEvidenceCandidateSourceBudgetInvalid");
  }
  if (
    !Number.isSafeInteger(input.maxEvidencePerSource) ||
    input.maxEvidencePerSource < 1 ||
    input.maxEvidencePerSource > 16
  ) {
    throw namedError("MemoryEvidenceCandidatePerSourceBudgetInvalid");
  }
  const candidates = new Map<
    string,
    {
      candidate: MemoryEvidenceCandidateV2;
      score: number;
      lists: Set<string>;
      channels: Set<MemoryEvidenceChannelV1>;
      bestRank: number;
    }
  >();
  const sources = new Map<
    string,
    {
      score: number;
      channels: Set<MemoryEvidenceChannelV1>;
      bestRank: number;
      candidateIds: Set<string>;
    }
  >();
  const channelCandidates: Record<MemoryEvidenceChannelV1, Set<string>> = {
    l0: new Set<string>(),
    l1: new Set<string>(),
  };
  const seenRetrieverIds = new Set<string>();
  for (const list of input.lists) {
    const retrieverId = list.retrieverId.trim();
    if (!retrieverId || seenRetrieverIds.has(retrieverId)) {
      throw namedError("MemoryEvidenceCandidateRetrieverInvalid");
    }
    seenRetrieverIds.add(retrieverId);
    if (!Number.isFinite(list.weight) || list.weight <= 0) {
      throw namedError("MemoryEvidenceCandidateWeightInvalid");
    }
    const seenCandidates = new Set<string>();
    const bestSourceRanks = new Map<string, number>();
    let distinctRank = 0;
    for (const raw of list.candidates) {
      const candidate = normalizedEvidenceCandidateV2(raw);
      if (seenCandidates.has(candidate.candidateId)) continue;
      seenCandidates.add(candidate.candidateId);
      distinctRank += 1;
      channelCandidates[list.channel].add(candidate.candidateId);
      const current = candidates.get(candidate.candidateId);
      if (current && !sameEvidenceAddressV2(current.candidate, candidate)) {
        throw namedError("MemoryEvidenceCandidateIdentityConflict");
      }
      const state = current ?? {
        candidate,
        score: 0,
        lists: new Set<string>(),
        channels: new Set<MemoryEvidenceChannelV1>(),
        bestRank: Number.POSITIVE_INFINITY,
      };
      state.score += list.weight / (EVIDENCE_SOURCE_RRF_K + distinctRank);
      state.lists.add(retrieverId);
      state.channels.add(list.channel);
      state.bestRank = Math.min(state.bestRank, distinctRank);
      candidates.set(candidate.candidateId, state);
      bestSourceRanks.set(
        candidate.sourceId,
        Math.min(
          bestSourceRanks.get(candidate.sourceId) ?? Number.POSITIVE_INFINITY,
          distinctRank,
        ),
      );
      const source = sources.get(candidate.sourceId) ?? {
        score: 0,
        channels: new Set<MemoryEvidenceChannelV1>(),
        bestRank: Number.POSITIVE_INFINITY,
        candidateIds: new Set<string>(),
      };
      source.channels.add(list.channel);
      source.bestRank = Math.min(source.bestRank, distinctRank);
      source.candidateIds.add(candidate.candidateId);
      sources.set(candidate.sourceId, source);
    }
    for (const [sourceId, rank] of bestSourceRanks) {
      const source = sources.get(sourceId);
      if (!source) throw namedError("MemoryEvidenceSourceMissing");
      source.score += list.weight / (EVIDENCE_SOURCE_RRF_K + rank);
    }
  }
  const rankedCandidates = new Map(
    [...candidates.entries()].map(([candidateId, state]) => [
      candidateId,
      Object.freeze({
        ...state.candidate,
        score: state.score,
        listHits: state.lists.size,
        channels: Object.freeze([...state.channels].sort()),
        bestRank: state.bestRank,
      }),
    ]),
  );
  const rankedSources = [...sources.entries()]
    .map(([sourceId, state]) =>
      Object.freeze({
        sourceId,
        score: state.score,
        channelHits: state.channels.size,
        channels: Object.freeze([...state.channels].sort()),
        bestRank: state.bestRank,
        evidence: Object.freeze(
          [...state.candidateIds]
            .map((candidateId) => {
              const candidate = rankedCandidates.get(candidateId);
              if (!candidate) {
                throw namedError("MemoryEvidenceCandidateMissing");
              }
              return candidate;
            })
            .sort(
              (left, right) =>
                right.score - left.score ||
                right.listHits - left.listHits ||
                left.bestRank - right.bestRank ||
                left.candidateId.localeCompare(right.candidateId),
            )
            .slice(0, input.maxEvidencePerSource),
        ),
      }),
    )
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.channelHits - left.channelHits ||
        left.bestRank - right.bestRank ||
        left.sourceId.localeCompare(right.sourceId),
    );
  const selected = Object.freeze(rankedSources.slice(0, input.maxSources));
  return Object.freeze({
    policyVersion: PAW_MEMORY_EVIDENCE_CANDIDATE_FUSION_VERSION_V2,
    sources: selected,
    telemetry: Object.freeze({
      inputListCount: input.lists.length,
      l0CandidateCount: channelCandidates.l0.size,
      l1CandidateCount: channelCandidates.l1.size,
      fusedCandidateCount: candidates.size,
      fusedSourceCount: rankedSources.length,
      dualChannelSourceCount: rankedSources.filter(
        (source) => source.channelHits > 1,
      ).length,
      returnedSourceCount: selected.length,
      returnedEvidenceCount: selected.reduce(
        (total, source) => total + source.evidence.length,
        0,
      ),
    }),
  });
}

function normalizedEvidenceCandidateV2(
  input: MemoryEvidenceCandidateV2,
): MemoryEvidenceCandidateV2 {
  const candidateId = input.candidateId.trim();
  const sourceId = input.sourceId.trim();
  const evidenceRef = input.evidenceRef.trim();
  if (!candidateId || !sourceId || !evidenceRef) {
    throw namedError("MemoryEvidenceCandidateAddressInvalid");
  }
  return Object.freeze({
    ...input,
    candidateId,
    sourceId,
    evidenceRef,
    ...(input.observedAt?.trim()
      ? { observedAt: input.observedAt.trim() }
      : {}),
  });
}

function sameEvidenceAddressV2(
  left: MemoryEvidenceCandidateV2,
  right: MemoryEvidenceCandidateV2,
): boolean {
  return (
    left.sourceId === right.sourceId &&
    left.evidenceRef === right.evidenceRef &&
    left.sourceKind === right.sourceKind &&
    left.authority === right.authority &&
    left.observedAt === right.observedAt
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

function conversationTerms(value: string): ReadonlySet<string> {
  return new Set(
    value
      .normalize("NFKC")
      .toLocaleLowerCase()
      .match(/[\p{L}\p{N}]{2,}/gu) ?? [],
  );
}

const MEMORY_EVIDENCE_SUPPORT_STOP_WORDS = new Set([
  "about",
  "after",
  "before",
  "between",
  "current",
  "clue",
  "evidence",
  "from",
  "latest",
  "most",
  "recent",
  "record",
  "records",
  "that",
  "the",
  "their",
  "this",
  "trip",
  "user",
  "visit",
  "with",
]);

const MEMORY_EVIDENCE_MEASUREMENT_TERMS = new Set([
  "amount",
  "balance",
  "count",
  "cost",
  "date",
  "dates",
  "day",
  "days",
  "duration",
  "earned",
  "earnings",
  "number",
  "percent",
  "percentage",
  "price",
  "spent",
  "stars",
  "total",
  "value",
  "views",
]);

/**
 * Cheap post-retrieval support ordering. Retrieval rank proposes candidates;
 * this scorer prevents a later but unrelated turn from becoming a state
 * winner merely because it shares a source document with the true evidence.
 */
export function memoryEvidenceSupportScoreV1(
  requirement: string,
  content: string,
): number {
  const terms = [...conversationTerms(requirement)].filter(
    (term) => !MEMORY_EVIDENCE_SUPPORT_STOP_WORDS.has(term),
  );
  const normalized = content.normalize("NFKC").toLocaleLowerCase();
  let score = 0;
  for (const term of terms) {
    if (normalized.includes(term)) score += Math.max(1, term.length);
  }
  if (
    terms.some((term) => MEMORY_EVIDENCE_MEASUREMENT_TERMS.has(term)) &&
    /(?:\p{Sc}\s*)?\d/u.test(normalized)
  ) {
    score += 24;
  }
  return score;
}

function focusedConversationExcerpt(
  content: string,
  queryTerms: ReadonlySet<string>,
  maxChars: number,
  preferredAnchors: readonly string[] = [],
): string {
  if (content.length <= maxChars) return content;
  const normalized = content.normalize("NFKC").toLocaleLowerCase();
  const starts = new Set([0]);
  const anchorStarts = new Set<number>();
  for (const anchor of preferredAnchors) {
    let offset = 0;
    while (offset < normalized.length) {
      const index = normalized.indexOf(anchor, offset);
      if (index < 0) break;
      const start = Math.max(
        0,
        Math.min(
          content.length - maxChars,
          index - Math.min(160, Math.floor(maxChars / 3)),
        ),
      );
      starts.add(start);
      anchorStarts.add(start);
      offset = index + Math.max(1, anchor.length);
    }
  }
  for (const term of queryTerms) {
    let offset = 0;
    while (offset < normalized.length) {
      const index = normalized.indexOf(term, offset);
      if (index < 0) break;
      starts.add(Math.max(0, Math.min(content.length - maxChars, index - 160)));
      offset = index + Math.max(1, term.length);
    }
  }
  let bestStart = 0;
  let bestScore = -1;
  for (const start of starts) {
    const window = normalized.slice(start, start + maxChars);
    let score = anchorStarts.has(start) ? 10_000_000 : 0;
    for (const anchor of preferredAnchors) {
      if (window.includes(anchor)) score += 1_000_000 + anchor.length ** 2;
    }
    for (const term of queryTerms) {
      if (window.includes(term)) score += Math.max(1, term.length ** 2);
    }
    if (score > bestScore || (score === bestScore && start < bestStart)) {
      bestStart = start;
      bestScore = score;
    }
  }
  const prefix = bestStart > 0 ? "[…]\n" : "";
  return `${prefix}${content.slice(bestStart, bestStart + Math.max(1, maxChars - prefix.length))}`;
}

/**
 * Project a bounded, query-focused view of immutable evidence. Numeric ordinal
 * aliases bridge natural-language questions such as "27th item" to enumerated
 * source forms such as "27." without changing or inventing source content.
 */
export function projectMemoryEvidenceExcerptV1(
  content: string,
  query: string,
  maxChars: number,
): string {
  if (!Number.isSafeInteger(maxChars) || maxChars < 128 || maxChars > 16_384) {
    throw namedError("MemoryEvidenceExcerptBudgetInvalid");
  }
  const normalizedQuery = query.normalize("NFKC").toLocaleLowerCase();
  const anchors = memoryEvidenceOrdinalAnchorsV1(normalizedQuery);
  return focusedConversationExcerpt(
    content,
    conversationTerms(normalizedQuery),
    maxChars,
    anchors,
  );
}

/** Return a deterministic score only when source text contains the requested ordinal. */
export function memoryEvidenceOrdinalAnchorScoreV1(
  content: string,
  query: string,
): number {
  const normalized = content.normalize("NFKC").toLocaleLowerCase();
  return memoryEvidenceOrdinalAnchorsV1(query).reduce(
    (score, anchor) => score + (normalized.includes(anchor) ? 1 : 0),
    0,
  );
}

function memoryEvidenceOrdinalAnchorsV1(query: string): readonly string[] {
  const normalizedQuery = query.normalize("NFKC").toLocaleLowerCase();
  const anchors = new Set<string>();
  for (const match of normalizedQuery.matchAll(
    /\b(\d{1,4})(?:st|nd|rd|th)\b/gu,
  )) {
    const value = match[1];
    if (!value) continue;
    anchors.add(`${value}.`);
    anchors.add(`${value})`);
    anchors.add(`#${value}`);
  }
  return Object.freeze([...anchors]);
}
