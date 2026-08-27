import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  DerivedDecisionV1,
  InputFactV1,
  RunJournalEnvelopeV1,
} from "@paw/protocol";
import {
  RUN_JOURNAL_SCHEMA_VERSION_V1,
  parseRunJournalPrefixV1,
} from "@paw/protocol";
import {
  EMPTY_RUN_JOURNAL_PREFIX_HASH_V1,
  FileRunSessionV1,
  type FileSessionExecutionLeaseV1,
  SessionExecutionLeaseLostError,
  acquireFileSessionExecutionLeaseV1,
  readFileSessionJournalCommitIndexV1,
} from "../src/index.js";

const SESSION_ID = "fencing-session";
const RUN_ID = "fencing-run";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("fenced FileRunSession hard gates", () => {
  test("two real processes on the same empty head produce one commit and no loser artifact", async () => {
    const root = tempRoot();
    const readyOne = path.join(root, "ready-one");
    const readyTwo = path.join(root, "ready-two");
    const barrier = path.join(root, "claim-go");
    const first = runChild(
      childArgs("compete", root, "owner-one", 0, 100, 0, readyOne, barrier),
    );
    const second = runChild(
      childArgs("compete", root, "owner-two", 0, 100, 0, readyTwo, barrier),
    );
    await waitFor(() => fs.existsSync(readyOne) && fs.existsSync(readyTwo));
    fs.writeFileSync(barrier, "go\n", "utf8");

    const results = (await Promise.all([first, second])).map(parseChildResult);
    expect(results.filter(({ status }) => status === "committed")).toHaveLength(
      1,
    );
    expect(results.filter(({ status }) => status === "busy")).toHaveLength(1);
    expect(
      results.find(({ status }) => status === "busy")?.artifactPublished,
    ).toBeFalse();

    const index = commitIndex(root);
    expect(index.commits).toHaveLength(1);
    expect(artifactFiles(root)).toHaveLength(1);
    assertCommittedPrefix(root);
  });

  test("a takeover commits while the stale owner's published artifact stays orphaned", async () => {
    const root = tempRoot();
    const paused = path.join(root, "artifact-paused");
    const resume = path.join(root, "artifact-resume");
    const predecessor = runChild(
      childArgs(
        "pause_after_artifact",
        root,
        "owner-old",
        0,
        10,
        0,
        paused,
        resume,
      ),
    );
    await waitFor(() => fs.existsSync(paused));
    const staleArtifact = fs.readFileSync(paused, "utf8").trim();

    const successor = parseChildResult(
      await runChild(
        childArgs("commit", root, "owner-new", 10, 10, 0, "-", "-"),
      ),
    );
    expect(successor.status).toBe("committed");
    fs.writeFileSync(resume, "go\n", "utf8");
    const stale = parseChildResult(await predecessor);
    expect(stale.status).toBe("lost");

    const index = commitIndex(root);
    expect(index.commits).toHaveLength(1);
    expect(index.commits[0]?.artifactFileName).not.toBe(staleArtifact);
    expect(artifactFiles(root).map((file) => path.basename(file))).toContain(
      staleArtifact,
    );
    expect(artifactFiles(root)).toHaveLength(2);
    assertCommittedPrefix(root);
  });

  test("a committed predecessor makes a successor with the old anchor conflict", async () => {
    const root = tempRoot();
    const predecessor = parseChildResult(
      await runChild(
        childArgs("commit", root, "owner-old", 0, 10, 0, "-", "-"),
      ),
    );
    expect(predecessor.status).toBe("committed");

    const staleAnchor = parseChildResult(
      await runChild(
        childArgs("anchor_probe", root, "owner-new", 10, 10, 0, "-", "-"),
      ),
    );
    expect(staleAnchor.status).toBe("anchor_conflict");
    expect(staleAnchor.head).toEqual(commitIndex(root).head);
    expect(commitIndex(root).commits).toHaveLength(1);
    expect(artifactFiles(root)).toHaveLength(1);
  });

  test("missing referenced artifacts fail closed", async () => {
    const { root, lease } = await committedRoot();
    fs.rmSync(artifactFiles(root)[0] as string);
    expect(() => open(root, lease)).toThrow("artifact is missing");
  });

  test.skipIf(process.platform === "win32")(
    "a referenced artifact symlink fails closed on platforms with unprivileged file symlinks",
    async () => {
      const { root, lease } = await committedRoot();
      const artifact = artifactFiles(root)[0] as string;
      const outside = path.join(root, "outside-artifact.json");
      fs.copyFileSync(artifact, outside);
      fs.rmSync(artifact);
      fs.symlinkSync(outside, artifact, "file");
      expect(() => open(root, lease)).toThrow("symbolic link");
    },
  );

  test("a referenced artifact with an external hardlink fails closed", async () => {
    const { root, lease } = await committedRoot();
    const artifact = artifactFiles(root)[0] as string;
    fs.linkSync(artifact, path.join(root, "external-artifact-hardlink.json"));
    expect(() => open(root, lease)).toThrow("hardlink");
  });

  test("cross-run identity, envelope sequence, and prefix tampering fail closed", async () => {
    for (const tamper of ["cross_run", "sequence", "prefix"] as const) {
      const root = tempRoot();
      const lease = acquire(root, 0, 100, 0);
      open(root, lease).close();
      await commitTamperedArtifact(root, lease, tamper);
      expect(() => open(root, lease)).toThrow();
    }
  });

  test("an expired lease rejects every public read, write, and snapshot entry without mutation", async () => {
    const operations: Array<{
      readonly name: string;
      readonly run: (session: FileRunSessionV1) => unknown;
    }> = [
      { name: "recovery", run: (session) => session.readRecoveryInfo() },
      {
        name: "coordinator identity",
        run: (session) => session.readCoordinatorOwnershipIdentity(),
      },
      { name: "snapshot", run: (session) => session.createRecoverySnapshot() },
      { name: "read", run: (session) => session.readInputSnapshot() },
      {
        name: "append",
        run: (session) => session.appendInputFacts([attemptStarted("append")]),
      },
      {
        name: "input CAS",
        run: (session) =>
          session.commitInputFacts(0, [attemptStarted("input-cas")]),
      },
      {
        name: "decision CAS",
        run: (session) => session.commitDerivedDecision(0, decision(1)),
      },
      {
        name: "decision and input CAS",
        run: (session) =>
          session.commitDecisionAndInputFacts(0, decision(1), [
            attemptStarted("decision-input"),
          ]),
      },
    ];

    for (const operation of operations) {
      const root = tempRoot();
      let now = 0;
      const lease = acquire(root, now, 10, 0, () => now);
      const session = open(root, lease, () => now);
      now = 10;
      const before = rawTree(root);
      await expect(
        Promise.resolve().then(() => operation.run(session)),
      ).rejects.toBeInstanceOf(SessionExecutionLeaseLostError);
      expect(rawTree(root), operation.name).toEqual(before);
      session.close();
    }
  });

  test("a child crash after journal linearization reopens the committed batch exactly once", async () => {
    const root = tempRoot();
    await runChildExpectExit(
      childArgs("crash_after_journal", root, "owner-crash", 0, 10, 0, "-", "-"),
      23,
    );
    const before = commitIndex(root);
    expect(before.commits).toHaveLength(1);
    expect(before.head.tailSeq).toBe(1);

    const successor = acquire(
      root,
      10,
      10,
      before.head.tailSeq,
      () => 10,
      before.head.prefixHash,
      "owner-recovery",
    );
    const recovered = open(root, successor, () => 10);
    const snapshot = await recovered.readInputSnapshot();
    expect(snapshot.tailSeq).toBe(1);
    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.entries[0]?.seq).toBe(1);
    recovered.close();
    expect(commitIndex(root).commits).toHaveLength(1);
    expect(artifactFiles(root)).toHaveLength(1);
    assertCommittedPrefix(root);
  });
});

interface ChildResult {
  readonly status:
    | "committed"
    | "busy"
    | "lost"
    | "error"
    | "anchor_conflict"
    | "acquired";
  readonly artifactPublished: boolean;
  readonly artifactFileName?: string;
  readonly head?: { readonly tailSeq: number; readonly prefixHash: string };
}

function childArgs(
  mode: string,
  root: string,
  ownerId: string,
  now: number,
  ttlMs: number,
  baseTailSeq: number,
  readyPath: string,
  goPath: string,
  basePrefixHash = EMPTY_RUN_JOURNAL_PREFIX_HASH_V1,
): string[] {
  return [
    fixture("file-run-session-fencing-child.ts"),
    mode,
    root,
    SESSION_ID,
    RUN_ID,
    ownerId,
    String(now),
    String(ttlMs),
    String(baseTailSeq),
    basePrefixHash,
    readyPath,
    goPath,
  ];
}

function parseChildResult(value: string): ChildResult {
  return JSON.parse(value) as ChildResult;
}

function acquire(
  root: string,
  now: number,
  ttlMs: number,
  baseTailSeq: number,
  clock: () => number = () => now,
  basePrefixHash = EMPTY_RUN_JOURNAL_PREFIX_HASH_V1,
  ownerId = `owner-${roots.length}-${now}`,
): FileSessionExecutionLeaseV1 {
  const result = acquireFileSessionExecutionLeaseV1({
    workspaceRoot: root,
    sessionId: SESSION_ID,
    runId: RUN_ID,
    ownerId,
    ttlMs,
    baseTailSeq,
    basePrefixHash,
    clock,
  });
  if (result.status !== "acquired") {
    throw new Error(`expected acquired lease, got ${result.status}`);
  }
  return result.lease;
}

function open(
  root: string,
  lease: FileSessionExecutionLeaseV1,
  clock: () => number = () => 0,
): FileRunSessionV1 {
  return new FileRunSessionV1({
    workspaceRoot: root,
    sessionId: SESSION_ID,
    runId: RUN_ID,
    executionLease: lease,
    clock,
  });
}

async function committedRoot(): Promise<{
  readonly root: string;
  readonly lease: FileSessionExecutionLeaseV1;
}> {
  const root = tempRoot();
  const lease = acquire(root, 0, 100, 0);
  const session = open(root, lease);
  await session.appendInputFacts([attemptStarted("baseline")]);
  session.close();
  return { root, lease };
}

async function commitTamperedArtifact(
  root: string,
  lease: FileSessionExecutionLeaseV1,
  tamper: "cross_run" | "sequence" | "prefix",
): Promise<void> {
  const artifactRunId = tamper === "cross_run" ? "foreign-run" : RUN_ID;
  const envelopeRunId = artifactRunId;
  const envelopeSeq = tamper === "sequence" ? 2 : 1;
  const envelope: RunJournalEnvelopeV1 = {
    schemaVersion: RUN_JOURNAL_SCHEMA_VERSION_V1,
    sessionId: SESSION_ID,
    runId: envelopeRunId,
    seq: envelopeSeq,
    ts: 0,
    record: { kind: "input_fact", fact: attemptStarted(tamper) },
  };
  const artifact = {
    schemaVersion: "paw.file-run-session.batch-artifact.v2",
    sessionId: SESSION_ID,
    runId: artifactRunId,
    previousTailSeq: 0,
    previousPrefixHash: EMPTY_RUN_JOURNAL_PREFIX_HASH_V1,
    startSeq: 1,
    endSeq: 1,
    envelopes: [envelope],
  };
  const content = `${JSON.stringify(artifact)}\n`;
  const artifactHash = hashBytes(content);
  const artifactFileName = `0000000000000001-0000000000000001-${artifactHash}.json`;
  fs.writeFileSync(
    path.join(artifactDirectory(root), artifactFileName),
    content,
    "utf8",
  );
  const result = await lease.linearizeJournalBatch({
    commitId: artifactHash,
    expectedHead: {
      tailSeq: 0,
      prefixHash: EMPTY_RUN_JOURNAL_PREFIX_HASH_V1,
    },
    nextHead: {
      tailSeq: 1,
      prefixHash: tamper === "prefix" ? "f".repeat(64) : hashPrefix([envelope]),
    },
    batchStartSeq: 1,
    batchEndSeq: 1,
    artifactId: artifactHash,
    artifactFileName,
    artifactContentHash: artifactHash,
  });
  expect(result.status).toBe("committed");
}

function attemptStarted(label: string): InputFactV1 {
  return {
    type: "attempt.started",
    goalHash: `goal-${label}`,
    configHash: `config-${label}`,
  };
}

function decision(inputThroughSeq: number): DerivedDecisionV1 {
  return {
    type: "control.decided",
    reducerVersion: "fencing-test-reducer-v1",
    inputThroughSeq,
    stateHash: `state-${inputThroughSeq}`,
    action: { kind: "continue", reasonCode: "continue" },
  };
}

function commitIndex(root: string) {
  return readFileSessionJournalCommitIndexV1({
    workspaceRoot: root,
    sessionId: SESSION_ID,
    runId: RUN_ID,
  });
}

function assertCommittedPrefix(root: string): void {
  const index = commitIndex(root);
  const envelopes = index.commits.flatMap((commit) => {
    const artifact = JSON.parse(
      fs.readFileSync(
        path.join(artifactDirectory(root), commit.artifactFileName),
        "utf8",
      ),
    ) as { envelopes: RunJournalEnvelopeV1[] };
    return artifact.envelopes;
  });
  expect(parseRunJournalPrefixV1(envelopes)).toHaveLength(index.head.tailSeq);
  expect(hashPrefix(envelopes)).toBe(index.head.prefixHash);
}

function hashPrefix(envelopes: readonly RunJournalEnvelopeV1[]): string {
  return hashBytes(JSON.stringify(envelopes));
}

function hashBytes(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function artifactDirectory(root: string): string {
  return path.join(
    root,
    ".paw",
    "paw-next",
    "sessions",
    stablePathKey(SESSION_ID),
    stablePathKey(RUN_ID),
    "journal-artifacts",
  );
}

function artifactFiles(root: string): string[] {
  const directory = artifactDirectory(root);
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory)
    .filter((name) => /^\d{16}-\d{16}-[0-9a-f]{64}\.json$/.test(name))
    .sort()
    .map((name) => path.join(directory, name));
}

function stablePathKey(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paw-fenced-session-"));
  roots.push(root);
  return root;
}

function fixture(name: string): string {
  return path.join(import.meta.dir, "fixtures", name);
}

function rawTree(root: string): readonly string[] {
  const values: string[] = [];
  const visit = (folder: string): void => {
    for (const name of fs.readdirSync(folder).sort()) {
      const full = path.join(folder, name);
      const relative = path.relative(root, full).replaceAll("\\", "/");
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) {
        values.push(`link:${relative}->${fs.readlinkSync(full)}`);
      } else if (stat.isDirectory()) {
        values.push(`dir:${relative}`);
        visit(full);
      } else {
        values.push(`file:${relative}:${hashBytes(fs.readFileSync(full))}`);
      }
    }
  };
  visit(root);
  return values;
}

function runChild(args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...args], {
      cwd: path.resolve(import.meta.dir, ".."),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`fenced child exited ${code}: ${stderr}`));
    });
  });
}

function runChildExpectExit(
  args: readonly string[],
  expectedCode: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...args], {
      cwd: path.resolve(import.meta.dir, ".."),
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === expectedCode) resolve();
      else reject(new Error(`fenced crash child exited ${code}: ${stderr}`));
    });
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("child barrier timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
