import path from "node:path";

import {
  applyWorkspacePatch,
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
  LspClient,
  detectLspCommand,
} from "@paw/workspace";
import { renderSkillPrompt } from "@paw/core";

import type { HarnessContext } from "./context.js";
import type { McpClientManager } from "./mcp-client.js";
import {
  classifyShellCommand,
  interpretShellExitCode,
  runShellInWorkspace,
  type RunShellResult,
  runShellInWorkspaceStreaming,
} from "./run-shell.js";

export interface ToolRunResult {
  readonly ok: boolean;
  /** JSON-serializable payload for logs / model context. */
  readonly payload: unknown;
  /** One-line human summary. */
  readonly summary: string;
}

const READ = "workspace.read_file" as const;
const LIST = "workspace.list_dir" as const;
const WRITE = "workspace.write_file" as const;
const EDIT = "workspace.edit_file" as const;
const SEARCH = "workspace.search" as const;
const GLOB = "workspace.glob" as const;
const GREP = "workspace.grep" as const;
const SHELL = "workspace.run_shell" as const;
const WEBFETCH = "workspace.web_fetch" as const;
const WEBSEARCH = "workspace.web_search" as const;
const TODO_WRITE = "workspace.todo_write" as const;
const NOTEBOOK_EDIT = "workspace.notebook_edit" as const;
const BRIEF = "workspace.brief" as const;
const GIT_STATUS = "workspace.git_status" as const;
const GIT_LOG = "workspace.git_log" as const;
const GIT_DIFF = "workspace.git_diff" as const;
const RUN_AGENT = "workspace.run_agent" as const;
const RUN_SKILL = "workspace.run_skill" as const;
const LSP = "workspace.lsp" as const;
const APPLY_PATCH = "workspace.apply_patch" as const;
const SYMBOL_SEARCH = "workspace.symbol_search" as const;

const BUILTIN_TOOLS = [READ, LIST, SEARCH, WRITE, EDIT, GLOB, GREP, SHELL, WEBFETCH, WEBSEARCH, TODO_WRITE, NOTEBOOK_EDIT, BRIEF, GIT_STATUS, GIT_LOG, GIT_DIFF, RUN_AGENT, RUN_SKILL, LSP, APPLY_PATCH, SYMBOL_SEARCH] as const;

export type BuiltinToolName = (typeof BUILTIN_TOOLS)[number];
export type ToolName = BuiltinToolName | string;

/** Read-only tools skip the approval gate; writes / shell / unknown require approval when a resolver is set.
 *  For shell commands, inspects the command text to determine if it is read-only (ls, cat, grep, etc.).
 */
export function toolRequiresApproval(
  tool: string,
  mcp?: McpClientManager,
  args?: Record<string, unknown>,
): boolean {
  if (tool === READ || tool === LIST || tool === SEARCH || tool === GLOB || tool === GREP || tool === WEBFETCH || tool === WEBSEARCH) return false;
  if (tool === SHELL && args) {
    const cmd = typeof args.command === "string" ? args.command : "";
    if (cmd) {
      const classification = classifyShellCommand(cmd);
      if (classification.isReadOnly) return false;
    }
  }
  // MCP tools default to requiring approval unless explicitly exempted.
  if (mcp?.isMcpTool(tool)) return true;
  return true;
}

export function listToolNames(mcp?: McpClientManager): readonly ToolName[] {
  const built: ToolName[] = [...BUILTIN_TOOLS];
  if (!mcp) return built;
  for (const t of mcp.listTools()) {
    built.push(`mcp:${t.serverName}/${t.toolName}`);
  }
  return built;
}

/** Short catalog for system prompts. */
export function toolCatalogText(mcp?: McpClientManager): string {
  const lines = [
    "Tools (reply with one or more JSON objects, each on its own line, when calling tools):",
    `{"tool":"${READ}","args":{"path":"<relative-path>","offset":0,"limit":200}}`,
    `{"tool":"${LIST}","args":{"path":".","recursive":false}}`,
    `{"tool":"${SEARCH}","args":{"pattern":"<text-or-regex>","path":".","file_pattern":"*.ts","max_results":50,"case_sensitive":false,"regex":false,"max_depth":4}}`,
    `{"tool":"${GLOB}","args":{"pattern":"<glob-pattern e.g. **/*.ts>","path":".","max_depth":6}}`,
    `{"tool":"${GREP}","args":{"pattern":"<regex>","path":".","file_pattern":"*.ts","output_mode":"files_with_matches","-i":false,"-n":true,"head_limit":250,"max_results":50,"max_depth":4}}`,
    `{"tool":"${WRITE}","args":{"path":"<relative-path>","content":"<utf-8 text>","create_directories":true}}`,
    `{"tool":"${EDIT}","args":{"path":"<relative-path>","old_string":"<text to find>","new_string":"<replacement>"}}`,
    `{"tool":"${SHELL}","args":{"command":"<shell command>","cwd":".","timeout_sec":60}}`,
    `{"tool":"${WEBFETCH}","args":{"url":"<https://...>","max_length":50000}}`,
    `{"tool":"${WEBSEARCH}","args":{"query":"<search terms>","max_results":5}}`,
    `{"tool":"${TODO_WRITE}","args":{"todos":[{"id":"1","content":"<task description>","status":"pending","priority":"medium"}]}}`,
    `{"tool":"${NOTEBOOK_EDIT}","args":{"path":"<relative-path>","action":"edit","cell_index":0,"source":"<new cell source>","cell_type":"code"}}`,
    `{"tool":"${BRIEF}","args":{"path":".","max_files":50}}`,
    `{"tool":"${GIT_STATUS}","args":{}}`,
    `{"tool":"${GIT_LOG}","args":{"max_count":10}}`,
    `{"tool":"${GIT_DIFF}","args":{"path":"<optional-file-path>"}}`,
    `{"tool":"${RUN_AGENT}","args":{"goal":"<sub-goal>","max_steps":10}}`,
    `{"tool":"${RUN_SKILL}","args":{"skill_id":"<skill-id>","args":{"param1":"value1"}}}`,
    `{"tool":"${LSP}","args":{"file":"<relative-path>","method":"hover|definition|references|completion","line":0,"character":0}}`,
    `{"tool":"${APPLY_PATCH}","args":{"patch":"<unified diff string>"}}`,
    `{"tool":"${SYMBOL_SEARCH}","args":{"query":"<symbol-name-or-pattern>","max_results":20}} — AST-based: find function/class/interface/type definitions by name (use instead of grep when you need precise symbol lookup)`,
  ];

  if (mcp) {
    const mcpTools = mcp.listTools();
    if (mcpTools.length > 0) {
      lines.push("");
      lines.push("MCP tools (external servers):");
      for (const t of mcpTools) {
        const id = `mcp:${t.serverName}/${t.toolName}`;
        const schemaHint = JSON.stringify(t.inputSchema).slice(0, 200);
        lines.push(
          `{"tool":"${id}","args":${schemaHint}${schemaHint.length >= 200 ? "..." : ""}}`,
        );
      }
    }
  }

  return lines.join("\n");
}

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

  const rec = asRecord(args) ?? {};
  if (tool === READ) {
    const path = typeof rec.path === "string" ? rec.path : "";
    if (!path) {
      return {
        ok: false,
        payload: { error: "missing path" },
        summary: "read_file: missing path",
      };
    }
    const offset = num(rec.offset, 0) ?? 0;
    const limit = num(rec.limit, undefined);
    const r = readWorkspaceFile(ctx.workspaceRoot, path, {
      offset,
      ...(limit !== undefined ? { limit } : {}),
    });
    if (r.error) {
      return { ok: false, payload: r, summary: `read_file: ${r.error}` };
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
      return { ok: false, payload: r, summary: `list_dir: ${r.error}` };
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
      return {
        ok: false,
        payload: { error: "missing pattern" },
        summary: "search: missing pattern",
      };
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
      return { ok: false, payload: r, summary: `search: ${r.error}` };
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
      return {
        ok: false,
        payload: { error: "missing pattern" },
        summary: "glob: missing pattern",
      };
    }
    const globPath = typeof rec.path === "string" ? rec.path : ".";
    const maxDepth =
      num(rec.max_depth, undefined) ?? num(rec.maxDepth, undefined);
    const r = globWorkspaceFiles(ctx.workspaceRoot, globPath, {
      pattern,
      ...(maxDepth !== undefined ? { maxDepth } : {}),
    });
    if (r.error) {
      return { ok: false, payload: r, summary: `glob: ${r.error}` };
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
      return {
        ok: false,
        payload: { error: "missing pattern" },
        summary: "grep: missing pattern",
      };
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
    const context =
      num(rec["-C"], undefined) ?? num(rec.context, undefined);
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
      return { ok: false, payload: r, summary: `grep: ${r.error}` };
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
      return {
        ok: false,
        payload: { error: "missing path" },
        summary: "write_file: missing path",
      };
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
      return {
        ok: false,
        payload: r,
        summary: `write_file: ${r.error}`,
      };
    }
    ctx.watcher?.markAgentWritten(filePath);
    return {
      ok: true,
      payload: r,
      summary: `write_file: ${filePath} (${r.bytes_written ?? 0} bytes)`,
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
      return {
        ok: false,
        payload: { error: "missing path" },
        summary: "edit_file: missing path",
      };
    }
    if (!oldString) {
      return {
        ok: false,
        payload: { error: "missing old_string" },
        summary: "edit_file: missing old_string",
      };
    }
    const startLine =
      num(rec.start_line, undefined) ?? num(rec.startLine, undefined);
    const endLine =
      num(rec.end_line, undefined) ?? num(rec.endLine, undefined);
    const fuzzy =
      typeof rec.fuzzy === "boolean"
        ? rec.fuzzy
        : typeof rec.fuzzy_match === "boolean"
          ? rec.fuzzy_match
          : false;
    const r = editWorkspaceFile(ctx.workspaceRoot, filePath, {
      oldString: oldString || undefined,
      newString,
      ...(startLine !== undefined ? { startLine } : {}),
      ...(endLine !== undefined ? { endLine } : {}),
      ...(fuzzy ? { fuzzy: true } : {}),
    });
    if (r.error) {
      return {
        ok: false,
        payload: r,
        summary: `edit_file: ${r.error}`,
      };
    }
    const diffHint =
      r.linesAdded !== undefined && r.linesRemoved !== undefined
        ? ` +${r.linesAdded}/-${r.linesRemoved}`
        : "";
    ctx.watcher?.markAgentWritten(filePath);
    return {
      ok: true,
      payload: r,
      summary: `edit_file: ${filePath}${diffHint}`,
    };
  }
  if (tool === SHELL) {
    const cmd = typeof rec.command === "string" ? rec.command : "";
    if (!cmd.trim()) {
      return {
        ok: false,
        payload: { error: "missing command" },
        summary: "run_shell: missing command",
      };
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
      return {
        ok: false,
        payload: r,
        summary: `run_shell: ${msg}`,
      };
    }
    const code = r.exit_code ?? "?";
    const interpretation = interpretShellExitCode(cmd, r.exit_code);
    const enriched: RunShellResult = {
      ...r,
      interpretation: interpretation.message,
    };
    const isError = interpretation.isError && r.exit_code !== 0;
    const summary = isError && interpretation.message
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
    const maxLength = num(rec.max_length, undefined) ?? num(rec.maxLength, undefined);
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
    const maxResults = num(rec.max_results, undefined) ?? num(rec.maxResults, undefined);
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
          o.status === "pending" || o.status === "in_progress" || o.status === "done"
            ? o.status
            : "pending";
        const priority =
          o.priority === "low" || o.priority === "medium" || o.priority === "high"
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
    const maxFiles = num(rec.max_files, undefined) ?? num(rec.maxFiles, undefined);
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
    const maxCount = num(rec.max_count, undefined) ?? num(rec.maxCount, undefined) ?? 10;
    const r = gitLog(ctx.workspaceRoot, maxCount);
    if (r.error) {
      return { ok: false, payload: r, summary: `git_log: ${r.error}` };
    }
    const n = r.commits?.length ?? 0;
    return { ok: true, payload: r, summary: `git_log: ${n} commit(s)` };
  }
  if (tool === GIT_DIFF) {
    const diffPath = typeof rec.path === "string" && rec.path.trim() ? rec.path : undefined;
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
    const maxSteps = num(rec.max_steps, undefined) ?? num(rec.maxSteps, undefined);
    const r = await launcher.launch(goal, maxSteps);
    return {
      ok: r.status === "completed",
      payload: r,
      summary: `run_agent: ${r.status} (${r.stepsTaken} steps)`,
    };
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
      payload: { skillId, rendered, skill },
      summary: `run_skill: ${skillId} rendered`,
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
    const client = new LspClient("file://" + ctx.workspaceRoot);
    try {
      await client.start({ command: cmd.command, args: cmd.args, cwd: ctx.workspaceRoot });
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
      for (const f of r.results.filter((rr) => rr.ok).map((rr) => rr.path)) {
        ctx.watcher?.markAgentWritten(f);
      }
    }
    return {
      ok: r.ok,
      payload: r,
      summary: r.summary,
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
    const maxResults = num(rec.max_results, undefined) ?? num(rec.maxResults, undefined) ?? 20;
    const r = searchWorkspaceSymbols(ctx.workspaceRoot, query, { maxResults });
    if (r.error) {
      return { ok: false, payload: r, summary: `symbol_search: ${r.error}` };
    }
    const totalSymbols = r.matches?.reduce((sum, m) => sum + m.symbols.length, 0) ?? 0;
    const tail = r.truncated ? " (truncated)" : "";
    return {
      ok: true,
      payload: r,
      summary: `symbol_search: ${totalSymbols} symbol(s) in ${r.matches?.length ?? 0} file(s)${tail}`,
    };
  }
  return {
    ok: false,
    payload: { error: `unknown tool: ${tool}` },
    summary: `unknown tool: ${tool}`,
  };
}
