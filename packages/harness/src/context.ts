import type { SkillRegistry, TodoStore } from "@paw/core";
import type { WorkspaceWatcher } from "@paw/workspace";

import type { McpClientManager } from "./mcp-client.js";

export interface SubAgentResult {
  readonly result: string;
  readonly stepsTaken: number;
  readonly status: "completed" | "failed";
}

export interface SubAgentLauncher {
  launch(goal: string, maxSteps?: number): Promise<SubAgentResult>;
}

export interface HarnessContext {
  readonly workspaceRoot: string;
  /** Optional MCP client manager for external tool calls. */
  readonly mcp?: McpClientManager;
  /** Optional task list store for {@link TODO_WRITE} tool. */
  readonly todoStore?: TodoStore;
  /** Optional sub-agent launcher for {@link RUN_AGENT} tool. */
  readonly subAgentLauncher?: SubAgentLauncher;
  /** Optional skill registry for {@link RUN_SKILL} tool. */
  readonly skillRegistry?: SkillRegistry;
  /** Optional callback for real-time shell output chunks. */
  readonly onShellChunk?: (tool: string, chunk: string, isStderr: boolean) => void;
  /** Optional filesystem watcher to track external modifications. */
  readonly watcher?: WorkspaceWatcher;
}
