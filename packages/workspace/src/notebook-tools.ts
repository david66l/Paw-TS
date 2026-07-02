/**
 * notebook-tools.ts — Jupyter Notebook (.ipynb) 编辑工具
 *
 * 【是什么】
 * 提供对 Jupyter Notebook 文件的增删改操作。支持四种操作：
 * - edit: 修改指定 cell 的源码和/或类型
 * - append: 在末尾追加新 cell
 * - insert: 在指定位置插入新 cell
 * - delete: 删除指定 cell
 *
 * 【为什么需要】
 * 在数据分析和 AI 辅助编程场景中，Jupyter Notebook 是常用格式。
 * AI Agent 需要能够修改 notebook 中的代码和文档，而不仅仅是读写文本文件。
 *
 * 【关键设计决策】
 * 1. 直接 JSON 操作：notebook 文件本质是 JSON，解析后直接修改 cells 数组，
 *    不需要依赖任何 Jupyter 库，零依赖、简洁高效。
 * 2. source 格式兼容：Jupyter 的 cell.source 可以是 string 或 string[]，
 *    setSource 函数会根据原始格式选择对应的存储方式。
 * 3. 路径安全检查：使用 checkWorkspacePath 确保操作不会逃逸工作区范围。
 * 4. code cell 特殊字段：切换到 code 类型时，自动添加 outputs=[] 和
 *    execution_count=null，符合 notebook 规范。
 */

import fs from "node:fs";

import { checkWorkspacePath } from "./path-guard.js";

/** notebook 编辑操作的选项 */
export interface NotebookEditOptions {
  /** 操作类型：编辑、追加、插入、删除 */
  readonly action: "edit" | "append" | "insert" | "delete";
  /** 要操作的 cell 索引（edit 和 delete 时必须） */
  readonly cellIndex?: number;
  /** 新的 cell 源码（edit/append/insert 时可选） */
  readonly source?: string;
  /** cell 类型（edit/append/insert 时可选） */
  readonly cellType?: "code" | "markdown";
}

/** notebook 编辑操作的返回结果 */
export interface NotebookEditResult {
  /** 操作是否成功 */
  readonly success: boolean;
  /** 操作后 notebook 中的 cell 总数 */
  readonly cellCount?: number;
  /** 错误信息（如有） */
  readonly error?: string;
}

/** Jupyter Notebook 中单个 cell 的内部结构 */
interface NotebookCell {
  cell_type: "code" | "markdown" | "raw";
  source: string | string[];
  metadata: Record<string, unknown>;
  outputs?: unknown[];
  execution_count?: number | null;
}

/** Jupyter Notebook 文件的顶层 JSON 结构 */
interface NotebookJson {
  cells: NotebookCell[];
  metadata: Record<string, unknown>;
  nbformat: number;
  nbformat_minor: number;
}

/** 类型守卫：验证一个未知值是否为合法的 Notebook JSON 结构 */
function asNotebookJson(v: unknown): NotebookJson | null {
  if (v === null || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o.cells)) return null;
  if (typeof o.nbformat !== "number") return null;
  return o as unknown as NotebookJson;
}

/**
 * 设置 cell 的源码内容。
 *
 * Jupyter notebook 中 cell.source 有两种格式：
 * - string[]（每行一个元素，行末带 \n）
 * - string（完整文本）
 *
 * 此函数会根据原始格式选择对应的写入方式，尽量保持 notebook 的风格一致性。
 * 如果是 string[] 格式，会将输入按换行符拆分，每行末尾（除最后一行）添加 \n。
 */
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

/**
 * 编辑 Jupyter Notebook 文件。
 *
 * 支持四种操作：
 * - edit: 修改指定索引的 cell（可同时修改源码和类型）
 * - append: 在末尾追加新 cell
 * - insert: 在指定位置插入新 cell（默认索引 0）
 * - delete: 删除指定索引的 cell
 *
 * 切换 cell 类型为 code 时，会自动添加 outputs 和 execution_count 字段。
 *
 * @param workspaceRoot 工作区根目录绝对路径
 * @param relPath notebook 文件相对于工作区的路径
 * @param opts 编辑操作选项
 * @returns 操作结果，包含 success 标志和 cellCount
 */
export function editNotebook(
  workspaceRoot: string,
  relPath: string,
  opts: NotebookEditOptions,
): NotebookEditResult {
  // 安全检查：确保目标路径在工作区内
  const guard = checkWorkspacePath(workspaceRoot, relPath);
  if (!guard.allowed) {
    return { success: false, error: guard.reason };
  }
  const filePath = guard.resolvedPath;

  // 读取原始文件
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    return { success: false, error: err.message };
  }

  // 解析 JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { success: false, error: "invalid JSON in notebook file" };
  }

  // 验证 notebook 结构
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
    // 如果提供了 source，更新 cell 源码
    if (opts.source !== undefined) {
      setSource(cell, opts.source);
    }
    // 如果提供了 cellType，更新 cell 类型
    if (opts.cellType !== undefined) {
      cell.cell_type = opts.cellType;
      // 切换到 code 类型时，确保有 outputs 数组和 execution_count
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
    // splice 在指定位置插入，现有元素自动后移
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

  // 将修改后的 notebook 写回文件
  try {
    fs.writeFileSync(filePath, JSON.stringify(nb, null, 1), "utf8");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    return { success: false, error: err.message };
  }

  return { success: true, cellCount: nb.cells.length };
}
