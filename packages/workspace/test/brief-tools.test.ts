import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { generateBrief } from "../src/brief-tools.js";

describe("generateBrief", () => {
  test("handles empty directory", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-brief-"));
    const r = generateBrief(root);
    expect(r.error).toBeUndefined();
    expect(r.summary).toContain("Empty workspace");
  });

  test("detects Node.js project", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-brief-"));
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "test", version: "1.0.0" }),
      "utf8",
    );
    writeFileSync(path.join(root, "index.ts"), "const x = 1;\n", "utf8");
    const r = generateBrief(root);
    expect(r.error).toBeUndefined();
    expect(r.summary).toContain("Node.js");
    expect(r.summary).toContain("package.json");
  });

  test("detects Python project", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-brief-"));
    writeFileSync(
      path.join(root, "pyproject.toml"),
      '[project]\nname = "test"\n',
      "utf8",
    );
    writeFileSync(path.join(root, "main.py"), "print('hello')\n", "utf8");
    const r = generateBrief(root);
    expect(r.error).toBeUndefined();
    expect(r.summary).toContain("Python");
  });

  test("reads README", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-brief-"));
    writeFileSync(
      path.join(root, "README.md"),
      "# Test Project\n\nThis is a test.\n",
      "utf8",
    );
    const r = generateBrief(root);
    expect(r.error).toBeUndefined();
    expect(r.summary).toContain("README");
    expect(r.summary).toContain("Test Project");
  });

  test("respects max_files limit", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-brief-"));
    for (let i = 0; i < 10; i++) {
      writeFileSync(path.join(root, `f${i}.txt`), `file ${i}\n`, "utf8");
    }
    const r = generateBrief(root, { maxFiles: 5 });
    expect(r.error).toBeUndefined();
    expect(r.filesScanned).toBeLessThanOrEqual(5);
  });

  test("ignores node_modules", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-brief-"));
    mkdirSync(path.join(root, "node_modules", "foo"), { recursive: true });
    writeFileSync(
      path.join(root, "node_modules", "foo", "index.js"),
      "module.exports = 1;",
      "utf8",
    );
    writeFileSync(path.join(root, "app.js"), "console.log('hello');\n", "utf8");
    const r = generateBrief(root);
    expect(r.error).toBeUndefined();
    expect(r.summary).not.toContain("node_modules");
  });
});
