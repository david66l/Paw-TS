import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { executeTool } from "../src/registry/index.js";

/**
 * `workspace.notebook_edit` 是 §D9 里最后一个"无测试的工具 id"。
 *
 * 它有三条出口：missing path（裸 payload）、`editNotebook` 失败（payload 就是
 * 那个失败对象）、成功（顺带通过 `ctx.watcher.markAgentWritten` 通知监听器）。
 * 成功那条会在临时工作区里写一个真实的 `.ipynb`，所以覆盖到的是真写入路径，
 * 而不是桩。
 */

const WORKSPACE = mkdtempSync(path.join(tmpdir(), "paw-notebook-"));

function notebookPath(name: string, cells: readonly unknown[] = []): string {
  const p = path.join(WORKSPACE, name);
  writeFileSync(
    p,
    JSON.stringify({ cells, metadata: {}, nbformat: 4, nbformat_minor: 5 }, null, 1),
    "utf8",
  );
  return name;
}

const MARKDOWN_CELL = {
  cell_type: "markdown",
  metadata: {},
  source: ["# title"],
};

describe("workspace.notebook_edit", () => {
  test("an omitted path is refused by the schema", async () => {
    const r = await executeTool({ workspaceRoot: WORKSPACE }, "workspace.notebook_edit", {});
    expect(r.ok).toBe(false);
    expect((r.payload as Record<string, unknown>).error_code).toBe("E_SCHEMA_INVALID");
    expect((r.payload as Record<string, unknown>).field).toBe("path");
  });

  test("an empty path reaches the handler: bare payload, no error_code", async () => {
    const r = await executeTool({ workspaceRoot: WORKSPACE }, "workspace.notebook_edit", {
      path: "",
    });
    expect(r.ok).toBe(false);
    expect((r.payload as Record<string, unknown>).error).toBe("missing path");
    expect((r.payload as Record<string, unknown>).error_code).toBeUndefined();
    expect(r.summary).toBe("notebook_edit: missing path");
  });

  test("a non-notebook file fails and the reason is surfaced in the summary", async () => {
    writeFileSync(path.join(WORKSPACE, "notes.txt"), "not a notebook", "utf8");
    const r = await executeTool({ workspaceRoot: WORKSPACE }, "workspace.notebook_edit", {
      path: "notes.txt",
      action: "append",
      source: "x",
      cell_type: "markdown",
    });
    expect(r.ok).toBe(false);
    expect(r.summary.startsWith("notebook_edit: ")).toBe(true);
    // payload 就是 editNotebook 的失败对象本身（含 success:false）
    expect((r.payload as Record<string, unknown>).success).toBe(false);
  });

  test("appending a cell writes the notebook and marks it agent-written", async () => {
    const name = notebookPath("append.ipynb", [MARKDOWN_CELL]);
    const marked: string[] = [];
    const r = await executeTool(
      {
        workspaceRoot: WORKSPACE,
        watcher: { markAgentWritten: (p: string) => marked.push(p) } as never,
      },
      "workspace.notebook_edit",
      { path: name, action: "append", source: "print(1)", cell_type: "code" },
    );
    expect(r.ok).toBe(true);
    expect((r.payload as Record<string, unknown>).cellCount).toBe(2);
    expect(r.summary).toBe(`notebook_edit: ${name} (2 cells)`);
    // 成功的写入要让监听器知道，否则 watcher 会把这次改动当成外部修改
    expect(marked).toEqual([name]);

    const written = JSON.parse(readFileSync(path.join(WORKSPACE, name), "utf8")) as {
      cells: { cell_type: string; source: string[] }[];
    };
    expect(written.cells).toHaveLength(2);
    expect(written.cells[1]?.cell_type).toBe("code");
  });

  test("editing a cell replaces its source in place", async () => {
    const name = notebookPath("edit.ipynb", [MARKDOWN_CELL]);
    const r = await executeTool({ workspaceRoot: WORKSPACE }, "workspace.notebook_edit", {
      path: name,
      action: "edit",
      cell_index: 0,
      source: "# replaced",
      cell_type: "markdown",
    });
    expect(r.ok).toBe(true);
    expect((r.payload as Record<string, unknown>).cellCount).toBe(1);
    const written = JSON.parse(readFileSync(path.join(WORKSPACE, name), "utf8")) as {
      cells: { source: string[] }[];
    };
    expect(written.cells[0]?.source.join("")).toContain("replaced");
  });
});
