import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  auditFeatureLedger,
  artifactPaths,
  loadHarnessLedger,
  saveFeatureList,
  saveHarnessLedger,
  type FeatureItem,
} from "./artifacts.ts";
import { captureProgressSnapshot, evaluateProgressDelta } from "./progress.ts";
import { reconcilePassesWithE2e } from "./verify-e2e.ts";

function feature(over: Partial<FeatureItem> = {}): FeatureItem {
  return {
    id: "f1",
    category: "functional",
    description: "does a thing",
    steps: ["open", "observe"],
    passes: false,
    e2e: { actions: [{ type: "goto", path: "/" }] },
    ...over,
  };
}

describe("longrun harness control plane", () => {
  test("agent pass claims are audited but not canonical", () => {
    const canonical = [feature()];
    const audit = auditFeatureLedger(canonical, [feature({ passes: true })]);
    expect(audit.changedPassClaims).toEqual(["f1"]);
    expect(audit.contractViolations).toEqual([]);
    expect(canonical[0]?.passes).toBe(false);
  });

  test("agent contract edits are detected", () => {
    const audit = auditFeatureLedger(
      [feature()],
      [feature({ description: "easier contract" })],
    );
    expect(audit.contractViolations).toEqual([
      "feature contract changed: f1",
    ]);
  });

  test("duplicate feature ids are rejected as a contract violation", () => {
    const audit = auditFeatureLedger([feature()], [feature(), feature()]);
    expect(audit.contractViolations).toContain("duplicate feature id: f1");
  });

  test("canonical ledger survives visible mirror tampering", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-longrun-ledger-"));
    try {
      saveFeatureList(root, [feature()]);
      saveHarnessLedger(root, [feature({ passes: true })]);
      saveFeatureList(root, [feature({ passes: false })]);
      expect(loadHarnessLedger(root)[0]?.passes).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("canonical ledger rejects content whose integrity hash was not updated", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-longrun-integrity-"));
    try {
      saveHarnessLedger(root, [feature()]);
      const ledgerPath = artifactPaths(root).harnessLedgerPath;
      const envelope = JSON.parse(readFileSync(ledgerPath, "utf8")) as {
        features: FeatureItem[];
      };
      envelope.features[0]!.passes = true;
      writeFileSync(ledgerPath, `${JSON.stringify(envelope, null, 2)}\n`);
      expect(() => loadHarnessLedger(root)).toThrow("integrity hash mismatch");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("invalid canonical ledger recovers from last-known-good backup", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-longrun-recovery-"));
    try {
      saveHarnessLedger(root, [feature()]);
      saveHarnessLedger(root, [feature({ passes: true })]);
      writeFileSync(artifactPaths(root).harnessLedgerPath, "{truncated");
      const recovered = loadHarnessLedger(root);
      expect(recovered[0]?.passes).toBe(false);
      expect(loadHarnessLedger(root)[0]?.passes).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("only external E2E promotes a feature to passing", () => {
    const rec = reconcilePassesWithE2e([feature()], {
      ok: true,
      baseUrl: "http://127.0.0.1",
      results: [{ id: "f1", ok: true }],
    });
    expect(rec.features[0]?.passes).toBe(true);
    expect(rec.verifiedToPass).toEqual(["f1"]);
  });

  test("ledger-only activity is no progress", () => {
    const delta = evaluateProgressDelta({
      before: { sourceTreeHash: "same", gitHead: "a" },
      after: { sourceTreeHash: "same", gitHead: "b" },
      targetE2ePassed: false,
    });
    expect(delta.progressed).toBe(false);
    expect(delta.reasons).toEqual([]);
  });

  test("source change or E2E pass is progress", () => {
    expect(
      evaluateProgressDelta({
        before: { sourceTreeHash: "a", gitHead: "a" },
        after: { sourceTreeHash: "b", gitHead: "b" },
        targetE2ePassed: false,
      }).reasons,
    ).toEqual(["source_tree_changed"]);
    expect(
      evaluateProgressDelta({
        before: { sourceTreeHash: "a", gitHead: "a" },
        after: { sourceTreeHash: "a", gitHead: "a" },
        targetE2ePassed: true,
      }).reasons,
    ).toEqual(["target_e2e_passed"]);
  });

  test("snapshot ignores harness files but detects product edits", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-longrun-progress-"));
    try {
      execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
      mkdirSync(path.join(root, ".paw"), { recursive: true });
      writeFileSync(path.join(root, "app.ts"), "export const value = 1;\n");
      writeFileSync(path.join(root, "feature_list.json"), "[]\n");
      writeFileSync(path.join(root, ".paw", "longrun-feature-ledger.json"), "[]\n");
      const before = captureProgressSnapshot(root);
      writeFileSync(path.join(root, "feature_list.json"), "[{\"passes\":true}]\n");
      writeFileSync(path.join(root, ".paw", "longrun-feature-ledger.json"), "[{\"passes\":true}]\n");
      const ledgerOnly = captureProgressSnapshot(root);
      expect(ledgerOnly.sourceTreeHash).toBe(before.sourceTreeHash);
      writeFileSync(path.join(root, "app.ts"), "export const value = 2;\n");
      const productEdit = captureProgressSnapshot(root);
      expect(productEdit.sourceTreeHash).not.toBe(before.sourceTreeHash);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
