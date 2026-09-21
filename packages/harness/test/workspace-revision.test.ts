import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { captureWorkspaceRevision, compareWorkspaceRevisions } from "../src/workspace-revision.js";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (!path.resolve(root).startsWith(path.join(os.tmpdir(), "paw-revision-")))
      throw new Error("Unsafe fixture");
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("content snapshots detect untracked writes, same-sized edits, deletes and unchanged checks", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paw-revision-"));
  roots.push(root);
  execFileSync("git", ["init", "--quiet", root], { windowsHide: true });
  fs.writeFileSync(path.join(root, "a.js"), "good");
  const before = await captureWorkspaceRevision(root);
  expect(compareWorkspaceRevisions(before, await captureWorkspaceRevision(root)).changed).toBe(
    false,
  );
  fs.writeFileSync(path.join(root, "a.js"), "bad!");
  fs.writeFileSync(path.join(root, "b.js"), "new");
  expect(compareWorkspaceRevisions(before, await captureWorkspaceRevision(root))).toMatchObject({
    changed: true,
    paths: ["a.js", "b.js"],
  });
  fs.unlinkSync(path.join(root, "a.js"));
  expect(compareWorkspaceRevisions(before, await captureWorkspaceRevision(root)).paths).toContain(
    "a.js",
  );
});
test("missing snapshot evidence remains unknown", () => {
  expect(compareWorkspaceRevisions(undefined, new Map()).changed).toBe("unknown");
});
