/**
 * Default {@link SubAgentLauncher} implementation using {@link AgentOrchestrator}.
 */

import type { RunEventEnvelope } from "@paw/core";
import type {
  McpServerConfig,
  SubAgentLaunchOptions,
  SubAgentLauncher,
  SubAgentResult,
} from "@paw/harness";
import type { LanguageModel } from "@paw/models";

import { buildMinimalSharedContext } from "./orchestrator/agent-args.js";
import { AgentOrchestrator } from "./orchestrator.js";
import type { SharedContext } from "./orchestrator/types.js";

export interface DefaultSubAgentLauncherOptions {
  readonly workspaceRoot: string;
  readonly model?: LanguageModel;
  readonly subAgentModel?: LanguageModel;
  readonly skillsDir?: string;
  readonly mcpServers?: readonly McpServerConfig[];
  readonly maxSteps?: number;
}

function isSharedContext(value: unknown): value is SharedContext {
  return (
    value !== null &&
    typeof value === "object" &&
    "task" in value &&
    typeof (value as SharedContext).task === "string"
  );
}

function resolveSharedContext(
  goal: string,
  sharedContext: unknown | undefined,
  args: Record<string, unknown> | undefined,
): SharedContext {
  if (isSharedContext(sharedContext)) {
    return sharedContext;
  }
  return buildMinimalSharedContext(goal, args);
}

export class DefaultSubAgentLauncher implements SubAgentLauncher {
  private readonly workspaceRoot: string;
  private readonly model?: LanguageModel;
  private readonly subAgentModel?: LanguageModel;
  private readonly skillsDir?: string;
  private readonly mcpServers?: readonly McpServerConfig[];
  private readonly defaultMaxSteps: number;

  constructor(opts: DefaultSubAgentLauncherOptions) {
    this.workspaceRoot = opts.workspaceRoot;
    this.model = opts.model;
    this.subAgentModel = opts.subAgentModel;
    this.skillsDir = opts.skillsDir;
    this.mcpServers = opts.mcpServers;
    this.defaultMaxSteps = opts.maxSteps ?? 10;
  }

  private createChildOrchestrator(
    sharedContext: SharedContext,
    onEvent: (envelope: RunEventEnvelope) => void,
  ): AgentOrchestrator {
    const childModel = this.subAgentModel ?? this.model;
    return new AgentOrchestrator({
      model: childModel,
      auxiliaryModel: childModel,
      runMode: "child",
      sharedContext,
      childPolicy: sharedContext.childPolicy ?? "read_only",
      skillsDir: this.skillsDir,
      mcpServers: this.mcpServers,
      memoryExtraction: "off",
      onEvent,
    });
  }

  async launch(
    goal: string,
    maxSteps?: number,
    options?: SubAgentLaunchOptions,
  ): Promise<SubAgentResult> {
    const parentRunId =
      options?.parentRunId ?? `parent-${Date.now().toString(36)}`;
    const agentId =
      options?.agentId ??
      `sub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return this.launchStreaming({
      goal,
      maxSteps,
      signal: options?.signal,
      parentRunId,
      agentId,
      onEvent: options?.onEvent ?? (() => {}),
      sharedContext: options?.sharedContext,
      args: options?.args,
    });
  }

  async launchStreaming(options: {
    goal: string;
    maxSteps?: number;
    signal?: AbortSignal;
    parentRunId: string;
    agentId: string;
    onEvent: (envelope: RunEventEnvelope) => void;
    sharedContext?: unknown;
    args?: Record<string, unknown>;
  }): Promise<SubAgentResult> {
    const runId = options.agentId;
    let stepsTaken = 0;
    const events: RunEventEnvelope[] = [];
    const sharedContext = resolveSharedContext(
      options.goal,
      options.sharedContext,
      options.args,
    );

    const orch = this.createChildOrchestrator(sharedContext, (envelope) => {
      events.push(envelope);
      options.onEvent(envelope);
      if (envelope.event.type === "loop.tick") {
        stepsTaken = envelope.event.turn;
      }
    });

    const result = await orch.run({
      runId,
      goal: options.goal,
      workspaceRoot: this.workspaceRoot,
      maxSteps: options.maxSteps ?? this.defaultMaxSteps,
      abortSignal: options.signal,
    });

    return {
      status: result.status === "completed" ? "completed" : "failed",
      summary: result.message,
      trace: {
        messages: [],
        events,
        stepsTaken,
      },
    };
  }
}
