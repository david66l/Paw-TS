import { describe, expect, test } from "bun:test";
import { compileMemoryQueryAnswerOriginV1 } from "../src/query-answer-origin.js";
import type {
  MemoryEvidenceQueryIntentV3,
  MemoryEvidenceRequirementV3,
} from "../src/query-plan-contracts.js";
import { compileMemoryStateBindingCertificatesV1 } from "../src/state-binding-certificate-v1.js";
import {
  bindMemoryStateObservationV2,
  compileMemoryStateSlotsV2,
  compileMemoryStateSourceLockV2,
  resolveMemoryStateFrameV2,
} from "../src/state-frame-v2.js";
import {
  PAW_MEMORY_STATE_MECHANICAL_BINDING_PROFILE_POLICY_V1,
  compileMemoryStateMechanicalBindingProfilesV1,
  summarizeMemoryStateMechanicalBindingProfilesV1,
} from "../src/state-mechanical-binding-profile-v1.js";
import { bindMemoryEvidenceTemporalConstraintV1 } from "../src/temporal-constraint.js";

const query = "Where does the user live?";
const intent: MemoryEvidenceQueryIntentV3 = {
  answerShape: "lookup",
  temporalMode: "any",
  roleConstraint: "user",
  needsPlanning: true,
};
const requirement: MemoryEvidenceRequirementV3 = {
  requirementId: "home",
  label: "the user's home",
  searchText: "user home",
  temporalMode: "any",
  roleConstraint: "user",
  relation: "direct",
  coverageMode: "any",
  minimumEvidence: 1,
  dependencyRelation: "independent",
  dependsOnRequirementIds: [],
};

function fixture(content = "My home is Paris. My sister lives in Berlin.") {
  const slots = compileMemoryStateSlotsV2({
    query,
    intent,
    requirements: [requirement],
    origin: compileMemoryQueryAnswerOriginV1(query),
    temporalConstraints: new Map([
      [
        requirement.requirementId,
        bindMemoryEvidenceTemporalConstraintV1({
          query,
          queryEnvelopeMode: intent.temporalMode,
          leafMode: requirement.temporalMode,
          constraint: requirement.temporalConstraint,
        }),
      ],
    ]),
  });
  const slot = slots[0];
  if (!slot) throw new Error("fixture");
  const sourceLock = compileMemoryStateSourceLockV2([
    {
      sourceId: "source-1",
      evidenceRef: "ref-1",
      content,
      authority: "user_asserted",
      role: "user",
      observedAt: "2025-01-02T00:00:00Z",
    },
  ]);
  const start = content.indexOf("Paris");
  const observation = bindMemoryStateObservationV2({
    slot,
    sourceLock,
    proposal: {
      slotId: slot.slotId,
      evidenceRef: "ref-1",
      valueSpans: [{ start, end: start + "Paris".length }],
      predicateKind: "assert",
      polarity: "positive",
      modality: "observed",
    },
  });
  const verification = {
    verifierVersion: "test-verifier",
    verificationRevision: "test-revision",
    acceptedObservationIds: [observation.observationId],
    rejectedObservationIds: [],
  };
  const validatedObservations = compileMemoryStateBindingCertificatesV1({
    query,
    slots,
    sourceLock,
    proposedObservations: [observation],
    verification,
  });
  const frame = resolveMemoryStateFrameV2({
    slots,
    sourceLock,
    observations: [observation],
  });
  return {
    slots,
    sourceLock,
    validatedObservations,
    frame,
    slotScopes: [{ slotId: slot.slotId, evidenceRefs: ["ref-1"] }],
  };
}

describe("mechanical binding profile v1", () => {
  test("separates deterministic proofs from unresolved semantic claims", () => {
    const profiles = compileMemoryStateMechanicalBindingProfilesV1(fixture());
    expect(profiles).toHaveLength(1);
    const profile = profiles[0];
    if (!profile) throw new Error("fixture");
    expect(profile.policyVersion).toBe(
      PAW_MEMORY_STATE_MECHANICAL_BINDING_PROFILE_POLICY_V1,
    );
    expect(Object.values(profile.proofs).every(Boolean)).toBe(true);
    expect(profile.unresolvedSemanticClaims).toEqual({
      subjectBinding: true,
      slotAttributeBinding: true,
      clauseAttachment: true,
      entailment: true,
    });
  });

  test("reports repeated value text as a mechanical ambiguity", () => {
    const profiles = compileMemoryStateMechanicalBindingProfilesV1(
      fixture("My home is Paris. I visited Paris last year."),
    );
    expect(profiles[0]?.proofs.valueOccurrenceUnique).toBe(false);
    expect(profiles[0]?.metrics.occurrenceCountBucket).toBe("multiple");
  });

  test("summary is content-free and counts proof failures without ids or quotes", () => {
    const profiles = compileMemoryStateMechanicalBindingProfilesV1(
      fixture("My home is Paris. I visited Paris last year."),
    );
    const summary = summarizeMemoryStateMechanicalBindingProfilesV1(profiles);
    expect(summary.profileCount).toBe(1);
    expect(summary.mechanicallyCompleteCount).toBe(0);
    expect(summary.mechanicallyIncompleteCount).toBe(1);
    expect(summary.proofFailureCounts.valueOccurrenceUnique).toBe(1);
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain("Paris");
    expect(serialized).not.toContain("observationId");
    expect(serialized).not.toContain("ref-1");
  });
});
