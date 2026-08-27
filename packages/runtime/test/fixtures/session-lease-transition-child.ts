import fs from "node:fs";

import {
  EMPTY_RUN_JOURNAL_PREFIX_HASH_V1,
  acquireFileSessionExecutionLeaseV1,
} from "../../src/session/session-execution-lease.js";

const [mode, workspaceRoot, sessionId, runId, readyPath, goPath, claimedPath] =
  process.argv.slice(2);
if (
  !mode ||
  !workspaceRoot ||
  !sessionId ||
  !runId ||
  !readyPath ||
  !goPath ||
  !claimedPath
) {
  throw new Error("session lease transition child arguments are missing");
}

let now = mode === "takeover" ? 100 : 0;
const waitForFile = async (filePath: string): Promise<void> => {
  while (!fs.existsSync(filePath)) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
};
const pauseAtTransition = (): void => {
  fs.writeFileSync(readyPath, "ready\n", "utf8");
  while (!fs.existsSync(goPath)) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
  }
};

if (mode === "takeover") {
  const result = acquireFileSessionExecutionLeaseV1({
    workspaceRoot,
    sessionId,
    runId,
    ownerId: `${runId}-takeover-owner`,
    ttlMs: 100,
    baseTailSeq: 0,
    basePrefixHash: EMPTY_RUN_JOURNAL_PREFIX_HASH_V1,
    clock: () => now,
    beforeTransitionPublish: pauseAtTransition,
  });
  process.stdout.write(
    `${JSON.stringify(
      result.status === "acquired"
        ? { status: "acquired", token: result.lease.fencingToken }
        : result.status === "busy"
          ? { status: "busy", token: result.fencingToken }
          : { status: "anchor_conflict", head: result.head },
    )}\n`,
  );
} else {
  const acquired = acquireFileSessionExecutionLeaseV1({
    workspaceRoot,
    sessionId,
    runId,
    ownerId: `${runId}-owner`,
    ttlMs: 100,
    baseTailSeq: 0,
    basePrefixHash: EMPTY_RUN_JOURNAL_PREFIX_HASH_V1,
    clock: () => now,
    beforeTransitionPublish: (attempt) => {
      if (attempt.kind !== "claim") pauseAtTransition();
    },
  });
  if (acquired.status !== "acquired")
    throw new Error("owner failed to acquire");
  fs.writeFileSync(claimedPath, "claimed\n", "utf8");
  await waitForFile(`${claimedPath}.act`);
  now = 99;
  if (mode === "renew") {
    try {
      await acquired.lease.renew();
      process.stdout.write(`${JSON.stringify({ status: "renewed" })}\n`);
    } catch {
      process.stdout.write(`${JSON.stringify({ status: "lost" })}\n`);
    }
  } else if (mode === "release") {
    process.stdout.write(
      `${JSON.stringify({ status: await acquired.lease.release() })}\n`,
    );
  } else if (mode === "commit") {
    const artifactHash = "c".repeat(64);
    const result = await acquired.lease.linearizeJournalBatch({
      commitId: "commit-1",
      expectedHead: {
        tailSeq: 0,
        prefixHash: EMPTY_RUN_JOURNAL_PREFIX_HASH_V1,
      },
      nextHead: { tailSeq: 1, prefixHash: "d".repeat(64) },
      batchStartSeq: 1,
      batchEndSeq: 1,
      artifactId: artifactHash,
      artifactFileName: `0000000000000001-0000000000000001-${artifactHash}.json`,
      artifactContentHash: artifactHash,
    });
    process.stdout.write(`${JSON.stringify({ status: result.status })}\n`);
  } else {
    throw new Error(`unknown transition mode: ${mode}`);
  }
}
