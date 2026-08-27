import fs from "node:fs";

import type { InputFactV1 } from "@paw/protocol";
import {
  FileRunSessionV1,
  acquireFileSessionExecutionLeaseV1,
} from "../../src/index.js";

const [
  mode,
  workspaceRoot,
  sessionId,
  runId,
  ownerId,
  nowText,
  ttlText,
  baseTailText,
  basePrefixHash,
  readyPath,
  goPath,
] = process.argv.slice(2);

if (
  !mode ||
  !workspaceRoot ||
  !sessionId ||
  !runId ||
  !ownerId ||
  !nowText ||
  !ttlText ||
  !baseTailText ||
  !basePrefixHash ||
  !readyPath ||
  !goPath
) {
  throw new Error("fenced File Session child arguments are missing");
}

const now = Number(nowText);
const ttlMs = Number(ttlText);
const baseTailSeq = Number(baseTailText);
let artifactPublished = false;
let publishedArtifactFileName: string | undefined;

function waitForBarrier(filePath: string): void {
  while (!fs.existsSync(filePath)) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
  }
}

const acquired = acquireFileSessionExecutionLeaseV1({
  workspaceRoot,
  sessionId,
  runId,
  ownerId,
  ttlMs,
  baseTailSeq,
  basePrefixHash,
  clock: () => now,
  ...(mode === "compete"
    ? {
        beforeTransitionPublish(attempt) {
          if (attempt.kind !== "claim") return;
          fs.writeFileSync(readyPath, "ready\n", "utf8");
          waitForBarrier(goPath);
        },
      }
    : {}),
});

if (acquired.status !== "acquired") {
  process.stdout.write(
    `${JSON.stringify(
      acquired.status === "busy"
        ? {
            status: "busy",
            fencingToken: acquired.fencingToken,
            artifactPublished,
          }
        : {
            status: "anchor_conflict",
            head: acquired.head,
            artifactPublished,
          },
    )}\n`,
  );
  process.exit(0);
}

if (mode === "anchor_probe") {
  process.stdout.write(
    `${JSON.stringify({
      status: "acquired",
      fencingToken: acquired.lease.fencingToken,
      artifactPublished,
    })}\n`,
  );
  process.exit(0);
}

const hooks = {
  afterArtifactPublished(attempt: { artifactFileName: string }): void {
    artifactPublished = true;
    publishedArtifactFileName = attempt.artifactFileName;
    if (mode !== "pause_after_artifact") return;
    fs.writeFileSync(readyPath, `${attempt.artifactFileName}\n`, "utf8");
    waitForBarrier(goPath);
  },
  afterJournalLinearized(): void {
    if (mode === "crash_after_journal") process.exit(23);
  },
};

const session = new FileRunSessionV1({
  workspaceRoot,
  sessionId,
  runId,
  executionLease: acquired.lease,
  clock: () => now,
  commitHooks: hooks,
});

const fact: InputFactV1 = {
  type: "attempt.started",
  goalHash: `goal-${ownerId}`,
  configHash: `config-${ownerId}`,
};

try {
  await session.appendInputFacts([fact]);
  session.close();
  process.stdout.write(
    `${JSON.stringify({
      status: "committed",
      fencingToken: acquired.lease.fencingToken,
      artifactPublished,
      artifactFileName: publishedArtifactFileName,
    })}\n`,
  );
} catch (error) {
  session.close();
  process.stdout.write(
    `${JSON.stringify({
      status: acquired.lease.signal.aborted ? "lost" : "error",
      error: error instanceof Error ? error.message : String(error),
      artifactPublished,
      artifactFileName: publishedArtifactFileName,
    })}\n`,
  );
}
