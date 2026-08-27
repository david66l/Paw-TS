import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";
import {
  EMPTY_RUN_JOURNAL_PREFIX_HASH_V1,
  acquireFileSessionExecutionLeaseV1,
} from "@paw/runtime";

import {
  LEGACY_RUN_EVIDENCE_POLICY_VERSION_V1,
  LEGACY_RUN_SOURCE_KIND_V1,
  type LegacyRunInventoryEntryV1,
  discoverLegacyPawRunsForTestV1,
  discoverLegacyPawRunsV1,
  exportLegacyPawRunEvidenceForTestV1,
  exportLegacyPawRunEvidenceV1,
  inspectLegacyPawRunV1,
} from "../src/paw-next/legacy-run-offline.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("legacy Core JSONL + AppState offline evidence", () => {
  test("strictly inventories paired, partial, corrupt, and ambiguous sources without writing", () => {
    const root = temporaryDirectory("paw-legacy-inventory-");
    writePair(root, "paired");
    writeJournal(root, "journal-only");
    writeState(root, "state-only");
    writeState(root, "corrupt");
    writeRaw(root, ".paw/sessions/corrupt.jsonl", Buffer.from("not-json\n"));

    // The legacy journal filename sanitizer aliases `a/b` and `a_b`.
    writeJournal(root, "a/b", "a_b.jsonl");
    writeState(root, "a_b");
    const before = snapshotTree(root);

    const inventory = discoverLegacyPawRunsV1({ legacyRuntimeRoot: root });

    expect(entry(inventory.entries, "paired").status).toBe("paired_unbound");
    expect(entry(inventory.entries, "journal-only").status).toBe(
      "journal_only",
    );
    expect(entry(inventory.entries, "state-only").status).toBe("state_only");
    expect(entry(inventory.entries, "corrupt").status).toBe("corrupt");
    expect(entry(inventory.entries, "a/b").status).toBe("ambiguous");
    expect(entry(inventory.entries, "a_b").status).toBe("ambiguous");
    expect(entry(inventory.entries, "a/b").issues).toContain(
      "sanitized_run_id_alias",
    );
    expect(inventory.entries.every((item) => item.continuable === false)).toBe(
      true,
    );
    expect(Object.isFrozen(inventory)).toBe(true);
    expect(Object.isFrozen(inventory.entries)).toBe(true);
    expect(Object.isFrozen(inventory.entries[0]?.issues)).toBe(true);
    expect(snapshotTree(root)).toEqual(before);
  });

  test("marks sequence gaps and malformed AppState identity as corrupt instead of normalizing them", () => {
    const root = temporaryDirectory("paw-legacy-corrupt-shapes-");
    writePair(root, "seq-gap");
    writeRaw(
      root,
      ".paw/sessions/seq-gap.jsonl",
      Buffer.from(
        `${JSON.stringify({
          runId: "seq-gap",
          seq: 1,
          ts: 1,
          event: { type: "run.started", goal: "x" },
        })}\n${JSON.stringify({
          runId: "seq-gap",
          seq: 3,
          ts: 2,
          event: { type: "run.failed", message: "gap" },
        })}\n`,
      ),
    );
    writeJournal(root, "bad-state");
    writeRaw(
      root,
      ".paw/states/bad-state.json",
      Buffer.from(
        JSON.stringify({
          runId: "different-run",
          goal: "x",
          workspaceRoot: root,
          turn: 0,
          maxSteps: 1,
          messages: [],
          savedAt: 1,
        }),
      ),
    );

    const inventory = discoverLegacyPawRunsV1({ legacyRuntimeRoot: root });

    expect(entry(inventory.entries, "seq-gap")).toMatchObject({
      status: "corrupt",
      issues: expect.arrayContaining(["journal_invalid"]),
    });
    expect(entry(inventory.entries, "different-run")).toMatchObject({
      status: "ambiguous",
      issues: expect.arrayContaining(["source_name_mismatch"]),
    });
    expect(entry(inventory.entries, "bad-state")).toMatchObject({
      status: "journal_only",
      issues: expect.arrayContaining(["app_state_missing"]),
    });
  });

  test("pairs a special journal runId through the legacy filename sanitizer without treating it as a path", () => {
    const root = temporaryDirectory("paw-legacy-sanitized-id-");
    writeJournal(root, "solo/id", "solo_id.jsonl");

    const inventory = discoverLegacyPawRunsV1({ legacyRuntimeRoot: root });
    const found = entry(inventory.entries, "solo/id");

    expect(found.status).toBe("journal_only");
    expect(found.issues).not.toContain("source_name_mismatch");
    expect(found.issues).not.toContain("sanitized_run_id_alias");
    expect(
      fs.existsSync(path.join(root, ".paw", "sessions", "solo_id.jsonl")),
    ).toBe(true);
    expect(fs.existsSync(path.join(root, "solo"))).toBe(false);
  });

  test("missing fixed directories produce a stable empty frozen inventory without creating .paw", () => {
    const root = temporaryDirectory("paw-legacy-empty-");
    const before = snapshotTree(root);

    const first = discoverLegacyPawRunsV1({ legacyRuntimeRoot: root });
    const second = discoverLegacyPawRunsV1({ legacyRuntimeRoot: root });

    expect(first.entries).toEqual([]);
    expect(first).toEqual(second);
    expect(first.inventoryHash).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.isFrozen(first)).toBe(true);
    expect(snapshotTree(root)).toEqual(before);
    expect(fs.existsSync(path.join(root, ".paw"))).toBe(false);
  });

  test("never follows the untrusted AppState workspaceRoot and reports the omitted external-artifact scope", () => {
    const root = temporaryDirectory("paw-legacy-root-a-");
    const lure = temporaryDirectory("paw-legacy-root-b-");
    writePair(root, "run-a", { appWorkspaceRoot: lure });
    writePair(lure, "run-a", { goal: "secret lure goal" });
    fs.mkdirSync(path.join(root, ".paw", "checkpoints", "run-a"), {
      recursive: true,
    });
    fs.mkdirSync(path.join(root, ".paw", "sessions", "run-a", "tool-results"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(root, ".paw", "sessions", "run-a", "tool-results", "x.txt"),
      "sidecar-secret",
    );
    const rootBefore = snapshotTree(root);
    const lureBefore = snapshotTree(lure);

    const inventory = discoverLegacyPawRunsV1({ legacyRuntimeRoot: root });
    const found = entry(inventory.entries, "run-a");

    expect(found.status).toBe("paired_unbound");
    expect(found.issues).toEqual([
      "app_state_workspace_untrusted",
      "external_artifacts_not_collected",
    ]);
    expect(snapshotTree(root)).toEqual(rootBefore);
    expect(snapshotTree(lure)).toEqual(lureBefore);
  });

  test("inspection is anchored to inventory and returns detached immutable summaries", () => {
    const root = temporaryDirectory("paw-legacy-inspect-");
    writePair(root, "inspect-me", { outcome: true });
    const inventory = discoverLegacyPawRunsV1({ legacyRuntimeRoot: root });

    const inspected = inspectLegacyPawRunV1({
      legacyRuntimeRoot: root,
      sourceKind: LEGACY_RUN_SOURCE_KIND_V1,
      runId: "inspect-me",
      expectedInventoryHash: inventory.inventoryHash,
    });

    expect(inspected).toMatchObject({
      schemaVersion: "paw.legacy-run-inspection.v1",
      status: "paired_unbound",
      continuable: false,
      journal: {
        eventCount: 2,
        firstSeq: 1,
        lastSeq: 2,
        eventTypes: ["run.started", "run.succeeded"],
      },
      appState: { turn: 2, maxSteps: 8, hasOutcome: true },
    });
    expect(Object.isFrozen(inspected)).toBe(true);
    expect(Object.isFrozen(inspected.journal?.eventTypes)).toBe(true);

    writeJournal(root, "new-run");
    expect(() =>
      inspectLegacyPawRunV1({
        legacyRuntimeRoot: root,
        sourceKind: LEGACY_RUN_SOURCE_KIND_V1,
        runId: "inspect-me",
        expectedInventoryHash: inventory.inventoryHash,
      }),
    ).toThrow("inventory changed");
  });

  test("exports deterministic raw-byte evidence with an explicitly incomplete, non-continuable scope", () => {
    const root = temporaryDirectory("paw-legacy-export-");
    const outputs = temporaryDirectory("paw-legacy-output-");
    const { journalBytes, stateBytes } = writePair(root, "raw-run", {
      appWorkspaceRoot: "C:\\untrusted\\workspace",
    });
    const sourceBefore = snapshotTree(root);
    const inventory = discoverLegacyPawRunsV1({ legacyRuntimeRoot: root });
    const found = entry(inventory.entries, "raw-run");
    const firstPath = path.join(outputs, "one.paw-legacy.json");
    const secondPath = path.join(outputs, "two.paw-legacy.json");

    const first = exportLegacyPawRunEvidenceV1({
      legacyRuntimeRoot: root,
      sourceKind: LEGACY_RUN_SOURCE_KIND_V1,
      runId: "raw-run",
      outputPath: firstPath,
      expectedInventoryHash: inventory.inventoryHash,
      expectedPairDigest: found.pairDigest,
    });
    const second = exportLegacyPawRunEvidenceV1({
      legacyRuntimeRoot: root,
      sourceKind: LEGACY_RUN_SOURCE_KIND_V1,
      runId: "raw-run",
      outputPath: secondPath,
      expectedInventoryHash: inventory.inventoryHash,
      expectedPairDigest: found.pairDigest,
    });

    expect(first).toMatchObject({
      status: "exported",
      sourceStatus: "paired_unbound",
      continuable: false,
    });
    expect(second).toEqual(first);
    expect(fs.readFileSync(secondPath)).toEqual(fs.readFileSync(firstPath));
    const bundleText = fs.readFileSync(firstPath, "utf8");
    const bundle = JSON.parse(bundleText) as EvidenceBundle;
    expect(bundle).toMatchObject({
      schemaVersion: "paw.legacy-run-evidence.v1",
      evidenceKind: "legacy_core_storage_evidence",
      scope: "core_journal_and_app_state_only",
      externalArtifacts: "not_collected",
      sourceKind: LEGACY_RUN_SOURCE_KIND_V1,
      runId: "raw-run",
      sourceStatus: "paired_unbound",
      continuable: false,
    });
    expect(bundle).not.toHaveProperty("createdAt");
    expect(bundle).not.toHaveProperty("outputPath");
    expect(bundleText).not.toContain("raw-run.jsonl");
    expect(
      bundle.sourceFiles.every((source) =>
        /^[0-9a-f]{64}$/.test(source.entryNameHash),
      ),
    ).toBe(true);
    expect(sourceBytes(bundle, "session_journal")).toEqual(journalBytes);
    expect(sourceBytes(bundle, "app_state")).toEqual(stateBytes);
    expect(bundle.sourceFiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "session_journal",
          sha256: sha256(journalBytes),
        }),
        expect.objectContaining({
          role: "app_state",
          sha256: sha256(stateBytes),
        }),
      ]),
    );
    expect(snapshotTree(root)).toEqual(sourceBefore);
    if (process.platform !== "win32") {
      expect(fs.statSync(firstPath).mode & 0o777).toBe(0o600);
    }
  });

  test("re-reads anchors before export and leaves stale artifacts as harmless orphans", () => {
    const root = temporaryDirectory("paw-legacy-stale-");
    const outputs = temporaryDirectory("paw-legacy-stale-output-");
    writePair(root, "stale");
    const inventory = discoverLegacyPawRunsV1({ legacyRuntimeRoot: root });
    const found = entry(inventory.entries, "stale");
    const outputPath = path.join(outputs, "evidence.json");
    const orphan = path.join(
      outputs,
      ".evidence.json.paw-legacy-publish-old-owner.tmp",
    );
    fs.writeFileSync(orphan, "orphan-bytes");
    writeRaw(
      root,
      ".paw/sessions/stale.jsonl",
      Buffer.from(`${validJournal("stale")}\n`),
    );

    expect(() =>
      exportLegacyPawRunEvidenceV1({
        legacyRuntimeRoot: root,
        sourceKind: LEGACY_RUN_SOURCE_KIND_V1,
        runId: "stale",
        outputPath,
        expectedInventoryHash: inventory.inventoryHash,
        expectedPairDigest: found.pairDigest,
      }),
    ).toThrow("inventory changed");
    expect(fs.existsSync(outputPath)).toBe(false);
    expect(fs.readFileSync(orphan, "utf8")).toBe("orphan-bytes");
  });

  test("enforces aggregate source bytes in discover, inspect, and export before publication", () => {
    const root = temporaryDirectory("paw-legacy-total-budget-");
    const outputs = temporaryDirectory("paw-legacy-total-budget-out-");
    const bytes = writePair(root, "budgeted");
    const inventory = discoverLegacyPawRunsV1({ legacyRuntimeRoot: root });
    const found = entry(inventory.entries, "budgeted");
    const total = bytes.journalBytes.byteLength + bytes.stateBytes.byteLength;
    const policy = {
      policyVersion: LEGACY_RUN_EVIDENCE_POLICY_VERSION_V1,
      maxInventoryEntries: 10,
      maxSourceFileBytes: Math.max(
        bytes.journalBytes.byteLength,
        bytes.stateBytes.byteLength,
      ),
      maxTotalSourceBytes: total - 1,
      maxBundleBytes: total * 10,
    } as const;
    const outputPath = path.join(outputs, "must-not-exist.json");

    expect(() =>
      discoverLegacyPawRunsV1({ legacyRuntimeRoot: root, policy }),
    ).toThrow("aggregate byte limit");
    expect(() =>
      inspectLegacyPawRunV1({
        legacyRuntimeRoot: root,
        sourceKind: LEGACY_RUN_SOURCE_KIND_V1,
        runId: "budgeted",
        policy,
      }),
    ).toThrow("aggregate byte limit");
    expect(() =>
      exportLegacyPawRunEvidenceV1({
        legacyRuntimeRoot: root,
        sourceKind: LEGACY_RUN_SOURCE_KIND_V1,
        runId: "budgeted",
        outputPath,
        expectedInventoryHash: inventory.inventoryHash,
        expectedPairDigest: found.pairDigest,
        policy,
      }),
    ).toThrow("aggregate byte limit");
    expect(fs.existsSync(outputPath)).toBe(false);
  });

  test("fails closed when a source is replaced after the pair read and before inventory publication", () => {
    const root = temporaryDirectory("paw-legacy-read-toctou-");
    writePair(root, "moving");
    const journalPath = path.join(root, ".paw", "sessions", "moving.jsonl");
    const replacement = path.join(root, ".paw", "sessions", "replacement.tmp");
    fs.writeFileSync(replacement, validJournal("moving"));
    let hooks = 0;

    expect(() =>
      discoverLegacyPawRunsForTestV1(
        { legacyRuntimeRoot: root },
        {
          afterSourcePairRead: () => {
            hooks += 1;
            fs.renameSync(replacement, journalPath);
          },
        },
      ),
    ).toThrow(/changed/);
    expect(hooks).toBe(1);
  });

  test("fails closed when the sessions directory is replaced with byte-identical content after its read", () => {
    const root = temporaryDirectory("paw-legacy-directory-toctou-");
    writePair(root, "moving-directory");
    const sessions = path.join(root, ".paw", "sessions");
    const oldSessions = path.join(root, ".paw", "sessions-old");
    const replacement = path.join(root, ".paw", "sessions-replacement");
    fs.mkdirSync(replacement);
    fs.copyFileSync(
      path.join(sessions, "moving-directory.jsonl"),
      path.join(replacement, "moving-directory.jsonl"),
    );
    let hooks = 0;

    expect(() =>
      discoverLegacyPawRunsForTestV1(
        { legacyRuntimeRoot: root },
        {
          afterJournalDirectoryRead: () => {
            hooks += 1;
            fs.renameSync(sessions, oldSessions);
            fs.renameSync(replacement, sessions);
          },
        },
      ),
    ).toThrow(/changed/);
    expect(hooks).toBe(1);
    expect(
      fs.readFileSync(path.join(sessions, "moving-directory.jsonl")),
    ).toEqual(
      fs.readFileSync(path.join(oldSessions, "moving-directory.jsonl")),
    );
  });

  test("publishes at most one immutable file across deterministic pre-link and post-link crashes", () => {
    const root = temporaryDirectory("paw-legacy-publish-crash-");
    const outputs = temporaryDirectory("paw-legacy-publish-crash-out-");
    writePair(root, "crash");
    const inventory = discoverLegacyPawRunsV1({ legacyRuntimeRoot: root });
    const found = entry(inventory.entries, "crash");
    const input = {
      legacyRuntimeRoot: root,
      sourceKind: LEGACY_RUN_SOURCE_KIND_V1,
      runId: "crash",
      expectedInventoryHash: inventory.inventoryHash,
      expectedPairDigest: found.pairDigest,
    } as const;
    const beforeLinkPath = path.join(outputs, "before-link.json");
    const beforeLinkError = new Error("crash after temp fsync");
    expect(() =>
      exportLegacyPawRunEvidenceForTestV1(
        { ...input, outputPath: beforeLinkPath },
        {
          afterPublisherTempFsync: () => {
            const temporary = fs
              .readdirSync(outputs)
              .find((name) => name.includes("paw-legacy-publish"));
            expect(temporary).toBeDefined();
            if (process.platform !== "win32" && temporary) {
              expect(
                fs.statSync(path.join(outputs, temporary)).mode & 0o777,
              ).toBe(0o600);
            }
            throw beforeLinkError;
          },
        },
      ),
    ).toThrow(beforeLinkError);
    expect(fs.existsSync(beforeLinkPath)).toBe(false);
    expect(fs.readdirSync(outputs)).toEqual([]);

    const afterLinkPath = path.join(outputs, "after-link.json");
    const afterLinkError = new Error("crash after formal link");
    expect(() =>
      exportLegacyPawRunEvidenceForTestV1(
        { ...input, outputPath: afterLinkPath },
        {
          afterPublisherLink: () => {
            throw afterLinkError;
          },
        },
      ),
    ).toThrow(afterLinkError);
    const committedBytes = fs.readFileSync(afterLinkPath);
    expect(
      exportLegacyPawRunEvidenceV1({ ...input, outputPath: afterLinkPath }),
    ).toMatchObject({ status: "target_exists", continuable: false });
    expect(fs.readFileSync(afterLinkPath)).toEqual(committedBytes);
    expect(
      fs
        .readdirSync(outputs)
        .filter((name) => name.includes("paw-legacy-publish")),
    ).toEqual([]);
  });

  test("does not delete or publish a hostile replacement of the fsynced publisher temp", () => {
    const root = temporaryDirectory("paw-legacy-publisher-toctou-");
    const outputs = temporaryDirectory("paw-legacy-publisher-toctou-out-");
    writePair(root, "publisher-race");
    const inventory = discoverLegacyPawRunsV1({ legacyRuntimeRoot: root });
    const found = entry(inventory.entries, "publisher-race");
    const outputPath = path.join(outputs, "evidence.json");
    const movedPublisherTemp = path.join(
      outputs,
      "publisher-temp-moved-by-test",
    );
    let hostileTempPath = "";
    const hostileBytes = Buffer.from("hostile replacement must survive");

    expect(() =>
      exportLegacyPawRunEvidenceForTestV1(
        {
          legacyRuntimeRoot: root,
          sourceKind: LEGACY_RUN_SOURCE_KIND_V1,
          runId: "publisher-race",
          outputPath,
          expectedInventoryHash: inventory.inventoryHash,
          expectedPairDigest: found.pairDigest,
        },
        {
          afterPublisherTempFsync: () => {
            const tempName = fs
              .readdirSync(outputs)
              .find((name) => name.includes("paw-legacy-publish"));
            if (!tempName) throw new Error("publisher temp missing");
            hostileTempPath = path.join(outputs, tempName);
            fs.renameSync(hostileTempPath, movedPublisherTemp);
            fs.writeFileSync(hostileTempPath, hostileBytes);
          },
        },
      ),
    ).toThrow(/changed/);
    expect(fs.existsSync(outputPath)).toBe(false);
    expect(fs.readFileSync(hostileTempPath)).toEqual(hostileBytes);
    expect(fs.existsSync(movedPublisherTemp)).toBe(true);
  });

  test("never overwrites an existing target, including a hard-linked target", () => {
    const root = temporaryDirectory("paw-legacy-no-overwrite-");
    const outputs = temporaryDirectory("paw-legacy-no-overwrite-output-");
    writePair(root, "no-overwrite");
    const inventory = discoverLegacyPawRunsV1({ legacyRuntimeRoot: root });
    const found = entry(inventory.entries, "no-overwrite");
    const outputPath = path.join(outputs, "evidence.json");
    const aliasPath = path.join(outputs, "alias.json");
    fs.writeFileSync(outputPath, "do-not-replace");
    fs.linkSync(outputPath, aliasPath);
    const before = snapshotTree(outputs);

    const result = exportLegacyPawRunEvidenceV1({
      legacyRuntimeRoot: root,
      sourceKind: LEGACY_RUN_SOURCE_KIND_V1,
      runId: "no-overwrite",
      outputPath,
      expectedInventoryHash: inventory.inventoryHash,
      expectedPairDigest: found.pairDigest,
    });

    expect(result).toEqual({
      status: "target_exists",
      sourceStatus: "paired_unbound",
      continuable: false,
      reasonCode: "target_exists",
    });
    expect(snapshotTree(outputs)).toEqual(before);
    expect(fs.readFileSync(aliasPath, "utf8")).toBe("do-not-replace");
  });

  test("isolates hard-linked legacy input as corrupt and refuses to export it", () => {
    const root = temporaryDirectory("paw-legacy-links-");
    const outputs = temporaryDirectory("paw-legacy-links-output-");
    writePair(root, "linked");
    fs.linkSync(
      path.join(root, ".paw", "sessions", "linked.jsonl"),
      path.join(root, ".paw", "sessions", "linked-alias.jsonl"),
    );
    const before = snapshotTree(root);

    const unsafeInventory = discoverLegacyPawRunsV1({
      legacyRuntimeRoot: root,
    });
    expect(entry(unsafeInventory.entries, "linked")).toMatchObject({
      status: "corrupt",
      issues: expect.arrayContaining(["journal_invalid"]),
    });
    expect(snapshotTree(root)).toEqual(before);
    expect(snapshotTree(outputs)).toEqual([]);
    expect(() =>
      exportLegacyPawRunEvidenceV1({
        legacyRuntimeRoot: root,
        sourceKind: LEGACY_RUN_SOURCE_KIND_V1,
        runId: "linked",
        outputPath: path.join(outputs, "must-not-publish.json"),
        expectedInventoryHash: unsafeInventory.inventoryHash,
        expectedPairDigest: entry(unsafeInventory.entries, "linked").pairDigest,
      }),
    ).toThrow("could not be collected safely");
    expect(snapshotTree(outputs)).toEqual([]);

    // Use a fresh valid source to isolate the output-location guard.
    const validRoot = temporaryDirectory("paw-legacy-output-guard-");
    writePair(validRoot, "guarded");
    const inventory = discoverLegacyPawRunsV1({
      legacyRuntimeRoot: validRoot,
    });
    const found = entry(inventory.entries, "guarded");
    expect(() =>
      exportLegacyPawRunEvidenceV1({
        legacyRuntimeRoot: validRoot,
        sourceKind: LEGACY_RUN_SOURCE_KIND_V1,
        runId: "guarded",
        outputPath: path.join(
          validRoot,
          ".paw",
          "sessions",
          "should-not-exist.json",
        ),
        expectedInventoryHash: inventory.inventoryHash,
        expectedPairDigest: found.pairDigest,
      }),
    ).toThrow("outside source storage");
    expect(
      fs.existsSync(
        path.join(validRoot, ".paw", "sessions", "should-not-exist.json"),
      ),
    ).toBe(false);

    const arbitraryPawOutput = path.join(validRoot, ".paw", "export.json");
    expect(() =>
      exportLegacyPawRunEvidenceV1({
        legacyRuntimeRoot: validRoot,
        sourceKind: LEGACY_RUN_SOURCE_KIND_V1,
        runId: "guarded",
        outputPath: arbitraryPawOutput,
        expectedInventoryHash: inventory.inventoryHash,
        expectedPairDigest: found.pairDigest,
      }),
    ).toThrow("outside source storage");
    expect(fs.existsSync(arbitraryPawOutput)).toBe(false);

    const pawNextOutput = path.join(
      validRoot,
      ".paw",
      "paw-next",
      "export.json",
    );
    expect(() =>
      exportLegacyPawRunEvidenceV1({
        legacyRuntimeRoot: validRoot,
        sourceKind: LEGACY_RUN_SOURCE_KIND_V1,
        runId: "guarded",
        outputPath: pawNextOutput,
        expectedInventoryHash: inventory.inventoryHash,
        expectedPairDigest: found.pairDigest,
      }),
    ).toThrow("outside source storage");
    expect(fs.existsSync(pawNextOutput)).toBe(false);
  });

  test.skipIf(process.platform === "win32")(
    "does not follow a symbolic-link source file",
    () => {
      const root = temporaryDirectory("paw-legacy-source-symlink-");
      const outside = temporaryDirectory("paw-legacy-source-symlink-outside-");
      writeState(root, "linked");
      const outsideJournal = path.join(outside, "outside.jsonl");
      fs.writeFileSync(outsideJournal, validJournal("linked"));
      fs.mkdirSync(path.join(root, ".paw", "sessions"), { recursive: true });
      fs.symlinkSync(
        outsideJournal,
        path.join(root, ".paw", "sessions", "linked.jsonl"),
      );
      const outsideBefore = snapshotTree(outside);

      const inventory = discoverLegacyPawRunsV1({ legacyRuntimeRoot: root });

      expect(entry(inventory.entries, "linked")).toMatchObject({
        status: "corrupt",
        issues: expect.arrayContaining(["journal_invalid"]),
      });
      expect(snapshotTree(outside)).toEqual(outsideBefore);
    },
  );

  test.skipIf(process.platform !== "win32")(
    "does not follow a Windows junction used as a fixed legacy directory",
    () => {
      const root = temporaryDirectory("paw-legacy-source-junction-");
      const outside = temporaryDirectory("paw-legacy-source-junction-outside-");
      writeState(outside, "lure");
      fs.mkdirSync(path.join(root, ".paw"), { recursive: true });
      fs.symlinkSync(
        path.join(outside, ".paw", "states"),
        path.join(root, ".paw", "states"),
        "junction",
      );
      const outsideBefore = snapshotTree(outside);

      expect(() =>
        discoverLegacyPawRunsV1({ legacyRuntimeRoot: root }),
      ).toThrow("unsafe directory");
      expect(snapshotTree(outside)).toEqual(outsideBefore);
    },
  );

  test("does not guess or convert an unversioned early FileSession-shaped directory", () => {
    const root = temporaryDirectory("paw-legacy-file-session-v1-");
    fs.mkdirSync(
      path.join(
        root,
        ".paw",
        "paw-next",
        "sessions",
        "legacy-session",
        "run-a",
        "batches",
      ),
      { recursive: true },
    );
    const before = snapshotTree(root);

    const inventory = discoverLegacyPawRunsV1({ legacyRuntimeRoot: root });
    const opaque = inventory.entries.find(
      (item) => item.sourceKind === "paw_next_authority_v2",
    );

    expect(opaque).toMatchObject({
      status: "corrupt",
      continuable: false,
      issues: ["current_paw_next_run_not_migrated"],
    });
    expect(snapshotTree(root)).toEqual(before);
  });

  test("reports current Paw Next authority as already_current and never treats it as legacy input", () => {
    const root = temporaryDirectory("paw-legacy-current-");
    const acquired = acquireFileSessionExecutionLeaseV1({
      workspaceRoot: root,
      sessionId: "current-session",
      runId: "current-run",
      ttlMs: 1_000,
      baseTailSeq: 0,
      basePrefixHash: EMPTY_RUN_JOURNAL_PREFIX_HASH_V1,
      clock: () => 0,
    });
    if (acquired.status !== "acquired") throw new Error("expected lease");
    const before = snapshotTree(root);

    const inventory = discoverLegacyPawRunsV1({ legacyRuntimeRoot: root });
    const current = inventory.entries.find(
      (item) => item.sourceKind === "paw_next_authority_v2",
    );

    expect(current).toMatchObject({
      sourceKind: "paw_next_authority_v2",
      status: "already_current",
      continuable: false,
      issues: ["current_paw_next_run_not_migrated"],
    });
    expect(snapshotTree(root)).toEqual(before);
  });
});

function temporaryDirectory(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function writePair(
  root: string,
  runId: string,
  options: {
    readonly appWorkspaceRoot?: string;
    readonly goal?: string;
    readonly outcome?: boolean;
  } = {},
): { journalBytes: Buffer; stateBytes: Buffer } {
  return {
    journalBytes: writeJournal(root, runId),
    stateBytes: writeState(root, runId, options),
  };
}

function writeJournal(
  root: string,
  runId: string,
  entryName = `${sanitizeLegacyRunId(runId)}.jsonl`,
): Buffer {
  const bytes = Buffer.from(validJournal(runId));
  writeRaw(root, path.join(".paw", "sessions", entryName), bytes);
  return bytes;
}

function validJournal(runId: string): string {
  return `${JSON.stringify({
    runId,
    seq: 1,
    ts: 100,
    event: { type: "run.started", goal: "legacy goal" },
  })}\n${JSON.stringify({
    runId,
    seq: 2,
    ts: 200,
    event: { type: "run.succeeded", result: "legacy result" },
  })}\n`;
}

function writeState(
  root: string,
  runId: string,
  options: {
    readonly appWorkspaceRoot?: string;
    readonly goal?: string;
    readonly outcome?: boolean;
  } = {},
): Buffer {
  const bytes = Buffer.from(
    `${JSON.stringify(
      {
        runId,
        goal: options.goal ?? "legacy goal",
        workspaceRoot: options.appWorkspaceRoot ?? root,
        turn: 2,
        maxSteps: 8,
        messages: [
          { role: "user", content: "legacy user body" },
          { role: "assistant", content: "legacy assistant body" },
        ],
        ...(options.outcome
          ? { outcome: { status: "completed", message: "done" } }
          : {}),
        savedAt: 300,
      },
      null,
      2,
    )}\n`,
  );
  writeRaw(root, path.join(".paw", "states", `${runId}.json`), bytes);
  return bytes;
}

function writeRaw(root: string, relative: string, bytes: Buffer): void {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
}

function entry(
  entries: readonly LegacyRunInventoryEntryV1[],
  runId: string,
): LegacyRunInventoryEntryV1 {
  const found = entries.find(
    (item) =>
      item.sourceKind === LEGACY_RUN_SOURCE_KIND_V1 && item.runId === runId,
  );
  if (!found) throw new Error(`missing inventory entry ${runId}`);
  return found;
}

function sourceBytes(
  bundle: EvidenceBundle,
  role: "session_journal" | "app_state",
): Buffer {
  const found = bundle.sourceFiles.find((source) => source.role === role);
  if (!found) throw new Error(`missing bundle source ${role}`);
  return Buffer.from(found.bytesBase64, "base64");
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sanitizeLegacyRunId(runId: string): string {
  return runId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function snapshotTree(root: string): readonly string[] {
  const rows: string[] = [];
  walk(root, "", rows);
  return rows.sort();
}

function walk(root: string, relative: string, rows: string[]): void {
  const directory = path.join(root, relative);
  for (const name of fs.readdirSync(directory).sort()) {
    const childRelative = path.join(relative, name);
    const absolute = path.join(root, childRelative);
    const stat = fs.lstatSync(absolute);
    const normalized = childRelative.split(path.sep).join("/");
    if (stat.isSymbolicLink()) {
      rows.push(`link:${normalized}:${fs.readlinkSync(absolute)}`);
    } else if (stat.isDirectory()) {
      rows.push(`dir:${normalized}`);
      walk(root, childRelative, rows);
    } else {
      rows.push(
        `file:${normalized}:${stat.nlink}:${stat.mode & 0o777}:${sha256(
          fs.readFileSync(absolute),
        )}`,
      );
    }
  }
}

interface EvidenceBundle {
  readonly schemaVersion: string;
  readonly evidenceKind: string;
  readonly scope: string;
  readonly externalArtifacts: string;
  readonly sourceKind: string;
  readonly runId: string;
  readonly sourceStatus: string;
  readonly continuable: boolean;
  readonly sourceFiles: readonly {
    readonly role: "session_journal" | "app_state";
    readonly entryNameHash: string;
    readonly sha256: string;
    readonly bytesBase64: string;
  }[];
}
