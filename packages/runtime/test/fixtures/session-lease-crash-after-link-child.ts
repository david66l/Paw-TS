import {
  EMPTY_RUN_JOURNAL_PREFIX_HASH_V1,
  acquireFileSessionExecutionLeaseV1,
} from "../../src/session/session-execution-lease.js";

const [workspaceRoot, sessionId] = process.argv.slice(2);
if (!workspaceRoot || !sessionId) {
  throw new Error("session lease crash child arguments are missing");
}

acquireFileSessionExecutionLeaseV1({
  workspaceRoot,
  sessionId,
  runId: "crashed-run",
  ownerId: "crashed-owner",
  ttlMs: 100,
  baseTailSeq: 0,
  basePrefixHash: EMPTY_RUN_JOURNAL_PREFIX_HASH_V1,
  clock: () => 0,
  afterTransitionLink: () => process.exit(23),
});

throw new Error("afterTransitionLink did not terminate the process");
