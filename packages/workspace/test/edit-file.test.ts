import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { editWorkspaceFile } from "../src/files/write.js";

describe("editWorkspaceFile — string mode", () => {
  test("CRLF file accepts LF old_string and preserves CRLF", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-edit-"));
    writeFileSync(
      path.join(root, "a.py"),
      "def f():\r\n    return get_type_hints(self.parent)\r\n",
      "utf8",
    );
    const r = editWorkspaceFile(root, "a.py", {
      oldString: "    return get_type_hints(self.parent)\n",
      newString:
        "    return get_type_hints(self.parent, None, self.config.autodoc_type_aliases)\n",
    });
    expect(r.error).toBeUndefined();
    expect(r.replacements).toBe(1);
    const content = fs.readFileSync(path.join(root, "a.py"), "utf8");
    expect(content).toContain("\r\n");
    expect(content).toContain(
      "get_type_hints(self.parent, None, self.config.autodoc_type_aliases)",
    );
    expect(content.includes("\n") && !content.includes("\r\n")).toBe(false);
  });

  test("replace_all replaces every occurrence", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-edit-"));
    writeFileSync(path.join(root, "a.txt"), "foo bar\nfoo baz\n", "utf8");
    const r = editWorkspaceFile(root, "a.txt", {
      oldString: "foo",
      newString: "qux",
      replaceAll: true,
    });
    expect(r.error).toBeUndefined();
    expect(r.replacements).toBe(2);
    expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe(
      "qux bar\nqux baz\n",
    );
  });

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

  test("treats JavaScript replacement tokens as literal source text", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-edit-"));
    writeFileSync(path.join(root, "tokens.txt"), "before TARGET after\n", "utf8");
    const literal = "$&|$`|$'|$$";
    const r = editWorkspaceFile(root, "tokens.txt", {
      oldString: "TARGET",
      newString: literal,
    });
    expect(r.error).toBeUndefined();
    expect(fs.readFileSync(path.join(root, "tokens.txt"), "utf8")).toBe(
      `before ${literal} after\n`,
    );
  });

  test("does not duplicate a file suffix for matplotlib-style Python source", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-edit-"));
    const suffix = Array.from(
      { length: 1_300 },
      (_, index) => `line_${index} = ${index}`,
    ).join("\n");
    const before = `def _wrap_in_tex(s):\n    return '$' + s.replace('-', '{-}') + '}$'\n${suffix}\n`;
    const oldString = "    return '$' + s.replace('-', '{-}') + '}$'";
    const newString =
      "    return '$' + s.replace('-', '{-}').replace(':', '{:}') + '}$'";
    writeFileSync(path.join(root, "dates.py"), before, "utf8");

    const r = editWorkspaceFile(root, "dates.py", { oldString, newString });

    expect(r.error).toBeUndefined();
    const after = fs.readFileSync(path.join(root, "dates.py"), "utf8");
    expect(after).toBe(before.slice(0, before.indexOf(oldString)) + newString + before.slice(before.indexOf(oldString) + oldString.length));
    expect(after.match(/line_1299 = 1299/g)).toHaveLength(1);
    expect(r.linesAdded).toBe(1);
    expect(r.linesRemoved).toBe(1);
  });

  test("rejects an oversized replacement before writing", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-edit-"));
    const filePath = path.join(root, "a.txt");
    writeFileSync(filePath, "before TARGET after\n", "utf8");
    const original = fs.readFileSync(filePath, "utf8");

    const r = editWorkspaceFile(root, "a.txt", {
      oldString: "TARGET",
      newString: "x".repeat(512 * 1024),
    });

    expect(r.error).toContain("edited file exceeds max");
    expect(fs.readFileSync(filePath, "utf8")).toBe(original);
  });

  test("checks the final CRLF-restored byte size before writing", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-edit-"));
    const filePath = path.join(root, "crlf.txt");
    const original = `${"a\r\n".repeat(100_000)}TARGET\r\n`;
    writeFileSync(filePath, original, "utf8");

    const r = editWorkspaceFile(root, "crlf.txt", {
      oldString: "TARGET",
      newString: "x".repeat(300_000),
    });

    expect(r.error).toContain("edited file exceeds max");
    expect(fs.readFileSync(filePath, "utf8")).toBe(original);
  });

  test("uses UTF-8 bytes rather than JavaScript character count", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-edit-"));
    const filePath = path.join(root, "unicode.txt");
    writeFileSync(filePath, "TARGET\n", "utf8");

    const r = editWorkspaceFile(root, "unicode.txt", {
      oldString: "TARGET",
      newString: "你".repeat(180_000),
    });

    expect(r.error).toContain("edited file exceeds max");
    expect(fs.readFileSync(filePath, "utf8")).toBe("TARGET\n");
  });

  test("replace_all uses non-overlapping literal matches", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-edit-"));
    writeFileSync(path.join(root, "overlap.txt"), "aaaa\n", "utf8");

    const r = editWorkspaceFile(root, "overlap.txt", {
      oldString: "aa",
      newString: "$'",
      replaceAll: true,
    });

    expect(r.error).toBeUndefined();
    expect(r.replacements).toBe(2);
    expect(fs.readFileSync(path.join(root, "overlap.txt"), "utf8")).toBe(
      "$'$'\n",
    );
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
    expect(r.error).toContain("replace_all");
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
    expect(r.changed).toBe(false);
  });

  test("fuzzy match ignores leading/trailing whitespace", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-edit-"));
    writeFileSync(path.join(root, "a.txt"), "\thello\t\n", "utf8");
    const r = editWorkspaceFile(root, "a.txt", {
      oldString: " hello ",
      newString: "world",
      fuzzy: true,
    });
    expect(r.error).toBeUndefined();
    expect(r.replacements).toBe(1);
    const content = fs.readFileSync(path.join(root, "a.txt"), "utf8");
    expect(content).toBe("world\n");
  });

  test("rejects oversized fuzzy output before writing", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-edit-"));
    const filePath = path.join(root, "fuzzy.txt");
    writeFileSync(filePath, "\thello\t\n", "utf8");

    const r = editWorkspaceFile(root, "fuzzy.txt", {
      oldString: " hello ",
      newString: "x".repeat(512 * 1024),
      fuzzy: true,
    });

    expect(r.error).toContain("edited file exceeds max");
    expect(fs.readFileSync(filePath, "utf8")).toBe("\thello\t\n");
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

  test("rejects oversized line replacement before writing", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-edit-"));
    const filePath = path.join(root, "a.txt");
    writeFileSync(filePath, "a\nb\nc\n", "utf8");

    const r = editWorkspaceFile(root, "a.txt", {
      startLine: 2,
      newString: "x".repeat(512 * 1024),
    });

    expect(r.error).toContain("edited file exceeds max");
    expect(fs.readFileSync(filePath, "utf8")).toBe("a\nb\nc\n");
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
