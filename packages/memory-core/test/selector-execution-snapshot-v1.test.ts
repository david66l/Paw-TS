import { describe, expect, test } from "bun:test";
import { compileMemoryEvidenceSelectorGroupsV1 } from "../src/evidence-selector-groups.js";
import type {
  MemoryEvidenceBoundTemporalConstraintV1,
  MemoryEvidenceQueryIntentV3,
  MemoryEvidenceRequirementV3,
} from "../src/query-plan-contracts.js";
import {
  type MemorySelectorExecutionGroupInputV1,
  compileMemorySelectorExecutionSnapshotV1,
} from "../src/selector-execution-snapshot-v1.js";
import { bindMemoryEvidenceTemporalConstraintV1 } from "../src/temporal-constraint.js";

const intent: MemoryEvidenceQueryIntentV3 = Object.freeze({
  answerShape: "lookup",
  temporalMode: "any",
  roleConstraint: "user",
  needsPlanning: true,
});

const requirements: readonly MemoryEvidenceRequirementV3[] = Object.freeze([
  Object.freeze({
    requirementId: "requirement-1",
    label: "first operand",
    searchText: "first",
    temporalMode: "any",
    roleConstraint: "user",
    dependencyRelation: "independent",
    dependsOnRequirementIds: Object.freeze([]),
  }),
  Object.freeze({
    requirementId: "requirement-2",
    label: "second operand",
    searchText: "second",
    temporalMode: "any",
    roleConstraint: "user",
    dependencyRelation: "independent",
    dependsOnRequirementIds: Object.freeze([]),
  }),
]);

const temporalConstraints: readonly MemoryEvidenceBoundTemporalConstraintV1[] =
  Object.freeze(
    requirements.map((requirement) =>
      bindMemoryEvidenceTemporalConstraintV1({
        query: "What were both operands?",
        queryEnvelopeMode: intent.temporalMode,
        leafMode: requirement.temporalMode,
      }),
    ),
  );

const candidateScopes = Object.freeze([
  Object.freeze({
    requirementId: "requirement-1",
    evidenceRefs: Object.freeze(["evidence-1"]),
  }),
  Object.freeze({
    requirementId: "requirement-2",
    evidenceRefs: Object.freeze(["evidence-2"]),
  }),
]);
const selectorGroups = compileMemoryEvidenceSelectorGroupsV1({
  intent,
  requirements,
});
const selectorGroupOne = selectorGroups[0];
const selectorGroupTwo = selectorGroups[1];
const temporalOne = temporalConstraints[0];
const temporalTwo = temporalConstraints[1];
if (!selectorGroupOne || !selectorGroupTwo || !temporalOne || !temporalTwo) {
  throw new Error("fixture invalid");
}

function assessment(requirementId: string, evidenceRef?: string) {
  return Object.freeze({
    requirementId,
    supportingEvidenceRefs: Object.freeze(
      evidenceRef === undefined ? [] : [evidenceRef],
    ),
    contradictingEvidenceRefs: Object.freeze([]),
    unknownEvidenceRefs: Object.freeze([]),
    evidenceDispositions: Object.freeze(
      evidenceRef === undefined
        ? []
        : [
            Object.freeze({
              requirementId,
              evidenceRef,
              disposition: "supporting" as const,
              resolvedRole: "user" as const,
              evidenceUse: "user_fact" as const,
              contextEvidenceRefs: Object.freeze([]),
            }),
          ],
    ),
  });
}

function compile(groups: readonly MemorySelectorExecutionGroupInputV1[]) {
  return compileMemorySelectorExecutionSnapshotV1({
    query: "What were both operands?",
    intent,
    requirements,
    temporalConstraints,
    candidateScopes,
    lockedSourceIds: Object.freeze(["source-1", "source-2"]),
    originRevision: "origin-revision",
    selectorVersion: "selector-version",
    selectionRevision: "selection-revision",
    committedAttempt: "baseline",
    attemptCount: 1,
    groups,
  });
}

describe("selector execution snapshot v1", () => {
  test("keeps committed and failed groups transactionally distinct", () => {
    const snapshot = compile([
      Object.freeze({
        groupId: selectorGroupOne.groupId,
        requirementIds: Object.freeze(["requirement-1"]),
        status: "committed" as const,
        assessments: Object.freeze([assessment("requirement-1", "evidence-1")]),
      }),
      Object.freeze({
        groupId: selectorGroupTwo.groupId,
        requirementIds: Object.freeze(["requirement-2"]),
        status: "failed" as const,
        assessments: Object.freeze([]),
        failureCodes: Object.freeze(["SelectorGroupFailed"]),
      }),
    ]);

    expect(snapshot.groups[0]?.requirements[0]?.status).toBe("assessed");
    expect(snapshot.groups[0]?.requirements[0]?.assessment).toBeDefined();
    expect(snapshot.groups[1]?.requirements[0]?.status).toBe(
      "unassessed_group_failed",
    );
    expect(snapshot.groups[1]?.requirements[0]?.assessment).toBeUndefined();
  });

  test("does not conflate assessed-empty with unassessed", () => {
    const snapshot = compile([
      Object.freeze({
        groupId: selectorGroupOne.groupId,
        requirementIds: Object.freeze(["requirement-1"]),
        status: "committed" as const,
        assessments: Object.freeze([assessment("requirement-1")]),
      }),
      Object.freeze({
        groupId: selectorGroupTwo.groupId,
        requirementIds: Object.freeze(["requirement-2"]),
        status: "failed" as const,
        assessments: Object.freeze([]),
      }),
    ]);

    expect(
      snapshot.groups[0]?.requirements[0]?.assessment?.supportingEvidenceRefs,
    ).toEqual([]);
    expect(snapshot.groups[1]?.requirements[0]?.assessment).toBeUndefined();
  });

  test("rejects partial assessments inside a committed group", () => {
    expect(() =>
      compile([
        Object.freeze({
          groupId: selectorGroupOne.groupId,
          requirementIds: Object.freeze(["requirement-1", "requirement-2"]),
          status: "committed" as const,
          assessments: Object.freeze([
            assessment("requirement-1", "evidence-1"),
          ]),
        }),
      ]),
    ).toThrow("MemorySelectorExecutionSnapshotGroupInvalid");
  });

  test("rejects assessments attached to a failed group", () => {
    expect(() =>
      compile([
        Object.freeze({
          groupId: selectorGroupOne.groupId,
          requirementIds: Object.freeze(["requirement-1"]),
          status: "failed" as const,
          assessments: Object.freeze([
            assessment("requirement-1", "evidence-1"),
          ]),
        }),
        Object.freeze({
          groupId: selectorGroupTwo.groupId,
          requirementIds: Object.freeze(["requirement-2"]),
          status: "failed" as const,
          assessments: Object.freeze([]),
        }),
      ]),
    ).toThrow("MemorySelectorExecutionSnapshotGroupInvalid");
  });

  test("binds snapshot identity to group status, temporal binding, and scope", () => {
    const groups = Object.freeze([
      Object.freeze({
        groupId: selectorGroupOne.groupId,
        requirementIds: Object.freeze(["requirement-1"]),
        status: "committed" as const,
        assessments: Object.freeze([assessment("requirement-1", "evidence-1")]),
      }),
      Object.freeze({
        groupId: selectorGroupTwo.groupId,
        requirementIds: Object.freeze(["requirement-2"]),
        status: "failed" as const,
        assessments: Object.freeze([]),
      }),
    ]);
    const base = compile(groups);
    const changedTemporal = compileMemorySelectorExecutionSnapshotV1({
      query: "What were both operands?",
      intent,
      requirements,
      temporalConstraints: Object.freeze([
        Object.freeze({
          ...temporalOne,
          bindingRevision: "binding-changed",
        }),
        temporalTwo,
      ]),
      candidateScopes,
      lockedSourceIds: Object.freeze(["source-1", "source-2"]),
      originRevision: "origin-revision",
      selectorVersion: "selector-version",
      selectionRevision: "selection-revision",
      committedAttempt: "baseline",
      attemptCount: 1,
      groups,
    });

    expect(changedTemporal.snapshotRevision).not.toBe(base.snapshotRevision);
  });
});
