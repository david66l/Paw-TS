import type { ChatMessage } from "@paw/core";
import type { JournalContextAnnotationV1 } from "./journal-context-plan.js";

/** Inserts only between complete timeline units; never inside a tool exchange. */
export function insertJournalContextAnnotationsV1(
  prefix: readonly ChatMessage[],
  units: readonly {
    message: ChatMessage;
    sourceFromSeq: number;
    sourceThroughSeq: number;
  }[],
  annotations: readonly JournalContextAnnotationV1[],
): readonly ChatMessage[] {
  const buckets = new Map<number, ChatMessage[]>();
  const tail: ChatMessage[] = [];
  for (const item of annotations) {
    if (item.placement === "tail") {
      tail.push({ role: "user", content: item.content });
      continue;
    }
    const anchor =
      item.placement === "after_boundary"
        ? units.filter((unit) => unit.sourceThroughSeq <= item.sourceThroughSeq).length - 1
        : units.findIndex(
            (unit) =>
              unit.sourceFromSeq <= item.sourceThroughSeq &&
              unit.sourceThroughSeq >= item.sourceThroughSeq,
          );
    if (anchor < 0 && item.placement === "after_unit") {
      if (item.fallbackContent !== undefined)
        tail.push({ role: "user", content: item.fallbackContent });
      continue;
    }
    const bucket = buckets.get(anchor + 1) ?? [];
    bucket.push({ role: "user", content: item.content });
    buckets.set(anchor + 1, bucket);
  }
  return [
    ...prefix,
    ...(buckets.get(0) ?? []),
    ...units.flatMap((unit, index) => [unit.message, ...(buckets.get(index + 1) ?? [])]),
    ...tail,
  ];
}
