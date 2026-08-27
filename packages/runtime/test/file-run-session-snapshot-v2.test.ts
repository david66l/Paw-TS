import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  type ControlDecision,
  type LoopControlState,
  type ReplayVerificationV1,
  assertReplayEquivalentV1,
  inspectAgentLoopContinueCursorV1,
} from "@paw/agent-loop";
import type {
  ControlDecisionActionV1,
  DerivedDecisionV1,
  InputFactV1,
  RunJournalEnvelopeV1,
} from "@paw/protocol";
import {
  EMPTY_RUN_JOURNAL_PREFIX_HASH_V1,
  type FileRunSessionCommitHooksV1,
  FileRunSessionV1,
  type FileSessionExecutionLeaseV1,
  SessionExecutionLeaseLostError,
  acquireFileSessionExecutionLeaseV1,
  projectDurableInputInboxStateV1,
  readFileSessionAuthorityInventoryV1,
  readFileSessionJournalCommitIndexV1,
} from "../src/index.js";

const SESSION_ID = "snapshot-session";
const RUN_ID = "snapshot-run";
const roots: string[] = [];
let ownerCounter = 0;

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("FileRunSession recovery snapshot v2", () => {
  test("full replay and snapshot plus tail expose the exact same canonical state", async () => {
    const full = await createReplayFixture(false);
    const snapshotted = await createReplayFixture(true);

    expect(snapshotted.prefix).toEqual(full.prefix);
    expect(snapshotted.inputSnapshot).toEqual(full.inputSnapshot);
    expect(snapshotted.recoveryInfo).toEqual({
      mode: "snapshot_plus_tail",
      snapshotThroughSeq: 4,
      tailEnvelopeCount: 2,
    });
    expect(full.recoveryInfo).toEqual({
      mode: "full_journal",
      snapshotThroughSeq: 0,
      tailEnvelopeCount: 6,
    });

    assertReplayEquivalentV1(full.prefix, replayVerification());
    assertReplayEquivalentV1(snapshotted.prefix, replayVerification());
    expect(inspectAgentLoopContinueCursorV1(snapshotted.inputSnapshot)).toEqual(
      inspectAgentLoopContinueCursorV1(full.inputSnapshot),
    );
    expect(projectDurableInputInboxStateV1(snapshotted.inputSnapshot)).toEqual(
      projectDurableInputInboxStateV1(full.inputSnapshot),
    );
  });

  test("snapshot events leave the journal head, scanner inventory, and raw journal bytes unchanged", async () => {
    const root = tempRoot();
    const lease = acquire(root);
    const session = open(root, lease);
    await appendReplayPrefixThroughFirstDecision(session);
    const indexBefore = commitIndex(root);
    const inventoryBefore = inventory(root);
    const journalBefore = journalArtifactBytes(root);

    const created = await session.createRecoverySnapshot();
    expect(created).toEqual({
      status: "created",
      throughSeq: 4,
      prefixHash: indexBefore.head.prefixHash,
    });
    expect(commitIndex(root).head).toEqual(indexBefore.head);
    expect(commitIndex(root).commits).toEqual(indexBefore.commits);
    expect(inventory(root)).toEqual(inventoryBefore);
    expect(journalArtifactBytes(root)).toEqual(journalBefore);
    expect(snapshotEventCount(root)).toBe(1);
    const event = snapshotEvents(root)[0];
    const journalCommit = indexBefore.commits.at(-1);
    if (!event || !journalCommit) {
      throw new Error("expected one snapshot and one journal authority event");
    }
    expect(Object.keys(event).sort()).toEqual(
      [
        "schemaVersion",
        "type",
        "eventSeq",
        "previousEventHash",
        "sessionId",
        "runId",
        "ownerId",
        "fencingToken",
        "snapshotId",
        "committedAt",
        "journalCommitId",
        "journalCommitEventSeq",
        "journalTailSeq",
        "journalPrefixHash",
        "throughSeq",
        "prefixHash",
        "artifactId",
        "artifactFileName",
        "artifactContentHash",
      ].sort(),
    );
    expect(event).toMatchObject({
      schemaVersion: "paw.session-execution-lease-event.v1",
      type: "recovery_snapshot_commit",
      sessionId: SESSION_ID,
      runId: RUN_ID,
      journalCommitId: journalCommit.commitId,
      journalCommitEventSeq: journalCommit.eventSeq,
      journalTailSeq: 4,
      journalPrefixHash: indexBefore.head.prefixHash,
      throughSeq: 4,
      prefixHash: indexBefore.head.prefixHash,
      artifactId: event.snapshotId,
      artifactContentHash: event.snapshotId,
    });
    expect(event?.artifactFileName).toBe(
      `snapshot-0000000000000004-${event.snapshotId}.json`,
    );
    expect(session.readRecoveryInfo()).toEqual({
      mode: "snapshot_plus_tail",
      snapshotThroughSeq: 4,
      tailEnvelopeCount: 0,
    });

    const treeBeforeReuse = rawTree(root);
    expect(await session.createRecoverySnapshot()).toEqual({
      ...created,
      status: "reused",
    });
    expect(rawTree(root)).toEqual(treeBeforeReuse);
    expect(snapshotEventCount(root)).toBe(1);

    await session.appendInputFacts([abortRequested()]);
    expect(session.readRecoveryInfo()).toEqual({
      mode: "snapshot_plus_tail",
      snapshotThroughSeq: 4,
      tailEnvelopeCount: 1,
    });
    expect(await session.commitDerivedDecision(5, replayDecision(5))).toBe(
      "committed",
    );
    const firstSnapshotFiles = snapshotFiles(root);
    expect(firstSnapshotFiles).toHaveLength(1);
    expect(await session.createRecoverySnapshot()).toMatchObject({
      status: "created",
      throughSeq: 6,
    });
    expect(snapshotFiles(root)).toHaveLength(2);
    expect(snapshotFiles(root)).toEqual(
      expect.arrayContaining(firstSnapshotFiles),
    );
    expect(journalArtifactBytes(root)).toEqual(
      journalArtifactBytesFromIndex(root),
    );
    const expectedPrefix = await session.readCanonicalPrefix();
    const [olderSnapshot, latestSnapshot] = snapshotFiles(root);
    if (!olderSnapshot || !latestSnapshot) {
      throw new Error("expected two committed recovery snapshots");
    }
    fs.utimesSync(olderSnapshot, new Date(9_000), new Date(9_000));
    fs.utimesSync(latestSnapshot, new Date(1_000), new Date(1_000));
    session.close();

    const reopened = open(root, lease);
    expect(reopened.readRecoveryInfo()).toEqual({
      mode: "snapshot_plus_tail",
      snapshotThroughSeq: 6,
      tailEnvelopeCount: 0,
    });
    expect(await reopened.readCanonicalPrefix()).toEqual(expectedPrefix);
    reopened.close();
  });

  test("losing the lease after snapshot publication leaves only an ignored orphan", async () => {
    const root = tempRoot();
    let now = 0;
    const lease = acquire(root, {
      ttlMs: 10,
      clock: () => now,
    });
    const session = open(root, lease, {
      afterSnapshotArtifactPublished() {
        now = 11;
      },
    });
    await session.appendInputFacts([attemptStarted()]);
    const prefix = await session.readCanonicalPrefix();

    await expect(session.createRecoverySnapshot()).rejects.toBeInstanceOf(
      SessionExecutionLeaseLostError,
    );
    expect(snapshotFiles(root)).toHaveLength(1);
    expect(commitIndex(root).latestRecoverySnapshot).toBeUndefined();

    const head = commitIndex(root).head;
    const successorLease = acquire(root, {
      now,
      ttlMs: 10,
      baseTailSeq: head.tailSeq,
      basePrefixHash: head.prefixHash,
      clock: () => now,
    });
    const successor = open(root, successorLease);
    expect(successor.readRecoveryInfo()).toEqual({
      mode: "full_journal",
      snapshotThroughSeq: 0,
      tailEnvelopeCount: 1,
    });
    expect(await successor.readCanonicalPrefix()).toEqual(prefix);
    successor.close();
  });

  test("a crash after snapshot linearization reopens exactly once from the committed snapshot", async () => {
    const root = tempRoot();
    const lease = acquire(root);
    const crash = new Error("crash after snapshot authority commit");
    const session = open(root, lease, {
      afterSnapshotLinearized() {
        throw crash;
      },
    });
    await session.appendInputFacts([attemptStarted()]);
    const expectedPrefix = await session.readCanonicalPrefix();

    await expect(session.createRecoverySnapshot()).rejects.toThrow(
      crash.message,
    );
    expect(snapshotEventCount(root)).toBe(1);
    expect(commitIndex(root).latestRecoverySnapshot).toBeDefined();

    const reopened = open(root, lease);
    expect(reopened.readRecoveryInfo()).toEqual({
      mode: "snapshot_plus_tail",
      snapshotThroughSeq: 1,
      tailEnvelopeCount: 0,
    });
    expect(await reopened.readCanonicalPrefix()).toEqual(expectedPrefix);
    expect(await reopened.createRecoverySnapshot()).toMatchObject({
      status: "reused",
      throughSeq: 1,
    });
    expect(snapshotEventCount(root)).toBe(1);
    reopened.close();
  });

  test("a committed snapshot never replaces validation of covered raw journal refs", async () => {
    for (const mutation of ["missing", "tampered", "hardlink"] as const) {
      const fixture = await createSnapshottedJournal();
      const raw = journalArtifactFiles(fixture.root)[0] as string;
      if (mutation === "missing") {
        fs.rmSync(raw);
      } else if (mutation === "tampered") {
        fs.appendFileSync(raw, " ", "utf8");
      } else {
        fs.linkSync(raw, path.join(tempRoot(), `raw-${mutation}.json`));
      }
      expect(() => open(fixture.root, fixture.lease)).toThrow();
    }
  });

  test("missing, corrupt, hardlinked, or redirected committed snapshot storage fails closed", async () => {
    for (const mutation of ["missing", "tampered", "hardlink"] as const) {
      const fixture = await createSnapshottedJournal();
      const snapshot = snapshotFiles(fixture.root)[0] as string;
      if (mutation === "missing") {
        fs.rmSync(snapshot);
      } else if (mutation === "tampered") {
        fs.appendFileSync(snapshot, " ", "utf8");
      } else {
        fs.linkSync(
          snapshot,
          path.join(tempRoot(), `snapshot-${mutation}.json`),
        );
      }
      expect(() => open(fixture.root, fixture.lease)).toThrow();
    }

    const redirected = await createSnapshottedJournal();
    const snapshots = snapshotDirectory(redirected.root);
    const external = path.join(tempRoot(), "foreign-snapshots");
    fs.renameSync(snapshots, external);
    fs.symlinkSync(
      external,
      snapshots,
      process.platform === "win32" ? "junction" : "dir",
    );
    expect(() => open(redirected.root, redirected.lease)).toThrow();
  });

  test("snapshot envelope identity, sequence, and prefix drift fail closed", async () => {
    for (const mutation of [
      "cross_session",
      "cross_run",
      "sequence",
      "prefix",
    ] as const) {
      const root = tempRoot();
      const lease = acquire(root);
      const session = open(root, lease);
      await session.appendInputFacts([attemptStarted()]);
      const prefix = await session.readCanonicalPrefix();
      session.close();
      await linearizeForgedSnapshot(root, lease, prefix, mutation);
      expect(() => open(root, lease)).toThrow();
    }
  });

  test("a corrupt latest committed snapshot never falls back to an older valid snapshot", async () => {
    const root = tempRoot();
    const lease = acquire(root);
    const session = open(root, lease);
    await session.appendInputFacts([attemptStarted()]);
    await session.createRecoverySnapshot();
    await session.appendInputFacts([promoted()]);
    await session.createRecoverySnapshot();
    session.close();

    const [older, latest] = snapshotFiles(root);
    if (!older || !latest) throw new Error("expected two recovery snapshots");
    const olderBytes = fs.readFileSync(older, "hex");
    fs.utimesSync(older, new Date(9_000), new Date(9_000));
    fs.utimesSync(latest, new Date(1_000), new Date(1_000));
    fs.appendFileSync(latest, " ", "utf8");
    const before = rawTree(root);

    expect(() => open(root, lease)).toThrow();
    expect(fs.readFileSync(older, "hex")).toBe(olderBytes);
    expect(rawTree(root)).toEqual(before);
    expect(commitIndex(root).latestRecoverySnapshot?.throughSeq).toBe(2);
  });

  test.skipIf(process.platform === "win32")(
    "symlinked committed snapshot and covered journal artifacts fail closed",
    async () => {
      for (const kind of ["snapshot", "journal"] as const) {
        const fixture = await createSnapshottedJournal();
        const formal =
          kind === "snapshot"
            ? (snapshotFiles(fixture.root)[0] as string)
            : (journalArtifactFiles(fixture.root)[0] as string);
        const external = path.join(tempRoot(), `${kind}.json`);
        fs.renameSync(formal, external);
        fs.symlinkSync(external, formal, "file");
        expect(() => open(fixture.root, fixture.lease)).toThrow();
      }
    },
  );

  test("unreferenced snapshot orphans are ignored without deleting raw artifacts", async () => {
    const root = tempRoot();
    const lease = acquire(root);
    let session = open(root, lease);
    await session.appendInputFacts([attemptStarted()]);
    session.close();
    const rawBefore = journalArtifactBytes(root);
    const orphanContent = "not a committed snapshot\n";
    const orphanHash = hashBytes(orphanContent);
    fs.mkdirSync(snapshotDirectory(root), { recursive: true });
    const orphan = path.join(
      snapshotDirectory(root),
      `snapshot-0000000000000001-${orphanHash}.json`,
    );
    fs.writeFileSync(orphan, orphanContent, "utf8");

    session = open(root, lease);
    expect(session.readRecoveryInfo().mode).toBe("full_journal");
    expect(journalArtifactBytes(root)).toEqual(rawBefore);
    expect(fs.readFileSync(orphan, "utf8")).toBe(orphanContent);
    session.close();
  });

  test("snapshot and queued journal/heartbeat mutations serialize without changing canonical order", async () => {
    const root = tempRoot();
    const lease = acquire(root);
    const session = open(root, lease);
    await session.appendInputFacts([attemptStarted()]);

    const renewal = lease.renew();
    const snapshot = session.createRecoverySnapshot();
    const tail = session.appendInputFacts([promoted()]);
    await expect(renewal).resolves.toBeUndefined();
    await expect(snapshot).resolves.toMatchObject({ throughSeq: 1 });
    await expect(tail).resolves.toBeUndefined();
    expect(session.readRecoveryInfo()).toEqual({
      mode: "snapshot_plus_tail",
      snapshotThroughSeq: 1,
      tailEnvelopeCount: 1,
    });
    expect(
      (await session.readCanonicalPrefix()).map((item) => item.seq),
    ).toEqual([1, 2]);
    session.close();
  });
});

interface ReplayState extends LoopControlState {
  readonly inputCount: number;
}

async function createReplayFixture(withSnapshot: boolean): Promise<{
  readonly prefix: readonly RunJournalEnvelopeV1[];
  readonly inputSnapshot: Awaited<
    ReturnType<FileRunSessionV1["readInputSnapshot"]>
  >;
  readonly recoveryInfo: ReturnType<FileRunSessionV1["readRecoveryInfo"]>;
}> {
  const root = tempRoot();
  const lease = acquire(root);
  let session = open(root, lease);
  await appendReplayPrefixThroughFirstDecision(session);
  if (withSnapshot) await session.createRecoverySnapshot();
  await session.appendInputFacts([abortRequested()]);
  expect(await session.commitDerivedDecision(5, replayDecision(5))).toBe(
    "committed",
  );
  session.close();
  session = open(root, lease);
  const result = {
    prefix: await session.readCanonicalPrefix(),
    inputSnapshot: await session.readInputSnapshot(),
    recoveryInfo: session.readRecoveryInfo(),
  };
  session.close();
  return result;
}

async function appendReplayPrefixThroughFirstDecision(
  session: FileRunSessionV1,
): Promise<void> {
  await session.appendInputFacts([attemptStarted()]);
  expect(await session.commitDerivedDecision(1, replayDecision(1))).toBe(
    "committed",
  );
  await session.appendInputFacts([promoted()]);
  expect(await session.commitDerivedDecision(3, replayDecision(3))).toBe(
    "committed",
  );
}

function replayVerification(): ReplayVerificationV1<
  Readonly<{ mode: "snapshot-test" }>,
  ReplayState
> {
  return {
    runConfig: { mode: "snapshot-test" },
    reducerVersion: "snapshot-reducer-v1",
    reducer: { reduce: reduceReplayFacts },
    stateHasher: { hash: hashReplayState },
    derivedDecision({ state, inputThroughSeq, stateHash, reducerVersion }) {
      return {
        type: "control.decided",
        reducerVersion,
        inputThroughSeq,
        stateHash,
        action: replayAction(state.decision),
      };
    },
  };
}

function replayDecision(inputThroughSeq: number): DerivedDecisionV1 {
  const facts = [
    attemptStarted(),
    ...(inputThroughSeq >= 3 ? [promoted()] : []),
    ...(inputThroughSeq >= 5 ? [abortRequested()] : []),
  ];
  const state = reduceReplayFacts(facts);
  return {
    type: "control.decided",
    reducerVersion: "snapshot-reducer-v1",
    inputThroughSeq,
    stateHash: hashReplayState(state),
    action: replayAction(state.decision),
  };
}

function reduceReplayFacts(facts: readonly InputFactV1[]): ReplayState {
  const abort = [...facts]
    .reverse()
    .find((fact) => fact.type === "abort.requested");
  return {
    inputCount: facts.length,
    decision: abort
      ? { kind: "aborted", reason: abort.reason ?? "aborted" }
      : facts.some((fact) => fact.type === "input.promoted")
        ? { kind: "await_user", reason: "need-user" }
        : { kind: "continue" },
  };
}

function hashReplayState(state: ReplayState): string {
  return JSON.stringify(state);
}

function replayAction(decision: ControlDecision): ControlDecisionActionV1 {
  switch (decision.kind) {
    case "continue":
      return { kind: "continue", reasonCode: "continue" };
    case "await_user":
      return { kind: "wait", waitFor: "user", reasonCode: decision.reason };
    case "await_external":
      return {
        kind: "wait",
        waitFor: "external",
        reasonCode: decision.reason,
      };
    case "completed":
      return { kind: "complete", reasonCode: decision.reason };
    case "incomplete":
      return { kind: "incomplete", reasonCode: decision.reason };
    case "failed":
      return { kind: "failed", reasonCode: decision.reason };
    case "aborted":
      return { kind: "abort", reasonCode: decision.reason };
  }
}

function attemptStarted(): InputFactV1 {
  return {
    type: "attempt.started",
    goalHash: "snapshot-goal",
    configHash: "snapshot-config",
  };
}

function promoted(): InputFactV1 {
  return {
    type: "input.promoted",
    inputId: "snapshot-input",
    delivery: "initial",
    content: "snapshot goal",
    contentHash: "snapshot-content-hash",
  };
}

function abortRequested(): InputFactV1 {
  return { type: "abort.requested", source: "host", reason: "snapshot-stop" };
}

async function createSnapshottedJournal(): Promise<{
  readonly root: string;
  readonly lease: FileSessionExecutionLeaseV1;
}> {
  const root = tempRoot();
  const lease = acquire(root);
  const session = open(root, lease);
  await session.appendInputFacts([attemptStarted()]);
  await session.createRecoverySnapshot();
  session.close();
  return { root, lease };
}

function acquire(
  root: string,
  options: Readonly<{
    now?: number;
    ttlMs?: number;
    baseTailSeq?: number;
    basePrefixHash?: string;
    clock?: () => number;
  }> = {},
): FileSessionExecutionLeaseV1 {
  const now = options.now ?? 0;
  const result = acquireFileSessionExecutionLeaseV1({
    workspaceRoot: root,
    sessionId: SESSION_ID,
    runId: RUN_ID,
    ownerId: `snapshot-owner-${ownerCounter++}`,
    ttlMs: options.ttlMs ?? 1_000_000,
    baseTailSeq: options.baseTailSeq ?? 0,
    basePrefixHash: options.basePrefixHash ?? EMPTY_RUN_JOURNAL_PREFIX_HASH_V1,
    clock: options.clock ?? (() => now),
  });
  if (result.status !== "acquired") {
    throw new Error(`snapshot lease acquisition failed: ${result.status}`);
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
    sessionId: SESSION_ID,
    runId: RUN_ID,
    executionLease: lease,
    clock: () => 42,
    commitHooks,
  });
}

function inventory(root: string) {
  return readFileSessionAuthorityInventoryV1({
    workspaceRoot: root,
    sessionId: SESSION_ID,
  });
}

function commitIndex(root: string) {
  return readFileSessionJournalCommitIndexV1({
    workspaceRoot: root,
    sessionId: SESSION_ID,
    runId: RUN_ID,
  });
}

function journalArtifactBytes(root: string): Readonly<Record<string, string>> {
  return Object.freeze(
    Object.fromEntries(
      journalArtifactFiles(root).map((file) => [
        path.basename(file),
        fs.readFileSync(file, "hex"),
      ]),
    ),
  );
}

function journalArtifactBytesFromIndex(
  root: string,
): Readonly<Record<string, string>> {
  return Object.freeze(
    Object.fromEntries(
      commitIndex(root).commits.map((commit) => {
        const file = path.join(
          journalArtifactDirectory(root),
          commit.artifactFileName,
        );
        return [commit.artifactFileName, fs.readFileSync(file, "hex")];
      }),
    ),
  );
}

function journalArtifactFiles(root: string): string[] {
  const directory = journalArtifactDirectory(root);
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory)
    .filter((name) => /^\d{16}-\d{16}-[0-9a-f]{64}\.json$/.test(name))
    .sort()
    .map((name) => path.join(directory, name));
}

function snapshotFiles(root: string): string[] {
  const directory = snapshotDirectory(root);
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory)
    .filter((name) => /^snapshot-\d{16}-[0-9a-f]{64}\.json$/.test(name))
    .sort()
    .map((name) => path.join(directory, name));
}

function snapshotEventCount(root: string): number {
  return snapshotEvents(root).length;
}

function snapshotEvents(root: string): Array<Record<string, unknown>> {
  return allFiles(root, (name) => /^\d{16}\.json$/.test(name)).flatMap(
    (file) => {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<
        string,
        unknown
      >;
      return parsed.type === "recovery_snapshot_commit" ? [parsed] : [];
    },
  );
}

async function linearizeForgedSnapshot(
  root: string,
  lease: FileSessionExecutionLeaseV1,
  prefix: readonly RunJournalEnvelopeV1[],
  mutation: "cross_session" | "cross_run" | "sequence" | "prefix",
): Promise<void> {
  const index = commitIndex(root);
  const journalCommit = index.commits.at(-1);
  if (!journalCommit) throw new Error("forged snapshot needs a journal commit");
  const artifact = {
    schemaVersion: "paw.file-run-session.recovery-snapshot.v2",
    sessionId: mutation === "cross_session" ? "foreign-session" : SESSION_ID,
    runId: mutation === "cross_run" ? "foreign-run" : RUN_ID,
    throughSeq:
      mutation === "sequence" ? index.head.tailSeq + 1 : index.head.tailSeq,
    prefixHash: mutation === "prefix" ? "f".repeat(64) : index.head.prefixHash,
    envelopes: prefix,
  };
  const content = `${JSON.stringify(artifact)}\n`;
  const hash = hashBytes(content);
  const artifactFileName = `snapshot-${String(index.head.tailSeq).padStart(16, "0")}-${hash}.json`;
  fs.mkdirSync(snapshotDirectory(root), { recursive: true });
  fs.writeFileSync(
    path.join(snapshotDirectory(root), artifactFileName),
    content,
    "utf8",
  );
  const result = await lease.linearizeRecoverySnapshot({
    snapshotId: hash,
    journalCommitId: journalCommit.commitId,
    journalCommitEventSeq: journalCommit.eventSeq,
    head: index.head,
    throughSeq: index.head.tailSeq,
    prefixHash: index.head.prefixHash,
    artifactId: hash,
    artifactFileName,
    artifactContentHash: hash,
  });
  expect(result.status).toBe("committed");
}

function journalArtifactDirectory(root: string): string {
  return path.join(runDirectory(root), "journal-artifacts");
}

function snapshotDirectory(root: string): string {
  return path.join(runDirectory(root), "recovery-snapshots");
}

function runDirectory(root: string): string {
  return path.join(
    root,
    ".paw",
    "paw-next",
    "sessions",
    stablePathKey(SESSION_ID),
    stablePathKey(RUN_ID),
  );
}

function stablePathKey(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashBytes(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function allFiles(root: string, accept: (name: string) => boolean): string[] {
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
        entries.push(`file:${relative}:${hashBytes(fs.readFileSync(full))}`);
      }
    }
  };
  visit(root);
  return entries;
}

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paw-snapshot-v2-"));
  roots.push(root);
  return root;
}
