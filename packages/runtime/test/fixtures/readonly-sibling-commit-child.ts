import {
  EMPTY_RUN_JOURNAL_PREFIX_HASH_V1,
  FileRunSessionV1,
  acquireFileSessionExecutionLeaseV1,
} from "../../src/index.js";

const [workspaceRoot, sessionId, runId] = process.argv.slice(2);
if (!workspaceRoot || !sessionId || !runId) {
  throw new Error("workspaceRoot, sessionId, and runId are required");
}

const acquired = acquireFileSessionExecutionLeaseV1({
  workspaceRoot,
  sessionId,
  runId,
  ttlMs: 60_000,
  baseTailSeq: 0,
  basePrefixHash: EMPTY_RUN_JOURNAL_PREFIX_HASH_V1,
});
if (acquired.status !== "acquired") {
  throw new Error(`sibling lease was not acquired: ${acquired.status}`);
}

const session = new FileRunSessionV1({
  workspaceRoot,
  sessionId,
  runId,
  executionLease: acquired.lease,
});
await session.appendInputFacts([
  {
    type: "attempt.started",
    goalHash: "sibling-goal-hash",
    configHash: "sibling-config-hash",
  },
  {
    type: "input.promoted",
    inputId: "sibling-input",
    delivery: "initial",
    content: "sibling goal",
    contentHash: "sibling-goal-hash",
  },
]);
session.close();
if ((await acquired.lease.release()) !== "released") {
  throw new Error("sibling lease was not released");
}
