/**
 * AgentGroup: manages parallel child agents, event forwarding, result merging,
 * cancellation, and concurrency limits.
 */

import type { ContextManager, RunEvent, RunEventEnvelope } from "@paw/core";
import type { AgentToolCallAction } from "@paw/core";
import type { SubAgentLauncher } from "@paw/harness";
import type { WorkspaceWatcher } from "@paw/workspace";
import { MULTI_AGENT_LIMITS, PARENT_FORWARD_EVENTS } from "./constants.js";
import { parseRunAgentMaxSteps } from "./context-summarizer.js";
import type {
  AgentRunState,
  ChildAgentState,
  ChildPhase,
  SharedContext,
  SubAgentResult,
} from "./types.js";

interface ChildController {
  readonly agentId: string;
  readonly goal: string;
  readonly maxSteps: number;
  readonly promise: Promise<SubAgentResult>;
  state: ChildAgentState;
}

interface AgentGroupOptions {
  readonly parentRunId: string;
  readonly parentOnEvent: (envelope: RunEventEnvelope) => void;
  readonly parentCtxMgr: ContextManager;
  readonly parentWatcher?: WorkspaceWatcher;
  readonly launcher: SubAgentLauncher;
  readonly depth: number;
}

export class AgentGroup {
  private readonly parentRunId: string;
  private readonly parentOnEvent: (envelope: RunEventEnvelope) => void;
  private readonly parentWatcher?: WorkspaceWatcher;
  private readonly launcher: SubAgentLauncher;
  private readonly depth: number;
  private readonly localController = new AbortController();
  private children = new Map<string, ChildController>();

  constructor(opts: AgentGroupOptions) {
    this.parentRunId = opts.parentRunId;
    this.parentOnEvent = opts.parentOnEvent;

    this.parentWatcher = opts.parentWatcher;
    this.launcher = opts.launcher;
    this.depth = opts.depth;
  }

  /** Launch multiple child agents in parallel with concurrency guards. */
  async launchAll(
    calls: readonly AgentToolCallAction[],
    sharedCtxForCall: (call: AgentToolCallAction) => SharedContext,
    parentSignal?: AbortSignal,
  ): Promise<SubAgentResult[]> {
    // Guard: max children per turn
    if (calls.length > MULTI_AGENT_LIMITS.maxChildrenPerTurn) {
      throw new Error(
        `Cannot launch ${calls.length} child agents; max is ${MULTI_AGENT_LIMITS.maxChildrenPerTurn}`,
      );
    }

    // Guard: max depth
    if (this.depth >= MULTI_AGENT_LIMITS.maxChildDepth) {
      throw new Error(
        `Child agent depth ${this.depth} exceeds max ${MULTI_AGENT_LIMITS.maxChildDepth}`,
      );
    }

    // Combine parent signal with local controller for cascading cancellation
    const childSignal = parentSignal
      ? AbortSignal.any([parentSignal, this.localController.signal])
      : this.localController.signal;

    // Build child controllers
    const controllers: ChildController[] = calls.map((call, idx) => {
      const agentId = `child-${this.parentRunId}-${idx}`;
      const goal =
        typeof call.args?.goal === "string"
          ? call.args.goal
          : String(call.args?.goal ?? "");
      const sharedContext = sharedCtxForCall(call);
      const callArgs =
        call.args && typeof call.args === "object"
          ? (call.args as Record<string, unknown>)
          : undefined;
      const maxSteps =
        parseRunAgentMaxSteps(callArgs) ?? MULTI_AGENT_LIMITS.maxChildSteps;

      const state: ChildAgentState = {
        agentId,
        goal,
        phase: "queued",
        progress: 0,
      };

      const promise = this.launcher
        .launchStreaming({
          goal,
          maxSteps,
          signal: childSignal,
          parentRunId: this.parentRunId,
          agentId,
          onEvent: (envelope) => this.onChildEvent(agentId, envelope),
          sharedContext,
        })
        .then((result) => {
          this.updateChildState(agentId, "completed", 100, result);
          return result;
        })
        .catch((err) => {
          const errorMsg = err instanceof Error ? err.message : String(err);
          this.updateChildState(agentId, "failed", 0, undefined, errorMsg);
          return {
            status: "failed" as const,
            summary: `Child agent failed: ${errorMsg}`,
            errors: [errorMsg],
          };
        });

      const controller: ChildController = {
        agentId,
        goal,
        maxSteps,
        promise,
        state,
      };
      this.children.set(agentId, controller);
      return controller;
    });

    // Wait for all to settle (allow partial failures)
    const results = await Promise.allSettled(controllers.map((c) => c.promise));

    // Clean up settled children to prevent unbounded map growth across turns
    for (const c of controllers) {
      this.children.delete(c.agentId);
    }

    // Convert SettledResult[] to SubAgentResult[]
    return results.map((r, idx) => {
      if (r.status === "fulfilled") {
        return r.value;
      }
      const agentId = controllers[idx]?.agentId;
      return {
        status: "failed" as const,
        summary: `Child agent ${agentId} rejected: ${String(r.reason)}`,
        errors: [String(r.reason)],
      };
    });
  }

  /** Cancel all running child agents. */
  async cancelAll(): Promise<void> {
    this.localController.abort();
    // Wait for all children to exit (they will reject/resolve after abort)
    await Promise.allSettled(
      [...this.children.values()].map((c) =>
        c.promise.catch(() => {
          /* ignore */
        }),
      ),
    );
  }

  /** Receive events from a child agent. */
  onChildEvent(agentId: string, envelope: RunEventEnvelope): void {
    const controller = this.children.get(agentId);
    if (!controller) return;

    const event = envelope.event;

    // Update internal child state based on event type
    switch (event.type) {
      case "run.started":
        this.updateChildState(agentId, "model_calling", 0);
        break;
      case "loop.tick": {
        const maxSteps = controller.maxSteps;
        const progress =
          maxSteps > 0
            ? Math.min(50, (event.turn / maxSteps) * 50)
            : 0;
        this.updateChildState(agentId, "model_calling", progress);
        break;
      }
      case "phase":
        if (event.name === "tool") {
          this.updateChildState(agentId, "tool_executing", 75);
        }
        break;
      case "tool.result":
        this.updateChildState(agentId, "tool_executing", 85);
        break;
      case "run.completed":
        this.updateChildState(agentId, "completed", 100);
        break;
      case "run.failed":
        this.updateChildState(agentId, "failed", 0, undefined, event.message);
        break;
    }

    // Forward whitelisted events to parent
    const childEventType = `child.${mapToChildEventType(event.type)}`;
    if (PARENT_FORWARD_EVENTS.has(childEventType)) {
      this.parentOnEvent({
        runId: this.parentRunId,
        seq: envelope.seq,
        ts: envelope.ts,
        event: {
          type: childEventType as RunEvent["type"],
          agentId,
          originalEvent: event,
        } as unknown as RunEvent,
      });
    }

    // Notify parent watcher of file writes by child agents
    if (
      event.type === "tool.result" &&
      (event.tool === "workspace.write_file" ||
        event.tool === "workspace.edit_file") &&
      event.ok
    ) {
      const detail = event.detail;
      const filePath =
        detail && typeof detail === "object" && "path" in detail
          ? String((detail as Record<string, unknown>).path)
          : undefined;
      if (filePath && this.parentWatcher) {
        this.parentWatcher.takeExternallyModified();
      }
    }
  }

  /** Get the hierarchical state tree for TUI display. */
  getStateTree(): AgentRunState {
    return {
      runId: this.parentRunId,
      phase: "waiting_children",
      progress: this.computeOverallProgress(),
      children: [...this.children.values()].map((c) => ({
        runId: c.agentId,
        phase: c.state.phase,
        progress: c.state.progress,
      })),
    };
  }

  private updateChildState(
    agentId: string,
    phase: ChildPhase,
    progress: number,
    result?: SubAgentResult,
    error?: string,
  ): void {
    const controller = this.children.get(agentId);
    if (!controller) return;
    controller.state = {
      ...controller.state,
      phase,
      progress,
      ...(result ? { result } : {}),
      ...(error ? { error } : {}),
    };
  }

  private computeOverallProgress(): number {
    if (this.children.size === 0) return 0;
    let total = 0;
    for (const c of this.children.values()) {
      total += c.state.progress;
    }
    return Math.round(total / this.children.size);
  }
}

/** Map internal RunEvent type to child event type prefix. */
function mapToChildEventType(eventType: string): string {
  switch (eventType) {
    case "run.started":
      return "started";
    case "run.completed":
      return "completed";
    case "run.failed":
      return "failed";
    case "tool.call":
      return "tool_call";
    case "tool.result":
      return "tool_result";
    default:
      return "phase_changed";
  }
}
