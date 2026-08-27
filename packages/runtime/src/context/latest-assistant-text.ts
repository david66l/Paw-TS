import type { SessionInputSnapshot } from "@paw/agent-loop";
import type { InputFactV1, ModelResponseV1 } from "@paw/protocol";
import { parseModelResponseV1 } from "@paw/protocol";

import { assertCanonicalModelResponseCarrierV1 } from "../payload/verified-canonical-payload-index.js";
import type { VerifiedCanonicalPayloadEvidenceV1 } from "../payload/verified-model-response-evidence.js";
import { projectLatestWorkSegmentBoundaryV1 } from "../work-segment-boundary.js";

export interface ProjectLatestAssistantTextOptionsV1 {
  readonly snapshot: SessionInputSnapshot<InputFactV1>;
  readonly providerProtocol: ModelResponseV1["providerProtocol"];
  readonly payloadEvidence?: VerifiedCanonicalPayloadEvidenceV1;
}

/** Read the latest model settlement's canonical assistant text. */
export function projectLatestAssistantTextV1(
  options: ProjectLatestAssistantTextOptionsV1,
): string | undefined {
  if (
    options.providerProtocol !== "openai-compatible" &&
    options.providerProtocol !== "anthropic-compatible"
  ) {
    throw new Error("Latest assistant provider protocol is invalid");
  }
  assertSnapshotOrder(options.snapshot);
  const segmentMarkerSeq =
    projectLatestWorkSegmentBoundaryV1(options.snapshot)?.markerSeq ?? 0;
  for (
    let index = options.snapshot.entries.length - 1;
    index >= 0;
    index -= 1
  ) {
    const entry = options.snapshot.entries[index];
    if (!entry) continue;
    if (entry.seq <= segmentMarkerSeq) return undefined;
    const fact = entry.fact;
    if (fact?.type !== "model.settled") continue;
    if (!fact.response) return undefined;
    const payloadEvidence =
      fact.response.kind === "artifact_ref"
        ? capturePayloadEvidence(options.payloadEvidence)
        : undefined;
    payloadEvidence?.assertSnapshot(options.snapshot);
    const response =
      fact.response.kind === "inline"
        ? parseModelResponseV1(fact.response.value)
        : payloadEvidence?.requireModelResponse({
            snapshot: options.snapshot,
            carrierSeq: entry.seq,
            modelCallId: fact.modelCallId,
            payload: fact.response,
          });
    if (!response) {
      throw new Error(
        "Latest assistant artifact requires exact canonical evidence",
      );
    }
    assertCanonicalModelResponseCarrierV1(fact, response);
    if (response.providerProtocol !== options.providerProtocol) {
      throw new Error("Latest assistant provider protocol mismatch");
    }
    return response.assistantContent;
  }
  return undefined;
}

function assertSnapshotOrder(
  snapshot: SessionInputSnapshot<InputFactV1>,
): void {
  let previousSeq = 0;
  for (const entry of snapshot.entries) {
    if (entry.seq <= previousSeq || entry.seq > snapshot.tailSeq) {
      throw new Error("Latest assistant snapshot order is invalid");
    }
    previousSeq = entry.seq;
  }
  if (
    snapshot.latestInputSeq !== previousSeq ||
    snapshot.tailSeq < snapshot.latestInputSeq
  ) {
    throw new Error("Latest assistant snapshot metadata is invalid");
  }
}

function capturePayloadEvidence(
  evidence: VerifiedCanonicalPayloadEvidenceV1 | undefined,
): VerifiedCanonicalPayloadEvidenceV1 | undefined {
  if (evidence === undefined) return undefined;
  if (
    typeof evidence.assertSnapshot !== "function" ||
    typeof evidence.requireModelResponse !== "function" ||
    typeof evidence.requirePayload !== "function"
  ) {
    throw new Error("Latest assistant payload evidence is invalid");
  }
  return Object.freeze({
    assertSnapshot: evidence.assertSnapshot.bind(evidence),
    requireModelResponse: evidence.requireModelResponse.bind(evidence),
    requirePayload: evidence.requirePayload.bind(evidence),
  });
}
