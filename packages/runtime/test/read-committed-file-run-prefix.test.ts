import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";
import {
  EMPTY_RUN_JOURNAL_PREFIX_HASH_V1,
  FileRunSessionV1,
  acquireFileSessionExecutionLeaseV1,
  readCommittedFileRunPrefixV1,
  readFileSessionJournalCommitIndexV1,
} from "../src/index.js";
import { readCommittedFileRunPrefixForTestV1 } from "../src/session/file-run-session.js";

const SESSION_ID = "readonly-session";
const RUN_ID = "readonly-run";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("strict read-only committed File Run prefix", () => {
  test("returns a recursively frozen canonical prefix without acquiring a lease or changing bytes", async () => {
    const fixture = await committedRun();
    const before = rawTree(fixture.root);

    const prefix = readCommittedFileRunPrefixV1(fixture);

    expect(prefix).toHaveLength(2);
    expect(prefix.map((item) => item.seq)).toEqual([1, 2]);
    expect(Object.isFrozen(prefix)).toBe(true);
    expect(Object.isFrozen(prefix[0])).toBe(true);
    expect(Object.isFrozen(prefix[0]?.record)).toBe(true);
    expect(
      Object.isFrozen(
        prefix[0]?.record.kind === "input_fact"
          ? prefix[0].record.fact
          : undefined,
      ),
    ).toBe(true);
    expect(rawTree(fixture.root)).toEqual(before);
  });

  test("accepts owned artifact and metadata publisher links but never cleans them", async () => {
    const fixture = await committedRun();
    const artifact = onlyArtifact(fixture.root);
    const artifactTemp = `${artifact}.tmp-${process.pid}-${randomUUID()}`;
    fs.linkSync(artifact, artifactTemp);
    const metadata = path.join(runDirectory(fixture.root), "metadata.json");
    const metadataTemp = path.join(
      path.dirname(metadata),
      `metadata.json.tmp-${process.pid}-${randomUUID()}`,
    );
    fs.linkSync(metadata, metadataTemp);
    const before = rawTree(fixture.root);

    expect(readCommittedFileRunPrefixV1(fixture)).toHaveLength(2);
    expect(rawTree(fixture.root)).toEqual(before);
    expect(fs.statSync(artifact).nlink).toBe(2);
    expect(fs.statSync(metadata).nlink).toBe(2);
  });

  test("a stale expected head fails without touching committed storage", async () => {
    const fixture = await committedRun();
    const before = rawTree(fixture.root);

    expect(() =>
      readCommittedFileRunPrefixV1({
        ...fixture,
        expectedHead: {
          tailSeq: 0,
          prefixHash: EMPTY_RUN_JOURNAL_PREFIX_HASH_V1,
        },
      }),
    ).toThrow(/stale/i);
    expect(rawTree(fixture.root)).toEqual(before);
  });

  test("rejects a regular file workspace root without changing it", () => {
    const container = workspace();
    const fileRoot = path.join(container, "not-a-workspace");
    fs.writeFileSync(fileRoot, "unchanged\n");
    const before = fs.readFileSync(fileRoot);

    expect(() =>
      readCommittedFileRunPrefixV1({
        workspaceRoot: fileRoot,
        sessionId: SESSION_ID,
        runId: RUN_ID,
        expectedHead: {
          tailSeq: 1,
          prefixHash: "a".repeat(64),
        },
      }),
    ).toThrow(/workspace root.*directory/i);
    expect(fs.readFileSync(fileRoot)).toEqual(before);
  });

  test("a sibling run commit during the read invalidates the full Session inventory", async () => {
    const fixture = await committedRun();
    const artifact = onlyArtifact(fixture.root);
    const publisherTemp = `${artifact}.tmp-${process.pid}-${randomUUID()}`;
    fs.linkSync(artifact, publisherTemp);

    expect(() =>
      readCommittedFileRunPrefixForTestV1({
        ...fixture,
        afterAuthorityInventoryRead() {
          const child = spawnSync(
            process.execPath,
            [
              path.join(
                import.meta.dir,
                "fixtures",
                "readonly-sibling-commit-child.ts",
              ),
              fixture.root,
              fixture.sessionId,
              "sibling-run",
            ],
            { encoding: "utf8" },
          );
          if (child.status !== 0) {
            throw new Error(
              `sibling commit fixture failed: ${child.stderr || child.stdout}`,
            );
          }
        },
      }),
    ).toThrow(/inventory changed/i);

    expect(fs.existsSync(publisherTemp)).toBe(true);
    expect(fs.statSync(artifact).nlink).toBe(2);
    const sibling = readFileSessionJournalCommitIndexV1({
      workspaceRoot: fixture.root,
      sessionId: fixture.sessionId,
      runId: "sibling-run",
    });
    expect(sibling.head.tailSeq).toBe(2);
    expect(sibling.commits).toHaveLength(1);
  });

  test("missing, hash-damaged, and sequence-damaged committed artifacts fail closed", async () => {
    const missing = await committedRun();
    fs.renameSync(
      onlyArtifact(missing.root),
      path.join(missing.root, "missing-artifact"),
    );
    assertReadFailsWithoutMutation(missing, /missing/i);

    const damaged = await committedRun();
    fs.appendFileSync(onlyArtifact(damaged.root), "damage");
    assertReadFailsWithoutMutation(damaged, /hash|canonical/i);

    const badSequence = await malformedSequenceRun();
    assertReadFailsWithoutMutation(badSequence, /range|seq/i);
  });

  test("external hardlinks, artifact symlinks, and artifact-directory junctions fail closed", async () => {
    const linked = await committedRun();
    fs.linkSync(
      onlyArtifact(linked.root),
      path.join(linked.root, "external-hardlink"),
    );
    assertReadFailsWithoutMutation(linked, /hardlink/i);

    const symbolic = await committedRun();
    const symbolicArtifact = onlyArtifact(symbolic.root);
    const symbolicTarget = path.join(symbolic.root, "artifact-copy");
    fs.copyFileSync(symbolicArtifact, symbolicTarget);
    fs.rmSync(symbolicArtifact);
    if (trySymlink(symbolicTarget, symbolicArtifact, "file")) {
      assertReadFailsWithoutMutation(symbolic, /symbolic|symlink/i);
    }

    const redirected = await committedRun();
    const artifacts = path.dirname(onlyArtifact(redirected.root));
    const outside = path.join(redirected.root, "outside-artifacts");
    fs.renameSync(artifacts, outside);
    fs.symlinkSync(
      outside,
      artifacts,
      process.platform === "win32" ? "junction" : "dir",
    );
    assertReadFailsWithoutMutation(redirected, /real directory|symbolic/i);
  });

  test("metadata identity drift fails closed and does not get repaired", async () => {
    const fixture = await committedRun();
    const metadata = path.join(runDirectory(fixture.root), "metadata.json");
    fs.writeFileSync(
      metadata,
      `${JSON.stringify({
        schemaVersion: "paw.file-run-session.v2",
        sessionId: SESSION_ID,
        runId: "other-run",
      })}\n`,
    );
    assertReadFailsWithoutMutation(fixture, /metadata/i);
  });
});

interface PrefixFixture {
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly expectedHead: {
    readonly tailSeq: number;
    readonly prefixHash: string;
  };
  readonly root: string;
}

async function committedRun(): Promise<PrefixFixture> {
  const root = workspace();
  const lease = acquired(root);
  const session = new FileRunSessionV1({
    workspaceRoot: root,
    sessionId: SESSION_ID,
    runId: RUN_ID,
    executionLease: lease,
  });
  await session.appendInputFacts([
    {
      type: "attempt.started",
      goalHash: "goal-hash",
      configHash: "config-hash",
    },
    {
      type: "input.promoted",
      inputId: "input-1",
      delivery: "initial",
      content: "goal",
      contentHash: "goal-hash",
    },
  ]);
  session.close();
  expect(await lease.release()).toBe("released");
  return fixture(root);
}

async function malformedSequenceRun(): Promise<PrefixFixture> {
  const root = workspace();
  const lease = acquired(root);
  new FileRunSessionV1({
    workspaceRoot: root,
    sessionId: SESSION_ID,
    runId: RUN_ID,
    executionLease: lease,
  }).close();
  const envelope = {
    schemaVersion: "paw.run-journal.v1" as const,
    sessionId: SESSION_ID,
    runId: RUN_ID,
    seq: 2,
    ts: 0,
    record: {
      kind: "input_fact" as const,
      fact: {
        type: "attempt.started" as const,
        goalHash: "goal-hash",
        configHash: "config-hash",
      },
    },
  };
  const artifact = {
    schemaVersion: "paw.file-run-session.batch-artifact.v2",
    sessionId: SESSION_ID,
    runId: RUN_ID,
    previousTailSeq: 0,
    previousPrefixHash: EMPTY_RUN_JOURNAL_PREFIX_HASH_V1,
    startSeq: 1,
    endSeq: 1,
    envelopes: [envelope],
  };
  const content = `${JSON.stringify(artifact)}\n`;
  const contentHash = hash(content);
  const artifactFileName = `0000000000000001-0000000000000001-${contentHash}.json`;
  fs.writeFileSync(
    path.join(runDirectory(root), "journal-artifacts", artifactFileName),
    content,
  );
  const nextHead = {
    tailSeq: 1,
    prefixHash: hash(JSON.stringify([envelope])),
  };
  const committed = await lease.linearizeJournalBatch({
    commitId: contentHash,
    expectedHead: {
      tailSeq: 0,
      prefixHash: EMPTY_RUN_JOURNAL_PREFIX_HASH_V1,
    },
    nextHead,
    batchStartSeq: 1,
    batchEndSeq: 1,
    artifactId: contentHash,
    artifactFileName,
    artifactContentHash: contentHash,
  });
  expect(committed.status).toBe("committed");
  expect(await lease.release()).toBe("released");
  return { ...fixture(root), expectedHead: nextHead };
}

function acquired(root: string) {
  const result = acquireFileSessionExecutionLeaseV1({
    workspaceRoot: root,
    sessionId: SESSION_ID,
    runId: RUN_ID,
    ttlMs: 60_000,
    baseTailSeq: 0,
    basePrefixHash: EMPTY_RUN_JOURNAL_PREFIX_HASH_V1,
  });
  if (result.status !== "acquired") {
    throw new Error(`test lease was not acquired: ${result.status}`);
  }
  return result.lease;
}

function fixture(root: string): PrefixFixture {
  const index = readFileSessionJournalCommitIndexV1({
    workspaceRoot: root,
    sessionId: SESSION_ID,
    runId: RUN_ID,
  });
  return {
    workspaceRoot: root,
    sessionId: SESSION_ID,
    runId: RUN_ID,
    expectedHead: index.head,
    root,
  };
}

function assertReadFailsWithoutMutation(
  fixtureValue: PrefixFixture,
  expected: RegExp,
): void {
  const before = rawTree(fixtureValue.root);
  expect(() => readCommittedFileRunPrefixV1(fixtureValue)).toThrow(expected);
  expect(rawTree(fixtureValue.root)).toEqual(before);
}

function onlyArtifact(root: string): string {
  const directory = path.join(runDirectory(root), "journal-artifacts");
  const artifacts = fs
    .readdirSync(directory)
    .filter((name) => /^\d{16}-\d{16}-[0-9a-f]{64}\.json$/.test(name));
  expect(artifacts).toHaveLength(1);
  return path.join(directory, artifacts[0] as string);
}

function runDirectory(root: string): string {
  return path.join(
    root,
    ".paw",
    "paw-next",
    "sessions",
    hash(SESSION_ID),
    hash(RUN_ID),
  );
}

function rawTree(root: string): readonly string[] {
  const output: string[] = [];
  function visit(current: string): void {
    for (const name of fs.readdirSync(current).sort()) {
      const full = path.join(current, name);
      const relative = path.relative(root, full);
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) {
        output.push(`link:${relative}:${fs.readlinkSync(full)}`);
      } else if (stat.isDirectory()) {
        output.push(`dir:${relative}`);
        visit(full);
      } else {
        output.push(
          `file:${relative}:${stat.nlink}:${hash(fs.readFileSync(full))}`,
        );
      }
    }
  }
  visit(root);
  return output;
}

function trySymlink(
  target: string,
  linkPath: string,
  type: fs.symlink.Type,
): boolean {
  try {
    fs.symlinkSync(target, linkPath, type);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "EPERM" || error.code === "EACCES")
    ) {
      return false;
    }
    throw error;
  }
}

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paw-prefix-readonly-"));
  roots.push(root);
  return root;
}
