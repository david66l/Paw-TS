import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { editNotebook } from "../src/notebook-tools.js";

describe("editNotebook", () => {
  test("edits cell source", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-nb-"));
    const nbPath = path.join(root, "test.ipynb");
    writeFileSync(
      nbPath,
      JSON.stringify({
        cells: [
          { cell_type: "code", source: "print(1)", metadata: {}, outputs: [], execution_count: null },
          { cell_type: "markdown", source: "# Hello", metadata: {} },
        ],
        metadata: {},
        nbformat: 4,
        nbformat_minor: 5,
      }),
      "utf8",
    );
    const r = editNotebook(root, "test.ipynb", {
      action: "edit",
      cellIndex: 0,
      source: "print(2)",
    });
    expect(r.success).toBe(true);
    expect(r.cellCount).toBe(2);
    const updated = JSON.parse(
      require("node:fs").readFileSync(nbPath, "utf8"),
    );
    expect(updated.cells[0].source).toBe("print(2)");
  });

  test("appends new cell", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-nb-"));
    const nbPath = path.join(root, "test.ipynb");
    writeFileSync(
      nbPath,
      JSON.stringify({
        cells: [],
        metadata: {},
        nbformat: 4,
        nbformat_minor: 5,
      }),
      "utf8",
    );
    const r = editNotebook(root, "test.ipynb", {
      action: "append",
      source: "print(3)",
      cellType: "code",
    });
    expect(r.success).toBe(true);
    expect(r.cellCount).toBe(1);
    const updated = JSON.parse(
      require("node:fs").readFileSync(nbPath, "utf8"),
    );
    expect(updated.cells[0].cell_type).toBe("code");
  });

  test("inserts cell at index", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-nb-"));
    const nbPath = path.join(root, "test.ipynb");
    writeFileSync(
      nbPath,
      JSON.stringify({
        cells: [
          { cell_type: "code", source: "a", metadata: {} },
          { cell_type: "code", source: "b", metadata: {} },
        ],
        metadata: {},
        nbformat: 4,
        nbformat_minor: 5,
      }),
      "utf8",
    );
    const r = editNotebook(root, "test.ipynb", {
      action: "insert",
      cellIndex: 1,
      source: "inserted",
    });
    expect(r.success).toBe(true);
    expect(r.cellCount).toBe(3);
    const updated = JSON.parse(
      require("node:fs").readFileSync(nbPath, "utf8"),
    );
    expect(updated.cells[1].source).toBe("inserted");
  });

  test("deletes cell", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-nb-"));
    const nbPath = path.join(root, "test.ipynb");
    writeFileSync(
      nbPath,
      JSON.stringify({
        cells: [
          { cell_type: "code", source: "a", metadata: {} },
        ],
        metadata: {},
        nbformat: 4,
        nbformat_minor: 5,
      }),
      "utf8",
    );
    const r = editNotebook(root, "test.ipynb", {
      action: "delete",
      cellIndex: 0,
    });
    expect(r.success).toBe(true);
    expect(r.cellCount).toBe(0);
  });

  test("returns error for out of range index", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-nb-"));
    const nbPath = path.join(root, "test.ipynb");
    writeFileSync(
      nbPath,
      JSON.stringify({
        cells: [],
        metadata: {},
        nbformat: 4,
        nbformat_minor: 5,
      }),
      "utf8",
    );
    const r = editNotebook(root, "test.ipynb", {
      action: "edit",
      cellIndex: 0,
      source: "x",
    });
    expect(r.success).toBe(false);
    expect(r.error).toContain("out of range");
  });

  test("returns error for invalid JSON", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paw-nb-"));
    const nbPath = path.join(root, "bad.ipynb");
    writeFileSync(nbPath, "not json", "utf8");
    const r = editNotebook(root, "bad.ipynb", {
      action: "edit",
      cellIndex: 0,
      source: "x",
    });
    expect(r.success).toBe(false);
    expect(r.error).toContain("invalid JSON");
  });
});
