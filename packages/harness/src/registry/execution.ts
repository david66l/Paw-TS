import path from "node:path";

import {
  type ToolErrorCode,
  makeToolError,
  renderSkillPrompt,
} from "@paw/core";
import {
  LspClient,
  applyWorkspacePatch,
  detectLspCommand,
  editNotebook,
  editWorkspaceFile,
  fetchWebPage,
  generateBrief,
  gitDiff,
  gitLog,
  gitStatus,
  globWorkspaceFiles,
  grepWorkspaceText,
  listWorkspaceFiles,
  readWorkspaceFile,
  searchWeb,
  searchWorkspaceSymbols,
  searchWorkspaceText,
  writeWorkspaceFile,
} from "@paw/workspace";

import type { HarnessContext } from "../context.js";
import { diagnoseEditedFilesV1 } from "../post-edit-diagnostics.js";
import {
  type RunShellResult,
  interpretShellExitCode,
  runShellInWorkspace,
  runShellInWorkspaceStreaming,
} from "../shell/index.js";

import fs from "node:fs";
import {
  ACCEPTANCE_UPDATE,
  APPLY_PATCH,
  BRIEF,
  CONTEXT_RECALL,
  CREATE_AGENT,
  EDIT,
  GIT_DIFF,
  GIT_LOG,
  GIT_STATUS,
  GLOB,
  GREP,
  JOB_KILL,
  JOB_LIST,
  JOB_READ,
  JOB_START,
  JOB_WAIT,
  LIST,
  LSP,
  MEMORY_LIST,
  MEMORY_READ,
  MEMORY_SAVE,
  NOTEBOOK_EDIT,
  READ,
  RUN_AGENT,
  RUN_SKILL,
  SEARCH,
  SHELL,
  SYMBOL_SEARCH,
  TODO_WRITE,
  type ToolRunResult,
  WEBFETCH,
  WEBSEARCH,
  WRITE,
  toolDefinitions,
} from "./definitions.js";

type AcceptanceUpdateInput = Omit<
  import("@paw/core").AgentAcceptanceUpdateAction,
  "type"
>;

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function num(v: unknown, d: number | undefined): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) {
    return v;
  }
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  }
  return d;
}

interface JsonPropertySchema {
  readonly type?: string;
}

interface JsonObjectSchema {
  readonly properties?: Record<string, JsonPropertySchema>;
  readonly required?: string[];
}

function schemaForTool(tool: string): JsonObjectSchema | null {
  const sanitized = tool.replace(/\./g, "_");
  const def = toolDefinitions().find((d) => d.function.name === sanitized);
  const schema = def?.function.parameters;
  return schema && typeof schema === "object"
    ? (schema as JsonObjectSchema)
    : null;
}

function matchesJsonType(value: unknown, expected: string): boolean {
  if (expected === "integer") {
    return Number.isInteger(value);
  }
  if (expected === "array") {
    return Array.isArray(value);
  }
  if (expected === "object") {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }
  if (expected === "boolean") {
    return typeof value === "boolean";
  }
  if (expected === "number") {
    return typeof value === "number";
  }
  if (expected === "string") {
    return typeof value === "string";
  }
  return true;
}

function validateArgs(tool: string, args: unknown): ToolRunResult | null {
  const schema = schemaForTool(tool);
  if (!schema) {
    return null;
  }
  const rec = asRecord(args) ?? (args == null ? {} : null);
  if (!rec) {
    return {
      ok: false,
      payload: makeToolError("E_SCHEMA_INVALID", "arguments must be an object"),
      summary: `${tool}: E_SCHEMA_INVALID arguments must be an object`,
    };
  }
  for (const name of schema.required ?? []) {
    if (!(name in rec)) {
      return {
        ok: false,
        payload: makeToolError(
          "E_SCHEMA_INVALID",
          `missing required field: ${name}`,
          { field: name },
        ),
        summary: `${tool}: E_SCHEMA_INVALID missing required field: ${name}`,
      };
    }
  }
  for (const [name, prop] of Object.entries(schema.properties ?? {})) {
    if (!(name in rec) || rec[name] === undefined || prop.type === undefined) {
      continue;
    }
    if (!matchesJsonType(rec[name], prop.type)) {
      return {
        ok: false,
        payload: makeToolError(
          "E_SCHEMA_INVALID",
          `field ${name} must be ${prop.type}`,
          { field: name, expected: prop.type },
        ),
        summary: `${tool}: E_SCHEMA_INVALID field ${name} must be ${prop.type}`,
      };
    }
  }
  return null;
}

function toolErrorResult(
  tool: string,
  code: ToolErrorCode,
  message: string,
  detail?: Parameters<typeof makeToolError>[2],
): ToolRunResult {
  return {
    ok: false,
    payload: makeToolError(code, message, detail),
    summary: `${tool}: ${code} ${message}`,
  };
}

function diagnosticSummarySuffix(diagnostics: {
  readonly status: string;
  readonly issueCount: number;
}): string {
  return diagnostics.status === "issues"
    ? `; syntax diagnostics: ${diagnostics.issueCount} error(s)`
    : diagnostics.status === "clean"
      ? "; syntax diagnostics: clean"
      : "; syntax diagnostics: unavailable";
}

function parseAcceptanceUpdate(
  rec: Record<string, unknown>,
): AcceptanceUpdateInput | string {
  const rawAdd = Array.isArray(rec.add) ? rec.add : [];
  const rawUpdates = Array.isArray(rec.updates) ? rec.updates : [];
  const add: Array<AcceptanceUpdateInput["add"][number]> = [];
  const updates: Array<AcceptanceUpdateInput["updates"][number]> = [];
  for (const [index, raw] of rawAdd.entries()) {
    const item = asRecord(raw);
    if (!item || typeof item.text !== "string" || !item.text.trim()) {
      return `add[${index}].text must be a non-empty string`;
    }
    if (
      item.source !== "user" &&
      item.source !== "repository" &&
      item.source !== "verification"
    ) {
      return `add[${index}].source must be user, repository, or verification`;
    }
    if (item.ref !== undefined && typeof item.ref !== "string") {
      return `add[${index}].ref must be a string`;
    }
    add.push({
      text: item.text.trim(),
      source: item.source,
      ...(typeof item.ref === "string" && item.ref.trim()
        ? { ref: item.ref.trim() }
        : {}),
    });
  }
  for (const [index, raw] of rawUpdates.entries()) {
    const item = asRecord(raw);
    if (!item || typeof item.id !== "string" || !item.id.trim()) {
      return `updates[${index}].id must be a non-empty string`;
    }
    if (
      item.status !== "pending" &&
      item.status !== "satisfied" &&
      item.status !== "blocked" &&
      item.status !== "superseded"
    ) {
      return `updates[${index}].status is invalid`;
    }
    if (item.evidence !== undefined && typeof item.evidence !== "string") {
      return `updates[${index}].evidence must be a string`;
    }
    const evidence =
      typeof item.evidence === "string" ? item.evidence.trim() : "";
    if (item.status === "satisfied" && !evidence) {
      return `updates[${index}] satisfied requires non-empty evidence`;
    }
    updates.push({
      id: item.id.trim(),
      status: item.status,
      ...(evidence ? { evidence } : {}),
    });
  }
  if (add.length === 0 && updates.length === 0) {
    return "at least one add or update is required";
  }
  return {
    add,
    updates,
    reason: typeof rec.reason === "string" ? rec.reason.trim() : "",
  };
}

function errorCodeForToolPayload(payload: unknown): ToolErrorCode {
  const rec = asRecord(payload);
  const error = typeof rec?.error === "string" ? rec.error.toLowerCase() : "";
  const risk = typeof rec?.risk === "string" ? rec.risk : "";
  if (risk === "escaped" || risk === "sensitive") {
    return "E_POLICY_DENIED";
  }
  if (
    error.includes("escapes workspace") ||
    error.includes("sensitive") ||
    error.includes("disallowed") ||
    error.includes("blocked pattern") ||
    error.includes("blocked literal") ||
    error.includes("blocked command") ||
    error.includes("blocked:") ||
    error.includes("requires approval") ||
    error.includes("default action")
  ) {
    return "E_POLICY_DENIED";
  }
  if (
    error.includes("enoent") ||
    error.includes("not found") ||
    error.includes("missing")
  ) {
    return "E_USER";
  }
  return "E_FATAL";
}

export async function executeTool(
  ctx: HarnessContext,
  tool: string,
  args: unknown,
): Promise<ToolRunResult> {
  // MCP tools take priority if present.
  if (ctx.mcp?.isMcpTool(tool)) {
    const parsed = ctx.mcp.parseToolId(tool);
    if (!parsed) {
      return {
        ok: false,
        payload: { error: `invalid MCP tool id: ${tool}` },
        summary: `invalid MCP tool id: ${tool}`,
      };
    }
    return ctx.mcp.callTool(parsed.serverName, parsed.toolName, args);
  }

  const schemaError = validateArgs(tool, args);
  if (schemaError) {
    return schemaError;
  }

  const rec = asRecord(args) ?? {};
  if (tool === READ) {
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
  if (tool === LIST) {
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
  if (tool === SEARCH) {
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
    const maxResults =
      num(rec.max_results, undefined) ?? num(rec.maxResults, undefined);
    const maxDepth =
      num(rec.max_depth, undefined) ?? num(rec.maxDepth, undefined);
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
    const n =
      r.match_count ?? (Array.isArray(r.matches) ? r.matches.length : 0);
    const tail = r.truncated ? " (truncated)" : "";
    return {
      ok: true,
      payload: r,
      summary: `search: ${n} match(es)${tail}`,
    };
  }
  if (tool === GLOB) {
    const pattern = typeof rec.pattern === "string" ? rec.pattern : "";
    if (!pattern) {
      return toolErrorResult("glob", "E_USER", "missing pattern", {
        field: "pattern",
      });
    }
    const globPath = typeof rec.path === "string" ? rec.path : ".";
    const maxDepth =
      num(rec.max_depth, undefined) ?? num(rec.maxDepth, undefined);
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
  if (tool === GREP) {
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
    const maxResults =
      num(rec.max_results, undefined) ?? num(rec.maxResults, undefined);
    const maxDepth =
      num(rec.max_depth, undefined) ?? num(rec.maxDepth, undefined);
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
    const contextBefore =
      num(rec["-B"], undefined) ?? num(rec.context_before, undefined);
    const contextAfter =
      num(rec["-A"], undefined) ?? num(rec.context_after, undefined);
    const context = num(rec["-C"], undefined) ?? num(rec.context, undefined);
    const showLineNumbers =
      typeof rec["-n"] === "boolean"
        ? rec["-n"]
        : typeof rec.show_line_numbers === "boolean"
          ? rec.show_line_numbers
          : true;
    const headLimit =
      num(rec.head_limit, undefined) ?? num(rec.headLimit, undefined);
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
  if (tool === WRITE) {
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
      return toolErrorResult(
        "write_file",
        errorCodeForToolPayload(r),
        r.error,
        { path: filePath },
      );
    }
    if (r.changed === false) {
      return toolErrorResult(
        "write_file",
        "E_USER",
        "write produced no content change",
        { path: filePath },
      );
    }
    ctx.watcher?.markAgentWritten(filePath);
    const diagnostics = diagnoseEditedFilesV1(ctx.workspaceRoot, [filePath]);
    return {
      ok: true,
      payload: { ...r, diagnostics },
      summary: `write_file: ${filePath} (${r.bytes_written ?? 0} bytes)${diagnosticSummarySuffix(diagnostics)}`,
    };
  }
  if (tool === EDIT) {
    const filePath = typeof rec.path === "string" ? rec.path : "";
    const oldString =
      typeof rec.old_string === "string"
        ? rec.old_string
        : typeof rec.oldString === "string"
          ? rec.oldString
          : "";
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
    if (!oldString) {
      return toolErrorResult("edit_file", "E_USER", "missing old_string", {
        field: "old_string",
      });
    }
    const startLine =
      num(rec.start_line, undefined) ?? num(rec.startLine, undefined);
    const endLine = num(rec.end_line, undefined) ?? num(rec.endLine, undefined);
    const fuzzy =
      typeof rec.fuzzy === "boolean"
        ? rec.fuzzy
        : typeof rec.fuzzy_match === "boolean"
          ? rec.fuzzy_match
          : false;
    const replaceAll =
      rec.replace_all === true ||
      rec.replaceAll === true ||
      rec.replace_all === "true";
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
  if (tool === JOB_START) {
    const command = typeof rec.command === "string" ? rec.command.trim() : "";
    if (!command) {
      return toolErrorResult("job_start", "E_USER", "missing command", {
        field: "command",
      });
    }
    if (!ctx.managedJobs) {
      return toolErrorResult(
        "job_start",
        "E_FATAL",
        "managed job controller not configured",
      );
    }
    const cwd =
      typeof rec.cwd === "string" && rec.cwd.trim() ? rec.cwd : undefined;
    const outputLimitBytes =
      num(rec.output_limit_bytes, undefined) ??
      num(rec.outputLimitBytes, undefined);
    if (
      outputLimitBytes !== undefined &&
      (!Number.isSafeInteger(outputLimitBytes) ||
        outputLimitBytes < 1_024 ||
        outputLimitBytes > 4 * 1024 * 1024)
    ) {
      return toolErrorResult(
        "job_start",
        "E_SCHEMA_INVALID",
        "output_limit_bytes must be an integer between 1024 and 4194304",
      );
    }
    try {
      const started = await ctx.managedJobs.startShell({
        command,
        ...(cwd ? { cwd } : {}),
        ...(outputLimitBytes !== undefined ? { outputLimitBytes } : {}),
      });
      return {
        ok: true,
        payload: started,
        summary: `job_start: ${started.jobId} running (pid ${started.pid})`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return toolErrorResult(
        "job_start",
        message.startsWith("[ToolExecutionPolicy:")
          ? "E_POLICY_DENIED"
          : "E_FATAL",
        message,
      );
    }
  }
  if (tool === JOB_LIST) {
    if (!ctx.managedJobs) {
      return toolErrorResult(
        "job_list",
        "E_FATAL",
        "managed job controller not configured",
      );
    }
    const jobs = ctx.managedJobs.list();
    return {
      ok: true,
      payload: { jobs },
      summary: `job_list: ${jobs.length} job(s)`,
    };
  }
  if (tool === JOB_READ) {
    const id = typeof rec.id === "string" ? rec.id.trim() : "";
    if (!id) return toolErrorResult("job_read", "E_USER", "missing id");
    if (!ctx.managedJobs) {
      return toolErrorResult(
        "job_read",
        "E_FATAL",
        "managed job controller not configured",
      );
    }
    try {
      const read = ctx.managedJobs.read(id);
      return {
        ok: true,
        payload: read,
        summary: `job_read: ${id} ${read.snapshot.status} (${read.text.length} chars)`,
      };
    } catch (error) {
      return toolErrorResult(
        "job_read",
        "E_USER",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  if (tool === JOB_WAIT) {
    const id = typeof rec.id === "string" ? rec.id.trim() : "";
    if (!id) return toolErrorResult("job_wait", "E_USER", "missing id");
    if (!ctx.managedJobs) {
      return toolErrorResult(
        "job_wait",
        "E_FATAL",
        "managed job controller not configured",
      );
    }
    const requested = num(rec.timeout_sec, undefined) ?? 10;
    if (!Number.isFinite(requested) || requested < 0.1 || requested > 30) {
      return toolErrorResult(
        "job_wait",
        "E_SCHEMA_INVALID",
        "timeout_sec must be between 0.1 and 30",
      );
    }
    try {
      const waited = await ctx.managedJobs.wait(
        id,
        Math.floor(requested * 1_000),
        ctx.abortSignal,
      );
      return {
        ok: true,
        payload: waited,
        summary: waited.timedOut
          ? `job_wait: ${id} still ${waited.snapshot.status} after ${requested}s`
          : `job_wait: ${id} ${waited.snapshot.status}`,
      };
    } catch (error) {
      return toolErrorResult(
        "job_wait",
        "E_USER",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  if (tool === JOB_KILL) {
    const id = typeof rec.id === "string" ? rec.id.trim() : "";
    if (!id) return toolErrorResult("job_kill", "E_USER", "missing id");
    if (!ctx.managedJobs) {
      return toolErrorResult(
        "job_kill",
        "E_FATAL",
        "managed job controller not configured",
      );
    }
    const reason =
      typeof rec.reason === "string" && rec.reason.trim()
        ? rec.reason.trim()
        : undefined;
    try {
      const status = ctx.managedJobs.kill(id, reason);
      return {
        ok: true,
        payload: { id, status },
        summary: `job_kill: ${id} ${status}`,
      };
    } catch (error) {
      return toolErrorResult(
        "job_kill",
        "E_USER",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  if (tool === SHELL) {
    const cmd = typeof rec.command === "string" ? rec.command : "";
    if (!cmd.trim()) {
      return toolErrorResult("run_shell", "E_USER", "missing command", {
        field: "command",
      });
    }
    const cwd =
      typeof rec.cwd === "string" && rec.cwd.trim() ? rec.cwd : undefined;
    const timeoutSec =
      num(rec.timeout_sec, undefined) ?? num(rec.timeoutSec, undefined);
    const timeoutMs =
      timeoutSec !== undefined && Number.isFinite(timeoutSec)
        ? Math.floor(timeoutSec * 1000)
        : undefined;
    const shellOpts = {
      ...(cwd !== undefined ? { cwd } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(ctx.shellSandbox ? { shellSandbox: ctx.shellSandbox } : {}),
      ...(ctx.shellCommandPreApproved ? { skipApprovalGate: true } : {}),
    };
    const onChunk = ctx.onShellChunk;
    const r = onChunk
      ? await runShellInWorkspaceStreaming(ctx.workspaceRoot, cmd, {
          ...shellOpts,
          onChunk: (chunk, isStderr) => onChunk(tool, chunk, isStderr),
        })
      : runShellInWorkspace(ctx.workspaceRoot, cmd, shellOpts);
    if (r.error) {
      const msg = r.timed_out ? "timeout" : r.error;
      const code: ToolErrorCode = r.timed_out
        ? "E_RETRY"
        : r.requiresApproval
          ? "E_POLICY_DENIED"
          : errorCodeForToolPayload(r);
      return toolErrorResult("run_shell", code, msg);
    }
    const code = r.exit_code ?? "?";
    const interpretation = interpretShellExitCode(cmd, r.exit_code);
    const enriched: RunShellResult = {
      ...r,
      interpretation: interpretation.message,
    };
    const isError = interpretation.isError && r.exit_code !== 0;
    const summary =
      isError && interpretation.message
        ? `run_shell: exit ${code} — ${interpretation.message}`
        : `run_shell: exit ${code}`;
    return {
      ok: !isError,
      payload: enriched,
      summary,
    };
  }
  if (tool === WEBFETCH) {
    const url = typeof rec.url === "string" ? rec.url : "";
    const maxLength =
      num(rec.max_length, undefined) ?? num(rec.maxLength, undefined);
    const r = await fetchWebPage({
      url,
      ...(maxLength !== undefined ? { maxLength } : {}),
    });
    if (r.error) {
      return { ok: false, payload: r, summary: `web_fetch: ${r.error}` };
    }
    const len = r.content?.length ?? 0;
    return {
      ok: true,
      payload: r,
      summary: `web_fetch: ${r.title ?? url} (${len} chars)`,
    };
  }
  if (tool === WEBSEARCH) {
    const query = typeof rec.query === "string" ? rec.query : "";
    if (!query.trim()) {
      return {
        ok: false,
        payload: { error: "missing query" },
        summary: "web_search: missing query",
      };
    }
    const maxResults =
      num(rec.max_results, undefined) ?? num(rec.maxResults, undefined);
    const r = await searchWeb({
      query,
      ...(maxResults !== undefined ? { maxResults } : {}),
    });
    if (r.error) {
      return { ok: false, payload: r, summary: `web_search: ${r.error}` };
    }
    const n = r.results?.length ?? 0;
    return {
      ok: true,
      payload: r,
      summary: `web_search: ${n} result(s)`,
    };
  }
  if (tool === ACCEPTANCE_UPDATE) {
    const parsed = parseAcceptanceUpdate(rec);
    if (typeof parsed === "string") {
      return toolErrorResult("acceptance_update", "E_SCHEMA_INVALID", parsed);
    }
    if (!ctx.acceptanceLedger) {
      return toolErrorResult(
        "acceptance_update",
        "E_FATAL",
        "acceptance ledger not configured",
      );
    }
    const result = await ctx.acceptanceLedger.apply(parsed);
    if (!result.ok) {
      return toolErrorResult(
        "acceptance_update",
        "E_USER",
        result.error ?? "acceptance ledger rejected the update",
      );
    }
    return {
      ok: true,
      payload: {
        updated: true,
        state: result.state,
      },
      summary: `acceptance_update: ${parsed.add.length} added, ${parsed.updates.length} updated`,
    };
  }
  if (tool === TODO_WRITE) {
    const todos = Array.isArray(rec.todos) ? rec.todos : [];
    const todoStore = ctx.todoStore;
    if (!todoStore) {
      return {
        ok: false,
        payload: { error: "todo store not configured" },
        summary: "todo_write: todo store not configured",
      };
    }
    const items = todos
      .map((t: unknown): import("@paw/core").TodoItem | null => {
        if (t === null || typeof t !== "object") return null;
        const o = t as Record<string, unknown>;
        const id = typeof o.id === "string" ? o.id : "";
        const content = typeof o.content === "string" ? o.content : "";
        const status =
          o.status === "pending" ||
          o.status === "in_progress" ||
          o.status === "done"
            ? o.status
            : "pending";
        const priority =
          o.priority === "low" ||
          o.priority === "medium" ||
          o.priority === "high"
            ? o.priority
            : undefined;
        if (!id || !content) return null;
        return { id, content, status, ...(priority ? { priority } : {}) };
      })
      .filter((t): t is import("@paw/core").TodoItem => t !== null);
    todoStore.set(items);
    return {
      ok: true,
      payload: { count: items.length },
      summary: `todo_write: ${items.length} task(s)`,
    };
  }
  if (tool === NOTEBOOK_EDIT) {
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
    const cellIndex =
      num(rec.cell_index, undefined) ?? num(rec.cellIndex, undefined);
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
  if (tool === BRIEF) {
    const briefPath = typeof rec.path === "string" ? rec.path : ".";
    const maxFiles =
      num(rec.max_files, undefined) ?? num(rec.maxFiles, undefined);
    const r = generateBrief(ctx.workspaceRoot, {
      path: briefPath,
      ...(maxFiles !== undefined ? { maxFiles } : {}),
    });
    if (r.error) {
      return { ok: false, payload: r, summary: `brief: ${r.error}` };
    }
    const lines = r.summary?.split("\n").length ?? 0;
    return {
      ok: true,
      payload: r,
      summary: `brief: ${r.filesScanned ?? 0} files, ${lines} lines`,
    };
  }
  if (tool === GIT_STATUS) {
    const r = gitStatus(ctx.workspaceRoot);
    if (r.error) {
      return { ok: false, payload: r, summary: `git_status: ${r.error}` };
    }
    const parts: string[] = [];
    if (r.branch) parts.push(`branch: ${r.branch}`);
    if (r.ahead) parts.push(`ahead ${r.ahead}`);
    if (r.behind) parts.push(`behind ${r.behind}`);
    if (r.staged?.length) parts.push(`${r.staged.length} staged`);
    if (r.modified?.length) parts.push(`${r.modified.length} modified`);
    if (r.untracked?.length) parts.push(`${r.untracked.length} untracked`);
    const summary = parts.length > 0 ? parts.join(", ") : "clean";
    return { ok: true, payload: r, summary: `git_status: ${summary}` };
  }
  if (tool === GIT_LOG) {
    const maxCount =
      num(rec.max_count, undefined) ?? num(rec.maxCount, undefined) ?? 10;
    const r = gitLog(ctx.workspaceRoot, maxCount);
    if (r.error) {
      return { ok: false, payload: r, summary: `git_log: ${r.error}` };
    }
    const n = r.commits?.length ?? 0;
    return { ok: true, payload: r, summary: `git_log: ${n} commit(s)` };
  }
  if (tool === GIT_DIFF) {
    const diffPath =
      typeof rec.path === "string" && rec.path.trim() ? rec.path : undefined;
    const r = gitDiff(ctx.workspaceRoot, diffPath);
    if (r.error) {
      return { ok: false, payload: r, summary: `git_diff: ${r.error}` };
    }
    const lines = r.diff?.split("\n").length ?? 0;
    return { ok: true, payload: r, summary: `git_diff: ${lines} line(s)` };
  }
  if (tool === RUN_AGENT) {
    const goal = typeof rec.goal === "string" ? rec.goal : "";
    if (!goal.trim()) {
      return {
        ok: false,
        payload: { error: "missing goal" },
        summary: "run_agent: missing goal",
      };
    }
    const launcher = ctx.subAgentLauncher;
    if (!launcher) {
      return {
        ok: false,
        payload: { error: "sub-agent launcher not configured" },
        summary: "run_agent: sub-agent launcher not configured",
      };
    }
    const maxSteps =
      num(rec.max_steps, undefined) ?? num(rec.maxSteps, undefined);
    const sharedContext = ctx.buildSubAgentSharedContext?.({
      goal,
      args: rec,
    });
    const r = await launcher.launch(goal, maxSteps, {
      args: rec,
      sharedContext,
      signal: ctx.abortSignal,
      parentRunId: ctx.parentRunId,
    });
    const agentId =
      typeof rec.agent_id === "string"
        ? rec.agent_id
        : typeof rec.agentId === "string"
          ? rec.agentId
          : "";
    return {
      ok: r.status === "completed",
      payload: r,
      summary: `run_agent: ${r.status}${agentId ? ` [${agentId}]` : ""} (${r.trace?.stepsTaken ?? 0} steps)`,
    };
  }
  if (tool === CREATE_AGENT) {
    // 落盘 .paw/agents/<id>.md（合规校验由调用方 @paw/agent writeAgentFile 更严；
    // harness 做基础校验 + 写文件，避免 harness→agent 循环依赖）
    const id = typeof rec.id === "string" ? rec.id.trim() : "";
    const name = typeof rec.name === "string" ? rec.name.trim() : "";
    const prompt = typeof rec.prompt === "string" ? rec.prompt.trim() : "";
    if (!id || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)) {
      return {
        ok: false,
        payload: { error: "invalid id" },
        summary: "create_agent: invalid id",
      };
    }
    if (!name || !prompt) {
      return {
        ok: false,
        payload: { error: "name and prompt required" },
        summary: "create_agent: name and prompt required",
      };
    }
    const role =
      typeof rec.role === "string" && rec.role.trim() ? rec.role.trim() : name;
    const tools =
      typeof rec.tools === "string" && rec.tools.trim()
        ? rec.tools.trim()
        : "inherit";
    const childPolicy =
      rec.child_policy === "read_write" || rec.childPolicy === "read_write"
        ? "read_write"
        : "read_only";
    const modelRaw =
      typeof rec.model === "string" ? rec.model.trim() : "inherit";
    const model =
      modelRaw === "flash" || modelRaw === "pro" ? modelRaw : "inherit";
    const outputFormat =
      typeof rec.output_format === "string" && rec.output_format.trim()
        ? rec.output_format.trim().replace(/\n/g, " ")
        : typeof rec.outputFormat === "string" && rec.outputFormat.trim()
          ? rec.outputFormat.trim().replace(/\n/g, " ")
          : "Return a clear summary of what you did.";
    const emoji =
      typeof rec.emoji === "string" && rec.emoji.trim() ? rec.emoji.trim() : "";
    const description =
      typeof rec.description === "string" && rec.description.trim()
        ? rec.description.trim()
        : "";
    const overwrite = rec.overwrite === true;

    // Prefer injected writer when available (full validate + registry reload)
    if (ctx.createAgent) {
      const r = await ctx.createAgent({
        id,
        name,
        role,
        prompt,
        tools,
        childPolicy,
        model,
        outputFormat,
        emoji: emoji || undefined,
        description: description || undefined,
        overwrite,
      });
      return {
        ok: r.ok,
        payload: r,
        summary: r.ok
          ? `create_agent: wrote ${r.id} → ${r.path ?? ".paw/agents"}`
          : `create_agent: ${r.error ?? "failed"}`,
      };
    }

    const agentsDir = path.join(ctx.workspaceRoot, ".paw", "agents");
    const filePath = path.join(agentsDir, `${id}.md`);
    try {
      fs.mkdirSync(agentsDir, { recursive: true });
      if (!overwrite && fs.existsSync(filePath)) {
        return {
          ok: false,
          payload: { error: `exists: ${id}` },
          summary: `create_agent: Agent 已存在 ${id}`,
        };
      }
      const lines = [
        "---",
        `id: ${id}`,
        `name: ${name}`,
        `role: ${role}`,
        ...(emoji ? [`emoji: ${emoji}`] : []),
        ...(description ? [`description: ${description}`] : []),
        `tools: ${tools}`,
        `childPolicy: ${childPolicy}`,
        `model: ${model}`,
        `outputFormat: ${outputFormat}`,
        "canSpawn: false",
        "maxSteps: 12",
        "kind: worker",
        "memoryExtraction: off",
        "---",
        "",
        prompt,
        "",
      ];
      fs.writeFileSync(filePath, lines.join("\n"), "utf-8");
      return {
        ok: true,
        payload: { id, path: filePath },
        summary: `create_agent: wrote ${id}`,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        payload: { error: msg },
        summary: `create_agent: ${msg}`,
      };
    }
  }
  if (tool === RUN_SKILL) {
    const skillId = typeof rec.skill_id === "string" ? rec.skill_id : "";
    if (!skillId) {
      return {
        ok: false,
        payload: { error: "missing skill_id" },
        summary: "run_skill: missing skill_id",
      };
    }
    const registry = ctx.skillRegistry;
    if (!registry) {
      return {
        ok: false,
        payload: { error: "skill registry not configured" },
        summary: "run_skill: skill registry not configured",
      };
    }
    const skill = registry.get(skillId);
    if (!skill) {
      return {
        ok: false,
        payload: { error: `skill not found: ${skillId}` },
        summary: `run_skill: skill not found: ${skillId}`,
      };
    }
    const skillArgs = asRecord(rec.args) ?? {};
    const rendered = renderSkillPrompt(skill, skillArgs);
    return {
      ok: true,
      payload: { skillId },
      summary: `run_skill: ${skillId}`,
      // Expanded skill prompt injected as a user message so the model
      // follows it on the next turn without needing to re-read the result.
      newMessages: [{ role: "user", content: rendered }],
    };
  }
  if (tool === LSP) {
    const filePath = typeof rec.file === "string" ? rec.file : "";
    const method = typeof rec.method === "string" ? rec.method : "hover";
    const line = num(rec.line, undefined) ?? 0;
    const character = num(rec.character, undefined) ?? 0;
    if (!filePath) {
      return {
        ok: false,
        payload: { error: "missing file" },
        summary: "lsp: missing file",
      };
    }
    const cmd = detectLspCommand(filePath);
    if (!cmd) {
      return {
        ok: false,
        payload: { error: `no LSP server known for ${path.extname(filePath)}` },
        summary: `lsp: no LSP server for ${path.extname(filePath)}`,
      };
    }
    const client = new LspClient(`file://${ctx.workspaceRoot}`);
    try {
      await client.start({
        command: cmd.command,
        args: cmd.args,
        cwd: ctx.workspaceRoot,
      });
      let result: unknown;
      switch (method) {
        case "hover":
          result = await client.hover(filePath, line, character);
          break;
        case "definition":
          result = await client.definition(filePath, line, character);
          break;
        case "references":
          result = await client.references(filePath, line, character);
          break;
        case "completion":
          result = await client.completion(filePath, line, character);
          break;
        default:
          return {
            ok: false,
            payload: { error: `unknown LSP method: ${method}` },
            summary: `lsp: unknown method ${method}`,
          };
      }
      await client.stop();
      return {
        ok: true,
        payload: result,
        summary: `lsp: ${method} on ${filePath}`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        payload: { error: msg },
        summary: `lsp: ${msg}`,
      };
    }
  }
  if (tool === APPLY_PATCH) {
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
      for (const f of r.results
        .filter((rr) => rr.ok && rr.changed === true)
        .map((rr) => rr.path)) {
        ctx.watcher?.markAgentWritten(f);
      }
    }
    const changedPaths = r.ok
      ? r.results
          .filter((result) => result.ok && result.changed === true)
          .map((result) => result.path)
      : [];
    const diagnostics = r.ok
      ? diagnoseEditedFilesV1(ctx.workspaceRoot, changedPaths)
      : undefined;
    return {
      ok: r.ok,
      payload: diagnostics ? { ...r, diagnostics } : r,
      summary: diagnostics
        ? `${r.summary}${diagnosticSummarySuffix(diagnostics)}`
        : r.summary,
    };
  }
  if (tool === SYMBOL_SEARCH) {
    const query = typeof rec.query === "string" ? rec.query : "";
    if (!query.trim()) {
      return {
        ok: false,
        payload: { error: "missing query" },
        summary: "symbol_search: missing query",
      };
    }
    const maxResults =
      num(rec.max_results, undefined) ?? num(rec.maxResults, undefined) ?? 20;
    const r = searchWorkspaceSymbols(ctx.workspaceRoot, query, { maxResults });
    if (r.error) {
      return { ok: false, payload: r, summary: `symbol_search: ${r.error}` };
    }
    const totalSymbols =
      r.matches?.reduce((sum, m) => sum + m.symbols.length, 0) ?? 0;
    const tail = r.truncated ? " (truncated)" : "";
    return {
      ok: true,
      payload: r,
      summary: `symbol_search: ${totalSymbols} symbol(s) in ${r.matches?.length ?? 0} file(s)${tail}`,
    };
  }
  if (tool === MEMORY_LIST) {
    if (!ctx.memoryRuntime) {
      return {
        ok: false,
        payload: {
          error:
            "memory Runtime unavailable (Postgres down or not initialized)",
        },
        summary: "memory.list: runtime unavailable",
      };
    }
    try {
      const records = await ctx.memoryRuntime.listMemories({ limit: 50 });
      const entries = records.map((r) => ({
        name: r.id,
        type: r.type,
        description: r.summary,
        title: r.title,
        confidence: r.confidence,
      }));
      return {
        ok: true,
        payload: { entries },
        summary: `memory.list: ${entries.length} entr${entries.length === 1 ? "y" : "ies"}`,
      };
    } catch (err) {
      return {
        ok: false,
        payload: {
          error: err instanceof Error ? err.message : String(err),
        },
        summary: "memory.list: failed",
      };
    }
  }
  if (tool === MEMORY_READ) {
    const name = typeof rec.name === "string" ? rec.name.trim() : "";
    if (!name) {
      return {
        ok: false,
        payload: { error: "missing name" },
        summary: "memory.read: missing name",
      };
    }
    if (!ctx.memoryRuntime) {
      return {
        ok: false,
        payload: { error: "memory Runtime unavailable" },
        summary: "memory.read: runtime unavailable",
      };
    }
    try {
      const record = await ctx.memoryRuntime.readMemory(name);
      if (!record) {
        return {
          ok: false,
          payload: { error: `memory not found: ${name}` },
          summary: `memory.read: not found (${name})`,
        };
      }
      return {
        ok: true,
        payload: record,
        summary: `memory.read: ${record.title || name}`,
      };
    } catch (err) {
      return {
        ok: false,
        payload: {
          error: err instanceof Error ? err.message : String(err),
        },
        summary: "memory.read: failed",
      };
    }
  }
  if (tool === MEMORY_SAVE) {
    const name = typeof rec.name === "string" ? rec.name.trim() : "";
    const content = typeof rec.content === "string" ? rec.content : "";
    const memType =
      typeof rec.type === "string" &&
      ["user", "feedback", "project", "reference"].includes(rec.type)
        ? (rec.type as "user" | "feedback" | "project" | "reference")
        : "project";
    if (!name) {
      return {
        ok: false,
        payload: { error: "missing name" },
        summary: "memory.save: missing name",
      };
    }
    if (!content) {
      return {
        ok: false,
        payload: { error: "missing content" },
        summary: "memory.save: missing content",
      };
    }
    if (!ctx.memoryRuntime) {
      return {
        ok: false,
        payload: { error: "memory Runtime unavailable" },
        summary: "memory.save: runtime unavailable",
      };
    }
    const description = content.replace(/\n/g, " ").slice(0, 120).trim();
    try {
      const typeMap: Record<string, string> = {
        user: "user_preference",
        feedback: "user_preference",
        project: "project_knowledge",
        reference: "project_knowledge",
      };
      const saved = await ctx.memoryRuntime.saveMemory({
        title: name,
        summary: description,
        content,
        type: typeMap[memType] ?? "project_knowledge",
        taskId: ctx.memoryTaskId,
      });
      return {
        ok: true,
        payload: {
          name,
          candidateId: saved.candidateId,
          decision: saved.decision,
          memoryId: saved.memoryId,
        },
        summary: `memory.save: ${saved.decisionStatus} "${name}"`,
      };
    } catch (err) {
      return {
        ok: false,
        payload: {
          error: err instanceof Error ? err.message : String(err),
        },
        summary: "memory.save: failed",
      };
    }
  }
  if (tool === CONTEXT_RECALL) {
    const id = typeof rec.id === "string" ? rec.id.trim() : "";
    if (!id) {
      return {
        ok: false,
        payload: { error: "missing id" },
        summary: "context.recall: missing id",
      };
    }
    const registry = ctx.artifactRegistry;
    if (!registry) {
      return {
        ok: false,
        payload: { error: "artifact registry not configured" },
        summary: "context.recall: artifact registry not configured",
      };
    }
    const part =
      rec.part === "tail" || rec.part === "chunk" ? rec.part : "head";
    const offset = num(rec.offset, undefined) ?? 0;
    const limit = num(rec.limit, undefined) ?? 8000;
    const outcome = registry.tryRecall(id, { part, offset, limit });
    if (!outcome.ok) {
      // 预算拒绝 / 无效 ID：返回候选列表（不静默失败）
      return {
        ok: false,
        payload: {
          error: outcome.reason ?? "recall failed",
          ...(outcome.candidates && outcome.candidates.length > 0
            ? { candidates: outcome.candidates }
            : {}),
        },
        summary: `context.recall: ${outcome.reason ?? "failed"}`,
      };
    }
    const entry = outcome.entry;
    const window = outcome.window;
    const head = [
      `[recalled archive id=${entry?.id}, tool=${entry?.tool}, ok=${entry?.ok}, created at turn ${entry?.turn}]`,
      `[window ${window?.part ?? "head"} offset=${window?.offset ?? 0} len=${window?.length ?? 0} total=${window?.total ?? 0}]`,
      ...(entry?.callerText
        ? [`[producing action] ${entry.callerText.slice(0, 400)}`]
        : []),
      "--- content ---",
    ].join("\n");
    return {
      ok: true,
      payload: `${head}\n${outcome.content ?? ""}`,
      summary: `context.recall: ${entry?.tool ?? id} (${window?.length ?? 0}/${window?.total ?? "?"} chars)`,
    };
  }
  return {
    ok: false,
    payload: { error: `unknown tool: ${tool}` },
    summary: `unknown tool: ${tool}`,
  };
}
