import { describe, expect, test } from "bun:test";
import { compileMemoryQueryAnswerOriginV1 } from "../src/query-answer-origin.js";
import type {
  MemoryEvidenceQueryIntentV3,
  MemoryEvidenceRequirementV3,
} from "../src/query-plan-contracts.js";
import {
  PAW_MEMORY_STATE_BINDING_CERTIFICATE_POLICY_V1,
  compileMemoryStateBindingCertificatesV1,
  validateMemoryStateBindingCertificateV1,
} from "../src/state-binding-certificate-v1.js";
import {
  type MemoryStateSlotSpecV2,
  bindMemoryStateObservationV2,
  compileMemoryStateSlotsV2,
  compileMemoryStateSourceLockV2,
} from "../src/state-frame-v2.js";
import {
  buildMemoryStateObservationVerificationRequestV2,
  createJsonMemoryStateObservationVerifierV2,
} from "../src/state-observation-verifier-v2.js";
import { bindMemoryEvidenceTemporalConstraintV1 } from "../src/temporal-constraint.js";

const query = "Where does the user currently live?";
const intent: MemoryEvidenceQueryIntentV3 = {
  answerShape: "lookup",
  temporalMode: "latest",
  roleConstraint: "user",
  needsPlanning: true,
};
const requirement: MemoryEvidenceRequirementV3 = {
  requirementId: "current-home",
  label: "the user's current home",
  searchText: "user current home",
  temporalMode: "latest",
  roleConstraint: "user",
  relation: "direct",
  coverageMode: "latest",
  minimumEvidence: 1,
  dependencyRelation: "independent",
  dependsOnRequirementIds: [],
};

function fixture() {
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
  const slot = slots[0] as MemoryStateSlotSpecV2;
  const content =
    "My old home was Rome. My current home is Paris. My sister lives in Berlin.";
  const sourceLock = compileMemoryStateSourceLockV2([
    {
      sourceId: "source-1",
      evidenceRef: "ref-1",
      content,
      authority: "user_asserted",
      role: "user",
      observedAt: "2025-01-02T00:00:00Z",
      episodeOrder: 2,
      turnOrder: 3,
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
      predicateKind: "update",
      polarity: "positive",
      modality: "observed",
    },
  });
  return {
    slots,
    sourceLock,
    observation,
    verificationInput: {
      query,
      slots,
      sourceLock,
      proposedObservations: [observation],
    },
  };
}

function acceptingVerifier() {
  return createJsonMemoryStateObservationVerifierV2({
    model: {
      async complete(request) {
        const payload = JSON.parse(request.user) as {
          observations: readonly Readonly<{ observationId: string }>[];
        };
        return {
          status: "completed" as const,
          text: JSON.stringify({
            acceptedObservationIds: payload.observations.map(
              (observation) => observation.observationId,
            ),
            rejectedObservationIds: [],
          }),
        };
      },
    },
  });
}

describe("host-compiled state binding certificate v1", () => {
  test("binds an accepted observation to immutable slot, evidence, and local claim context", async () => {
    const data = fixture();
    const verification = await acceptingVerifier().verify(
      data.verificationInput,
      new AbortController().signal,
    );
    const input = { ...data.verificationInput, verification };
    const validated = compileMemoryStateBindingCertificatesV1(input);

    expect(validated).toHaveLength(1);
    const candidate = validated[0];
    const slot = data.slots[0];
    if (!candidate || !slot) throw new Error("fixture");
    expect(candidate.certificate.policyVersion).toBe(
      PAW_MEMORY_STATE_BINDING_CERTIFICATE_POLICY_V1,
    );
    expect(candidate.certificate.slotBinding.slotId).toBe(slot.slotId);
    expect(candidate.certificate.claimBinding.supportSpan.text).toBe(
      "My current home is Paris.",
    );
    expect(candidate.certificate.claimBinding.subject).toEqual({
      referent: "query_user",
      basis: "speaker_deictic",
    });
    expect(candidate.certificate.claimBinding.value.exactSpans[0]?.text).toBe(
      "Paris",
    );
    expect(candidate.certificate.semanticAttestation.decision).toBe("accepted");
    expect(validateMemoryStateBindingCertificateV1(candidate, input)).toBe(
      candidate,
    );
  });

  test("fails closed when a caller tampers with a host-derived claim field", async () => {
    const data = fixture();
    const verification = await acceptingVerifier().verify(
      data.verificationInput,
      new AbortController().signal,
    );
    const input = { ...data.verificationInput, verification };
    const candidate = compileMemoryStateBindingCertificatesV1(input)[0];
    if (!candidate) throw new Error("fixture");
    const tampered = {
      ...candidate,
      certificate: {
        ...candidate.certificate,
        claimBinding: {
          ...candidate.certificate.claimBinding,
          subject: {
            referent: "assistant" as const,
            basis: "speaker_deictic" as const,
          },
        },
      },
    };
    expect(() =>
      validateMemoryStateBindingCertificateV1(tampered, input),
    ).toThrow("MemoryStateBindingCertificateBoundaryInvalid");
  });

  test("rejects incomplete or overlapping verifier partitions", () => {
    const data = fixture();
    expect(() =>
      compileMemoryStateBindingCertificatesV1({
        ...data.verificationInput,
        verification: {
          verifierVersion: "verifier",
          verificationRevision: "revision",
          acceptedObservationIds: [data.observation.observationId],
          rejectedObservationIds: [data.observation.observationId],
        },
      }),
    ).toThrow("MemoryStateBindingCertificatePartitionInvalid");
  });

  test("projects subject, exact value offsets, and only the local supporting sentence to the verifier", () => {
    const data = fixture();
    const request = buildMemoryStateObservationVerificationRequestV2(
      data.verificationInput,
    );
    const payload = JSON.parse(request.user) as {
      observations: readonly Readonly<{
        typedClaim: Readonly<{
          subject: Readonly<{ referent: string; basis: string }>;
          localSupport: Readonly<{ text: string; start: number; end: number }>;
          valueSpans: readonly Readonly<{
            text: string;
            start: number;
            end: number;
          }>[];
        }>;
      }>[];
    };
    const claim = payload.observations[0]?.typedClaim;
    const valueSpan = data.observation.valueSpans[0];
    if (!valueSpan) throw new Error("fixture");
    expect(claim?.subject).toEqual({
      referent: "query_user",
      basis: "speaker_deictic",
    });
    expect(claim?.localSupport.text).toBe("My current home is Paris.");
    expect(claim?.localSupport.text).not.toContain("Rome");
    expect(claim?.localSupport.text).not.toContain("Berlin");
    expect(claim?.valueSpans[0]).toEqual({
      text: "Paris",
      start: valueSpan.start,
      end: valueSpan.end,
    });
    expect(request.system).toContain("another person");
  });

  test("projects the exact earlier lifecycle claim and binds the pair into the certificate", async () => {
    const base = fixture();
    const slot = base.slots[0] as MemoryStateSlotSpecV2;
    const oldContent = "My home is Rome.";
    const newContent = "I moved; my home is now Paris instead.";
    const sourceLock = compileMemoryStateSourceLockV2([
      {
        sourceId: "old-source",
        evidenceRef: "old-home",
        content: oldContent,
        authority: "user_asserted",
        role: "user",
        observedAt: "2024-01-01T00:00:00.000Z",
      },
      {
        sourceId: "new-source",
        evidenceRef: "new-home",
        content: newContent,
        authority: "user_asserted",
        role: "user",
        observedAt: "2024-02-01T00:00:00.000Z",
      },
    ]);
    const oldObservation = bindMemoryStateObservationV2({
      slot,
      sourceLock,
      proposal: {
        slotId: slot.slotId,
        evidenceRef: "old-home",
        valueSpans: [
          {
            start: oldContent.indexOf("Rome"),
            end: oldContent.indexOf("Rome") + "Rome".length,
          },
        ],
        predicateKind: "assert",
        polarity: "positive",
        modality: "observed",
      },
    });
    const newObservation = bindMemoryStateObservationV2({
      slot,
      sourceLock,
      proposal: {
        slotId: slot.slotId,
        evidenceRef: "new-home",
        valueSpans: [
          {
            start: newContent.indexOf("Paris"),
            end: newContent.indexOf("Paris") + "Paris".length,
          },
        ],
        lifecycleRelation: "supersedes",
        lifecycleTargetEvidenceRef: "old-home",
        predicateKind: "update",
        polarity: "positive",
        modality: "observed",
      },
    });
    const verificationInput = {
      query,
      slots: base.slots,
      sourceLock,
      proposedObservations: [oldObservation, newObservation],
    };
    const request = buildMemoryStateObservationVerificationRequestV2(
      verificationInput,
    );
    const payload = JSON.parse(request.user) as {
      observations: readonly Readonly<{
        typedClaim: Readonly<{
          lifecycleTarget: null | Readonly<{
            slot: Readonly<{ slotId: string }>;
            typedClaim: Readonly<{
              localSupport: Readonly<{ text: string }>;
              predicateKind: string;
              modality: string;
              bindingRevision: string;
            }>;
            evidence: Readonly<{
              evidenceRef: string;
              observedAt: string;
              content: string;
            }>;
          }>;
        }>;
      }>[];
    };
    const lifecycleTarget = payload.observations[1]?.typedClaim.lifecycleTarget;
    expect(lifecycleTarget).toMatchObject({
      slot: { slotId: slot.slotId },
      typedClaim: {
        localSupport: { text: "My home is Rome." },
        predicateKind: "assert",
        modality: "observed",
        bindingRevision: oldObservation.bindingRevision,
      },
      evidence: {
        evidenceRef: "old-home",
        observedAt: "2024-01-01T00:00:00.000Z",
        content: oldContent,
      },
    });
    const verification = await acceptingVerifier().verify(
      verificationInput,
      new AbortController().signal,
    );
    const validated = compileMemoryStateBindingCertificatesV1({
      ...verificationInput,
      verification,
    });
    expect(validated[1]?.certificate.claimBinding.lifecycle.target).toMatchObject(
      {
        observationId: oldObservation.observationId,
        bindingRevision: oldObservation.bindingRevision,
        slotId: slot.slotId,
        evidenceRef: "old-home",
        predicateKind: "assert",
      },
    );
    expect(request.system).toContain("exact lifecycleTarget object");
  });
});
