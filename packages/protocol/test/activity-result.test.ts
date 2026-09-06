import { expect, test } from "bun:test";
import { parseRunJournalPrefixV1 } from "../src/index.js";

function prefix(result?: unknown) {
  return [
    { type: "attempt.started", goalHash: "g", configHash: "c" },
    {
      type: "runtime.activity_started",
      activityId: "stage",
      activityKind: "collaboration_child",
      label: "stage",
      startedAt: 1,
    },
    {
      type: "runtime.activity_settled",
      activityId: "stage",
      status: "completed",
      settledAt: 2,
      summary: "checked",
      ...(result === undefined ? {} : { result }),
    },
  ].map((fact, index) => ({
    schemaVersion: "paw.run-journal.v1",
    sessionId: "s",
    runId: "r",
    seq: index + 1,
    ts: index,
    record: { kind: "input_fact", fact },
  }));
}
test("activity results are optional bounded durable JSON and retain their activity binding", () => {
  expect(parseRunJournalPrefixV1(prefix())).toHaveLength(3);
  const evidence = {
    schemaVersion: "paw.stage-result.v1",
    callId: "call",
    audit: { status: "verified", inspected: [] },
  };
  const parsed = parseRunJournalPrefixV1(prefix(evidence));
  expect(parsed[2]?.record).toMatchObject({ fact: { result: evidence } });
  expect(() =>
    parseRunJournalPrefixV1(prefix({ invalid: () => undefined })),
  ).toThrow();
  expect(() =>
    parseRunJournalPrefixV1(prefix({ text: "x".repeat(32001) })),
  ).toThrow("too large");
  const missing = prefix(evidence);
  missing.splice(1, 1);
  const settlement = missing[1];
  if (!settlement) throw new Error("fixture");
  settlement.seq = 2;
  expect(() => parseRunJournalPrefixV1(missing)).toThrow("has no start");
});
