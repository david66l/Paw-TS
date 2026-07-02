import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { grepWorkspaceText } from "../src/files/read.js";

describe("grepWorkspaceText", () => {
  test("files_with_matches mode", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-grep-"));
    writeFileSync(path.join(root, "a.ts"), "const foo = 1;\n", "utf8");
    writeFileSync(path.join(root, "b.ts"), "const bar = 2;\n", "utf8");
    const r = grepWorkspaceText(root, ".", {
      pattern: "foo",
      outputMode: "files_with_matches",
    });
    expect(r.error).toBeUndefined();
    expect(r.mode).toBe("files_with_matches");
    expect(r.filenames).toEqual(["a.ts"]);
    expect(r.match_count).toBe(1);
  });

  test("count mode", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-grep-"));
    writeFileSync(path.join(root, "a.ts"), "foo\nfoo\nbar\n", "utf8");
    const r = grepWorkspaceText(root, ".", {
      pattern: "foo",
      outputMode: "count",
    });
    expect(r.error).toBeUndefined();
    expect(r.mode).toBe("count");
    expect(r.match_count).toBe(2);
  });

  test("content mode with context", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-grep-"));
    writeFileSync(
      path.join(root, "a.ts"),
      "line1\nline2\nfoo\nline4\nline5\n",
      "utf8",
    );
    const r = grepWorkspaceText(root, ".", {
      pattern: "foo",
      outputMode: "content",
      context: 1,
    });
    expect(r.error).toBeUndefined();
    expect(r.mode).toBe("content");
    expect(r.content).toContain("line2");
    expect(r.content).toContain("foo");
    expect(r.content).toContain("line4");
  });

  test("content mode without context", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-grep-"));
    writeFileSync(path.join(root, "a.ts"), "alpha\nbeta\n", "utf8");
    const r = grepWorkspaceText(root, ".", {
      pattern: "beta",
      outputMode: "content",
    });
    expect(r.error).toBeUndefined();
    expect(r.content).toContain("beta");
    expect(r.content).not.toContain("alpha");
  });

  test("regex pattern", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-grep-"));
    writeFileSync(path.join(root, "a.ts"), "foo123\nbar\n", "utf8");
    const r = grepWorkspaceText(root, ".", {
      pattern: "foo\\d+",
      regex: true,
      outputMode: "files_with_matches",
    });
    expect(r.error).toBeUndefined();
    expect(r.filenames).toEqual(["a.ts"]);
  });

  test("file_pattern filters files", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-grep-"));
    writeFileSync(path.join(root, "a.ts"), "foo\n", "utf8");
    writeFileSync(path.join(root, "b.js"), "foo\n", "utf8");
    const r = grepWorkspaceText(root, ".", {
      pattern: "foo",
      filePattern: "*.ts",
      outputMode: "files_with_matches",
    });
    expect(r.error).toBeUndefined();
    expect(r.filenames).toEqual(["a.ts"]);
  });

  test("head_limit truncates results", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-grep-"));
    for (let i = 0; i < 10; i++) {
      writeFileSync(path.join(root, `f${i}.ts`), `foo${i}\n`, "utf8");
    }
    const r = grepWorkspaceText(root, ".", {
      pattern: "foo",
      outputMode: "files_with_matches",
      headLimit: 5,
    });
    expect(r.error).toBeUndefined();
    expect(r.filenames?.length).toBe(5);
    expect(r.truncated).toBe(true);
  });

  test("case_sensitive option", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-grep-"));
    writeFileSync(path.join(root, "a.ts"), "Foo\n", "utf8");
    const r = grepWorkspaceText(root, ".", {
      pattern: "foo",
      caseSensitive: true,
      outputMode: "files_with_matches",
    });
    expect(r.error).toBeUndefined();
    expect(r.filenames).toEqual([]);
  });

  test("offset skips first N results", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-grep-"));
    for (let i = 0; i < 5; i++) {
      writeFileSync(path.join(root, `f${i}.ts`), `foo${i}\n`, "utf8");
    }
    const r = grepWorkspaceText(root, ".", {
      pattern: "foo",
      outputMode: "files_with_matches",
      offset: 2,
    });
    expect(r.error).toBeUndefined();
    expect(r.filenames?.length).toBe(3);
  });
});
