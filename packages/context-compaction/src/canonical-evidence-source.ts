import type { Session } from "@paw/agent-loop";
import type { InputFactV1 } from "@paw/protocol";
import type { VerifiedCanonicalPayloadEvidenceV1 } from "@paw/runtime";

import type { CheckpointEvidenceSourceV1 } from "./checkpoint-distiller.js";
import {
  type CheckpointResolvedPayloadV1,
  projectCheckpointEvidenceV1,
} from "./checkpoint-evidence.js";

export interface CanonicalPayloadCheckpointEvidenceSourceOptionsV1 {
  readonly snapshots: Pick<Session<InputFactV1, unknown>, "readInputSnapshot">;
  readonly loadPayloadEvidence: (
    snapshot: Awaited<
      ReturnType<Session<InputFactV1, unknown>["readInputSnapshot"]>
    >,
    signal: AbortSignal,
  ) =>
    | VerifiedCanonicalPayloadEvidenceV1
    | Promise<VerifiedCanonicalPayloadEvidenceV1>;
}

/** Resolves only canonical, location-bound payloads from the active run. */
export function createCanonicalPayloadCheckpointEvidenceSourceV1(
  options: CanonicalPayloadCheckpointEvidenceSourceOptionsV1,
): CheckpointEvidenceSourceV1 {
  const readSnapshot = options.snapshots.readInputSnapshot.bind(
    options.snapshots,
  );
  const loadPayloadEvidence = options.loadPayloadEvidence.bind(options);
  return Object.freeze({
    async load(
      input: Parameters<CheckpointEvidenceSourceV1["load"]>[0],
      callOptions: Parameters<CheckpointEvidenceSourceV1["load"]>[1],
    ) {
      const snapshot = await readSnapshot();
      const evidence = await loadPayloadEvidence(snapshot, callOptions.signal);
      evidence.assertSnapshot(snapshot);
      const currentBySeq = new Map(
        snapshot.entries.map((entry) => [entry.seq, entry.fact]),
      );
      const resolved: CheckpointResolvedPayloadV1[] = [];
      for (const source of input.sourceEntries) {
        const current = currentBySeq.get(source.seq);
        if (
          !current ||
          JSON.stringify(current) !== JSON.stringify(source.fact)
        ) {
          throw new Error(
            "Checkpoint source changed before payload resolution",
          );
        }
        const occurrence = payloadOccurrence(source.seq, source.fact);
        if (!occurrence) continue;
        resolved.push(
          Object.freeze({
            carrierSeq: source.seq,
            value: evidence.requirePayload({
              snapshot,
              location: occurrence.location,
              payload: occurrence.payload,
            }),
          }),
        );
      }
      return projectCheckpointEvidenceV1(input.sourceEntries, resolved);
    },
  });
}

function payloadOccurrence(
  seq: number,
  fact: InputFactV1,
):
  | Readonly<{
      location: Parameters<
        VerifiedCanonicalPayloadEvidenceV1["requirePayload"]
      >[0]["location"];
      payload: Parameters<
        VerifiedCanonicalPayloadEvidenceV1["requirePayload"]
      >[0]["payload"];
    }>
  | undefined {
  if (fact.type === "model.settled" && fact.response) {
    return {
      location: {
        kind: "model_response",
        carrierType: "model.settled",
        carrierSeq: seq,
        modelCallId: fact.modelCallId,
      },
      payload: fact.response,
    };
  }
  if (fact.type === "tool.settled" && fact.observation?.payload) {
    return {
      location: {
        kind: "tool_observation",
        carrierType: "tool.settled",
        carrierSeq: seq,
        callId: fact.callId,
      },
      payload: fact.observation.payload,
    };
  }
  if (fact.type === "context.checkpoint_recorded") {
    return {
      location: {
        kind: "task_checkpoint",
        carrierType: "context.checkpoint_recorded",
        carrierSeq: seq,
        checkpointId: fact.checkpointId,
        ...(fact.distillationClaimId === undefined
          ? {}
          : { distillationClaimId: fact.distillationClaimId }),
      },
      payload: fact.checkpoint,
    };
  }
  return undefined;
}
