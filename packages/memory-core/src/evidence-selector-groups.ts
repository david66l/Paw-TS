import { hashCanonicalJsonV1 } from "./canonical.js";
import type {
  MemoryEvidenceQueryIntentV3,
  MemoryEvidenceRequirementV3,
} from "./evidence-query-planner.js";

export const PAW_MEMORY_EVIDENCE_SELECTOR_GROUP_POLICY_V1 =
  "paw.memory-evidence-selector-groups.v1:dag-connected-transactions" as const;

export interface MemoryEvidenceSelectorGroupV1 {
  readonly groupId: string;
  readonly requirementIds: readonly string[];
  readonly requirements: readonly MemoryEvidenceRequirementV3[];
}

/**
 * Compiles the planner-owned obligation DAG into selector transaction groups.
 * Dependencies are atomic. Independent operands may commit proof separately;
 * closure still requires every required operand before the answer can close.
 * `all` and `convergent` remain atomic inside their own requirement. Legacy or
 * custom plans without complete DAG metadata stay query-atomic.
 */
export function compileMemoryEvidenceSelectorGroupsV1(input: {
  readonly intent: MemoryEvidenceQueryIntentV3;
  readonly requirements: readonly MemoryEvidenceRequirementV3[];
}): readonly MemoryEvidenceSelectorGroupV1[] {
  if (input.requirements.length < 1 || input.requirements.length > 4) {
    throw namedError("MemoryEvidenceSelectorGroupInputInvalid");
  }
  const byId = new Map(
    input.requirements.map((requirement, index) => [
      requirement.requirementId,
      { requirement, index },
    ]),
  );
  if (
    byId.size !== input.requirements.length ||
    input.requirements.some(
      (requirement) =>
        !requirement.requirementId.trim() ||
        (requirement.dependsOnRequirementIds ?? []).some(
          (dependency) =>
            dependency === requirement.requirementId || !byId.has(dependency),
        ),
    )
  ) {
    throw namedError("MemoryEvidenceSelectorGroupInputInvalid");
  }

  const completeDag = input.requirements.every(
    (requirement) =>
      requirement.dependencyRelation !== undefined &&
      requirement.dependsOnRequirementIds !== undefined,
  );
  // Recommendation constraints jointly define one synthesized choice. A
  // partial preference commit can be worse than the validated immutable
  // baseline, so this answer shape keeps the existing query transaction.
  const queryAtomic = !completeDag || input.intent.answerShape === "recommend";
  const parent = input.requirements.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root] as number;
    while (parent[index] !== index) {
      const next = parent[index] as number;
      parent[index] = root;
      index = next;
    }
    return root;
  };
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot === rightRoot) return;
    parent[Math.max(leftRoot, rightRoot)] = Math.min(leftRoot, rightRoot);
  };

  if (queryAtomic) {
    for (let index = 1; index < input.requirements.length; index += 1) {
      union(0, index);
    }
  } else {
    for (const [index, requirement] of input.requirements.entries()) {
      for (const dependency of requirement.dependsOnRequirementIds ?? []) {
        union(index, byId.get(dependency)?.index as number);
      }
    }
  }

  const membersByRoot = new Map<number, MemoryEvidenceRequirementV3[]>();
  for (const [index, requirement] of input.requirements.entries()) {
    const root = find(index);
    const members = membersByRoot.get(root) ?? [];
    members.push(requirement);
    membersByRoot.set(root, members);
  }
  return Object.freeze(
    [...membersByRoot]
      .sort(([left], [right]) => left - right)
      .map(([, requirements]) => {
        const frozenRequirements = Object.freeze([...requirements]);
        const requirementIds = Object.freeze(
          frozenRequirements.map((requirement) => requirement.requirementId),
        );
        return Object.freeze({
          groupId: hashCanonicalJsonV1({
            policy: PAW_MEMORY_EVIDENCE_SELECTOR_GROUP_POLICY_V1,
            requirementIds,
          } as never),
          requirementIds,
          requirements: frozenRequirements,
        });
      }),
  );
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}
