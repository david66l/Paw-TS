import { createHash } from "node:crypto";
/** Offline journal replay: reads committed data, never executes recorded tools or models. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RunJournalEnvelopeV1 } from "../../packages/protocol/src/index.js";
import {
  EMPTY_RUN_JOURNAL_PREFIX_HASH_V1,
  FileRunSessionV1,
  acquireFileSessionExecutionLeaseV1,
  readCommittedFileRunPrefixV1,
} from "../../packages/runtime/src/index.js";
import { readFileSessionJournalCommitIndexStrictV1 } from "../../packages/runtime/src/session/session-execution-lease.js";

const [sourceRoot, sessionId, runId, output] = process.argv.slice(2);
if (!sourceRoot || !sessionId || !runId || !output) {
  throw new Error(
    "Usage: session-replay-profile.ts <source-workspace> <session-id> <run-id> <output.json>",
  );
}
const sourceIndex = readFileSessionJournalCommitIndexStrictV1({
  workspaceRoot: sourceRoot,
  sessionId,
  runId,
});
const prefix = readCommittedFileRunPrefixV1({
  workspaceRoot: sourceRoot,
  sessionId,
  runId,
  expectedHead: sourceIndex.head,
});
const key = (text: string) => createHash("sha256").update(text).digest("hex");
const artifacts = path.join(
  sourceRoot,
  ".paw/paw-next/sessions",
  key(sessionId),
  key(runId),
  "journal-artifacts",
);
const batches = fs
  .readdirSync(artifacts)
  .filter((name) => name.endsWith(".json"))
  .map(
    (name) =>
      JSON.parse(fs.readFileSync(path.join(artifacts, name), "utf8")) as {
        startSeq: number;
        endSeq: number;
        envelopes: RunJournalEnvelopeV1[];
      },
  )
  .sort((a, b) => a.startSeq - b.startSeq);
// Only accept a unique, fully committed batch partition. Orphans are not replayed.
let through = 0;
for (const batch of batches) {
  if (
    batch.startSeq !== through + 1 ||
    JSON.stringify(batch.envelopes) !==
      JSON.stringify(prefix.slice(through, batch.endSeq))
  ) {
    throw new Error(
      "Source artifacts are not a unique committed prefix partition",
    );
  }
  through = batch.endSeq;
}
if (through !== prefix.length) throw new Error("Incomplete source partition");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "paw-session-profile-"));
const acquired = acquireFileSessionExecutionLeaseV1({
  workspaceRoot: root,
  sessionId,
  runId,
  ownerId: "offline-profile",
  ttlMs: 1_000_000,
  baseTailSeq: 0,
  basePrefixHash: EMPTY_RUN_JOURNAL_PREFIX_HASH_V1,
  clock: () => 42,
});
if (acquired.status !== "acquired")
  throw new Error("Cannot acquire replay lease");
const session = new FileRunSessionV1({
  workspaceRoot: root,
  sessionId,
  runId,
  executionLease: acquired.lease,
  clock: () => 42,
});
const operations = [
  "readFileSync",
  "lstatSync",
  "readdirSync",
  "realpathSync",
  "fsyncSync",
  "writeFileSync",
  "linkSync",
] as const;
const originals = new Map<string, (...args: unknown[]) => unknown>();
const io: Record<string, { calls: number; ms: number }> = {};
for (const name of operations) {
  const original = fs[name] as unknown as (...args: unknown[]) => unknown;
  originals.set(name, original);
  const metric = { calls: 0, ms: 0 };
  io[name] = metric;
  Reflect.set(
    fs,
    name,
    Object.assign((...args: unknown[]) => {
      const started = performance.now();
      try {
        return original.apply(fs, args);
      } finally {
        metric.calls++;
        metric.ms += performance.now() - started;
      }
    }, original),
  );
}
const measurements: {
  batch: number;
  tailSeq: number;
  readMs: number;
  commitMs: number;
}[] = [];
const started = performance.now();
try {
  for (const [index, batch] of batches.entries()) {
    const beforeRead = performance.now();
    const snapshot = await session.readInputSnapshot();
    const beforeCommit = performance.now();
    const records = batch.envelopes.map((entry) => entry.record);
    const first = records[0];
    if (!first) throw new Error("Empty batch");
    const facts = (selected: typeof records) =>
      selected.map((record) => {
        if (record.kind !== "input_fact")
          throw new Error("Unsupported mixed batch");
        return record.fact;
      });
    if (first.kind === "derived_decision") {
      const status =
        records.length === 1
          ? await session.commitDerivedDecision(
              snapshot.tailSeq,
              first.decision,
            )
          : await session.commitDecisionAndInputFacts(
              snapshot.tailSeq,
              first.decision,
              facts(records.slice(1)),
            );
      if (status !== "committed") throw new Error("Replay conflict");
    } else {
      await session.appendInputFacts(facts(records));
    }
    measurements.push({
      batch: index + 1,
      tailSeq: batch.endSeq,
      readMs: beforeCommit - beforeRead,
      commitMs: performance.now() - beforeCommit,
    });
  }
} finally {
  for (const [name, original] of originals) Reflect.set(fs, name, original);
  session.close();
  await acquired.lease.release();
}
const report = {
  schemaVersion: 1,
  source: {
    sessionId,
    runId,
    envelopes: prefix.length,
    batches: batches.length,
  },
  replayRoot: root,
  elapsedMs: performance.now() - started,
  io,
  measurements,
};
fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ output, elapsedMs: report.elapsedMs, io }));
