/**
 * Default {@link SubAgentLauncher} implementation using {@link AgentOrchestrator}.
 */

import type { SubAgentLauncher, SubAgentResult } from "@paw/harness";
import type { LanguageModel } from "@paw/models";

import { AgentOrchestrator } from "./orchestrator.js";

export interface DefaultSubAgentLauncherOptions {
  readonly workspaceRoot: string;
  readonly model?: LanguageModel;
  readonly mcpServers?: readonly import("@paw/harness").McpServerConfig[];
  readonly maxSteps?: number;
}

export class DefaultSubAgentLauncher implements SubAgentLauncher {
  private readonly workspaceRoot: string;
  private readonly model?: LanguageModel;
  private readonly mcpServers?: readonly import("@paw/harness").McpServerConfig[];
  private readonly defaultMaxSteps: number;

  constructor(opts: DefaultSubAgentLauncherOptions) {
    this.workspaceRoot = opts.workspaceRoot;
    this.model = opts.model;
    this.mcpServers = opts.mcpServers;
    this.defaultMaxSteps = opts.maxSteps ?? 10;
  }

  async launch(goal: string, maxSteps?: number): Promise<SubAgentResult> {
    const runId = `sub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const orch = new AgentOrchestrator({
      model: this.model,
      mcpServers: this.mcpServers,
    });
    const result = await orch.run({
      runId,
      goal,
      workspaceRoot: this.workspaceRoot,
      maxSteps: maxSteps ?? this.defaultMaxSteps,
    });
    return {
      result: result.message,
      stepsTaken: 0, // TODO: track steps from orchestrator
      status: result.status === "completed" ? "completed" : "failed",
    };
  }
}
