import type {
  MemoryEvidenceNotebookHitV1,
  MemoryEvidenceNotebookV1,
} from "./evidence-contracts.js";
import type { MemoryEvidenceObligationShapeV1 } from "./evidence-obligation.js";
import {
  type MemoryEvidenceBindingV1,
  type MemoryEvidenceOriginRoleV1,
  type MemoryEvidenceUseV1,
  classifyMemoryEvidenceUseV1,
  renderMemoryEvidencePacketContractV1,
} from "./evidence-origin.js";
import type {
  MemoryEvidenceQueryIntentV3,
  MemoryEvidenceRequirementV3,
} from "./evidence-query-planner.js";
import type { MemoryEvidenceResolutionV1 } from "./evidence-resolution-contracts.js";
import { mergeEvidenceHits } from "./evidence-resolution-validation.js";
import { memoryEvidenceOrdinalAnchorScoreV1 } from "./evidence-text.js";
import { compileMemoryEvidenceTemporalConstraintV1 } from "./temporal-constraint.js";

export function selectedNotebookEvidence(
  requirementHits: readonly (readonly MemoryEvidenceNotebookHitV1[])[],
  notebook: MemoryEvidenceNotebookV1,
): readonly MemoryEvidenceNotebookHitV1[] {
  const selectedRefs = new Set(
    notebook.coverage.flatMap((item) => item.selectedEvidenceRefs),
  );
  return mergeEvidenceHits(requirementHits.flat(), []).filter((hit) =>
    selectedRefs.has(hit.evidenceRef),
  );
}

export function createRootEvidenceRequirement(
  query: string,
  intent: MemoryEvidenceQueryIntentV3,
  obligationShape?: MemoryEvidenceObligationShapeV1,
): MemoryEvidenceRequirementV3 {
  const collectiveFallback = (obligationShape?.minimumEvidenceCount ?? 0) > 1;
  return Object.freeze({
    requirementId: "root-requirement",
    label: query.slice(0, 192),
    searchText: query.slice(0, 192),
    temporalMode: intent.temporalMode,
    temporalConstraint: compileMemoryEvidenceTemporalConstraintV1({
      query,
      queryEnvelopeMode: intent.temporalMode,
      leafMode: intent.temporalMode,
    }),
    roleConstraint: intent.roleConstraint,
    relation:
      intent.temporalMode === "latest"
        ? "temporal"
        : intent.answerShape === "compare" || intent.answerShape === "aggregate"
          ? "comparative"
          : "direct",
    coverageMode:
      intent.temporalMode === "latest"
        ? "latest"
        : collectiveFallback
          ? "all"
          : "any",
    minimumEvidence: collectiveFallback
      ? Math.min(3, obligationShape?.minimumEvidenceCount ?? 2)
      : 1,
  });
}

export function selectSupportCandidates(
  requirementHits: readonly (readonly MemoryEvidenceNotebookHitV1[])[],
  selectedSourceIds: readonly string[],
  allowContextOnly: boolean,
  maximum: number,
): readonly MemoryEvidenceNotebookHitV1[] {
  const allowed = new Set(selectedSourceIds);
  const rows = requirementHits.map((hits) =>
    hits.filter(
      (hit) =>
        allowed.has(hit.sourceId) &&
        (hit.authority !== "context_only" || allowContextOnly),
    ),
  );
  const output: MemoryEvidenceNotebookHitV1[] = [];
  const seen = new Set<string>();
  for (let rank = 0; output.length < maximum; rank += 1) {
    let found = false;
    for (const hits of rows) {
      const hit = hits[rank];
      if (!hit) continue;
      found = true;
      if (seen.has(hit.evidenceRef)) continue;
      seen.add(hit.evidenceRef);
      output.push(hit);
      if (output.length >= maximum) break;
    }
    if (!found) break;
  }
  return Object.freeze(output);
}

export function filterRequirementHits(
  hits: readonly MemoryEvidenceNotebookHitV1[],
  selectedRefs: ReadonlySet<string> | undefined,
): readonly MemoryEvidenceNotebookHitV1[] {
  if (selectedRefs === undefined) return hits;
  return Object.freeze(hits.filter((hit) => selectedRefs.has(hit.evidenceRef)));
}

export const PAW_MEMORY_DETERMINISTIC_SUPPORT_FLOOR_POLICY_V1 =
  "paw.memory-deterministic-support-floor.v1:nonempty-requirement-packet" as const;

/**
 * Selector abstention is a precision signal, not an availability verdict.
 * When a committed selection (or a failed selector group) leaves a requirement
 * with zero bound evidence while deterministic retrieval produced candidates
 * for that requirement inside the locked sources, the floor binds the top
 * lane-ranked candidates so the answer packet can never be empty by omission.
 *
 * The floor is code-owned: it never invents evidence, never widens the locked
 * source set, and never overrides a non-empty selector binding. Context-only
 * addresses stay closed here; the notebook applies the same rule.
 */
export function applyMemoryDeterministicSupportFloorV1(input: {
  readonly selectedRefsByRequirement: ReadonlyMap<string, ReadonlySet<string>>;
  readonly requirementIds: readonly string[];
  readonly requirementHits: readonly (readonly MemoryEvidenceNotebookHitV1[])[];
  readonly lockedSourceIds: readonly string[];
  readonly maxFloorHitsPerRequirement: number;
  /**
   * Refs the selector explicitly judged contradicting or unknown. An explicit
   * negative judgment is an exclusion decision and is honored; mere absence of
   * a supporting selection is not an exclusion.
   */
  readonly excludedEvidenceRefs?: readonly ReadonlySet<string>[];
}): {
  selectedRefsByRequirement: ReadonlyMap<string, ReadonlySet<string>>;
  flooredRequirementIds: readonly string[];
  policyVersion: typeof PAW_MEMORY_DETERMINISTIC_SUPPORT_FLOOR_POLICY_V1;
} {
  if (
    !Number.isSafeInteger(input.maxFloorHitsPerRequirement) ||
    input.maxFloorHitsPerRequirement < 1 ||
    input.maxFloorHitsPerRequirement > 8
  ) {
    throw namedError("MemoryDeterministicSupportFloorBudgetInvalid");
  }
  const locked = new Set(
    input.lockedSourceIds.map((sourceId) => sourceId.trim()).filter(Boolean),
  );
  const excluded = new Set(
    (input.excludedEvidenceRefs ?? []).flatMap((refs) => [...refs]),
  );
  const output = new Map(input.selectedRefsByRequirement);
  const floored: string[] = [];
  input.requirementIds.forEach((requirementId, index) => {
    const selected = output.get(requirementId);
    if (selected === undefined || selected.size > 0) return;
    const hits = (input.requirementHits[index] ?? []).filter(
      (hit) =>
        locked.has(hit.sourceId.trim()) &&
        hit.authority !== "context_only" &&
        hit.evidenceRef.trim() &&
        hit.content.trim() &&
        !excluded.has(hit.evidenceRef.trim()),
    );
    if (hits.length === 0) return;
    const floorRefs: string[] = [];
    const seen = new Set<string>();
    for (const hit of hits) {
      if (floorRefs.length >= input.maxFloorHitsPerRequirement) break;
      const ref = hit.evidenceRef.trim();
      if (seen.has(ref)) continue;
      seen.add(ref);
      floorRefs.push(ref);
    }
    if (floorRefs.length === 0) return;
    output.set(requirementId, new Set(floorRefs));
    floored.push(requirementId);
  });
  return {
    selectedRefsByRequirement: output,
    flooredRequirementIds: Object.freeze(floored),
    policyVersion: PAW_MEMORY_DETERMINISTIC_SUPPORT_FLOOR_POLICY_V1,
  };
}

export function buildPrimaryEvidencePacketSources(
  hits: readonly MemoryEvidenceNotebookHitV1[],
  selectedSourceIds: readonly string[],
  allowContextOnly: boolean,
  maxHitsPerSource: number,
  maxChars: number,
  excludedEvidenceRefs: ReadonlySet<string> = new Set(),
  answerRole: "supporting" | "candidate" = "supporting",
  query = "",
  roleConstraint: MemoryEvidenceOriginRoleV1 = "user",
  certifiedDialogueEvidenceRefs: ReadonlySet<string> = new Set(),
): readonly Readonly<{
  sourceId: string;
  text: string;
  evidenceRefs: readonly string[];
  evidenceBindings: readonly MemoryEvidenceBindingV1[];
  evidenceUses: readonly MemoryEvidenceUseV1[];
  answerRole: "supporting" | "candidate";
}>[] {
  const output: Array<{
    sourceId: string;
    text: string;
    evidenceRefs: readonly string[];
    evidenceBindings: readonly MemoryEvidenceBindingV1[];
    evidenceUses: readonly MemoryEvidenceUseV1[];
    answerRole: "supporting" | "candidate";
  }> = [];
  let chars = 0;
  for (const sourceId of selectedSourceIds) {
    const selected = hits
      .filter(
        (hit) =>
          hit.sourceId === sourceId &&
          !excludedEvidenceRefs.has(hit.evidenceRef) &&
          (hit.authority !== "context_only" ||
            allowContextOnly ||
            certifiedDialogueEvidenceRefs.has(hit.evidenceRef)),
      )
      .map((hit, rank) => ({
        hit,
        rank,
        evidenceUse: classifyMemoryEvidenceUseV1({
          roleConstraint,
          sourceKind: hit.sourceKind,
          authority: hit.authority,
          dialogueCertified: certifiedDialogueEvidenceRefs.has(hit.evidenceRef),
        }),
        ordinalScore: memoryEvidenceOrdinalAnchorScoreV1(hit.content, query),
      }))
      .filter(
        (item): item is typeof item & { evidenceUse: MemoryEvidenceUseV1 } =>
          item.evidenceUse !== undefined,
      )
      .sort(
        (left, right) =>
          right.ordinalScore - left.ordinalScore || left.rank - right.rank,
      )
      .slice(0, maxHitsPerSource);
    if (selected.length === 0) continue;
    const text = [
      renderMemoryEvidencePacketContractV1(),
      ...selected.map(
        ({ hit, evidenceUse }) =>
          `[evidence_use=${evidenceUse}; authority=${hit.authority}; observed=${hit.observedAt ?? "unknown"}; evidence=${hit.evidenceRef}]\n${hit.content}`,
      ),
    ].join("\n\n");
    if (chars + text.length > maxChars) continue;
    const evidenceBindings: readonly MemoryEvidenceBindingV1[] = Object.freeze(
      selected.map(({ hit, evidenceUse }) =>
        Object.freeze({ evidenceRef: hit.evidenceRef, evidenceUse }),
      ),
    );
    output.push({
      sourceId,
      text,
      evidenceRefs: Object.freeze(selected.map(({ hit }) => hit.evidenceRef)),
      evidenceBindings,
      evidenceUses: Object.freeze([
        ...new Set(evidenceBindings.map((binding) => binding.evidenceUse)),
      ]),
      answerRole,
    });
    chars += text.length;
  }
  return Object.freeze(output.map((item) => Object.freeze(item)));
}

export function buildPlannedEvidencePacketSources(input: {
  readonly query: string;
  readonly notebook: MemoryEvidenceNotebookV1;
  readonly primaryHits: readonly MemoryEvidenceNotebookHitV1[];
  readonly selectedSourceIds: readonly string[];
  readonly allowContextOnly: boolean;
  readonly includeFallback: boolean;
  readonly fallbackAnswerRole: "supporting" | "candidate";
  readonly maxFallbackChars: number;
  readonly maxFallbackHitsPerSource?: number;
  readonly roleConstraint: MemoryEvidenceOriginRoleV1;
  readonly certifiedDialogueEvidenceRefs?: ReadonlySet<string>;
}): MemoryEvidenceResolutionV1["packetSources"] {
  if (!input.includeFallback) return input.notebook.sources;
  const selectedRefs = new Set(
    input.notebook.coverage.flatMap((item) => item.selectedEvidenceRefs),
  );
  const fallback = buildPrimaryEvidencePacketSources(
    input.primaryHits,
    input.selectedSourceIds,
    input.allowContextOnly,
    input.maxFallbackHitsPerSource ?? 1,
    input.maxFallbackChars,
    selectedRefs,
    input.fallbackAnswerRole,
    input.query,
    input.roleConstraint,
    input.certifiedDialogueEvidenceRefs,
  );
  const bySource = new Map<
    string,
    {
      parts: string[];
      evidenceRefs: string[];
      evidenceBindings: Map<string, MemoryEvidenceUseV1>;
      answerRoles: Set<
        "current" | "ambiguous" | "supporting" | "candidate" | "mixed"
      >;
    }
  >();
  for (const source of [...input.notebook.sources, ...fallback]) {
    const current = bySource.get(source.sourceId) ?? {
      parts: [],
      evidenceRefs: [],
      evidenceBindings: new Map<string, MemoryEvidenceUseV1>(),
      answerRoles: new Set(),
    };
    current.parts.push(source.text);
    current.evidenceRefs.push(...source.evidenceRefs);
    for (const binding of source.evidenceBindings) {
      const existingUse = current.evidenceBindings.get(binding.evidenceRef);
      if (existingUse !== undefined && existingUse !== binding.evidenceUse) {
        throw namedError("MemoryEvidenceBindingConflict");
      }
      current.evidenceBindings.set(binding.evidenceRef, binding.evidenceUse);
    }
    current.answerRoles.add(source.answerRole);
    bySource.set(source.sourceId, current);
  }
  const orderedIds = [
    ...input.selectedSourceIds,
    ...input.notebook.sources.map((source) => source.sourceId),
  ];
  return Object.freeze(
    [...new Set(orderedIds)].flatMap((sourceId) => {
      const value = bySource.get(sourceId);
      if (!value) return [];
      const evidenceBindings: readonly MemoryEvidenceBindingV1[] =
        Object.freeze(
          [...value.evidenceBindings].map(([evidenceRef, evidenceUse]) =>
            Object.freeze({ evidenceRef, evidenceUse }),
          ),
        );
      return [
        Object.freeze({
          sourceId,
          text: value.parts.join("\n\n[Bounded primary fallback]\n"),
          evidenceRefs: Object.freeze([...new Set(value.evidenceRefs)]),
          evidenceBindings,
          evidenceUses: Object.freeze([
            ...new Set(evidenceBindings.map((binding) => binding.evidenceUse)),
          ]),
          answerRole: singleAnswerRole(value.answerRoles),
        }),
      ];
    }),
  );
}

function singleAnswerRole<T extends string>(
  roles: ReadonlySet<T>,
): T | "mixed" {
  return roles.size === 1 ? (roles.values().next().value ?? "mixed") : "mixed";
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}
