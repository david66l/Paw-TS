import type { SessionInputSnapshot } from "@paw/agent-loop";
import type { InputFactV1 } from "@paw/protocol";

export interface WorkSegmentBoundaryV1 {
  readonly segmentIndex: number;
  readonly markerSeq: number;
  readonly rootPromotionSeq: number;
  readonly inputId: string;
}

/** Pure current-segment boundary projection from one canonical input snapshot. */
export function projectLatestWorkSegmentBoundaryV1(
  snapshot: SessionInputSnapshot<InputFactV1>,
): WorkSegmentBoundaryV1 | undefined {
  assertSnapshotOrder(snapshot);
  let expectedSegmentIndex = 1;
  let latest: WorkSegmentBoundaryV1 | undefined;
  for (let index = 0; index < snapshot.entries.length; index += 1) {
    const entry = snapshot.entries[index];
    if (!entry || entry.fact.type !== "work.segment_started") continue;
    if (entry.fact.segmentIndex !== expectedSegmentIndex) {
      throw new Error("Work segment snapshot indexes are not contiguous");
    }
    const root = snapshot.entries[index + 1];
    if (
      !root ||
      root.seq !== entry.seq + 1 ||
      root.fact.type !== "input.promoted" ||
      root.fact.inputId !== entry.fact.inputId
    ) {
      throw new Error("Work segment snapshot has no exact root promotion");
    }
    latest = Object.freeze({
      segmentIndex: entry.fact.segmentIndex,
      markerSeq: entry.seq,
      rootPromotionSeq: root.seq,
      inputId: entry.fact.inputId,
    });
    expectedSegmentIndex += 1;
  }
  return latest;
}

function assertSnapshotOrder(
  snapshot: SessionInputSnapshot<InputFactV1>,
): void {
  let previousSeq = 0;
  for (const entry of snapshot.entries) {
    if (entry.seq <= previousSeq || entry.seq > snapshot.tailSeq) {
      throw new Error("Work segment snapshot order is invalid");
    }
    previousSeq = entry.seq;
  }
  if (
    snapshot.latestInputSeq !== previousSeq ||
    snapshot.tailSeq < snapshot.latestInputSeq
  ) {
    throw new Error("Work segment snapshot metadata is invalid");
  }
}
