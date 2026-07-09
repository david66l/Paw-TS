import type { ChatMessage } from "@paw/models";
import type { McpClientManager } from "../mcp-client.js";
import { classifyShellCommand } from "../shell/index.js";
import type { ToolDefinition } from "@paw/models";

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
export const SEARCH = "workspace.search" as const;
export const GLOB = "workspace.glob" as const;
export const GREP = "workspace.grep" as const;
export const SHELL = "workspace.run_shell" as const;
export const WEBFETCH = "workspace.web_fetch" as const;
export const WEBSEARCH = "workspace.web_search" as const;
export const TODO_WRITE = "workspace.todo_write" as const;
export const NOTEBOOK_EDIT = "workspace.notebook_edit" as const;
export const BRIEF = "workspace.brief" as const;
export const GIT_STATUS = "workspace.git_status" as const;
export const GIT_LOG = "workspace.git_log" as const;
export const GIT_DIFF = "workspace.git_diff" as const;
export const RUN_AGENT = "workspace.run_agent" as const;
export const RUN_SKILL = "workspace.run_skill" as const;
export const LSP = "workspace.lsp" as const;
export const APPLY_PATCH = "workspace.apply_patch" as const;
export const SYMBOL_SEARCH = "workspace.symbol_search" as const;
export const MEMORY_LIST = "memory.list" as const;
export const MEMORY_READ = "memory.read" as const;
export const MEMORY_SAVE = "memory.save" as const;

const BUILTIN_TOOLS = [
  READ,
  LIST,
  SEARCH,
  WRITE,
  EDIT,
  GLOB,
  GREP,
  SHELL,
  WEBFETCH,
  WEBSEARCH,
  TODO_WRITE,
  NOTEBOOK_EDIT,
  BRIEF,
  GIT_STATUS,
  GIT_LOG,
  GIT_DIFF,
  RUN_AGENT,
  RUN_SKILL,
  LSP,
  APPLY_PATCH,
  SYMBOL_SEARCH,
  MEMORY_LIST,
  MEMORY_READ,
  MEMORY_SAVE,
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
    tool === MEMORY_READ
  )
    return false;
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
export function toolDefinitions(mcp?: McpClientManager): ToolDefinition[] {
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
      "Perform exact string replacements in an existing file.",
      {
        path: { type: "string", description: "Relative path to the file" },
        old_string: { type: "string", description: "Text to find and replace" },
        new_string: { type: "string", description: "Replacement text" },
      },
      ["path", "old_string", "new_string"],
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
      "Execute a shell command in the workspace.",
      {
        command: { type: "string", description: "Shell command to execute" },
        cwd: {
          type: "string",
          description: "Working directory, relative to workspace root",
        },
        timeout_sec: { type: "integer", description: "Timeout in seconds" },
      },
      ["command"],
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
    fn(GIT_STATUS, "Show the working tree status.", {}),
    fn(GIT_LOG, "Show recent commit history.", {
      max_count: { type: "integer", description: "Number of commits to show" },
    }),
    fn(GIT_DIFF, "Show changes between commits or working tree.", {
      path: { type: "string", description: "Optional file path to limit diff" },
    }),
    fn(
      RUN_AGENT,
      "Launch a sub-agent to handle a complex task.",
      {
        goal: { type: "string", description: "Goal for the sub-agent" },
        max_steps: {
          type: "integer",
          description: "Max steps for the sub-agent",
        },
        agent_type: {
          type: "string",
          enum: ["simple", "research", "coding", "planning", "relay"],
          description: "Sub-agent specialization",
        },
        child_policy: {
          type: "string",
          enum: ["read_only", "read_write"],
          description: "Tool write policy for the sub-agent",
        },
      },
      ["goal"],
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
          description: "Unique name for this memory entry (e.g. 'api-auth-pattern')",
        },
        content: {
          type: "string",
          description: "Memory content (markdown ok; keep focused, not a dump)",
        },
        type: {
          type: "string",
          enum: ["user", "feedback", "project", "reference"],
          description: "Memory type: user (preference), feedback, project (conventions/decisions), reference (external info)",
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
  ];
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
    `{"tool":"${MEMORY_LIST}","args":{}} — list MemoryRuntime entries (short titles)`,
    `{"tool":"${MEMORY_READ}","args":{"name":"<name-or-id>"}} — read full memory body by name/id`,
    `{"tool":"${MEMORY_SAVE}","args":{"name":"<unique-name>","content":"<focused markdown>","type":"project|user|feedback|reference","tags":["tag1"],"priority":"mid"}} — save via governance (not a local md file)`,
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
