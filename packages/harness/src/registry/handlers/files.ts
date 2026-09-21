import { undoLastSafeFileMutationCheckpoint } from "@paw/core";
import {
  applyWorkspacePatch,
  editNotebook,
  editWorkspaceFile,
  globWorkspaceFiles,
  grepWorkspaceText,
  listWorkspaceFiles,
  readWorkspaceFile,
  searchWorkspaceText,
  writeWorkspaceFile,
} from "@paw/workspace";
/** 文件读写与检索类工具（read/list/search/glob/grep/write/edit/undo/notebook/patch）。 */
import { diagnoseEditedFilesV1 } from "../../post-edit-diagnostics.js";
import type { ToolRunResult } from "../definitions.js";
import {
  type ToolScope,
  diagnosticSummarySuffix,
  errorCodeForToolPayload,
  num,
  toolErrorResult,
} from "../tool-support.js";

/** `workspace.read_file` */
export async function handleRead(scope: ToolScope): Promise<ToolRunResult> {
  const { ctx, rec } = scope;
  const path = typeof rec.path === "string" ? rec.path : "";
  if (!path) {
    return toolErrorResult("read_file", "E_USER", "missing path", {
      field: "path",
    });
  }
  const offset = num(rec.offset, 0) ?? 0;
  const limit = num(rec.limit, undefined);
  const r = readWorkspaceFile(ctx.workspaceRoot, path, {
    offset,
    ...(limit !== undefined ? { limit } : {}),
  });
  if (r.error) {
    return toolErrorResult("read_file", errorCodeForToolPayload(r), r.error, {
      path,
    });
  }
  return {
    ok: true,
    payload: r,
    summary: `read_file: ${path} (${r.line_count ?? "?"} lines shown)`,
  };
}

/** `workspace.list_dir` */
export async function handleList(scope: ToolScope): Promise<ToolRunResult> {
  const { ctx, rec } = scope;
  const path = typeof rec.path === "string" ? rec.path : ".";
  const recursive = Boolean(rec.recursive);
  const r = listWorkspaceFiles(ctx.workspaceRoot, path, { recursive });
  if (r.error) {
    return toolErrorResult("list_dir", errorCodeForToolPayload(r), r.error, {
      path,
    });
  }
  const n = Array.isArray(r.files) ? r.files.length : 0;
  return {
    ok: true,
    payload: r,
    summary: `list_dir: ${path} (${n} entries)`,
  };
}

/** `workspace.search` */
export async function handleSearch(scope: ToolScope): Promise<ToolRunResult> {
  const { ctx, rec } = scope;
  const pattern = typeof rec.pattern === "string" ? rec.pattern : "";
  if (!pattern) {
    return toolErrorResult("search", "E_USER", "missing pattern", {
      field: "pattern",
    });
  }
  const searchPath = typeof rec.path === "string" ? rec.path : ".";
  const filePattern =
    typeof rec.file_pattern === "string"
      ? rec.file_pattern
      : typeof rec.filePattern === "string"
        ? rec.filePattern
        : undefined;
  const maxResults = num(rec.max_results, undefined) ?? num(rec.maxResults, undefined);
  const maxDepth = num(rec.max_depth, undefined) ?? num(rec.maxDepth, undefined);
  const caseSensitive =
    typeof rec.case_sensitive === "boolean"
      ? rec.case_sensitive
      : typeof rec.caseSensitive === "boolean"
        ? rec.caseSensitive
        : false;
  const useRegex =
    typeof rec.regex === "boolean"
      ? rec.regex
      : typeof rec.use_regex === "boolean"
        ? rec.use_regex
        : false;
  const r = searchWorkspaceText(ctx.workspaceRoot, searchPath, {
    pattern,
    ...(filePattern !== undefined ? { filePattern } : {}),
    ...(maxResults !== undefined ? { maxResults } : {}),
    ...(caseSensitive ? { caseSensitive: true } : {}),
    ...(useRegex ? { regex: true } : {}),
    ...(maxDepth !== undefined ? { maxDepth } : {}),
  });
  if (r.error) {
    return toolErrorResult("search", errorCodeForToolPayload(r), r.error);
  }
  const n = r.match_count ?? (Array.isArray(r.matches) ? r.matches.length : 0);
  const tail = r.truncated ? " (truncated)" : "";
  return {
    ok: true,
    payload: r,
    summary: `search: ${n} match(es)${tail}`,
  };
}

/** `workspace.glob` */
export async function handleGlob(scope: ToolScope): Promise<ToolRunResult> {
  const { ctx, rec } = scope;
  const pattern = typeof rec.pattern === "string" ? rec.pattern : "";
  if (!pattern) {
    return toolErrorResult("glob", "E_USER", "missing pattern", {
      field: "pattern",
    });
  }
  const globPath = typeof rec.path === "string" ? rec.path : ".";
  const maxDepth = num(rec.max_depth, undefined) ?? num(rec.maxDepth, undefined);
  const r = globWorkspaceFiles(ctx.workspaceRoot, globPath, {
    pattern,
    ...(maxDepth !== undefined ? { maxDepth } : {}),
  });
  if (r.error) {
    return toolErrorResult("glob", errorCodeForToolPayload(r), r.error);
  }
  const tail = r.truncated ? " (truncated)" : "";
  return {
    ok: true,
    payload: r,
    summary: `glob: ${r.numFiles ?? 0} file(s)${tail}`,
  };
}

/** `workspace.grep` */
export async function handleGrep(scope: ToolScope): Promise<ToolRunResult> {
  const { ctx, rec } = scope;
  const pattern = typeof rec.pattern === "string" ? rec.pattern : "";
  if (!pattern) {
    return toolErrorResult("grep", "E_USER", "missing pattern", {
      field: "pattern",
    });
  }
  const grepPath = typeof rec.path === "string" ? rec.path : ".";
  const filePattern =
    typeof rec.file_pattern === "string"
      ? rec.file_pattern
      : typeof rec.filePattern === "string"
        ? rec.filePattern
        : undefined;
  const maxResults = num(rec.max_results, undefined) ?? num(rec.maxResults, undefined);
  const maxDepth = num(rec.max_depth, undefined) ?? num(rec.maxDepth, undefined);
  const caseSensitive =
    typeof rec.case_sensitive === "boolean"
      ? rec.case_sensitive
      : typeof rec.caseSensitive === "boolean"
        ? rec.caseSensitive
        : false;
  const useRegex =
    typeof rec.regex === "boolean"
      ? rec.regex
      : typeof rec.use_regex === "boolean"
        ? rec.use_regex
        : true;
  const outputMode =
    typeof rec.output_mode === "string"
      ? (rec.output_mode as "content" | "files_with_matches" | "count")
      : typeof rec.outputMode === "string"
        ? (rec.outputMode as "content" | "files_with_matches" | "count")
        : "files_with_matches";
  const contextBefore = num(rec["-B"], undefined) ?? num(rec.context_before, undefined);
  const contextAfter = num(rec["-A"], undefined) ?? num(rec.context_after, undefined);
  const context = num(rec["-C"], undefined) ?? num(rec.context, undefined);
  const showLineNumbers =
    typeof rec["-n"] === "boolean"
      ? rec["-n"]
      : typeof rec.show_line_numbers === "boolean"
        ? rec.show_line_numbers
        : true;
  const headLimit = num(rec.head_limit, undefined) ?? num(rec.headLimit, undefined);
  const offset = num(rec.offset, undefined) ?? 0;
  const r = grepWorkspaceText(ctx.workspaceRoot, grepPath, {
    pattern,
    ...(filePattern !== undefined ? { filePattern } : {}),
    ...(maxResults !== undefined ? { maxResults } : {}),
    ...(caseSensitive ? { caseSensitive: true } : {}),
    ...(useRegex ? { regex: true } : {}),
    ...(maxDepth !== undefined ? { maxDepth } : {}),
    outputMode,
    ...(contextBefore !== undefined ? { contextBefore } : {}),
    ...(contextAfter !== undefined ? { contextAfter } : {}),
    ...(context !== undefined ? { context } : {}),
    showLineNumbers,
    ...(headLimit !== undefined ? { headLimit } : {}),
    ...(offset > 0 ? { offset } : {}),
  });
  if (r.error) {
    return toolErrorResult("grep", errorCodeForToolPayload(r), r.error);
  }
  if (r.mode === "count") {
    return {
      ok: true,
      payload: r,
      summary: `grep: ${r.match_count ?? 0} match(es)`,
    };
  }
  if (r.mode === "files_with_matches") {
    const tail = r.truncated ? " (truncated)" : "";
    return {
      ok: true,
      payload: r,
      summary: `grep: ${r.filenames?.length ?? 0} file(s)${tail}`,
    };
  }
  const tail = r.truncated ? " (truncated)" : "";
  return {
    ok: true,
    payload: r,
    summary: `grep: ${r.match_count ?? 0} match(es)${tail}`,
  };
}

/** `workspace.write_file` */
export async function handleWrite(scope: ToolScope): Promise<ToolRunResult> {
  const { ctx, rec } = scope;
  const filePath = typeof rec.path === "string" ? rec.path : "";
  const content = typeof rec.content === "string" ? rec.content : "";
  if (!filePath) {
    return toolErrorResult("write_file", "E_USER", "missing path", {
      field: "path",
    });
  }
  const createDirectories =
    typeof rec.create_directories === "boolean"
      ? rec.create_directories
      : typeof rec.createDirectories === "boolean"
        ? rec.createDirectories
        : true;
  const r = writeWorkspaceFile(ctx.workspaceRoot, filePath, content, {
    createDirectories,
  });
  if (r.error) {
    return toolErrorResult("write_file", errorCodeForToolPayload(r), r.error, { path: filePath });
  }
  if (r.changed === false) {
    return toolErrorResult("write_file", "E_USER", "write produced no content change", {
      path: filePath,
    });
  }
  ctx.watcher?.markAgentWritten(filePath);
  const diagnostics = diagnoseEditedFilesV1(ctx.workspaceRoot, [filePath]);
  return {
    ok: true,
    payload: { ...r, diagnostics },
    summary: `write_file: ${filePath} (${r.bytes_written ?? 0} bytes)${diagnosticSummarySuffix(diagnostics)}`,
  };
}

/** `workspace.edit_file` */
export async function handleEdit(scope: ToolScope): Promise<ToolRunResult> {
  const { ctx, rec } = scope;
  const filePath = typeof rec.path === "string" ? rec.path : "";
  const rawOldString =
    typeof rec.old_string === "string"
      ? rec.old_string
      : typeof rec.oldString === "string"
        ? rec.oldString
        : undefined;
  const oldString = rawOldString ?? "";
  const newString =
    typeof rec.new_string === "string"
      ? rec.new_string
      : typeof rec.newString === "string"
        ? rec.newString
        : "";
  if (!filePath) {
    return toolErrorResult("edit_file", "E_USER", "missing path", {
      field: "path",
    });
  }
  if (rawOldString === undefined) {
    return toolErrorResult("edit_file", "E_USER", "missing old_string", {
      field: "old_string",
    });
  }
  if (oldString.length === 0) {
    const created = writeWorkspaceFile(ctx.workspaceRoot, filePath, newString, {
      createDirectories: true,
      createOnly: true,
    });
    if (created.error) {
      return toolErrorResult("edit_file", errorCodeForToolPayload(created), created.error, {
        path: filePath,
      });
    }
    ctx.watcher?.markAgentWritten(filePath);
    const diagnostics = diagnoseEditedFilesV1(ctx.workspaceRoot, [filePath]);
    return {
      ok: true,
      payload: { ...created, diagnostics },
      summary: `edit_file(create): ${filePath} (${created.bytes_written ?? 0} bytes)${diagnosticSummarySuffix(diagnostics)}`,
    };
  }
  const startLine = num(rec.start_line, undefined) ?? num(rec.startLine, undefined);
  const endLine = num(rec.end_line, undefined) ?? num(rec.endLine, undefined);
  const fuzzy =
    typeof rec.fuzzy === "boolean"
      ? rec.fuzzy
      : typeof rec.fuzzy_match === "boolean"
        ? rec.fuzzy_match
        : false;
  const replaceAll =
    rec.replace_all === true || rec.replaceAll === true || rec.replace_all === "true";
  const r = editWorkspaceFile(ctx.workspaceRoot, filePath, {
    oldString: oldString || undefined,
    newString,
    ...(startLine !== undefined ? { startLine } : {}),
    ...(endLine !== undefined ? { endLine } : {}),
    ...(fuzzy ? { fuzzy: true } : {}),
    ...(replaceAll ? { replaceAll: true } : {}),
  });
  if (r.error) {
    return toolErrorResult("edit_file", errorCodeForToolPayload(r), r.error, {
      path: filePath,
    });
  }
  if (r.changed === false) {
    return toolErrorResult(
      "edit_file",
      "E_USER",
      "replacement produced no content change; use read_file or grep to inspect text",
      { path: filePath },
    );
  }
  const diffHint =
    r.linesAdded !== undefined && r.linesRemoved !== undefined
      ? ` +${r.linesAdded}/-${r.linesRemoved}`
      : "";
  ctx.watcher?.markAgentWritten(filePath);
  const diagnostics = diagnoseEditedFilesV1(ctx.workspaceRoot, [filePath]);
  return {
    ok: true,
    payload: { ...r, diagnostics },
    summary: `edit_file: ${filePath}${diffHint}${diagnosticSummarySuffix(diagnostics)}`,
  };
}

/** `workspace.undo_last_edit` */
export async function handleUndoLastEdit(scope: ToolScope): Promise<ToolRunResult> {
  const { ctx } = scope;
  const checkpointNamespaceId = ctx.checkpointNamespaceId?.trim() ?? ctx.parentRunId?.trim();
  if (!checkpointNamespaceId) {
    return toolErrorResult("undo_last_edit", "E_USER", "safe undo requires an active Agent run");
  }
  const undone = undoLastSafeFileMutationCheckpoint(ctx.workspaceRoot, checkpointNamespaceId);
  if (undone.status === "none") {
    return toolErrorResult(
      "undo_last_edit",
      "E_USER",
      "no finalized checkpoint-backed file mutation is available to undo",
    );
  }
  if (undone.status === "conflict") {
    return toolErrorResult(
      "undo_last_edit",
      "E_USER",
      `safe undo refused because files changed after the Agent edit: ${undone.conflictingPaths.join(", ")}`,
    );
  }
  if (undone.status === "invalid") {
    return toolErrorResult(
      "undo_last_edit",
      "E_USER",
      `safe undo refused because checkpoint metadata is invalid: ${undone.reason}`,
    );
  }
  const paths = undone.entry.targets.filter((target) => target !== "__shell_cmd__");
  for (const restoredPath of paths) {
    ctx.watcher?.markAgentWritten(restoredPath);
  }
  return {
    ok: true,
    summary: `undo_last_edit: restored checkpoint ${undone.entry.seq} (${paths.join(", ")})`,
    payload: {
      checkpointSeq: undone.entry.seq,
      restoredTool: undone.entry.tool,
      paths,
      workspaceEffect: { changed: paths.length > 0, paths },
    },
  };
}

/** `workspace.notebook_edit` */
export async function handleNotebookEdit(scope: ToolScope): Promise<ToolRunResult> {
  const { ctx, rec } = scope;
  const filePath = typeof rec.path === "string" ? rec.path : "";
  if (!filePath) {
    return {
      ok: false,
      payload: { error: "missing path" },
      summary: "notebook_edit: missing path",
    };
  }
  const action =
    typeof rec.action === "string"
      ? (rec.action as "edit" | "append" | "insert" | "delete")
      : "edit";
  const cellIndex = num(rec.cell_index, undefined) ?? num(rec.cellIndex, undefined);
  const source = typeof rec.source === "string" ? rec.source : undefined;
  const cellType =
    rec.cell_type === "code" || rec.cell_type === "markdown"
      ? rec.cell_type
      : rec.cellType === "code" || rec.cellType === "markdown"
        ? rec.cellType
        : undefined;
  const r = editNotebook(ctx.workspaceRoot, filePath, {
    action,
    ...(cellIndex !== undefined ? { cellIndex } : {}),
    ...(source !== undefined ? { source } : {}),
    ...(cellType !== undefined ? { cellType } : {}),
  });
  if (!r.success) {
    return {
      ok: false,
      payload: r,
      summary: `notebook_edit: ${r.error}`,
    };
  }
  ctx.watcher?.markAgentWritten(filePath);
  return {
    ok: true,
    payload: r,
    summary: `notebook_edit: ${filePath} (${r.cellCount} cells)`,
  };
}

/** `workspace.apply_patch` */
export async function handleApplyPatch(scope: ToolScope): Promise<ToolRunResult> {
  const { ctx, rec } = scope;
  const patchText = typeof rec.patch === "string" ? rec.patch : "";
  if (!patchText.trim()) {
    return {
      ok: false,
      payload: { error: "missing patch" },
      summary: "apply_patch: missing patch",
    };
  }
  const r = applyWorkspacePatch(ctx.workspaceRoot, patchText);
  if (r.ok) {
    for (const f of r.results.filter((rr) => rr.ok && rr.changed === true).map((rr) => rr.path)) {
      ctx.watcher?.markAgentWritten(f);
    }
  }
  const changedPaths = r.ok
    ? r.results
        .filter((result) => result.ok && result.changed === true)
        .map((result) => result.path)
    : [];
  const diagnostics = r.ok ? diagnoseEditedFilesV1(ctx.workspaceRoot, changedPaths) : undefined;
  return {
    ok: r.ok,
    payload: diagnostics ? { ...r, diagnostics } : r,
    summary: diagnostics ? `${r.summary}${diagnosticSummarySuffix(diagnostics)}` : r.summary,
  };
}
