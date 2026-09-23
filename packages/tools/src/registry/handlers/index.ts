import { handleCreateAgent, handleRunAgent, handleRunSkill } from "./agents.js";
import {
  handleApplyPatch,
  handleEdit,
  handleGlob,
  handleGrep,
  handleList,
  handleNotebookEdit,
  handleRead,
  handleSearch,
  handleUndoLastEdit,
  handleWrite,
} from "./files.js";
import { handleGitDiff, handleGitLog, handleGitStatus } from "./git.js";
import {
  handleJobKill,
  handleJobList,
  handleJobRead,
  handleJobStart,
  handleJobWait,
} from "./jobs.js";
import { handleLsp, handleSymbolSearch } from "./lsp.js";
import { handleMcpProxy } from "./mcp.js";
import {
  handleContextRecall,
  handleMemoryList,
  handleMemoryRead,
  handleMemorySave,
} from "./memory.js";
/** executeTool 的派发表：工具名 → 处理器。 */
import { handleBrowserCheck, handleShell, handleWebFetch, handleWebSearch } from "./shell-web.js";
import {
  handleAcceptanceUpdate,
  handleBrief,
  handleContextCompact,
  handleProgressRead,
  handleTodoWrite,
} from "./task.js";

import type { ToolRunResult } from "../definitions.js";
import {
  ACCEPTANCE_UPDATE,
  APPLY_PATCH,
  BRIEF,
  CONTEXT_COMPACT,
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
  MCP_PROXY,
  MEMORY_LIST,
  MEMORY_READ,
  MEMORY_SAVE,
  NOTEBOOK_EDIT,
  PROGRESS_READ,
  READ,
  RUN_AGENT,
  RUN_SKILL,
  SEARCH,
  SHELL,
  SYMBOL_SEARCH,
  TODO_WRITE,
  UNDO_LAST_EDIT,
  WEBFETCH,
  WEBSEARCH,
  WRITE,
} from "../definitions.js";
import type { ToolScope } from "../tool-support.js";

export type ToolHandler = (scope: ToolScope) => Promise<ToolRunResult>;

export const TOOL_HANDLERS: Readonly<Record<string, ToolHandler>> = Object.freeze({
  ["workspace.browser_check"]: handleBrowserCheck,
  [MCP_PROXY]: handleMcpProxy,
  [READ]: handleRead,
  [LIST]: handleList,
  [SEARCH]: handleSearch,
  [GLOB]: handleGlob,
  [GREP]: handleGrep,
  [WRITE]: handleWrite,
  [EDIT]: handleEdit,
  [UNDO_LAST_EDIT]: handleUndoLastEdit,
  [JOB_START]: handleJobStart,
  [JOB_LIST]: handleJobList,
  [JOB_READ]: handleJobRead,
  [JOB_WAIT]: handleJobWait,
  [JOB_KILL]: handleJobKill,
  [SHELL]: handleShell,
  [WEBFETCH]: handleWebFetch,
  [WEBSEARCH]: handleWebSearch,
  [ACCEPTANCE_UPDATE]: handleAcceptanceUpdate,
  [TODO_WRITE]: handleTodoWrite,
  [PROGRESS_READ]: handleProgressRead,
  [CONTEXT_COMPACT]: handleContextCompact,
  [NOTEBOOK_EDIT]: handleNotebookEdit,
  [BRIEF]: handleBrief,
  [GIT_STATUS]: handleGitStatus,
  [GIT_LOG]: handleGitLog,
  [GIT_DIFF]: handleGitDiff,
  [RUN_AGENT]: handleRunAgent,
  [CREATE_AGENT]: handleCreateAgent,
  [RUN_SKILL]: handleRunSkill,
  [LSP]: handleLsp,
  [APPLY_PATCH]: handleApplyPatch,
  [SYMBOL_SEARCH]: handleSymbolSearch,
  [MEMORY_LIST]: handleMemoryList,
  [MEMORY_READ]: handleMemoryRead,
  [MEMORY_SAVE]: handleMemorySave,
  [CONTEXT_RECALL]: handleContextRecall,
});
