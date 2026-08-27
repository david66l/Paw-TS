import fs from "node:fs";

import {
  EMPTY_RUN_JOURNAL_PREFIX_HASH_V1,
  acquireFileSessionExecutionLeaseV1,
} from "../../src/session/session-execution-lease.js";

const [workspaceRoot, sessionId, runId, readyPath, barrierPath] =
  process.argv.slice(2);
if (!workspaceRoot || !sessionId || !runId || !readyPath || !barrierPath) {
  throw new Error("session lease child arguments are missing");
}

fs.writeFileSync(readyPath, "ready\n", "utf8");
while (!fs.existsSync(barrierPath)) {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

const result = acquireFileSessionExecutionLeaseV1({
  workspaceRoot,
  sessionId,
  runId,
  ttlMs: 60_000,
  baseTailSeq: 0,
  basePrefixHash: EMPTY_RUN_JOURNAL_PREFIX_HASH_V1,
});
if (result.status === "anchor_conflict") {
  throw new Error("unexpected journal anchor conflict");
}
process.stdout.write(
  `${JSON.stringify(
    result.status === "acquired"
      ? {
          status: result.status,
          token: result.lease.fencingToken,
          ownerId: result.lease.ownerId,
        }
      : {
          status: result.status,
          token: result.fencingToken,
          ownerId: result.ownerId,
        },
  )}\n`,
);
