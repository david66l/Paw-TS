import type { FileSessionExecutionLeaseV1 } from "../../src/index.js";
import {
  EMPTY_RUN_JOURNAL_PREFIX_HASH_V1,
  FileRunSessionV1,
  acquireFileSessionExecutionLeaseV1,
  readFileSessionJournalCommitIndexV1,
} from "../../src/index.js";

const leases = new Map<string, FileSessionExecutionLeaseV1>();

export function openFencedTestSession(
  workspaceRoot: string,
  options: {
    readonly sessionId?: string;
    readonly runId?: string;
    readonly clock?: () => number;
  } = {},
): FileRunSessionV1 {
  const sessionId = options.sessionId ?? "session-1";
  const runId = options.runId ?? "run-1";
  const key = `${workspaceRoot}\0${sessionId}\0${runId}`;
  let lease = leases.get(key);
  if (!lease || lease.signal.aborted) {
    const index = readFileSessionJournalCommitIndexV1({
      workspaceRoot,
      sessionId,
      runId,
    });
    const acquired = acquireFileSessionExecutionLeaseV1({
      workspaceRoot,
      sessionId,
      runId,
      ownerId: `test-owner-${leases.size + 1}`,
      ttlMs: 1_000_000,
      baseTailSeq: index.head.tailSeq,
      basePrefixHash: index.head.prefixHash || EMPTY_RUN_JOURNAL_PREFIX_HASH_V1,
      clock: () => 42,
    });
    if (acquired.status !== "acquired") {
      throw new Error(`test lease acquisition failed: ${acquired.status}`);
    }
    lease = acquired.lease;
    leases.set(key, lease);
  }
  return new FileRunSessionV1({
    workspaceRoot,
    sessionId,
    runId,
    executionLease: lease,
    clock: options.clock,
  });
}
