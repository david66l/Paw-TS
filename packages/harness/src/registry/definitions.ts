import type { ChatMessage } from "@paw/models";
import type { ToolDefinition } from "@paw/models";
import type { McpClientManager } from "../mcp-client.js";
import type { ShellSandboxConfig } from "../sandbox/types.js";
import { classifyShellCommand } from "../shell/index.js";

export interface ToolRunResult {
  readonly ok: boolean;
  /** JSON-serializable payload for logs / model context. */
  readonly payload: unknown;
  /** One-line human summary. */
  readonly summary: string;
  /**
   * Messages to inject into the conversation before the next model turn.
   * Used by tools that expand into prompts (e.g. skills) so the model
   * sees the expanded content without needing to re-read the result.
   */
  readonly newMessages?: readonly ChatMessage[];
}

export const READ = "workspace.read_file" as const;
export const LIST = "workspace.list_dir" as const;
export const WRITE = "workspace.write_file" as const;
export const EDIT = "workspace.edit_file" as const;
export const UNDO_LAST_EDIT = "workspace.undo_last_edit" as const;
export const SEARCH = "workspace.search" as const;
export const GLOB = "workspace.glob" as const;
export const GREP = "workspace.grep" as const;
export const SHELL = "workspace.run_shell" as const;
export const JOB_START = "workspace.job_start" as const;
export const JOB_LIST = "workspace.job_list" as const;
export const JOB_READ = "workspace.job_read" as const;
export const JOB_WAIT = "workspace.job_wait" as const;
export const JOB_KILL = "workspace.job_kill" as const;
export const WEBFETCH = "workspace.web_fetch" as const;
export const WEBSEARCH = "workspace.web_search" as const;
export const TODO_WRITE = "workspace.todo_write" as const;
export const ACCEPTANCE_UPDATE = "workspace.acceptance_update" as const;
export const NOTEBOOK_EDIT = "workspace.notebook_edit" as const;
export const BRIEF = "workspace.brief" as const;
export const GIT_STATUS = "workspace.git_status" as const;
export const GIT_LOG = "workspace.git_log" as const;
export const GIT_DIFF = "workspace.git_diff" as const;
export const RUN_AGENT = "workspace.run_agent" as const;
export const CREATE_AGENT = "workspace.create_agent" as const;
export const RUN_SKILL = "workspace.run_skill" as const;
export const LSP = "workspace.lsp" as const;
export const APPLY_PATCH = "workspace.apply_patch" as const;
export const SYMBOL_SEARCH = "workspace.symbol_search" as const;
export const MEMORY_LIST = "memory.list" as const;
export const MEMORY_READ = "memory.read" as const;
export const MEMORY_SAVE = "memory.save" as const;
export const CONTEXT_RECALL = "context.recall" as const;

/**
 * 模型直接可见的核心工具集（4 个）。
 *
 * 参考 mini-SWE-agent 的实验证据（100 行 + bash = 74% on SWE-bench
 * Verified vs 全功能 harness ~30%）：模型认知负担与系统提示体积是
 * 主要瓶颈，不是工具数量本身。32 个工具的 schema 描述 + 系统提示
 * 占 ~5,100 token，挤占实际解题空间。
 *
 * bash 替代 run_shell、grep、glob、search、symbol_search、lsp、
 * git 命令、job 管理、web 工具；edit_file 合并 write_file 与
 * apply_patch 的核心场景；undo_last_edit 只提供受检查点与 CAS 约束的
 * 窄恢复能力。其余工具保留为内部能力（子 agent、桌面 UI、认证链直接
 * 调用），不进模型 schema。
 *
 * 桌面端传 allowedTools: null 可恢复全量工具 schema。
 */
/** Model-originated executable tools in the slim coding loop. */
export const CORE_MODEL_EXECUTABLE_TOOLS = [
  SHELL,
  READ,
  EDIT,
  UNDO_LAST_EDIT,
] as const;

/** Structured control actions parsed by the agent, not MCP tool definitions. */
export const CORE_MODEL_ACTIONS = [
  "action.final_answer",
  "action.ask_user",
  "action.plan_update",
  "action.acceptance_update",
  "action.abort",
] as const;

/**
 * Compatibility catalog for callers that display model-facing tools and
 * actions together. Execution code must use CORE_MODEL_EXECUTABLE_TOOLS;
 * final_answer/ask_user are agent control actions and never enter a tool
 * allowlist or provider tool schema.
 */
export const CORE_MODEL_TOOLS = [
  ...CORE_MODEL_EXECUTABLE_TOOLS,
  ...CORE_MODEL_ACTIONS,
] as const;

const BUILTIN_TOOLS = [
  READ,
  LIST,
  SEARCH,
  WRITE,
  EDIT,
  UNDO_LAST_EDIT,
  GLOB,
  GREP,
  SHELL,
  JOB_START,
  JOB_LIST,
  JOB_READ,
  JOB_WAIT,
  JOB_KILL,
  WEBFETCH,
  WEBSEARCH,
  TODO_WRITE,
  ACCEPTANCE_UPDATE,
  NOTEBOOK_EDIT,
  BRIEF,
  GIT_STATUS,
  GIT_LOG,
  GIT_DIFF,
  RUN_AGENT,
  CREATE_AGENT,
  RUN_SKILL,
  LSP,
  APPLY_PATCH,
  SYMBOL_SEARCH,
  MEMORY_LIST,
  MEMORY_READ,
  MEMORY_SAVE,
  CONTEXT_RECALL,
] as const;

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
  if (
    tool === READ ||
    tool === LIST ||
    tool === SEARCH ||
    tool === GLOB ||
    tool === GREP ||
    tool === WEBFETCH ||
    tool === WEBSEARCH ||
    tool === BRIEF ||
    tool === GIT_STATUS ||
    tool === GIT_LOG ||
    tool === GIT_DIFF ||
    tool === SYMBOL_SEARCH ||
    tool === LSP ||
    tool === MEMORY_LIST ||
    tool === MEMORY_READ ||
    tool === CONTEXT_RECALL ||
    tool === ACCEPTANCE_UPDATE ||
    tool === JOB_LIST ||
    tool === JOB_READ ||
    tool === JOB_WAIT ||
    tool === JOB_KILL
  )
    return false;
  if ((tool === SHELL || tool === JOB_START) && args) {
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

/** Map from sanitized function names back to paw-ts tool names. */
export function toolNameReverseMap(
  mcp?: McpClientManager,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const t of listToolNames(mcp)) {
    map.set(t.replace(/\./g, "_"), t);
  }
  return map;
}

/** OpenAI-format tool definitions for native function calling.
 *  Names are sanitized (dots → underscores) for providers that restrict identifiers.
 *  Use {@link toolNameReverseMap} to map results back to paw-ts tool names. */
export function toolDefinitions(
  mcp?: McpClientManager,
  options?: { readonly shellSandbox?: ShellSandboxConfig },
): ToolDefinition[] {
  const fn = (
    name: string,
    desc: string,
    props: Record<string, unknown>,
    required?: string[],
  ): ToolDefinition => ({
    type: "function",
    function: {
      name: name.replace(/\./g, "_"),
      description: desc,
      parameters: {
        type: "object",
        properties: props,
        ...(required ? { required } : {}),
      },
    },
  });
  const sandboxShell =
    options?.shellSandbox && options.shellSandbox.mode !== "off"
      ? (options.shellSandbox.commandShell ?? "sh")
      : undefined;
  const shellDialect = sandboxShell
    ? `Commands run inside the configured Linux container under POSIX /bin/${sandboxShell} syntax.`
    : process.platform === "win32"
      ? "Commands run under native Windows cmd.exe syntax. POSIX-only display helpers such as tail/head are unavailable unless the repository provides them."
      : "Commands run under POSIX /bin/sh syntax.";
  const defs: ToolDefinition[] = [
    fn(
      READ,
      "Read a file from the workspace. Returns content with line numbers.",
      {
        path: { type: "string", description: "Relative path to the file" },
        offset: { type: "integer", description: "Line offset from start" },
        limit: { type: "integer", description: "Max lines to read" },
      },
      ["path"],
    ),
    fn(
      LIST,
      "List files and directories in the workspace.",
      {
        path: {
          type: "string",
          description: "Directory path relative to workspace root",
        },
        recursive: {
          type: "boolean",
          description: "Recurse into subdirectories",
        },
      },
      ["path"],
    ),
    fn(
      SEARCH,
      "Search workspace text with bounded literal or regular-expression matching.",
      {
        pattern: { type: "string", description: "Text or regex to find" },
        path: { type: "string", description: "Directory or file to search" },
        file_pattern: {
          type: "string",
          description: "Optional file glob such as *.ts",
        },
        max_results: { type: "integer", description: "Maximum matches" },
        case_sensitive: { type: "boolean" },
        regex: { type: "boolean" },
        max_depth: { type: "integer" },
      },
      ["pattern"],
    ),
    fn(
      WRITE,
      "Create or overwrite a file in the workspace.",
      {
        path: { type: "string", description: "Relative path to the file" },
        content: { type: "string", description: "UTF-8 text content" },
        create_directories: {
          type: "boolean",
          description: "Create parent directories if needed",
        },
      },
      ["path", "content"],
    ),
    fn(
      EDIT,
      "Perform exact string replacements. To create a missing file, pass old_string as an empty string and new_string as the complete content. Line endings are matched flexibly (CRLF/LF).",
      {
        path: { type: "string", description: "Relative path to the file" },
        old_string: {
          type: "string",
          description:
            "Text to replace, or empty string only when creating a missing file",
        },
        new_string: { type: "string", description: "Replacement text" },
        replace_all: {
          type: "boolean",
          description:
            "If true, replace every occurrence of old_string (default false requires a unique match)",
        },
      },
      ["path", "old_string", "new_string"],
    ),
    fn(
      UNDO_LAST_EDIT,
      "Safely undo only this run's most recent checkpoint-backed edit/write/patch. Refuses to overwrite later external changes and cannot select arbitrary files, commits, or older revisions.",
      {},
    ),
    fn(
      GLOB,
      "Find files matching a glob pattern.",
      {
        pattern: { type: "string", description: "Glob pattern, e.g. **/*.ts" },
        path: { type: "string", description: "Directory to search in" },
        max_depth: { type: "integer", description: "Max directory depth" },
      },
      ["pattern"],
    ),
    fn(
      GREP,
      "Search file contents with a regex pattern.",
      {
        pattern: { type: "string", description: "Regex pattern to search for" },
        path: { type: "string", description: "Directory or file to search" },
        file_pattern: {
          type: "string",
          description: "File pattern filter, e.g. *.ts",
        },
        output_mode: {
          type: "string",
          description: "Output mode: content, files_with_matches, or count",
        },
        head_limit: { type: "integer", description: "Max lines to output" },
      },
      ["pattern"],
    ),
    fn(
      SHELL,
      `Execute a shell command in the workspace. ${shellDialect} Output is captured and bounded by the host, so do not append display-only pipes merely to truncate output.`,
      {
        command: {
          type: "string",
          description: `Shell command to execute. ${shellDialect}`,
        },
        cwd: {
          type: "string",
          description: "Working directory, relative to workspace root",
        },
        timeout_sec: { type: "integer", description: "Timeout in seconds" },
      },
      ["command"],
    ),
    fn(
      JOB_START,
      `Start a long-running shell command as a Paw-managed background job. ${shellDialect} Returns immediately with a job id. Use job_read for incremental output, job_wait for a bounded wait, and job_kill to stop the complete process tree. Final workspace effects and exit status are committed only after settlement.`,
      {
        command: {
          type: "string",
          description: `Shell command to run in the background. ${shellDialect}`,
        },
        cwd: {
          type: "string",
          description: "Working directory, relative to workspace root",
        },
        output_limit_bytes: {
          type: "integer",
          description: "Maximum unread output retained in memory",
        },
      },
      ["command"],
    ),
    fn(
      JOB_LIST,
      "List this run's managed background jobs and lifecycle states.",
      {},
    ),
    fn(
      JOB_READ,
      "Read and consume new output from one managed background job. Also returns its current lifecycle state.",
      { id: { type: "string", description: "Managed job id" } },
      ["id"],
    ),
    fn(
      JOB_WAIT,
      "Wait a bounded amount of time for one managed job to reach a terminal state. This never waits longer than 30 seconds; use it repeatedly for longer work.",
      {
        id: { type: "string", description: "Managed job id" },
        timeout_sec: {
          type: "number",
          description: "Wait duration in seconds (0.1 to 30; default 10)",
        },
      },
      ["id"],
    ),
    fn(
      JOB_KILL,
      "Request termination of a managed job and its descendant process tree.",
      {
        id: { type: "string", description: "Managed job id" },
        reason: { type: "string", description: "Optional stop reason" },
      },
      ["id"],
    ),
    fn(
      WEBFETCH,
      "Fetch content from a URL and extract information.",
      {
        url: { type: "string", description: "URL to fetch" },
        max_length: { type: "integer", description: "Max content length" },
      },
      ["url"],
    ),
    fn(
      WEBSEARCH,
      "Search the web and return results.",
      {
        query: { type: "string", description: "Search query" },
        max_results: { type: "integer", description: "Max number of results" },
      },
      ["query"],
    ),
    fn(
      TODO_WRITE,
      "Create and manage a structured task list.",
      {
        todos: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              content: { type: "string" },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "done"],
              },
              priority: { type: "string", enum: ["low", "medium", "high"] },
            },
            required: ["id", "content", "status"],
          },
        },
      },
      ["todos"],
    ),
    fn(
      ACCEPTANCE_UPDATE,
      "Persist observable acceptance and regression conditions separately from implementation todos. Use this proactively when user requirements, repository tests, or verification expose multiple behaviors. Add conditions before implementation; after verification, update each active condition with current-revision evidence. Never mark satisfied from intention or memory.",
      {
        add: {
          type: "array",
          description: "New observable conditions discovered this turn.",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              text: {
                type: "string",
                description:
                  "Concise observable behavior or regression condition",
              },
              source: {
                type: "string",
                enum: ["user", "repository", "verification"],
              },
              ref: {
                type: "string",
                description:
                  "Optional user message, file, test, or command reference",
              },
            },
            required: ["text", "source"],
          },
        },
        updates: {
          type: "array",
          description:
            "Status changes for existing criterion ids from Current State.",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: { type: "string" },
              status: {
                type: "string",
                enum: ["pending", "satisfied", "blocked", "superseded"],
              },
              evidence: {
                type: "string",
                description:
                  "Concrete current-revision evidence; required for satisfied",
              },
            },
            required: ["id", "status"],
          },
        },
        reason: {
          type: "string",
          description: "Why the ledger changed based on new evidence",
        },
      },
      ["add", "updates", "reason"],
    ),
    fn(
      NOTEBOOK_EDIT,
      "Edit, insert, append, or delete a cell in a Jupyter notebook.",
      {
        path: { type: "string", description: "Notebook path" },
        action: {
          type: "string",
          enum: ["edit", "append", "insert", "delete"],
        },
        cell_index: { type: "integer" },
        source: { type: "string" },
        cell_type: { type: "string", enum: ["code", "markdown"] },
      },
      ["path"],
    ),
    fn(BRIEF, "Generate a bounded structural brief of the workspace.", {
      path: { type: "string", description: "Directory to summarize" },
      max_files: { type: "integer", description: "Maximum files to scan" },
    }),
    fn(GIT_STATUS, "Show the working tree status.", {}),
    fn(GIT_LOG, "Show recent commit history.", {
      max_count: { type: "integer", description: "Number of commits to show" },
    }),
    fn(GIT_DIFF, "Show changes between commits or working tree.", {
      path: { type: "string", description: "Optional file path to limit diff" },
    }),
    fn(
      RUN_AGENT,
      "Dispatch a sub-agent for an independent, context-heavy thread such as codebase investigation, tracing call chains, or verifying a hypothesis. Read-only sub-agents run in parallel with other read-only calls, consume their own context window, and return only a summary plus changed-file list, keeping your context clean. Prefer a specific agent_id from the roster (e.g. bige for read-only code investigation); child_policy read_only is the safe default and is required unless the child must write.",
      {
        goal: { type: "string", description: "Goal for the sub-agent" },
        agent_id: {
          type: "string",
          description:
            "Registered agent id from .paw/agents (e.g. bianmu, keji). Preferred over agent_type.",
        },
        max_steps: {
          type: "integer",
          description: "Max steps for the sub-agent",
        },
        agent_type: {
          type: "string",
          enum: ["simple", "research", "coding", "planning", "relay"],
          description: "Legacy specialization when agent_id is omitted",
        },
        child_policy: {
          type: "string",
          enum: ["read_only", "read_write"],
          description: "Tool write policy override for the sub-agent",
        },
      },
      ["goal"],
    ),
    fn(
      CREATE_AGENT,
      "Create a new worker Agent definition under .paw/agents/<id>.md (validated, reusable). Use when no existing agent fits; then run_agent with that agent_id.",
      {
        id: {
          type: "string",
          description: "Agent id (lowercase letters, digits, _-)",
        },
        name: { type: "string", description: "Display name" },
        role: { type: "string", description: "Short role label" },
        prompt: {
          type: "string",
          description: "System prompt body for the agent",
        },
        tools: {
          type: "string",
          description:
            'Tool allowlist: "inherit" or comma-separated names (e.g. read_file, write_file, run_shell)',
        },
        child_policy: {
          type: "string",
          enum: ["read_only", "read_write"],
          description: "Default read_only",
        },
        model: {
          type: "string",
          enum: ["flash", "pro", "inherit"],
          description: "Model preference",
        },
        output_format: {
          type: "string",
          description: "Expected output format",
        },
        emoji: { type: "string", description: "Optional emoji for roster" },
        description: {
          type: "string",
          description: "One-line description for the roster",
        },
        overwrite: {
          type: "boolean",
          description: "Overwrite existing agent file if true",
        },
      },
      ["id", "name", "prompt"],
    ),
    fn(
      RUN_SKILL,
      "Execute a skill within the conversation.",
      {
        skill_id: { type: "string", description: "ID of the skill to invoke" },
        args: { type: "object", description: "Arguments for the skill" },
      },
      ["skill_id"],
    ),
    fn(
      LSP,
      "Query a configured language server for precise code navigation.",
      {
        file: { type: "string", description: "Source file path" },
        method: {
          type: "string",
          enum: ["hover", "definition", "references", "completion"],
        },
        line: { type: "integer", description: "Zero-based line" },
        character: { type: "integer", description: "Zero-based character" },
      },
      ["file"],
    ),
    fn(
      APPLY_PATCH,
      "Apply a unified diff atomically inside the workspace.",
      {
        patch: { type: "string", description: "Unified diff text" },
      },
      ["patch"],
    ),
    fn(
      SYMBOL_SEARCH,
      "Search for function/class/interface/type definitions by name (AST-based).",
      {
        query: { type: "string", description: "Symbol name or pattern" },
        max_results: { type: "integer", description: "Max number of results" },
      },
      ["query"],
    ),
    fn(
      MEMORY_LIST,
      "List persistent project memories (MemoryRuntime / Postgres). Returns short titles — use memory.read for full content.",
      {},
    ),
    fn(
      MEMORY_READ,
      "Read a persistent memory entry by name or id (MemoryRuntime). Prefer this over dumping long memory into the chat yourself.",
      {
        name: {
          type: "string",
          description: "Memory entry name or id",
        },
      },
      ["name"],
    ),
    fn(
      MEMORY_SAVE,
      "Save a durable memory (preferences, decisions, pointers). Goes through governance — not a local markdown file write.",
      {
        name: {
          type: "string",
          description:
            "Unique name for this memory entry (e.g. 'api-auth-pattern')",
        },
        content: {
          type: "string",
          description: "Memory content (markdown ok; keep focused, not a dump)",
        },
        type: {
          type: "string",
          enum: ["user", "feedback", "project", "reference"],
          description:
            "Memory type: user (preference), feedback, project (conventions/decisions), reference (external info)",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Optional tags for categorization and retrieval",
        },
        priority: {
          type: "string",
          enum: ["high", "mid", "low"],
          description: "Priority level (default: mid)",
        },
      },
      ["name", "content", "type"],
    ),
    fn(
      CONTEXT_RECALL,
      "Restore the full content of an archived (previously truncated) tool output by its archive id. Use when an [archived id=N, ...] marker appears in a tool result and you need the full text. For outputs larger than 8000 chars, use part=head (start) / part=tail (end) / part=chunk with offset to page through. After recall, that id stays permanently addressable for this task.",
      {
        id: {
          type: "string",
          description:
            "Archive id from an [archived id=N ...] marker, or a content hash. Unknown ids fall back to keyword search.",
        },
        part: {
          type: "string",
          enum: ["head", "tail", "chunk"],
          description:
            "Which window to return: head (start), tail (end), or chunk (cursor via offset)",
        },
        offset: {
          type: "integer",
          description: "Chunk cursor: character offset from start (part=chunk)",
        },
        limit: {
          type: "integer",
          description: "Max chars to return (default 8000, hard cap 8000)",
        },
      },
      ["id"],
    ),
  ];
  // P5.2 前缀稳定完整版：内置工具按名称固定排序（确定性 schema 顺序，
  // 避免迭代顺序抖动导致 system prompt 逐字节变化破坏 prompt cache）
  defs.sort((a, b) => a.function.name.localeCompare(b.function.name));
  if (mcp) {
    for (const t of mcp.listTools()) {
      defs.push({
        type: "function",
        function: {
          name: `mcp:${t.serverName}/${t.toolName}`,
          description: t.description ?? `MCP tool: ${t.toolName}`,
          parameters: (t.inputSchema as Record<string, unknown>) ?? {},
        },
      });
    }
  }
  return defs;
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
    `{"tool":"${UNDO_LAST_EDIT}","args":{}} — restore only the latest safe checkpoint-backed Agent edit`,
    `{"tool":"${SHELL}","args":{"command":"<shell command>","cwd":".","timeout_sec":60}}`,
    `{"tool":"${JOB_START}","args":{"command":"<long-running shell command>","cwd":".","output_limit_bytes":262144}}`,
    `{"tool":"${JOB_LIST}","args":{}}`,
    `{"tool":"${JOB_READ}","args":{"id":"shell-1"}}`,
    `{"tool":"${JOB_WAIT}","args":{"id":"shell-1","timeout_sec":10}}`,
    `{"tool":"${JOB_KILL}","args":{"id":"shell-1","reason":"no longer needed"}}`,
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
    `{"tool":"${MEMORY_LIST}","args":{}} — list MemoryRuntime entries (short titles)`,
    `{"tool":"${MEMORY_READ}","args":{"name":"<name-or-id>"}} — read full memory body by name/id`,
    `{"tool":"${MEMORY_SAVE}","args":{"name":"<unique-name>","content":"<focused markdown>","type":"project|user|feedback|reference","tags":["tag1"],"priority":"mid"}} — save via governance (not a local md file)`,
    `{"tool":"${CONTEXT_RECALL}","args":{"id":"<archive-id-from-[archived-marker]>","part":"head|tail|chunk","offset":0,"limit":8000}} — restore a truncated/evicted tool output by id (fallback: keyword search on unknown ids)`,
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
