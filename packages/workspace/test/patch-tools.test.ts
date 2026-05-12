import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { applyWorkspacePatch } from "../src/patch-tools.js";

describe("applyWorkspacePatch", () => {
  test("applies a single-file patch", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-patch-"));
    writeFileSync(path.join(root, "a.ts"), "line1\nline2\nline3\n", "utf8");

    const patch = `--- a/a.ts
+++ b/a.ts
@@ -1,3 +1,3 @@
 line1
-line2
+line2_modified
 line3
`;
    const r = applyWorkspacePatch(root, patch);
    expect(r.ok).toBe(true);
    expect(r.results.length).toBe(1);
    expect(r.results[0]!.path).toBe("a.ts");
    expect(r.results[0]!.ok).toBe(true);
    expect(r.results[0]!.linesAdded).toBe(1);
    expect(r.results[0]!.linesRemoved).toBe(1);

    const content = readFileSync(path.join(root, "a.ts"), "utf8");
    expect(content).toBe("line1\nline2_modified\nline3\n");
  });

  test("applies a multi-file patch", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-patch-"));
    writeFileSync(path.join(root, "a.ts"), "alpha\n", "utf8");
    writeFileSync(path.join(root, "b.ts"), "beta\n", "utf8");

    const patch = `--- a/a.ts
+++ b/a.ts
@@ -1 +1 @@
-alpha
+alpha_modified
--- a/b.ts
+++ b/b.ts
@@ -1 +1 @@
-beta
+beta_modified
`;
    const r = applyWorkspacePatch(root, patch);
    expect(r.ok).toBe(true);
    expect(r.results.length).toBe(2);
    expect(r.results[0]!.path).toBe("a.ts");
    expect(r.results[1]!.path).toBe("b.ts");

    expect(readFileSync(path.join(root, "a.ts"), "utf8")).toBe("alpha_modified\n");
    expect(readFileSync(path.join(root, "b.ts"), "utf8")).toBe("beta_modified\n");
  });

  test("rolls back on partial failure", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-patch-"));
    writeFileSync(path.join(root, "a.ts"), "alpha\n", "utf8");
    writeFileSync(path.join(root, "b.ts"), "beta\n", "utf8");

    // a.ts patch is valid, b.ts patch references non-existent text
    const patch = `--- a/a.ts
+++ b/a.ts
@@ -1 +1 @@
-alpha
+alpha_modified
--- a/b.ts
+++ b/b.ts
@@ -1 +1 @@
-NONEXISTENT
+beta_modified
`;
    const r = applyWorkspacePatch(root, patch);
    expect(r.ok).toBe(false);
    expect(r.summary).toContain("failed on b.ts");

    // a.ts should be rolled back to original
    expect(readFileSync(path.join(root, "a.ts"), "utf8")).toBe("alpha\n");
    expect(readFileSync(path.join(root, "b.ts"), "utf8")).toBe("beta\n");
  });

  test("rejects empty patch", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-patch-"));
    const r = applyWorkspacePatch(root, "");
    expect(r.ok).toBe(false);
    expect(r.summary).toContain("empty patch");
  });

  test("rejects patch for missing file", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-patch-"));
    const patch = `--- a/missing.ts
+++ b/missing.ts
@@ -1 +1 @@
-old
+new
`;
    const r = applyWorkspacePatch(root, patch);
    expect(r.ok).toBe(false);
    expect(r.summary).toContain("file not found");
  });

  test("rejects patch that escapes workspace", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-patch-"));
    writeFileSync(path.join(root, "a.ts"), "alpha\n", "utf8");

    const patch = `--- a/../etc/passwd
+++ b/../etc/passwd
@@ -1 +1 @@
-old
+new
`;
    const r = applyWorkspacePatch(root, patch);
    expect(r.ok).toBe(false);
    expect(r.summary).toContain("escapes workspace");
  });

  test("strips a/ b/ prefixes from git-style diffs", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-patch-"));
    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(path.join(root, "src/foo.ts"), "old\n", "utf8");

    const patch = `--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1 +1 @@
-old
+new
`;
    const r = applyWorkspacePatch(root, patch);
    expect(r.ok).toBe(true);
    expect(r.results[0]!.path).toBe("src/foo.ts");
    expect(readFileSync(path.join(root, "src/foo.ts"), "utf8")).toBe("new\n");
  });
});
