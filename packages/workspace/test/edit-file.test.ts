import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { editWorkspaceFile } from "../src/local-fs.js";

describe("editWorkspaceFile — string mode", () => {
  test("replaces unique match", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-edit-"));
    writeFileSync(path.join(root, "a.txt"), "hello world\nfoo bar\n", "utf8");
    const r = editWorkspaceFile(root, "a.txt", {
      oldString: "foo",
      newString: "baz",
    });
    expect(r.error).toBeUndefined();
    expect(r.replacements).toBe(1);
    expect(r.linesAdded).toBe(1);
    expect(r.linesRemoved).toBe(1);
    expect(r.diff).toContain("@@");
    const content = fs.readFileSync(path.join(root, "a.txt"), "utf8");
    expect(content).toBe("hello world\nbaz bar\n");
  });

  test("rejects when old_string not found", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-edit-"));
    writeFileSync(path.join(root, "a.txt"), "hello world\n", "utf8");
    const r = editWorkspaceFile(root, "a.txt", {
      oldString: "missing",
      newString: "x",
    });
    expect(r.error).toContain("not found");
    expect(r.replacements).toBeUndefined();
  });

  test("rejects ambiguous match (2+ occurrences)", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-edit-"));
    writeFileSync(path.join(root, "a.txt"), "foo foo foo\n", "utf8");
    const r = editWorkspaceFile(root, "a.txt", {
      oldString: "foo",
      newString: "bar",
    });
    expect(r.error).toContain("appears 3 times");
    expect(r.replacements).toBeUndefined();
  });

  test("rejects path escape", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-edit-"));
    const r = editWorkspaceFile(root, "../escape.txt", {
      oldString: "a",
      newString: "b",
    });
    expect(r.error).toBeDefined();
  });

  test("rejects missing file", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-edit-"));
    const r = editWorkspaceFile(root, "nonexistent.txt", {
      oldString: "a",
      newString: "b",
    });
    expect(r.error).toContain("not found");
  });

  test("empty new_string deletes old_string", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-edit-"));
    writeFileSync(path.join(root, "a.txt"), "removeTHIS\n", "utf8");
    const r = editWorkspaceFile(root, "a.txt", {
      oldString: "THIS",
      newString: "",
    });
    expect(r.error).toBeUndefined();
    expect(r.replacements).toBe(1);
    const content = fs.readFileSync(path.join(root, "a.txt"), "utf8");
    expect(content).toBe("remove\n");
  });

  test("multiline replacement works", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-edit-"));
    writeFileSync(
      path.join(root, "a.ts"),
      "function old() {\n  return 1;\n}\n",
      "utf8",
    );
    const r = editWorkspaceFile(root, "a.ts", {
      oldString: "function old() {\n  return 1;\n}",
      newString: "function newFn() {\n  return 2;\n}",
    });
    expect(r.error).toBeUndefined();
    expect(r.linesAdded).toBeGreaterThanOrEqual(1);
    expect(r.linesRemoved).toBeGreaterThanOrEqual(1);
    expect(r.diff).toContain("@@");
    const content = fs.readFileSync(path.join(root, "a.ts"), "utf8");
    expect(content).toBe("function newFn() {\n  return 2;\n}\n");
  });

  test("diff stats count added and removed lines", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-edit-"));
    writeFileSync(path.join(root, "a.txt"), "line1\nline2\nline3\n", "utf8");
    const r = editWorkspaceFile(root, "a.txt", {
      startLine: 2,
      endLine: 2,
      newString: "newA\nnewB",
    });
    expect(r.error).toBeUndefined();
    expect(r.linesAdded).toBe(2);
    expect(r.linesRemoved).toBe(1);
    expect(r.linesAffected).toBe(1);
    expect(r.diff).toContain("@@");
  });

  test("diff is empty when no content change", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-edit-"));
    writeFileSync(path.join(root, "a.txt"), "same\n", "utf8");
    const r = editWorkspaceFile(root, "a.txt", {
      oldString: "same",
      newString: "same",
    });
    expect(r.error).toBeUndefined();
    expect(r.linesAdded).toBe(0);
    expect(r.linesRemoved).toBe(0);
  });

  test("fuzzy match ignores leading/trailing whitespace", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-edit-"));
    writeFileSync(path.join(root, "a.txt"), "  hello  \n", "utf8");
    const r = editWorkspaceFile(root, "a.txt", {
      oldString: "hello",
      newString: "world",
      fuzzy: true,
    });
    expect(r.error).toBeUndefined();
    expect(r.replacements).toBe(1);
    const content = fs.readFileSync(path.join(root, "a.txt"), "utf8");
    expect(content).toBe("  world  \n");
  });

  test("fuzzy match falls back to exact when no fuzzy match", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-edit-"));
    writeFileSync(path.join(root, "a.txt"), "alpha\n", "utf8");
    const r = editWorkspaceFile(root, "a.txt", {
      oldString: "beta",
      newString: "gamma",
      fuzzy: true,
    });
    expect(r.error).toContain("not found");
  });
});

describe("editWorkspaceFile — line mode", () => {
  test("replaces single line by start_line", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-edit-"));
    writeFileSync(path.join(root, "a.txt"), "line1\nline2\nline3\n", "utf8");
    const r = editWorkspaceFile(root, "a.txt", {
      startLine: 2,
      newString: "REPLACED",
    });
    expect(r.error).toBeUndefined();
    expect(r.linesAffected).toBe(1);
    const content = fs.readFileSync(path.join(root, "a.txt"), "utf8");
    expect(content).toBe("line1\nREPLACED\nline3\n");
  });

  test("replaces line range", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-edit-"));
    writeFileSync(path.join(root, "a.txt"), "a\nb\nc\nd\n", "utf8");
    const r = editWorkspaceFile(root, "a.txt", {
      startLine: 2,
      endLine: 3,
      newString: "X",
    });
    expect(r.error).toBeUndefined();
    expect(r.linesAffected).toBe(2);
    const content = fs.readFileSync(path.join(root, "a.txt"), "utf8");
    expect(content).toBe("a\nX\nd\n");
  });

  test("multi-line replacement in line mode", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-edit-"));
    writeFileSync(path.join(root, "a.txt"), "a\nb\nc\n", "utf8");
    const r = editWorkspaceFile(root, "a.txt", {
      startLine: 2,
      newString: "x\ny\nz",
    });
    expect(r.error).toBeUndefined();
    const content = fs.readFileSync(path.join(root, "a.txt"), "utf8");
    expect(content).toBe("a\nx\ny\nz\nc\n");
  });

  test("deletes lines with empty newString", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-edit-"));
    writeFileSync(path.join(root, "a.txt"), "a\nb\nc\n", "utf8");
    const r = editWorkspaceFile(root, "a.txt", {
      startLine: 2,
      endLine: 2,
      newString: "",
    });
    expect(r.error).toBeUndefined();
    const content = fs.readFileSync(path.join(root, "a.txt"), "utf8");
    expect(content).toBe("a\nc\n");
  });

  test("rejects start_line beyond file length", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-edit-"));
    writeFileSync(path.join(root, "a.txt"), "one\n", "utf8");
    const r = editWorkspaceFile(root, "a.txt", {
      startLine: 5,
      newString: "x",
    });
    expect(r.error).toContain("exceeds");
  });

  test("end_line clamped to file length", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-edit-"));
    writeFileSync(path.join(root, "a.txt"), "a\nb\n", "utf8");
    const r = editWorkspaceFile(root, "a.txt", {
      startLine: 1,
      endLine: 100,
      newString: "X",
    });
    expect(r.error).toBeUndefined();
    const content = fs.readFileSync(path.join(root, "a.txt"), "utf8");
    expect(content).toBe("X\n");
  });
});
