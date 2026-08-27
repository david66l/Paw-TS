import { afterEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  EMPTY_RUN_JOURNAL_PREFIX_HASH_V1,
  type FileSessionExecutionLeaseV1,
  type LinearizeJournalBatchInputV1,
  acquireFileSessionExecutionLeaseV1,
  discoverFileSessionAuthoritiesV1,
} from "../src/index.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("strict read-only Session authority discovery", () => {
  test("an absent sessions root returns empty without creating storage", () => {
    const root = tempRoot();
    const before = rawTreeSnapshot(root);
    const result = discoverFileSessionAuthoritiesV1({ workspaceRoot: root });
    expect(result).toEqual({
      schemaVersion: "paw.file-session-authority-discovery.v1",
      entries: [],
    });
    expect(rawTreeSnapshot(root)).toBe(before);
    expect(isRecursivelyFrozen(result)).toBe(true);
  });

  test("discovers identities from hashed directories and only runs committed by authority", async () => {
    const root = tempRoot();
    const alpha = acquire(root, "session-alpha", "run-authority");
    await alpha.linearizeJournalBatch(linearizeInput("alpha-commit"));
    acquire(root, "session-zeta", "run-empty");
    const orphanRunDir = path.join(
      sessionDir(root, "session-alpha"),
      hashText("run-orphan"),
    );
    fs.mkdirSync(path.join(orphanRunDir, "journal-artifacts"), {
      recursive: true,
    });
    fs.writeFileSync(path.join(orphanRunDir, "orphan.txt"), "not authority\n");

    const first = discoverFileSessionAuthoritiesV1({ workspaceRoot: root });
    const second = discoverFileSessionAuthoritiesV1({ workspaceRoot: root });
    expect(first).toEqual(second);
    expect(first.entries.map(({ entryName }) => entryName)).toEqual(
      [...first.entries.map(({ entryName }) => entryName)].sort(),
    );
    const discovered = first.entries.filter(
      (entry) => entry.status === "discovered",
    );
    expect(discovered.map(({ sessionId }) => sessionId).sort()).toEqual([
      "session-alpha",
      "session-zeta",
    ]);
    expect(
      discovered.find(({ sessionId }) => sessionId === "session-alpha")
        ?.inventory.runs,
    ).toMatchObject([{ runId: "run-authority" }]);
    expect(
      discovered.find(({ sessionId }) => sessionId === "session-zeta")
        ?.inventory.runs,
    ).toEqual([]);
    expect(
      discovered.flatMap(({ inventory }) =>
        inventory.runs.map(({ runId }) => runId),
      ),
    ).not.toContain("run-orphan");
    expect(isRecursivelyFrozen(first)).toBe(true);
  });

  test("accepts publisher aliases without changing any authority bytes", async () => {
    const root = tempRoot();
    const sessionId = "publisher-session";
    const lease = acquire(root, sessionId, "run-1");
    await lease.linearizeJournalBatch(linearizeInput("publisher-commit"));
    const identity = path.join(ownershipDir(root, sessionId), "identity.json");
    const event = eventFiles(root, sessionId)[1] as string;
    const identityTemp = `${identity}.tmp-${process.pid}-${randomUUID()}`;
    const eventTemp = `${event}.tmp-${process.pid}-${randomUUID()}`;
    fs.linkSync(identity, identityTemp);
    fs.linkSync(event, eventTemp);
    const before = rawTreeSnapshot(root);

    const result = discoverFileSessionAuthoritiesV1({ workspaceRoot: root });

    expect(result.entries).toMatchObject([{ status: "discovered", sessionId }]);
    expect(rawTreeSnapshot(root)).toBe(before);
    expect(fs.existsSync(identityTemp)).toBe(true);
    expect(fs.existsSync(eventTemp)).toBe(true);
  });

  test("isolates malformed Sessions with stable reason codes", async () => {
    const root = tempRoot();
    const healthy = acquire(root, "healthy", "run-1");
    await healthy.linearizeJournalBatch(linearizeInput("healthy-commit"));

    acquire(root, "bad-authority", "run-1");
    fs.writeFileSync(eventFiles(root, "bad-authority")[0] as string, "{bad\n");

    acquire(root, "identity-mismatch", "run-1");
    fs.writeFileSync(
      path.join(ownershipDir(root, "identity-mismatch"), "identity.json"),
      `${JSON.stringify({
        schemaVersion: "paw.session-execution-lease-identity.v1",
        sessionId: "different-id",
      })}\n`,
    );

    const sessions = sessionsRoot(root);
    fs.mkdirSync(path.join(sessions, hashText("partial")));
    fs.writeFileSync(path.join(sessions, "foreign-entry"), "x");
    fs.writeFileSync(path.join(sessions, "f".repeat(64)), "x");
    const outside = tempRoot();
    fs.symlinkSync(
      outside,
      path.join(sessions, hashText("linked-session")),
      process.platform === "win32" ? "junction" : "dir",
    );

    const before = rawTreeSnapshot(root);
    const result = discoverFileSessionAuthoritiesV1({ workspaceRoot: root });
    expect(rawTreeSnapshot(root)).toBe(before);
    expect(
      result.entries.find(
        (entry) =>
          entry.status === "discovered" && entry.sessionId === "healthy",
      ),
    ).toBeDefined();
    expect(corruptReasonByEntry(result.entries)).toEqual({
      [hashText("bad-authority")]: "authority_corrupt",
      [hashText("identity-mismatch")]: "identity_storage_key_mismatch",
      [hashText("linked-session")]: "unsafe_session_directory",
      [hashText("partial")]: "identity_invalid",
      ["f".repeat(64)]: "unsafe_session_directory",
      "foreign-entry": "unrecognized_session_entry",
    });
    expect(
      result.entries.filter(({ status }) => status === "corrupt"),
    ).toHaveLength(6);
  });

  test("an unsafe shared sessions root fails the whole scan without following it", () => {
    const root = tempRoot();
    const outside = tempRoot();
    fs.mkdirSync(path.dirname(sessionsRoot(root)), { recursive: true });
    fs.symlinkSync(
      outside,
      sessionsRoot(root),
      process.platform === "win32" ? "junction" : "dir",
    );
    const outsideBefore = rawTreeSnapshot(outside);
    expect(() =>
      discoverFileSessionAuthoritiesV1({ workspaceRoot: root }),
    ).toThrow("symbolic link");
    expect(rawTreeSnapshot(outside)).toBe(outsideBefore);
  });
});

function acquire(
  root: string,
  sessionId: string,
  runId: string,
): FileSessionExecutionLeaseV1 {
  const result = acquireFileSessionExecutionLeaseV1({
    workspaceRoot: root,
    sessionId,
    runId,
    ttlMs: 1_000,
    baseTailSeq: 0,
    basePrefixHash: EMPTY_RUN_JOURNAL_PREFIX_HASH_V1,
    clock: () => 0,
  });
  if (result.status !== "acquired") throw new Error("expected lease");
  return result.lease;
}

function linearizeInput(commitId: string): LinearizeJournalBatchInputV1 {
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
  };
}

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paw-authority-scan-"));
  roots.push(root);
  return root;
}

function sessionsRoot(root: string): string {
  return path.join(root, ".paw", "paw-next", "sessions");
}

function sessionDir(root: string, sessionId: string): string {
  return path.join(sessionsRoot(root), hashText(sessionId));
}

function ownershipDir(root: string, sessionId: string): string {
  return path.join(sessionDir(root, sessionId), "ownership");
}

function eventFiles(root: string, sessionId: string): string[] {
  const directory = path.join(ownershipDir(root, sessionId), "events");
  return fs
    .readdirSync(directory)
    .filter((name) => /^\d{16}\.json$/.test(name))
    .sort()
    .map((name) => path.join(directory, name));
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function corruptReasonByEntry(
  entries: ReturnType<typeof discoverFileSessionAuthoritiesV1>["entries"],
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    entries.flatMap((entry) =>
      entry.status === "corrupt" ? [[entry.entryName, entry.reason]] : [],
    ),
  );
}

function rawTreeSnapshot(root: string): string {
  const entries: Array<Readonly<Record<string, string | number>>> = [];
  const visit = (directory: string): void => {
    for (const name of fs.readdirSync(directory).sort()) {
      const full = path.join(directory, name);
      const stat = fs.lstatSync(full);
      const relative = path.relative(root, full);
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
          hash: createHash("sha256")
            .update(fs.readFileSync(full))
            .digest("hex"),
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
