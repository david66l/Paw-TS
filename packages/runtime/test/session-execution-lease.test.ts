import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  EMPTY_RUN_JOURNAL_PREFIX_HASH_V1,
  type FileSessionExecutionLeaseOptionsV1,
  type LinearizeJournalBatchInputV1,
  SessionExecutionLeaseLostError,
  acquireFileSessionExecutionLeaseV1,
  readFileSessionAuthorityInventoryV1,
  readFileSessionJournalCommitIndexV1,
} from "../src/index.js";

const BASE_PREFIX_HASH = EMPTY_RUN_JOURNAL_PREFIX_HASH_V1;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("cross-process Session execution lease", () => {
  test("two real processes compete for one initial immutable event", async () => {
    const root = tempRoot();
    const barrier = path.join(root, "start");
    const childScript = fixture("session-lease-claim-child.ts");
    const readyOne = path.join(root, "ready-1");
    const readyTwo = path.join(root, "ready-2");
    const first = runChild([
      childScript,
      root,
      "shared",
      "run-a",
      readyOne,
      barrier,
    ]);
    const second = runChild([
      childScript,
      root,
      "shared",
      "run-b",
      readyTwo,
      barrier,
    ]);
    await waitFor(() => fs.existsSync(readyOne) && fs.existsSync(readyTwo));
    fs.writeFileSync(barrier, "go\n");
    const results = (await Promise.all([first, second])).map(
      (value) => JSON.parse(value) as ChildClaimResult,
    );
    expect(results.filter(({ status }) => status === "acquired")).toHaveLength(
      1,
    );
    expect(results.filter(({ status }) => status === "busy")).toHaveLength(1);
    expect(results.map(({ token }) => token)).toEqual([1, 1]);
    expect(new Set(results.map(({ ownerId }) => ownerId)).size).toBe(1);
    expect(readEvents(root, "shared")).toHaveLength(1);
  });

  test("all transitions share one contiguous hash-chained timeline", async () => {
    const root = tempRoot();
    let now = 100;
    const first = acquired(
      acquire(
        options(root, "timeline", "run-1", now, {
          ownerId: "owner-1",
          clock: () => now,
        }),
      ),
    );
    expect(first.baseTailSeq).toBe(0);
    expect(first.basePrefixHash).toBe(EMPTY_RUN_JOURNAL_PREFIX_HASH_V1);
    now = 150;
    await first.renew();
    expect(await first.release()).toBe("released");
    const second = acquired(acquire(options(root, "timeline", "run-2", now)));
    expect(second.fencingToken).toBe(2);
    const files = eventFiles(root, "timeline");
    const events = files.map(readJson);
    expect(events.map(({ type }) => type)).toEqual([
      "claim",
      "heartbeat",
      "release",
      "claim",
    ]);
    expect(events.map(({ eventSeq }) => eventSeq)).toEqual([1, 2, 3, 4]);
    expect(events.map(({ fencingToken }) => fencingToken)).toEqual([
      1, 1, 1, 2,
    ]);
    expect(events[0]).toMatchObject({
      baseTailSeq: 0,
      basePrefixHash: EMPTY_RUN_JOURNAL_PREFIX_HASH_V1,
    });
    for (let index = 1; index < files.length; index += 1) {
      expect(events[index]?.previousEventHash).toBe(
        hashFile(files[index - 1] as string),
      );
    }
  });

  test("journal commits advance a per-run head and exact retries are idempotent", async () => {
    const root = tempRoot();
    const lease = acquired(acquire(options(root, "journal", "run-1", 0)));
    const input = linearizeInput("commit-1");
    expect(await lease.linearizeJournalBatch(input)).toMatchObject({
      status: "committed",
      eventSeq: 2,
      head: input.nextHead,
    });
    expect(lease.expiresAt).toBe(100);
    expect(await lease.linearizeJournalBatch(input)).toMatchObject({
      status: "already_committed",
      eventSeq: 2,
      head: input.nextHead,
    });
    await expect(
      lease.linearizeJournalBatch({
        ...input,
        nextHead: { ...input.nextHead, prefixHash: "e".repeat(64) },
      }),
    ).rejects.toThrow("commitId was reused");
    expect(
      await lease.linearizeJournalBatch(linearizeInput("commit-2")),
    ).toEqual({ status: "conflict", head: input.nextHead });
    const next = nextLinearizeInput(input.nextHead, "commit-next");
    expect(await lease.linearizeJournalBatch(next)).toMatchObject({
      status: "committed",
      head: next.nextHead,
    });
    expect(await lease.linearizeJournalBatch(input)).toEqual({
      status: "conflict",
      head: next.nextHead,
    });
    expect(readEvents(root, "journal").map(({ type }) => type)).toEqual([
      "claim",
      "journal_commit",
      "journal_commit",
    ]);

    expect(() =>
      lease.linearizeJournalBatch({
        ...linearizeInput("bad-artifact"),
        artifactFileName: "arbitrary.json",
      }),
    ).toThrow("artifact identity");
  });

  test("replay rejects a tampered duplicate journal commit id", async () => {
    const root = tempRoot();
    const lease = acquired(acquire(options(root, "commit-tamper", "run-1", 0)));
    const first = linearizeInput("commit-first");
    await lease.linearizeJournalBatch(first);
    const secondHash = "e".repeat(64);
    const second: LinearizeJournalBatchInputV1 = {
      commitId: "commit-second",
      expectedHead: first.nextHead,
      nextHead: { tailSeq: 2, prefixHash: "f".repeat(64) },
      batchStartSeq: 2,
      batchEndSeq: 2,
      artifactId: secondHash,
      artifactFileName: `0000000000000002-0000000000000002-${secondHash}.json`,
      artifactContentHash: secondHash,
    };
    await lease.linearizeJournalBatch(second);
    const lastEvent = eventFiles(root, "commit-tamper")[2] as string;
    const tampered = readJson(lastEvent);
    tampered.commitId = first.commitId;
    fs.writeFileSync(lastEvent, `${JSON.stringify(tampered)}\n`);
    expect(() => acquire(options(root, "commit-tamper", "probe", 1))).toThrow(
      "commitId is duplicated",
    );
  });

  test("stale claim anchors return the authoritative head without writing", async () => {
    const newRunRoot = tempRoot();
    const invalidNewRun = acquire(
      options(newRunRoot, "new-run-anchor", "run-1", 0, {
        baseTailSeq: 1,
        basePrefixHash: "d".repeat(64),
      }),
    );
    expect(invalidNewRun).toEqual({
      status: "anchor_conflict",
      runId: "run-1",
      head: {
        tailSeq: 0,
        prefixHash: EMPTY_RUN_JOURNAL_PREFIX_HASH_V1,
      },
    });
    expect(eventFiles(newRunRoot, "new-run-anchor")).toHaveLength(0);

    const root = tempRoot();
    let now = 0;
    const lease = acquired(
      acquire(
        options(root, "stale-anchor", "run-1", now, { clock: () => now }),
      ),
    );
    const input = linearizeInput("commit-anchor");
    await lease.linearizeJournalBatch(input);
    now = 1;
    expect(await lease.release()).toBe("released");
    const before = eventFiles(root, "stale-anchor").length;
    const stale = acquire(options(root, "stale-anchor", "run-1", now));
    expect(stale).toEqual({
      status: "anchor_conflict",
      runId: "run-1",
      head: input.nextHead,
    });
    expect(eventFiles(root, "stale-anchor")).toHaveLength(before);
    const resumed = acquired(
      acquire(
        options(root, "stale-anchor", "run-1", now, {
          baseTailSeq: input.nextHead.tailSeq,
          basePrefixHash: input.nextHead.prefixHash,
        }),
      ),
    );
    expect(await resumed.linearizeJournalBatch(input)).toMatchObject({
      status: "already_committed",
      eventSeq: 2,
    });
    const next = nextLinearizeInput(input.nextHead, "new-owner-next");
    expect(await resumed.linearizeJournalBatch(next)).toMatchObject({
      status: "committed",
      head: next.nextHead,
    });
    expect(await resumed.linearizeJournalBatch(input)).toEqual({
      status: "conflict",
      head: next.nextHead,
    });
  });

  test("a stale predecessor cannot confirm an exact current-head commit", async () => {
    const root = tempRoot();
    let now = 0;
    const predecessor = acquired(
      acquire(
        options(root, "stale-predecessor", "run-1", now, {
          ownerId: "owner-old",
          clock: () => now,
        }),
      ),
    );
    const input = linearizeInput("predecessor-commit");
    await predecessor.linearizeJournalBatch(input);
    now = 100;
    const successor = acquired(
      acquire(
        options(root, "stale-predecessor", "run-1", now, {
          ownerId: "owner-new",
          baseTailSeq: input.nextHead.tailSeq,
          basePrefixHash: input.nextHead.prefixHash,
          clock: () => now,
        }),
      ),
    );
    expect(await predecessor.linearizeJournalBatch(input)).toEqual({
      status: "lost",
    });
    expect(predecessor.signal.aborted).toBe(true);
    expect(await successor.linearizeJournalBatch(input)).toMatchObject({
      status: "already_committed",
      head: input.nextHead,
    });
  });

  test("a stale predecessor cannot observe conflict after its successor advances the head", async () => {
    const root = tempRoot();
    let now = 0;
    const predecessor = acquired(
      acquire(
        options(root, "advanced-successor", "run-1", now, {
          ownerId: "owner-old",
          clock: () => now,
        }),
      ),
    );
    const first = linearizeInput("owner-one-commit");
    await predecessor.linearizeJournalBatch(first);
    now = 100;
    const successor = acquired(
      acquire(
        options(root, "advanced-successor", "run-1", now, {
          ownerId: "owner-new",
          baseTailSeq: first.nextHead.tailSeq,
          basePrefixHash: first.nextHead.prefixHash,
          clock: () => now,
        }),
      ),
    );
    const second = nextLinearizeInput(first.nextHead, "owner-two-commit");
    expect(await successor.linearizeJournalBatch(second)).toMatchObject({
      status: "committed",
      head: second.nextHead,
    });
    expect(await predecessor.linearizeJournalBatch(first)).toEqual({
      status: "lost",
    });
    expect(predecessor.signal.aborted).toBe(true);
  });

  test("an expired owner cannot linearize without a successor", async () => {
    const root = tempRoot();
    let now = 0;
    const lease = acquired(
      acquire(
        options(root, "expired-commit", "run-1", now, { clock: () => now }),
      ),
    );
    const committed = linearizeInput("expired");
    await lease.linearizeJournalBatch(committed);
    now = 100;
    expect(await lease.linearizeJournalBatch(committed)).toEqual({
      status: "lost",
    });
    expect(lease.signal.aborted).toBe(true);
    expect(readEvents(root, "expired-commit").map(({ type }) => type)).toEqual([
      "claim",
      "journal_commit",
    ]);
  });

  test("one Session keeps independent journal heads for different runs", async () => {
    const root = tempRoot();
    let now = 0;
    const runOneInput = linearizeInput("run-one-commit");
    const runOne = acquired(
      acquire(options(root, "multi-run", "run-1", now, { clock: () => now })),
    );
    await runOne.linearizeJournalBatch(runOneInput);
    expect(await runOne.release()).toBe("released");

    now = 1;
    const runTwo = acquired(
      acquire(options(root, "multi-run", "run-2", now, { clock: () => now })),
    );
    const runTwoInput = linearizeInput("run-two-commit", {
      nextHead: { tailSeq: 1, prefixHash: "e".repeat(64) },
    });
    await runTwo.linearizeJournalBatch(runTwoInput);
    expect(await runTwo.release()).toBe("released");

    now = 2;
    expect(
      acquire(
        options(root, "multi-run", "run-1", now, {
          baseTailSeq: runTwoInput.nextHead.tailSeq,
          basePrefixHash: runTwoInput.nextHead.prefixHash,
        }),
      ).status,
    ).toBe("anchor_conflict");
    const resumedRunOne = acquired(
      acquire(
        options(root, "multi-run", "run-1", now, {
          baseTailSeq: runOneInput.nextHead.tailSeq,
          basePrefixHash: runOneInput.nextHead.prefixHash,
        }),
      ),
    );
    expect(resumedRunOne.fencingToken).toBe(3);
  });

  test("local heartbeat and commit are serialized in either call order", async () => {
    for (const first of ["heartbeat", "commit"] as const) {
      const root = tempRoot();
      let now = 0;
      const lease = acquired(
        acquire(
          options(root, `local-${first}`, "run-1", now, { clock: () => now }),
        ),
      );
      now = 1;
      const commit = () =>
        lease.linearizeJournalBatch(linearizeInput(`commit-${first}`));
      if (first === "heartbeat") {
        const [renewed, committed] = await Promise.all([
          lease.renew(),
          commit(),
        ]);
        expect(renewed).toBeUndefined();
        expect(committed.status).toBe("committed");
      } else {
        const [committed, renewed] = await Promise.all([
          commit(),
          lease.renew(),
        ]);
        expect(committed.status).toBe("committed");
        expect(renewed).toBeUndefined();
      }
      expect(
        readEvents(root, `local-${first}`).map(({ type }) => type),
      ).toEqual(
        first === "heartbeat"
          ? ["claim", "heartbeat", "journal_commit"]
          : ["claim", "journal_commit", "heartbeat"],
      );
    }
  });

  test("local release and commit are serialized in either call order", async () => {
    const releaseFirstRoot = tempRoot();
    const releaseFirst = acquired(
      acquire(options(releaseFirstRoot, "release-first", "run-1", 0)),
    );
    const [released, lostCommit] = await Promise.all([
      releaseFirst.release(),
      releaseFirst.linearizeJournalBatch(linearizeInput("after-release")),
    ]);
    expect(released).toBe("released");
    expect(lostCommit).toEqual({ status: "lost" });
    expect(
      readEvents(releaseFirstRoot, "release-first").map(({ type }) => type),
    ).toEqual(["claim", "release"]);

    const commitFirstRoot = tempRoot();
    const commitFirst = acquired(
      acquire(options(commitFirstRoot, "commit-first", "run-1", 0)),
    );
    const input = linearizeInput("before-release");
    const [committed, releasedAfter] = await Promise.all([
      commitFirst.linearizeJournalBatch(input),
      commitFirst.release(),
    ]);
    expect(committed.status).toBe("committed");
    expect(releasedAfter).toBe("released");
    expect(await commitFirst.linearizeJournalBatch(input)).toEqual({
      status: "lost",
    });
    expect(commitFirst.signal.aborted).toBe(true);
    expect(
      readEvents(commitFirstRoot, "commit-first").map(({ type }) => type),
    ).toEqual(["claim", "journal_commit", "release"]);
  });

  test("expired and superseded owners cannot write", async () => {
    const root = tempRoot();
    let now = 0;
    const first = acquired(
      acquire(
        options(root, "takeover", "run-1", now, {
          clock: () => now,
        }),
      ),
    );
    now = 100;
    expect(await first.release()).toBe("lost");
    expect(eventFiles(root, "takeover")).toHaveLength(1);
    const second = acquired(acquire(options(root, "takeover", "run-2", now)));
    expect(second.fencingToken).toBe(2);
    await expect(first.renew()).rejects.toThrow(SessionExecutionLeaseLostError);
    expect(await first.release()).toBe("lost");
    expect(eventFiles(root, "takeover")).toHaveLength(2);
  });

  test("clock rollback fails without writing", async () => {
    const renewRoot = tempRoot();
    let renewNow = 100;
    const renewing = acquired(
      acquire(
        options(renewRoot, "renew-clock", "run-1", renewNow, {
          clock: () => renewNow,
        }),
      ),
    );
    renewNow = 99;
    await expect(renewing.renew()).rejects.toThrow("clock moved");
    expect(eventFiles(renewRoot, "renew-clock")).toHaveLength(1);

    const releaseRoot = tempRoot();
    let releaseNow = 100;
    const releasing = acquired(
      acquire(
        options(releaseRoot, "release-clock", "run-1", releaseNow, {
          clock: () => releaseNow,
        }),
      ),
    );
    releaseNow = 99;
    await expect(releasing.release()).rejects.toThrow("clock moved");
    expect(eventFiles(releaseRoot, "release-clock")).toHaveLength(1);

    const commitRoot = tempRoot();
    let commitNow = 100;
    const committing = acquired(
      acquire(
        options(commitRoot, "commit-clock", "run-1", commitNow, {
          clock: () => commitNow,
        }),
      ),
    );
    commitNow = 99;
    expect(
      await committing.linearizeJournalBatch(linearizeInput("clock-rollback")),
    ).toEqual({ status: "lost" });
    expect(committing.signal.aborted).toBe(true);
    expect(eventFiles(commitRoot, "commit-clock")).toHaveLength(1);

    const afterReleaseRoot = tempRoot();
    let afterReleaseNow = 100;
    const released = acquired(
      acquire(
        options(afterReleaseRoot, "released-clock", "run-1", afterReleaseNow, {
          clock: () => afterReleaseNow,
        }),
      ),
    );
    expect(await released.release()).toBe("released");
    afterReleaseNow = 99;
    expect(() =>
      acquire(
        options(afterReleaseRoot, "released-clock", "run-2", afterReleaseNow),
      ),
    ).toThrow("clock moved");
    expect(eventFiles(afterReleaseRoot, "released-clock")).toHaveLength(2);
  });

  test("takeover and renewal from the same S have one winner", async () => {
    const result = await runTransitionRace("renew", "takeover");
    expect(result.owner.status).toBe("lost");
    expect(result.takeover.status).toBe("acquired");
    expect(result.events.map(({ type }) => type)).toEqual(["claim", "claim"]);
    expect(result.events.map(({ fencingToken }) => fencingToken)).toEqual([
      1, 2,
    ]);
    expect(acquire(options(result.root, "race", "probe", 100)).status).toBe(
      "busy",
    );
  });

  test("takeover and journal commit linearize correctly in either order", async () => {
    const takeoverFirst = await runTransitionRace("commit", "takeover");
    expect(takeoverFirst.owner.status).toBe("lost");
    expect(takeoverFirst.takeover.status).toBe("acquired");
    expect(takeoverFirst.events.map(({ type }) => type)).toEqual([
      "claim",
      "claim",
    ]);

    const commitFirst = await runTransitionRace("commit", "owner");
    expect(commitFirst.owner.status).toBe("committed");
    expect(commitFirst.takeover.status).toBe("anchor_conflict");
    expect(commitFirst.events.map(({ type }) => type)).toEqual([
      "claim",
      "journal_commit",
    ]);
  });

  test("a winning heartbeat makes the losing takeover return busy", async () => {
    const result = await runTransitionRace("renew", "owner");
    expect(result.owner.status).toBe("renewed");
    expect(result.takeover.status).toBe("busy");
    expect(result.events.map(({ type }) => type)).toEqual([
      "claim",
      "heartbeat",
    ]);
    expect(result.events.map(({ fencingToken }) => fencingToken)).toEqual([
      1, 1,
    ]);
  });

  test("release wins S+1 and takeover retries as valid S+2", async () => {
    const result = await runTransitionRace("release", "owner");
    expect(result.owner.status).toBe("released");
    expect(result.takeover.status).toBe("acquired");
    expect(result.events.map(({ type }) => type)).toEqual([
      "claim",
      "release",
      "claim",
    ]);
    expect(result.events.map(({ eventSeq }) => eventSeq)).toEqual([1, 2, 3]);
  });

  test("readers tolerate the publisher link-before-unlink window", async () => {
    const root = tempRoot();
    const linked = path.join(root, "linked");
    const cleanup = path.join(root, "cleanup");
    const publisher = runChild([
      fixture("session-lease-link-window-child.ts"),
      root,
      "link-window",
      linked,
      cleanup,
    ]);
    await waitFor(() => fs.existsSync(linked));
    const loserReady = path.join(root, "loser-ready");
    const loserGo = path.join(root, "loser-go");
    const loser = runChild([
      fixture("session-lease-claim-child.ts"),
      root,
      "link-window",
      "loser",
      loserReady,
      loserGo,
    ]);
    await waitFor(() => fs.existsSync(loserReady));
    fs.writeFileSync(loserGo, "go\n");
    await new Promise((resolve) => setTimeout(resolve, 40));
    fs.writeFileSync(cleanup, "go\n");
    expect(JSON.parse(await publisher)).toMatchObject({ status: "acquired" });
    expect(JSON.parse(await loser)).toMatchObject({ status: "busy" });
    expect(eventFiles(root, "link-window")).toHaveLength(1);
  });

  test("a reader recovers the publisher temp after an after-link crash", async () => {
    const root = tempRoot();
    const crashed = runChildExpectExit(
      [
        fixture("session-lease-crash-after-link-child.ts"),
        root,
        "crash-window",
      ],
      23,
    );
    await crashed;
    const eventPath = eventFiles(root, "crash-window")[0] as string;
    expect(fs.lstatSync(eventPath).nlink).toBe(2);
    const successor = acquired(
      acquire(options(root, "crash-window", "successor", 100)),
    );
    expect(successor.fencingToken).toBe(2);
    expect(fs.lstatSync(eventPath).nlink).toBe(1);
    expect(eventFiles(root, "crash-window")).toHaveLength(2);
  });

  test("strict inventory leaves legitimate publisher aliases byte-for-byte unchanged", async () => {
    const root = tempRoot();
    const sessionId = "readonly-publisher-window";
    const lease = acquired(acquire(options(root, sessionId, "run-1", 0)));
    await lease.linearizeJournalBatch(linearizeInput("readonly-commit"));
    const identity = identityPath(root, sessionId);
    const event = eventFiles(root, sessionId)[1] as string;
    const identityTemp = `${identity}.tmp-${process.pid}-${randomUUID()}`;
    const eventTemp = `${event}.tmp-${process.pid}-${randomUUID()}`;
    fs.linkSync(identity, identityTemp);
    fs.linkSync(event, eventTemp);
    const before = rawTreeSnapshot(root);

    const inventory = readFileSessionAuthorityInventoryV1({
      workspaceRoot: root,
      sessionId,
    });

    expect(inventory.runs.map(({ runId }) => runId)).toEqual(["run-1"]);
    expect(inventory.runs[0]?.head.tailSeq).toBe(1);
    expect(rawTreeSnapshot(root)).toEqual(before);
    expect(fs.existsSync(identityTemp)).toBe(true);
    expect(fs.existsSync(eventTemp)).toBe(true);

    // The ordinary reader retains its crash-recovery cleanup semantics.
    readFileSessionJournalCommitIndexV1({
      workspaceRoot: root,
      sessionId,
      runId: "run-1",
    });
    expect(fs.existsSync(identityTemp)).toBe(false);
    expect(fs.existsSync(eventTemp)).toBe(false);
  });

  test("strict inventory of an absent Session is empty and creates nothing", () => {
    const root = tempRoot();
    const before = rawTreeSnapshot(root);
    const first = readFileSessionAuthorityInventoryV1({
      workspaceRoot: root,
      sessionId: "absent-session",
    });
    const second = readFileSessionAuthorityInventoryV1({
      workspaceRoot: root,
      sessionId: "absent-session",
    });
    expect(first.runs).toEqual([]);
    expect(first.inventoryHash).toBe(second.inventoryHash);
    expect(rawTreeSnapshot(root)).toEqual(before);
  });

  test("strict inventory rejects a regular file workspace root without changing it", () => {
    const container = tempRoot();
    const fileRoot = path.join(container, "not-a-workspace");
    fs.writeFileSync(fileRoot, "unchanged\n");
    const before = fs.readFileSync(fileRoot);

    expect(() =>
      readFileSessionAuthorityInventoryV1({
        workspaceRoot: fileRoot,
        sessionId: "file-root",
      }),
    ).toThrow(/workspace root.*directory/i);
    expect(fs.readFileSync(fileRoot)).toEqual(before);
  });

  test("strict inventory is sorted, stable, and recursively immutable", async () => {
    const root = tempRoot();
    const sessionId = "inventory-multi-run";
    let now = 0;
    const runZ = acquired(
      acquire(options(root, sessionId, "run-z", now, { clock: () => now })),
    );
    const zCommit = linearizeInput("z-commit");
    await runZ.linearizeJournalBatch(zCommit);
    await runZ.release();
    now = 1;
    const runA = acquired(
      acquire(options(root, sessionId, "run-a", now, { clock: () => now })),
    );
    const aCommit = linearizeInput("a-commit", {
      nextHead: { tailSeq: 1, prefixHash: "e".repeat(64) },
    });
    await runA.linearizeJournalBatch(aCommit);
    await runA.release();
    now = 2;
    acquired(
      acquire(options(root, sessionId, "run-empty", now, { clock: () => now })),
    );

    const first = readFileSessionAuthorityInventoryV1({
      workspaceRoot: root,
      sessionId,
    });
    const second = readFileSessionAuthorityInventoryV1({
      workspaceRoot: root,
      sessionId,
    });
    expect(first).toEqual(second);
    expect(first.runs.map(({ runId }) => runId)).toEqual(["run-a", "run-z"]);
    expect(
      first.runs.map(({ commits }) => commits.map(({ commitId }) => commitId)),
    ).toEqual([["a-commit"], ["z-commit"]]);
    expect(isRecursivelyFrozen(first)).toBe(true);
    expect(first.inventoryHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("strict inventory fails closed for partial and damaged authority", () => {
    const partialRoot = tempRoot();
    const partialOwnership = ownershipDir(partialRoot, "partial");
    fs.mkdirSync(path.dirname(partialOwnership), { recursive: true });
    const partialBefore = rawTreeSnapshot(partialRoot);
    expect(() =>
      readFileSessionAuthorityInventoryV1({
        workspaceRoot: partialRoot,
        sessionId: "partial",
      }),
    ).toThrow("partially missing");
    expect(rawTreeSnapshot(partialRoot)).toEqual(partialBefore);

    const missingRoot = tempRoot();
    acquired(acquire(options(missingRoot, "missing-events", "run-1", 0)));
    fs.rmSync(eventsDir(missingRoot, "missing-events"), { recursive: true });
    const missingBefore = rawTreeSnapshot(missingRoot);
    expect(() =>
      readFileSessionAuthorityInventoryV1({
        workspaceRoot: missingRoot,
        sessionId: "missing-events",
      }),
    ).toThrow("partially missing");
    expect(rawTreeSnapshot(missingRoot)).toEqual(missingBefore);

    const danglingRoot = tempRoot();
    const danglingSessionDir = path.dirname(
      ownershipDir(danglingRoot, "dangling-session"),
    );
    fs.mkdirSync(path.dirname(danglingSessionDir), { recursive: true });
    const removedTarget = tempRoot();
    fs.symlinkSync(
      removedTarget,
      danglingSessionDir,
      process.platform === "win32" ? "junction" : "dir",
    );
    fs.rmSync(removedTarget, { recursive: true });
    const danglingBefore = rawTreeSnapshot(danglingRoot);
    expect(() =>
      readFileSessionAuthorityInventoryV1({
        workspaceRoot: danglingRoot,
        sessionId: "dangling-session",
      }),
    ).toThrow("symbolic link");
    expect(rawTreeSnapshot(danglingRoot)).toEqual(danglingBefore);

    const corruptRoot = tempRoot();
    acquired(acquire(options(corruptRoot, "inventory-corrupt", "run-1", 0)));
    fs.writeFileSync(
      eventFiles(corruptRoot, "inventory-corrupt")[0] as string,
      "{bad\n",
    );
    expect(() =>
      readFileSessionAuthorityInventoryV1({
        workspaceRoot: corruptRoot,
        sessionId: "inventory-corrupt",
      }),
    ).toThrow("valid JSON");
  });

  test("strict parsing rejects damage, gaps, bad hashes and foreign entries", async () => {
    const corruptRoot = tempRoot();
    acquired(acquire(options(corruptRoot, "corrupt", "run-1", 0)));
    fs.writeFileSync(eventFiles(corruptRoot, "corrupt")[0] as string, "{bad\n");
    expect(() =>
      acquire(options(corruptRoot, "corrupt", "run-2", 100)),
    ).toThrow("valid JSON");

    const gapRoot = tempRoot();
    acquired(acquire(options(gapRoot, "gap", "run-1", 0)));
    const first = eventFiles(gapRoot, "gap")[0] as string;
    fs.renameSync(
      first,
      path.join(path.dirname(first), "0000000000000002.json"),
    );
    expect(() => acquire(options(gapRoot, "gap", "run-2", 100))).toThrow(
      "contiguous",
    );

    const hashRoot = tempRoot();
    let now = 0;
    const hashLease = acquired(
      acquire(options(hashRoot, "hash", "run-1", now, { clock: () => now })),
    );
    now = 1;
    await hashLease.renew();
    const second = eventFiles(hashRoot, "hash")[1] as string;
    const damaged = readJson(second);
    damaged.previousEventHash = "f".repeat(64);
    fs.writeFileSync(second, `${JSON.stringify(damaged)}\n`);
    expect(() => acquire(options(hashRoot, "hash", "run-2", 100))).toThrow(
      "previousEventHash",
    );

    const unknownRoot = tempRoot();
    acquired(acquire(options(unknownRoot, "unknown", "run-1", 0)));
    fs.writeFileSync(
      path.join(eventsDir(unknownRoot, "unknown"), "foreign.tmp"),
      "x",
    );
    expect(() =>
      acquire(options(unknownRoot, "unknown", "run-2", 100)),
    ).toThrow("Unrecognized");

    const staleTempRoot = tempRoot();
    acquired(acquire(options(staleTempRoot, "temp", "run-1", 0)));
    fs.writeFileSync(
      path.join(
        eventsDir(staleTempRoot, "temp"),
        `0000000000000002.json.tmp-1-${randomUUID()}`,
      ),
      "stale",
    );
    expect(acquire(options(staleTempRoot, "temp", "run-2", 1)).status).toBe(
      "busy",
    );

    const linkedTempRoot = tempRoot();
    acquired(acquire(options(linkedTempRoot, "linked-temp", "run-1", 0)));
    const outsideDirectory = tempRoot();
    fs.symlinkSync(
      outsideDirectory,
      path.join(
        eventsDir(linkedTempRoot, "linked-temp"),
        `0000000000000002.json.tmp-1-${randomUUID()}`,
      ),
      process.platform === "win32" ? "junction" : "dir",
    );
    expect(() =>
      acquire(options(linkedTempRoot, "linked-temp", "run-2", 1)),
    ).toThrow("temporary event is invalid");
    expect(() =>
      acquire(
        options(tempRoot(), "bad-base", "run-1", 0, {
          basePrefixHash: "NOT-A-HASH",
        }),
      ),
    ).toThrow("lowercase sha256");
  });

  test("formal identity and event hardlink aliases fail closed", async () => {
    const eventRoot = tempRoot();
    const eventLease = acquired(
      acquire(options(eventRoot, "event-link", "run-1", 0)),
    );
    fs.linkSync(
      eventFiles(eventRoot, "event-link")[0] as string,
      path.join(eventRoot, "alias.json"),
    );
    expect(() => eventLease.assertHeld()).toThrow(
      SessionExecutionLeaseLostError,
    );

    const identityRoot = tempRoot();
    acquired(acquire(options(identityRoot, "identity-link", "run-1", 0)));
    fs.linkSync(
      identityPath(identityRoot, "identity-link"),
      path.join(identityRoot, "identity-alias.json"),
    );
    expect(() =>
      acquire(options(identityRoot, "identity-link", "run-2", 100)),
    ).toThrow("external hardlink");

    const slotRoot = tempRoot();
    let now = 0;
    const slotLease = acquired(
      acquire(
        options(slotRoot, "slot-link", "run-1", now, { clock: () => now }),
      ),
    );
    const outside = path.join(slotRoot, "outside.json");
    fs.writeFileSync(outside, "{}\n");
    fs.linkSync(
      outside,
      path.join(eventsDir(slotRoot, "slot-link"), "0000000000000002.json"),
    );
    now = 1;
    await expect(slotLease.renew()).rejects.toThrow("hardlink");
  });

  test("post-acquire events ancestor swaps fail closed for every operation", async () => {
    for (const operation of ["assert", "renew", "release", "claim"] as const) {
      const root = tempRoot();
      const sessionId = `swap-${operation}`;
      let now = 0;
      const lease = acquired(
        acquire(options(root, sessionId, "run-1", now, { clock: () => now })),
      );
      const originalEvents = eventsDir(root, sessionId);
      fs.renameSync(originalEvents, `${originalEvents}.saved`);
      const outside = tempRoot();
      fs.symlinkSync(
        outside,
        originalEvents,
        process.platform === "win32" ? "junction" : "dir",
      );
      now = 1;
      if (operation === "assert")
        expect(() => lease.assertHeld()).toThrow(
          SessionExecutionLeaseLostError,
        );
      else if (operation === "renew")
        await expect(lease.renew()).rejects.toThrow(
          SessionExecutionLeaseLostError,
        );
      else if (operation === "release")
        await expect(lease.release()).rejects.toThrow("symbolic link");
      else
        expect(() => acquire(options(root, sessionId, "run-2", now))).toThrow(
          "symbolic link",
        );
      expect(fs.readdirSync(outside)).toEqual([]);
    }
  });

  test("post-acquire ownership parent swap cannot redirect authority", () => {
    const root = tempRoot();
    const lease = acquired(acquire(options(root, "parent-swap", "run-1", 0)));
    const originalOwnership = ownershipDir(root, "parent-swap");
    fs.renameSync(originalOwnership, `${originalOwnership}.saved`);
    const outside = tempRoot();
    fs.symlinkSync(
      outside,
      originalOwnership,
      process.platform === "win32" ? "junction" : "dir",
    );
    expect(() => lease.assertHeld()).toThrow(SessionExecutionLeaseLostError);
    expect(() => acquire(options(root, "parent-swap", "run-2", 100))).toThrow(
      "symbolic link",
    );
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  test("deleting events after identity exists never recreates authority", () => {
    const root = tempRoot();
    acquired(acquire(options(root, "deleted-events", "run-1", 0)));
    fs.rmSync(eventsDir(root, "deleted-events"), { recursive: true });
    expect(() =>
      acquire(options(root, "deleted-events", "run-2", 100)),
    ).toThrow();
    expect(fs.existsSync(eventsDir(root, "deleted-events"))).toBe(false);
  });
});

interface ChildClaimResult {
  readonly status: "acquired" | "busy";
  readonly token: number;
  readonly ownerId: string;
}

function acquire(value: FileSessionExecutionLeaseOptionsV1) {
  return acquireFileSessionExecutionLeaseV1(value);
}

function options(
  root: string,
  sessionId: string,
  runId: string,
  now: number,
  overrides: Partial<FileSessionExecutionLeaseOptionsV1> = {},
): FileSessionExecutionLeaseOptionsV1 {
  return {
    workspaceRoot: root,
    sessionId,
    runId,
    ttlMs: 100,
    baseTailSeq: 0,
    basePrefixHash: BASE_PREFIX_HASH,
    clock: () => now,
    ...overrides,
  };
}

function linearizeInput(
  commitId: string,
  overrides: Partial<LinearizeJournalBatchInputV1> = {},
): LinearizeJournalBatchInputV1 {
  const artifactHash = "c".repeat(64);
  return {
    commitId,
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
    ...overrides,
  };
}

function nextLinearizeInput(
  expectedHead: LinearizeJournalBatchInputV1["expectedHead"],
  commitId: string,
): LinearizeJournalBatchInputV1 {
  const artifactHash = "e".repeat(64);
  const startSeq = expectedHead.tailSeq + 1;
  const endSeq = startSeq;
  return {
    commitId,
    expectedHead,
    nextHead: { tailSeq: endSeq, prefixHash: "f".repeat(64) },
    batchStartSeq: startSeq,
    batchEndSeq: endSeq,
    artifactId: artifactHash,
    artifactFileName: `${String(startSeq).padStart(16, "0")}-${String(
      endSeq,
    ).padStart(16, "0")}-${artifactHash}.json`,
    artifactContentHash: artifactHash,
  };
}

function acquired(result: ReturnType<typeof acquire>) {
  if (result.status !== "acquired") throw new Error("expected acquired lease");
  return result.lease;
}

async function runTransitionRace(
  ownerMode: "renew" | "release" | "commit",
  first: "owner" | "takeover",
) {
  const root = tempRoot();
  const claimed = path.join(root, "claimed");
  const ownerReady = path.join(root, "owner-ready");
  const ownerGo = path.join(root, "owner-go");
  const takeoverReady = path.join(root, "takeover-ready");
  const takeoverGo = path.join(root, "takeover-go");
  const script = fixture("session-lease-transition-child.ts");
  const ownerRunId = ownerMode === "commit" ? "journal-run" : "owner-run";
  const takeoverRunId = ownerMode === "commit" ? "journal-run" : "takeover-run";
  const owner = runChild([
    script,
    ownerMode,
    root,
    "race",
    ownerRunId,
    ownerReady,
    ownerGo,
    claimed,
  ]);
  await waitFor(() => fs.existsSync(claimed));
  const takeover = runChild([
    script,
    "takeover",
    root,
    "race",
    takeoverRunId,
    takeoverReady,
    takeoverGo,
    path.join(root, "unused"),
  ]);
  await waitFor(() => fs.existsSync(takeoverReady));
  fs.writeFileSync(`${claimed}.act`, "act\n");
  await waitFor(() => fs.existsSync(ownerReady));
  if (first === "owner") {
    fs.writeFileSync(ownerGo, "go\n");
    await owner;
    fs.writeFileSync(takeoverGo, "go\n");
  } else {
    fs.writeFileSync(takeoverGo, "go\n");
    await takeover;
    fs.writeFileSync(ownerGo, "go\n");
  }
  return {
    root,
    owner: JSON.parse(await owner) as { status: string },
    takeover: JSON.parse(await takeover) as { status: string },
    events: readEvents(root, "race"),
  };
}

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paw-session-lease-"));
  roots.push(root);
  return root;
}

function fixture(name: string): string {
  return path.join(import.meta.dir, "fixtures", name);
}

function ownershipDir(root: string, sessionId: string): string {
  return path.join(
    root,
    ".paw",
    "paw-next",
    "sessions",
    createHash("sha256").update(sessionId).digest("hex"),
    "ownership",
  );
}

function eventsDir(root: string, sessionId: string): string {
  return path.join(ownershipDir(root, sessionId), "events");
}

function identityPath(root: string, sessionId: string): string {
  return path.join(ownershipDir(root, sessionId), "identity.json");
}

function eventFiles(root: string, sessionId: string): string[] {
  return fs
    .readdirSync(eventsDir(root, sessionId))
    .filter((name) => /^\d{16}\.json$/.test(name))
    .sort()
    .map((name) => path.join(eventsDir(root, sessionId), name));
}

function readEvents(
  root: string,
  sessionId: string,
): Record<string, unknown>[] {
  return eventFiles(root, sessionId).map(readJson);
}

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<
    string,
    unknown
  >;
}

function hashFile(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function rawTreeSnapshot(root: string): string {
  const entries: Array<Readonly<Record<string, string | number>>> = [];
  const visit = (directory: string): void => {
    for (const name of fs.readdirSync(directory).sort()) {
      const full = path.join(directory, name);
      const relative = path.relative(root, full);
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) {
        entries.push({
          path: relative,
          type: "symlink",
          target: fs.readlinkSync(full),
        });
      } else if (stat.isDirectory()) {
        entries.push({ path: relative, type: "directory" });
        visit(full);
      } else {
        entries.push({
          path: relative,
          type: "file",
          nlink: stat.nlink,
          size: stat.size,
          hash: hashFile(full),
        });
      }
    }
  };
  visit(root);
  return JSON.stringify(entries);
}

function isRecursivelyFrozen(value: unknown): boolean {
  if (value === null || typeof value !== "object") return true;
  if (!Object.isFrozen(value)) return false;
  return Object.values(value).every(isRecursivelyFrozen);
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
      else reject(new Error(`lease child exited ${code}: ${stderr}`));
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
      else reject(new Error(`lease crash child exited ${code}: ${stderr}`));
    });
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("child process ready timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
