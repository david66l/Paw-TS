import fs from "node:fs";

import {
  EMPTY_RUN_JOURNAL_PREFIX_HASH_V1,
  acquireFileSessionExecutionLeaseV1,
} from "../../src/session/session-execution-lease.js";

const [workspaceRoot, sessionId, readyPath, goPath] = process.argv.slice(2);
if (!workspaceRoot || !sessionId || !readyPath || !goPath) {
  throw new Error("session lease link-window child arguments are missing");
}

const result = acquireFileSessionExecutionLeaseV1({
  workspaceRoot,
  sessionId,
  runId: "publisher-run",
  ownerId: "publisher-owner",
  ttlMs: 60_000,
  baseTailSeq: 0,
  basePrefixHash: EMPTY_RUN_JOURNAL_PREFIX_HASH_V1,
  afterTransitionLink: () => {
    fs.writeFileSync(readyPath, "linked\n", "utf8");
    while (!fs.existsSync(goPath)) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
    }
  },
});

process.stdout.write(`${JSON.stringify({ status: result.status })}\n`);
