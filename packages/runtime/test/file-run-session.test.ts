import { afterEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DerivedDecisionV1, InputFactV1 } from "@paw/protocol";
import {
  EMPTY_RUN_JOURNAL_PREFIX_HASH_V1,
  type FileRunSessionCommitHooksV1,
  FileRunSessionV1,
  type FileSessionExecutionLeaseV1,
  SessionExecutionLeaseLostError,
  acquireFileSessionExecutionLeaseV1,
  readFileSessionJournalCommitIndexV1,
} from "../src/index.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("Paw Next fenced durable file Session", () => {
  test("reads an empty commit index without creating storage", () => {
    const root = tempRoot();
    expect(
      readFileSessionJournalCommitIndexV1({
        workspaceRoot: root,
        sessionId: "session-1",
        runId: "run-1",
      }),
    ).toEqual({
      sessionId: "session-1",
      runId: "run-1",
      head: {
        tailSeq: 0,
        prefixHash: EMPTY_RUN_JOURNAL_PREFIX_HASH_V1,
      },
      commits: [],
    });
    expect(fs.readdirSync(root)).toEqual([]);
  });

  test("loads only immutable refs from the authority commit index", async () => {
    const root = tempRoot();
    const lease = acquire(root);
    let session = open(root, lease);
    await session.appendInputFacts([attemptStarted(), promoted("goal")]);
    expect(await session.commitDerivedDecision(2, decision(2))).toBe(
      "committed",
    );
    session.close();

    const index = readFileSessionJournalCommitIndexV1({
      workspaceRoot: root,
      sessionId: "session-1",
      runId: "run-1",
    });
    expect(index.commits).toHaveLength(2);
    expect(index.head.tailSeq).toBe(3);
    expect(index.commits.map((commit) => commit.batchStartSeq)).toEqual([1, 3]);

    session = open(root, lease);
    expect(await session.readInputSnapshot()).toEqual({
      entries: [
        { seq: 1, fact: attemptStarted() },
        { seq: 2, fact: promoted("goal") },
      ],
      tailSeq: 3,
      latestInputSeq: 2,
    });
    session.close();
  });

  test("returns a recursively immutable commit index projection", async () => {
    const root = tempRoot();
    const lease = acquire(root);
    const session = open(root, lease);
    await session.appendInputFacts([attemptStarted()]);
    session.close();
    const index = readFileSessionJournalCommitIndexV1({
      workspaceRoot: root,
      sessionId: "session-1",
      runId: "run-1",
    });
    expect(Object.isFrozen(index)).toBeTrue();
    expect(Object.isFrozen(index.head)).toBeTrue();
    expect(Object.isFrozen(index.commits)).toBeTrue();
    expect(Object.isFrozen(index.commits[0])).toBeTrue();
    expect(Object.isFrozen(index.commits[0]?.previousHead)).toBeTrue();
    expect(() => {
      (index.head as { tailSeq: number }).tailSeq = 999;
    }).toThrow();
    expect(() => {
      (index.commits as unknown as unknown[]).push({});
    }).toThrow();
    expect(
      readFileSessionJournalCommitIndexV1({
        workspaceRoot: root,
        sessionId: "session-1",
        runId: "run-1",
      }).head.tailSeq,
    ).toBe(1);
  });

  test("rejects duck-typed and cross-workspace lease capabilities", () => {
    const root = tempRoot();
    const other = tempRoot();
    const real = acquire(root);
    const duck = {
      ...real,
      assertHeld: () => undefined,
      renew: async () => undefined,
      release: async () => "released" as const,
      linearizeJournalBatch: real.linearizeJournalBatch.bind(real),
    };
    expect(
      () =>
        new FileRunSessionV1({
          workspaceRoot: root,
          sessionId: "session-1",
          runId: "run-1",
          executionLease: duck,
        }),
    ).toThrow("issued execution lease capability");
    expect(() => open(other, real)).toThrow("identity mismatch");
  });

  test("rejects every mutated public lease identity field", () => {
    for (const [field, value] of [
      ["workspaceRoot", "mutated-workspace"],
      ["sessionId", "mutated-session"],
      ["runId", "mutated-run"],
    ] as const) {
      const root = tempRoot();
      const lease = acquire(root);
      (lease as unknown as Record<string, unknown>)[field] = value;
      expect(() => open(root, lease)).toThrow("identity mismatch");
    }
  });

  test("ignores a shadowed public linearize method and uses its issued bound operation", async () => {
    const root = tempRoot();
    const lease = acquire(root);
    let shadowCalled = false;
    (
      lease as unknown as {
        linearizeJournalBatch: typeof lease.linearizeJournalBatch;
      }
    ).linearizeJournalBatch = async () => {
      shadowCalled = true;
      return {
        status: "committed",
        eventSeq: 999,
        head: { tailSeq: 999, prefixHash: "f".repeat(64) },
      };
    };
    const session = open(root, lease);
    await session.appendInputFacts([attemptStarted()]);
    expect(shadowCalled).toBeFalse();
    expect(
      readFileSessionJournalCommitIndexV1({
        workspaceRoot: root,
        sessionId: "session-1",
        runId: "run-1",
      }).head.tailSeq,
    ).toBe(1);
    session.close();
  });

  test("detects legacy storage before creating fenced metadata or artifacts", () => {
    const root = tempRoot();
    const lease = acquire(root);
    const runDir = fileRunDirectory(root, "session-1", "run-1");
    fs.mkdirSync(path.join(runDir, "batches"), { recursive: true });
    const legacyMetadata = path.join(runDir, "metadata.json");
    const legacy = '{"schemaVersion":"paw.file-run-session.v1"}\n';
    fs.writeFileSync(legacyMetadata, legacy, "utf8");

    expect(() => open(root, lease)).toThrow("requires explicit migration");
    expect(fs.readFileSync(legacyMetadata, "utf8")).toBe(legacy);
    expect(fs.existsSync(path.join(runDir, "journal-artifacts"))).toBeFalse();
  });

  test("recovers metadata publisher crashes before and after the formal hardlink", () => {
    const beforeRoot = tempRoot();
    const beforeLease = acquire(beforeRoot);
    const beforeRunDir = fileRunDirectory(beforeRoot, "session-1", "run-1");
    fs.mkdirSync(beforeRunDir, { recursive: true });
    const beforeMetadata = path.join(beforeRunDir, "metadata.json");
    const beforeTemp = metadataTempPath(beforeMetadata);
    fs.writeFileSync(beforeTemp, "unpublished bytes", "utf8");
    let session = open(beforeRoot, beforeLease);
    expect(fs.existsSync(beforeTemp)).toBeFalse();
    expect(JSON.parse(fs.readFileSync(beforeMetadata, "utf8"))).toMatchObject({
      schemaVersion: "paw.file-run-session.v2",
      sessionId: "session-1",
      runId: "run-1",
    });
    session.close();

    const afterRoot = tempRoot();
    const afterLease = acquire(afterRoot);
    session = open(afterRoot, afterLease);
    session.close();
    const afterMetadata = findFiles(
      afterRoot,
      (name) => name === "metadata.json",
    )[0] as string;
    const afterTemp = metadataTempPath(afterMetadata);
    fs.linkSync(afterMetadata, afterTemp);
    expect(fs.lstatSync(afterMetadata).nlink).toBe(2);
    session = open(afterRoot, afterLease);
    expect(fs.existsSync(afterTemp)).toBeFalse();
    expect(fs.lstatSync(afterMetadata).nlink).toBe(1);
    session.close();
  });

  test("rejects metadata external hardlinks, multiple publisher aliases and unsafe temps", () => {
    const hardlinkRoot = tempRoot();
    const hardlinkLease = acquire(hardlinkRoot);
    let session = open(hardlinkRoot, hardlinkLease);
    session.close();
    let metadata = findFiles(
      hardlinkRoot,
      (name) => name === "metadata.json",
    )[0] as string;
    fs.linkSync(metadata, path.join(hardlinkRoot, "external-metadata-alias"));
    expect(() => open(hardlinkRoot, hardlinkLease)).toThrow(
      "external hardlink",
    );

    const aliasesRoot = tempRoot();
    const aliasesLease = acquire(aliasesRoot);
    session = open(aliasesRoot, aliasesLease);
    session.close();
    metadata = findFiles(
      aliasesRoot,
      (name) => name === "metadata.json",
    )[0] as string;
    fs.linkSync(metadata, metadataTempPath(metadata));
    fs.linkSync(metadata, metadataTempPath(metadata));
    expect(() => open(aliasesRoot, aliasesLease)).toThrow(
      "multiple publisher temps",
    );

    if (process.platform !== "win32") {
      const symlinkRoot = tempRoot();
      const symlinkLease = acquire(symlinkRoot);
      const runDir = fileRunDirectory(symlinkRoot, "session-1", "run-1");
      fs.mkdirSync(runDir, { recursive: true });
      fs.symlinkSync(
        path.join(symlinkRoot, "missing-temp-target"),
        metadataTempPath(path.join(runDir, "metadata.json")),
        "file",
      );
      expect(() => open(symlinkRoot, symlinkLease)).toThrow(
        "metadata temp is unsafe",
      );
    }
  });

  test("dangling legacy and metadata symlinks fail with a byte-identical tree", () => {
    for (const entryName of ["batches", "metadata.json"] as const) {
      if (process.platform === "win32" && entryName === "metadata.json") {
        continue;
      }
      const root = tempRoot();
      const lease = acquire(root);
      const runDir = fileRunDirectory(root, "session-1", "run-1");
      fs.mkdirSync(runDir, { recursive: true });
      const link = path.join(runDir, entryName);
      const missing = path.join(root, `missing-${entryName.replace(".", "-")}`);
      if (process.platform === "win32") {
        fs.mkdirSync(missing);
        fs.symlinkSync(missing, link, "junction");
        fs.rmdirSync(missing);
      } else {
        fs.symlinkSync(missing, link, entryName === "batches" ? "dir" : "file");
      }
      const before = rawTree(root);
      expect(() => open(root, lease)).toThrow();
      expect(rawTree(root)).toEqual(before);
    }
  });

  test("ignores a valid orphan artifact after publication but before commit", async () => {
    const root = tempRoot();
    const lease = acquire(root);
    const hooks: FileRunSessionCommitHooksV1 = {
      afterArtifactPublished() {
        throw new Error("simulated crash before authority commit");
      },
    };
    const crashed = open(root, lease, hooks);
    await expect(crashed.appendInputFacts([attemptStarted()])).rejects.toThrow(
      "simulated crash",
    );
    crashed.close();
    expect(artifactFiles(root)).toHaveLength(1);
    expect(
      readFileSessionJournalCommitIndexV1({
        workspaceRoot: root,
        sessionId: "session-1",
        runId: "run-1",
      }).commits,
    ).toHaveLength(0);

    const recovered = open(root, lease);
    expect((await recovered.readInputSnapshot()).tailSeq).toBe(0);
    recovered.close();
  });

  test("fails closed before commit when the artifact directory is redirected after publication", async () => {
    const root = tempRoot();
    const outside = tempRoot();
    const lease = acquire(root);
    const session = open(root, lease, {
      afterArtifactPublished() {
        const artifactsDir = findDirectory(root, "journal-artifacts");
        fs.renameSync(artifactsDir, `${artifactsDir}.saved`);
        fs.symlinkSync(
          outside,
          artifactsDir,
          process.platform === "win32" ? "junction" : "dir",
        );
      },
    });
    await expect(
      session.appendInputFacts([attemptStarted()]),
    ).rejects.toBeInstanceOf(SessionExecutionLeaseLostError);
    expect(
      readFileSessionJournalCommitIndexV1({
        workspaceRoot: root,
        sessionId: "session-1",
        runId: "run-1",
      }).commits,
    ).toHaveLength(0);
  });

  test("recovers a commit linearized before an in-memory crash", async () => {
    const root = tempRoot();
    const lease = acquire(root);
    const crashed = open(root, lease, {
      afterJournalLinearized() {
        throw new Error("simulated crash after authority commit");
      },
    });
    await expect(
      crashed.appendInputFacts([attemptStarted()]),
    ).rejects.toBeInstanceOf(SessionExecutionLeaseLostError);

    const recovered = open(root, lease);
    expect((await recovered.readInputSnapshot()).tailSeq).toBe(1);
    recovered.close();
  });

  test("fails closed for a corrupt committed artifact", async () => {
    const root = tempRoot();
    const lease = acquire(root);
    const session = open(root, lease);
    await session.appendInputFacts([attemptStarted()]);
    session.close();
    fs.writeFileSync(artifactFiles(root)[0] as string, "{truncated", "utf8");
    expect(() => open(root, lease)).toThrow("content hash is invalid");
  });

  test("fails closed on unknown artifact entries instead of promoting them", () => {
    const root = tempRoot();
    const lease = acquire(root);
    const session = open(root, lease);
    session.close();
    const artifactsDir = findDirectory(root, "journal-artifacts");
    fs.writeFileSync(path.join(artifactsDir, "foreign.txt"), "foreign", "utf8");
    expect(() => open(root, lease)).toThrow(
      "Unrecognized fenced journal artifact entry",
    );
  });

  test("ignores corrupt bytes in a safe unreferenced formal artifact", async () => {
    const root = tempRoot();
    const lease = acquire(root);
    const session = open(root, lease);
    session.close();
    const artifactsDir = findDirectory(root, "journal-artifacts");
    const content = "not-json\n";
    const hash = createHash("sha256").update(content).digest("hex");
    fs.writeFileSync(
      path.join(artifactsDir, `0000000000000001-0000000000000001-${hash}.json`),
      content,
      "utf8",
    );
    const recovered = open(root, lease);
    expect((await recovered.readInputSnapshot()).tailSeq).toBe(0);
    recovered.close();
  });

  test("serializes all local writes and preserves protocol order", async () => {
    const root = tempRoot();
    const lease = acquire(root);
    const session = open(root, lease);
    await Promise.all([
      session.appendInputFacts([attemptStarted()]),
      session.appendInputFacts([promoted("goal")]),
    ]);
    expect(
      (await session.readInputSnapshot()).entries.map(({ seq }) => seq),
    ).toEqual([1, 2]);
    expect(
      readFileSessionJournalCommitIndexV1({
        workspaceRoot: root,
        sessionId: "session-1",
        runId: "run-1",
      }).commits,
    ).toHaveLength(2);
    session.close();
  });

  test("detaches and freezes mutation inputs before entering the async queue", async () => {
    const root = tempRoot();
    const lease = acquire(root);
    let session = open(root, lease);
    await session.appendInputFacts([attemptStarted()]);
    const mutableFact = promoted("original") as {
      type: "input.promoted";
      inputId: string;
      delivery: "initial";
      content: string;
      contentHash: string;
    };
    const append = session.appendInputFacts([mutableFact]);
    mutableFact.content = "mutated after promise return";
    await append;

    const mutableDecision = decision(2) as {
      type: "control.decided";
      reducerVersion: string;
      inputThroughSeq: number;
      stateHash: string;
      action: { kind: "continue"; reasonCode: string };
    };
    const dispatch: InputFactV1 = {
      type: "model.dispatch_recorded",
      modelCallId: "model-original",
      turn: 1,
      requestHash: "request-original",
    };
    const combined = session.commitDecisionAndInputFacts(2, mutableDecision, [
      dispatch,
    ]);
    mutableDecision.action.reasonCode = "mutated-reason";
    (dispatch as { modelCallId: string }).modelCallId = "model-mutated";
    expect(await combined).toBe("committed");

    const snapshot = await session.readInputSnapshot();
    expect(snapshot.entries[1]?.fact).toMatchObject({ content: "original" });
    expect(snapshot.entries[2]?.fact).toMatchObject({
      modelCallId: "model-original",
    });
    expect(() => {
      (snapshot.entries[1]?.fact as { content: string }).content = "consumer";
    }).toThrow();
    session.close();

    const persisted = persistedEnvelopes(root);
    expect(persisted[2]?.record).toMatchObject({
      kind: "derived_decision",
      decision: { action: { reasonCode: "continue" } },
    });
    session = open(root, lease);
    expect((await session.readInputSnapshot()).entries[1]?.fact).toMatchObject({
      content: "original",
    });
    session.close();
  });

  test("keeps journal-head fencing orthogonal to caller tail CAS", async () => {
    const root = tempRoot();
    const lease = acquire(root);
    const session = open(root, lease);
    await session.appendInputFacts([attemptStarted(), promoted("goal")]);
    const count = artifactFiles(root).length;
    expect(await session.commitDerivedDecision(1, decision(2))).toBe(
      "conflict",
    );
    expect(artifactFiles(root)).toHaveLength(count);
    expect(() => session.commitInputFacts(-1, [promoted("invalid")])).toThrow(
      "expectedTailSeq",
    );
    session.close();
  });

  test("rejects an empty recovery snapshot with zero storage mutation", async () => {
    const root = tempRoot();
    const lease = acquire(root);
    const session = open(root, lease);
    const before = tree(root);
    await expect(session.createRecoverySnapshot()).rejects.toThrow(
      "requires a non-empty journal",
    );
    expect(tree(root)).toEqual(before);
    expect(session.readRecoveryInfo()).toEqual({
      mode: "full_journal",
      snapshotThroughSeq: 0,
      tailEnvelopeCount: 0,
    });
    session.close();
  });

  test("a released lease aborts every public read and write", async () => {
    const root = tempRoot();
    const lease = acquire(root);
    const session = open(root, lease);
    expect(await lease.release()).toBe("released");
    await expect(session.readInputSnapshot()).rejects.toBeInstanceOf(
      SessionExecutionLeaseLostError,
    );
    await expect(session.appendInputFacts([attemptStarted()])).rejects.toThrow(
      "closed",
    );
  });
});

function acquire(
  root: string,
  sessionId = "session-1",
  runId = "run-1",
): FileSessionExecutionLeaseV1 {
  const result = acquireFileSessionExecutionLeaseV1({
    workspaceRoot: root,
    sessionId,
    runId,
    ownerId: `owner-${roots.length}-${sessionId}-${runId}`,
    ttlMs: 1_000_000,
    baseTailSeq: 0,
    basePrefixHash: EMPTY_RUN_JOURNAL_PREFIX_HASH_V1,
    clock: () => 42,
  });
  if (result.status !== "acquired") {
    throw new Error(`lease acquisition failed: ${result.status}`);
  }
  return result.lease;
}

function open(
  root: string,
  lease: FileSessionExecutionLeaseV1,
  commitHooks?: FileRunSessionCommitHooksV1,
): FileRunSessionV1 {
  return new FileRunSessionV1({
    workspaceRoot: root,
    sessionId: "session-1",
    runId: "run-1",
    executionLease: lease,
    clock: () => 42,
    commitHooks,
  });
}

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paw-next-session-"));
  roots.push(root);
  return root;
}

function attemptStarted(): InputFactV1 {
  return {
    type: "attempt.started",
    goalHash: "goal-hash",
    configHash: "config-hash",
  };
}

function promoted(content: string): InputFactV1 {
  return {
    type: "input.promoted",
    inputId: `input-${content}`,
    delivery: "initial",
    content,
    contentHash: `hash-${content}`,
  };
}

function decision(inputThroughSeq: number): DerivedDecisionV1 {
  return {
    type: "control.decided",
    reducerVersion: "test-reducer-v1",
    inputThroughSeq,
    stateHash: `state-${inputThroughSeq}`,
    action: { kind: "continue", reasonCode: "continue" },
  };
}

function fileRunDirectory(
  root: string,
  sessionId: string,
  runId: string,
): string {
  return path.join(
    root,
    ".paw",
    "paw-next",
    "sessions",
    stablePathKey(sessionId),
    stablePathKey(runId),
  );
}

function stablePathKey(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function metadataTempPath(metadataPath: string): string {
  return `${metadataPath}.tmp-${process.pid}-${randomUUID()}`;
}

function artifactFiles(root: string): string[] {
  return findFiles(root, (name) =>
    /^\d{16}-\d{16}-[0-9a-f]{64}\.json$/.test(name),
  );
}

function persistedEnvelopes(root: string): Array<{
  readonly seq: number;
  readonly record: unknown;
}> {
  return artifactFiles(root)
    .flatMap((file) => {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
        envelopes?: Array<{ seq: number; record: unknown }>;
      };
      return parsed.envelopes ?? [];
    })
    .sort((left, right) => left.seq - right.seq);
}

function findFiles(root: string, accept: (name: string) => boolean): string[] {
  const found: string[] = [];
  const visit = (folder: string): void => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (accept(entry.name)) found.push(full);
    }
  };
  visit(root);
  return found.sort();
}

function findDirectory(root: string, name: string): string {
  const queue = [root];
  while (queue.length > 0) {
    const folder = queue.shift() as string;
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = path.join(folder, entry.name);
      if (entry.name === name) return full;
      queue.push(full);
    }
  }
  throw new Error(`directory not found: ${name}`);
}

function tree(root: string): readonly string[] {
  return findFiles(root, () => true).map((file) =>
    path.relative(root, file).replaceAll("\\", "/"),
  );
}

function rawTree(root: string): readonly string[] {
  const entries: string[] = [];
  const visit = (folder: string): void => {
    for (const name of fs.readdirSync(folder).sort()) {
      const full = path.join(folder, name);
      const relative = path.relative(root, full).replaceAll("\\", "/");
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) {
        entries.push(`link:${relative}->${fs.readlinkSync(full)}`);
      } else if (stat.isDirectory()) {
        entries.push(`dir:${relative}`);
        visit(full);
      } else {
        entries.push(`file:${relative}:${fs.readFileSync(full, "hex")}`);
      }
    }
  };
  visit(root);
  return entries;
}
