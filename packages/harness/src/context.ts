import type { SkillRegistry, TodoStore } from "@paw/core";
import type { WorkspaceWatcher } from "@paw/workspace";

import type { ShellSandboxConfig } from "./sandbox/index.js";
import type { McpClientManager } from "./mcp-client.js";

export interface SubAgentArtifact {
  readonly type: "file" | "code" | "test_result" | "search_result";
  readonly path?: string;
  readonly content: string;
  readonly summary: string;
}

export interface SubAgentResult {
  readonly status: "completed" | "failed";
  readonly summary: string;
  readonly findings?: readonly string[];
  readonly changedFiles?: readonly string[];
  readonly testsRun?: readonly {
    readonly name: string;
    readonly passed: boolean;
  }[];
  readonly errors?: readonly string[];
  readonly artifacts?: readonly SubAgentArtifact[];
  /** Full trace for debugging / replay / TUI – NOT injected into parent context. */
  readonly trace?: {
    readonly messages: readonly import("@paw/core").ChatMessage[];
    readonly events: readonly import("@paw/core").RunEventEnvelope[];
    readonly stepsTaken: number;
  };
}

export interface SubAgentLaunchOptions {
  readonly args?: Record<string, unknown>;
  readonly sharedContext?: unknown;
  readonly signal?: AbortSignal;
  readonly parentRunId?: string;
  readonly agentId?: string;
  readonly onEvent?: (envelope: import("@paw/core").RunEventEnvelope) => void;
}

export interface SubAgentLauncher {
  launch(
    goal: string,
    maxSteps?: number,
    options?: SubAgentLaunchOptions,
  ): Promise<SubAgentResult>;

  launchStreaming(options: {
    goal: string;
    maxSteps?: number;
    signal?: AbortSignal;
    parentRunId: string;
    agentId: string;
    onEvent: (envelope: import("@paw/core").RunEventEnvelope) => void;
    sharedContext?: unknown;
    args?: Record<string, unknown>;
  }): Promise<SubAgentResult>;
}

export interface HarnessContext {
  readonly workspaceRoot: string;
  readonly mcp?: McpClientManager;
  readonly todoStore?: TodoStore;
  readonly subAgentLauncher?: SubAgentLauncher;
  readonly skillRegistry?: SkillRegistry;
  readonly onShellChunk?: (
    tool: string,
    chunk: string,
    isStderr: boolean,
  ) => void;
  readonly watcher?: WorkspaceWatcher;
  readonly abortSignal?: AbortSignal;
  readonly parentRunId?: string;
  readonly buildSubAgentSharedContext?: (input: {
    readonly goal: string;
    readonly args: Record<string, unknown>;
  }) => unknown;
  /** Docker/Podman sandbox policy for workspace.run_shell. */
  readonly shellSandbox?: ShellSandboxConfig;
}
