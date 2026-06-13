/**
 * NotebookEditTool for Jupyter .ipynb files.
 */

import fs from "node:fs";

import { checkWorkspacePath } from "./path-guard.js";

export interface NotebookEditOptions {
  readonly action: "edit" | "append" | "insert" | "delete";
  readonly cellIndex?: number;
  readonly source?: string;
  readonly cellType?: "code" | "markdown";
}

export interface NotebookEditResult {
  readonly success: boolean;
  readonly cellCount?: number;
  readonly error?: string;
}

interface NotebookCell {
  cell_type: "code" | "markdown" | "raw";
  source: string | string[];
  metadata: Record<string, unknown>;
  outputs?: unknown[];
  execution_count?: number | null;
}

interface NotebookJson {
  cells: NotebookCell[];
  metadata: Record<string, unknown>;
  nbformat: number;
  nbformat_minor: number;
}

function asNotebookJson(v: unknown): NotebookJson | null {
  if (v === null || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o.cells)) return null;
  if (typeof o.nbformat !== "number") return null;
  return o as unknown as NotebookJson;
}

function setSource(cell: NotebookCell, source: string): void {
  // Jupyter notebooks store source as string or string array.
  // We preserve the original style when possible.
  if (Array.isArray(cell.source)) {
    cell.source = source
      .split("\n")
      .map((line, i, arr) => (i < arr.length - 1 ? `${line}\n` : line));
  } else {
    cell.source = source;
  }
}

export function editNotebook(
  workspaceRoot: string,
  relPath: string,
  opts: NotebookEditOptions,
): NotebookEditResult {
  const guard = checkWorkspacePath(workspaceRoot, relPath);
  if (!guard.allowed) {
    return { success: false, error: guard.reason };
  }
  const filePath = guard.resolvedPath;

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    return { success: false, error: err.message };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { success: false, error: "invalid JSON in notebook file" };
  }

  const nb = asNotebookJson(parsed);
  if (!nb) {
    return { success: false, error: "not a valid Jupyter notebook" };
  }

  const action = opts.action;

  if (action === "edit") {
    const idx = opts.cellIndex;
    if (idx === undefined) {
      return { success: false, error: "cell_index required for edit" };
    }
    if (idx < 0 || idx >= nb.cells.length) {
      return { success: false, error: `cell_index ${idx} out of range` };
    }
    const cell = nb.cells[idx]!;
    if (opts.source !== undefined) {
      setSource(cell, opts.source);
    }
    if (opts.cellType !== undefined) {
      cell.cell_type = opts.cellType;
      if (opts.cellType === "code") {
        cell.outputs = cell.outputs ?? [];
        cell.execution_count = null;
      }
    }
  } else if (action === "append") {
    const source = opts.source ?? "";
    const cellType = opts.cellType ?? "code";
    const newCell: NotebookCell = {
      cell_type: cellType,
      source,
      metadata: {},
      ...(cellType === "code" ? { outputs: [], execution_count: null } : {}),
    };
    setSource(newCell, source);
    nb.cells.push(newCell);
  } else if (action === "insert") {
    const idx = opts.cellIndex ?? 0;
    const source = opts.source ?? "";
    const cellType = opts.cellType ?? "code";
    const newCell: NotebookCell = {
      cell_type: cellType,
      source,
      metadata: {},
      ...(cellType === "code" ? { outputs: [], execution_count: null } : {}),
    };
    setSource(newCell, source);
    if (idx < 0 || idx > nb.cells.length) {
      return { success: false, error: `cell_index ${idx} out of range` };
    }
    nb.cells.splice(idx, 0, newCell);
  } else if (action === "delete") {
    const idx = opts.cellIndex;
    if (idx === undefined) {
      return { success: false, error: "cell_index required for delete" };
    }
    if (idx < 0 || idx >= nb.cells.length) {
      return { success: false, error: `cell_index ${idx} out of range` };
    }
    nb.cells.splice(idx, 1);
  }

  try {
    fs.writeFileSync(filePath, JSON.stringify(nb, null, 1), "utf8");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    return { success: false, error: err.message };
  }

  return { success: true, cellCount: nb.cells.length };
}
