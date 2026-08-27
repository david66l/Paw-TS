import type { JsonValue } from "@paw/protocol";
import type { MemoryAspectEdgeEvidenceV1 } from "./aspect-edge-linker.js";
import type {
  MemoryAspectClaimRoleV1,
  MemoryAspectGraphSnapshotV1,
  MemoryEvidenceEdgeV1,
} from "./aspect-graph.js";
import { measureMemoryAspectGraphV1 } from "./aspect-graph.js";
import { deriveMemoryAspectLinkStatementHashV1 } from "./aspect-linker.js";
import { hashCanonicalJsonV1 } from "./canonical.js";

export const PAW_MEMORY_ASPECT_EDGE_ADMISSION_VERSION_V1 =
  "paw.memory-aspect-edge-admission.v1:role-cue-overlap" as const;

export interface MemoryAspectEdgeAdmissionDecisionV1 {
  readonly edgeId: string;
  readonly disposition: "admit" | "reject" | "defer";
  readonly reasonCode:
    | "role_grounded"
    | "state_causal_grounded"
    | "state_transition_grounded"
    | "state_equivalence_grounded"
    | "conditional_grounded"
    | "evidence_missing"
    | "role_incompatible"
    | "causal_cue_missing"
    | "change_cue_missing"
    | "condition_cue_missing"
    | "discriminant_overlap_missing";
}

export interface MemoryAspectEdgeAdmissionV1 {
  readonly policyVersion: typeof PAW_MEMORY_ASPECT_EDGE_ADMISSION_VERSION_V1;
  readonly sourceGraphRevision: string;
  readonly admissionRevision: string;
  readonly decisions: readonly MemoryAspectEdgeAdmissionDecisionV1[];
  readonly admittedEdgeIds: readonly string[];
  readonly rejectedEdgeIds: readonly string[];
  readonly deferredEdgeIds: readonly string[];
}

/** Precision gate applied after semantic proposal and before graph commit. */
export function evaluateMemoryAspectEdgeAdmissionV1(
  input: Readonly<{
    snapshot: MemoryAspectGraphSnapshotV1;
    edges: readonly MemoryEvidenceEdgeV1[];
    catalog: readonly MemoryAspectEdgeEvidenceV1[];
  }>,
): MemoryAspectEdgeAdmissionV1 {
  measureMemoryAspectGraphV1(input.snapshot);
  const evidence = new Map<string, MemoryAspectEdgeEvidenceV1>();
  for (const item of input.catalog) {
    if (
      evidence.has(item.claimId) ||
      deriveMemoryAspectLinkStatementHashV1(item.statement) !==
        item.statementHash
    ) {
      throw namedError("MemoryAspectEdgeAdmissionCatalogInvalid");
    }
    evidence.set(item.claimId, item);
  }
  const weights = inverseDocumentWeights(
    input.catalog.map((item) => terms(item.statement)),
  );
  const roles = activeRoles(input.snapshot);
  const graphEdgeIds = new Set(input.snapshot.edges.map((edge) => edge.id));
  const seen = new Set<string>();
  const decisions = input.edges
    .map((edge) => {
      if (seen.has(edge.id)) {
        throw namedError("MemoryAspectEdgeAdmissionEdgeDuplicate");
      }
      seen.add(edge.id);
      if (graphEdgeIds.has(edge.id)) {
        throw namedError("MemoryAspectEdgeAdmissionEdgeAlreadyCommitted");
      }
      const from = evidence.get(edge.fromClaimId);
      const to = evidence.get(edge.toClaimId);
      if (from === undefined || to === undefined) {
        return decision(edge.id, "defer", "evidence_missing");
      }
      const fromRoles = roles.get(roleKey(edge, edge.fromClaimId));
      const toRoles = roles.get(roleKey(edge, edge.toClaimId));
      if (fromRoles === undefined || toRoles === undefined) {
        return decision(edge.id, "reject", "role_incompatible");
      }
      const overlap = discriminantOverlap(
        from.statement,
        to.statement,
        weights,
      );
      if (edge.edgeType === "supports") {
        if (isEvidenceRole(fromRoles) && hasStateRole(toRoles)) {
          return decision(edge.id, "admit", "role_grounded");
        }
        if (!hasStateRole(fromRoles) || !hasStateRole(toRoles)) {
          return decision(edge.id, "reject", "role_incompatible");
        }
        if (!hasCausalCue(from.statement)) {
          return decision(edge.id, "reject", "causal_cue_missing");
        }
        return overlap > 0
          ? decision(edge.id, "admit", "state_causal_grounded")
          : decision(edge.id, "reject", "discriminant_overlap_missing");
      }
      if (!hasStateRole(fromRoles) || !hasStateRole(toRoles)) {
        return decision(edge.id, "reject", "role_incompatible");
      }
      if (overlap <= 0) {
        return decision(edge.id, "reject", "discriminant_overlap_missing");
      }
      if (edge.edgeType === "supersedes") {
        return hasChangeCue(from.statement)
          ? decision(edge.id, "admit", "state_transition_grounded")
          : decision(edge.id, "reject", "change_cue_missing");
      }
      if (edge.edgeType === "same_state") {
        return decision(edge.id, "admit", "state_equivalence_grounded");
      }
      if (edge.edgeType === "qualifies") {
        if (hasQualifierRole(fromRoles) && !hasQualifierRole(toRoles)) {
          return decision(edge.id, "admit", "conditional_grounded");
        }
        return hasConditionCue(from.statement)
          ? decision(edge.id, "admit", "conditional_grounded")
          : decision(edge.id, "reject", "condition_cue_missing");
      }
      return decision(edge.id, "defer", "evidence_missing");
    })
    .sort((left, right) => left.edgeId.localeCompare(right.edgeId));
  const body = {
    policyVersion: PAW_MEMORY_ASPECT_EDGE_ADMISSION_VERSION_V1,
    sourceGraphRevision: input.snapshot.revision,
    decisions,
  };
  return Object.freeze({
    ...body,
    admissionRevision: hashCanonicalJsonV1(body as unknown as JsonValue),
    admittedEdgeIds: Object.freeze(
      decisions
        .filter((item) => item.disposition === "admit")
        .map((item) => item.edgeId),
    ),
    rejectedEdgeIds: Object.freeze(
      decisions
        .filter((item) => item.disposition === "reject")
        .map((item) => item.edgeId),
    ),
    deferredEdgeIds: Object.freeze(
      decisions
        .filter((item) => item.disposition === "defer")
        .map((item) => item.edgeId),
    ),
  });
}

function activeRoles(
  snapshot: MemoryAspectGraphSnapshotV1,
): ReadonlyMap<string, ReadonlySet<MemoryAspectClaimRoleV1>> {
  const retracted = new Set(
    snapshot.lifecycleEvents
      .filter((event) => event.targetKind === "membership")
      .map((event) => event.targetId),
  );
  const result = new Map<string, Set<MemoryAspectClaimRoleV1>>();
  for (const membership of snapshot.memberships) {
    if (retracted.has(membership.id)) continue;
    const key = `${membership.stateKeyId}\n${membership.claimId}`;
    const values = result.get(key) ?? new Set<MemoryAspectClaimRoleV1>();
    values.add(membership.role);
    result.set(key, values);
  }
  return result;
}

function roleKey(edge: MemoryEvidenceEdgeV1, claimId: string): string {
  return `${edge.stateKeyId ?? "unscoped"}\n${claimId}`;
}

function decision(
  edgeId: string,
  disposition: MemoryAspectEdgeAdmissionDecisionV1["disposition"],
  reasonCode: MemoryAspectEdgeAdmissionDecisionV1["reasonCode"],
): MemoryAspectEdgeAdmissionDecisionV1 {
  return Object.freeze({ edgeId, disposition, reasonCode });
}

function hasStateRole(roles: ReadonlySet<MemoryAspectClaimRoleV1>): boolean {
  return roles.has("state") || roles.has("fact");
}

function isEvidenceRole(roles: ReadonlySet<MemoryAspectClaimRoleV1>): boolean {
  return roles.has("event") || roles.has("cause") || roles.has("condition");
}

function hasQualifierRole(
  roles: ReadonlySet<MemoryAspectClaimRoleV1>,
): boolean {
  return roles.has("fact") || roles.has("condition");
}

function hasCausalCue(value: string): boolean {
  return CAUSAL_CUE.test(value.normalize("NFKC").toLocaleLowerCase());
}

function hasChangeCue(value: string): boolean {
  return CHANGE_CUE.test(value.normalize("NFKC").toLocaleLowerCase());
}

function hasConditionCue(value: string): boolean {
  return CONDITION_CUE.test(value.normalize("NFKC").toLocaleLowerCase());
}

function discriminantOverlap(
  left: string,
  right: string,
  weights: ReadonlyMap<string, number>,
): number {
  const rightTerms = terms(right);
  let score = 0;
  for (const term of terms(left)) {
    if (rightTerms.has(term) && (weights.get(term) ?? 0) > 0) {
      score += weights.get(term) ?? 0;
    }
  }
  return score;
}

function terms(value: string): ReadonlySet<string> {
  const normalized = value.normalize("NFKC").toLocaleLowerCase();
  const result = new Set(
    (normalized.match(/[\p{L}\p{N}]{2,}/gu) ?? []).filter(
      (term) => !STOP_WORDS.has(term),
    ),
  );
  for (const match of normalized.matchAll(/[\p{Script=Han}]+/gu)) {
    const chars = [...match[0]];
    for (let index = 0; index + 1 < chars.length; index += 1) {
      result.add(`${chars[index]}${chars[index + 1]}`);
    }
  }
  return result;
}

function inverseDocumentWeights(
  documents: readonly ReadonlySet<string>[],
): ReadonlyMap<string, number> {
  const frequency = new Map<string, number>();
  for (const document of documents) {
    for (const term of document) {
      frequency.set(term, (frequency.get(term) ?? 0) + 1);
    }
  }
  return new Map(
    [...frequency].map(([term, count]) => [
      term,
      Math.log((documents.length + 1) / (count + 1)),
    ]),
  );
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

const CAUSAL_CUE =
  /\b(?:because|due to|therefore|thus|so that|led to|leads to|resulted in|results in|reinforc(?:e|ed|es|ing)|inspir(?:e|ed|es|ing)|motivat(?:e|ed|es|ing)|prompt(?:ed|s|ing)|which made|as a result)\b|因为|由于|因此|所以|导致|促使|强化|启发|激励/u;
const CHANGE_CUE =
  /\b(?:now|no longer|instead|changed|shifted|switched|stopped|started|began|became|returned to|gave up|reconsidered|decided to|moved from|moved to|replaced|prefers? .+ over)\b|现在|不再|改为|转而|停止|开始|变得|重新|放弃|决定|取代|相比.+更/u;
const CONDITION_CUE =
  /\b(?:when|whenever|if|unless|during|while|depending on|in .+ situations?|for .+ cases?|under .+ conditions?)\b|当|如果|除非|期间|取决于|在.+情况下|针对/u;
const STOP_WORDS = new Set([
  "about",
  "after",
  "also",
  "and",
  "are",
  "been",
  "before",
  "but",
  "for",
  "from",
  "has",
  "have",
  "into",
  "its",
  "now",
  "that",
  "the",
  "their",
  "then",
  "they",
  "this",
  "uses",
  "was",
  "were",
  "will",
  "with",
]);
