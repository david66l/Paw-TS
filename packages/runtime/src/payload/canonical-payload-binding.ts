import type {
  DurableJsonPayloadV1,
  InputAttachmentV1,
  JsonValue,
  RunJournalEnvelopeV1,
} from "@paw/protocol";
import { parseRunJournalPrefixV1 } from "@paw/protocol";

import {
  canonicalJsonStringifyV1,
  immutableCanonicalJsonCloneV1,
} from "../context/canonical-json.js";

export const CANONICAL_DURABLE_JSON_PAYLOAD_BINDING_VERSION_V1 =
  "paw.canonical-durable-json-payload-binding.v1" as const;

export type DurableJsonPayloadFieldV1 =
  | Readonly<{
      kind: "input_attachment";
      inputId: string;
      attachmentId: string;
    }>
  | Readonly<{ kind: "model_response"; modelCallId: string }>
  | Readonly<{ kind: "tool_observation"; callId: string }>
  | Readonly<{ kind: "task_checkpoint"; checkpointId: string }>;

/**
 * The origin is the first canonical semantic carrier, not necessarily the
 * envelope currently carrying the ref. Repeated promotion/checkpoint carriers
 * must therefore project the same binding as their predecessor.
 */
export interface DurableJsonPayloadBindingV1 {
  readonly originSeq: number;
  readonly field: DurableJsonPayloadFieldV1;
}

export type CanonicalDurableJsonPayloadLocationV1 =
  | Readonly<{
      kind: "input_attachment";
      carrierType: "input.accepted" | "input.promoted";
      carrierSeq: number;
      attachmentIndex: number;
      inputId: string;
      attachmentId: string;
    }>
  | Readonly<{
      kind: "model_response";
      carrierType: "model.settled";
      carrierSeq: number;
      modelCallId: string;
    }>
  | Readonly<{
      kind: "tool_observation";
      carrierType: "tool.settled";
      carrierSeq: number;
      callId: string;
    }>
  | Readonly<{
      kind: "task_checkpoint";
      carrierType: "context.checkpoint_distillation_settled";
      carrierSeq: number;
      claimId: string;
      checkpointId: string;
    }>
  | Readonly<{
      kind: "task_checkpoint";
      carrierType: "context.checkpoint_recorded";
      carrierSeq: number;
      checkpointId: string;
      distillationClaimId?: string;
    }>;

export interface CanonicalDurableJsonPayloadOccurrenceV1 {
  readonly location: CanonicalDurableJsonPayloadLocationV1;
  readonly binding: DurableJsonPayloadBindingV1;
  readonly payload: DurableJsonPayloadV1;
}

interface CheckpointClaimProjection {
  readonly checkpointId: string;
  settlementSeq?: number;
}

/**
 * Project every durable JSON payload from one complete authoritative prefix.
 *
 * This is the only canonical origin/binding projector. It deliberately uses
 * real envelope seq values and first validates the full Protocol prefix. It
 * performs no storage I/O and does not infer authority from artifact files.
 */
export function projectCanonicalDurableJsonPayloadBindingsV1(
  fullPrefix: readonly RunJournalEnvelopeV1[],
): readonly CanonicalDurableJsonPayloadOccurrenceV1[] {
  const prefix = parseRunJournalPrefixV1(fullPrefix);
  const occurrences: CanonicalDurableJsonPayloadOccurrenceV1[] = [];
  const acceptedInputSeqs = new Map<string, number>();
  const checkpointClaims = new Map<string, CheckpointClaimProjection>();
  const artifactBindings = new Map<string, string>();

  const addOccurrence = (
    payload: DurableJsonPayloadV1,
    binding: DurableJsonPayloadBindingV1,
    location: CanonicalDurableJsonPayloadLocationV1,
  ): void => {
    const frozenBinding = freezeBinding(binding);
    if (payload.kind === "artifact_ref") {
      const key = canonicalJsonStringifyV1(
        frozenBinding as unknown as JsonValue,
      );
      const existing = artifactBindings.get(payload.artifactRef);
      if (existing !== undefined && existing !== key) {
        throw new Error(
          "Durable JSON payload artifact ref is reused across canonical bindings",
        );
      }
      artifactBindings.set(payload.artifactRef, key);
    }
    occurrences.push(
      Object.freeze({
        location: freezeLocation(location),
        binding: frozenBinding,
        payload: immutableCanonicalJsonCloneV1(
          payload as unknown as JsonValue,
        ) as unknown as DurableJsonPayloadV1,
      }),
    );
  };

  for (const envelope of prefix) {
    if (envelope.record.kind !== "input_fact") continue;
    const fact = envelope.record.fact;
    switch (fact.type) {
      case "input.accepted": {
        acceptedInputSeqs.set(fact.inputId, envelope.seq);
        addAttachmentOccurrences(
          fact.attachments,
          fact.type,
          fact.inputId,
          envelope.seq,
          envelope.seq,
          addOccurrence,
        );
        break;
      }
      case "input.promoted": {
        const acceptedSeq = acceptedInputSeqs.get(fact.inputId);
        const originSeq =
          fact.delivery === "initial" ? envelope.seq : acceptedSeq;
        if (originSeq === undefined) {
          throw new Error("Promoted input has no canonical payload origin");
        }
        addAttachmentOccurrences(
          fact.attachments,
          fact.type,
          fact.inputId,
          envelope.seq,
          originSeq,
          addOccurrence,
        );
        break;
      }
      case "model.settled": {
        if (fact.response !== undefined) {
          addOccurrence(
            fact.response,
            {
              originSeq: envelope.seq,
              field: {
                kind: "model_response",
                modelCallId: fact.modelCallId,
              },
            },
            {
              kind: "model_response",
              carrierType: fact.type,
              carrierSeq: envelope.seq,
              modelCallId: fact.modelCallId,
            },
          );
        }
        break;
      }
      case "tool.settled": {
        const payload = fact.observation?.payload;
        if (payload !== undefined) {
          addOccurrence(
            payload,
            {
              originSeq: envelope.seq,
              field: { kind: "tool_observation", callId: fact.callId },
            },
            {
              kind: "tool_observation",
              carrierType: fact.type,
              carrierSeq: envelope.seq,
              callId: fact.callId,
            },
          );
        }
        break;
      }
      case "context.checkpoint_distillation_claimed": {
        checkpointClaims.set(fact.claimId, {
          checkpointId: fact.checkpointId,
        });
        break;
      }
      case "context.checkpoint_distillation_settled": {
        const claim = checkpointClaims.get(fact.claimId);
        if (!claim) {
          throw new Error("Checkpoint settlement has no canonical claim");
        }
        if (fact.status === "completed" && fact.checkpoint !== undefined) {
          claim.settlementSeq = envelope.seq;
          addOccurrence(
            fact.checkpoint,
            {
              originSeq: envelope.seq,
              field: {
                kind: "task_checkpoint",
                checkpointId: claim.checkpointId,
              },
            },
            {
              kind: "task_checkpoint",
              carrierType: fact.type,
              carrierSeq: envelope.seq,
              claimId: fact.claimId,
              checkpointId: claim.checkpointId,
            },
          );
        }
        break;
      }
      case "context.checkpoint_recorded": {
        let originSeq = envelope.seq;
        if (fact.distillationClaimId !== undefined) {
          const claim = checkpointClaims.get(fact.distillationClaimId);
          if (
            !claim ||
            claim.checkpointId !== fact.checkpointId ||
            claim.settlementSeq === undefined
          ) {
            throw new Error(
              "Recorded checkpoint has no canonical distillation origin",
            );
          }
          originSeq = claim.settlementSeq;
        }
        addOccurrence(
          fact.checkpoint,
          {
            originSeq,
            field: {
              kind: "task_checkpoint",
              checkpointId: fact.checkpointId,
            },
          },
          {
            kind: "task_checkpoint",
            carrierType: fact.type,
            carrierSeq: envelope.seq,
            checkpointId: fact.checkpointId,
            ...(fact.distillationClaimId === undefined
              ? {}
              : { distillationClaimId: fact.distillationClaimId }),
          },
        );
        break;
      }
    }
  }

  return Object.freeze(occurrences);
}

function addAttachmentOccurrences(
  attachments: readonly InputAttachmentV1[] | undefined,
  carrierType: "input.accepted" | "input.promoted",
  inputId: string,
  carrierSeq: number,
  originSeq: number,
  add: (
    payload: DurableJsonPayloadV1,
    binding: DurableJsonPayloadBindingV1,
    location: CanonicalDurableJsonPayloadLocationV1,
  ) => void,
): void {
  for (const [attachmentIndex, attachment] of (attachments ?? []).entries()) {
    add(
      attachment.content,
      {
        originSeq,
        field: {
          kind: "input_attachment",
          inputId,
          attachmentId: attachment.attachmentId,
        },
      },
      {
        kind: "input_attachment",
        carrierType,
        carrierSeq,
        attachmentIndex,
        inputId,
        attachmentId: attachment.attachmentId,
      },
    );
  }
}

function freezeBinding(
  binding: DurableJsonPayloadBindingV1,
): DurableJsonPayloadBindingV1 {
  return Object.freeze({
    originSeq: binding.originSeq,
    field: Object.freeze({ ...binding.field }),
  });
}

function freezeLocation(
  location: CanonicalDurableJsonPayloadLocationV1,
): CanonicalDurableJsonPayloadLocationV1 {
  return Object.freeze({
    ...location,
  }) as CanonicalDurableJsonPayloadLocationV1;
}
