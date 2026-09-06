import { createHash } from "node:crypto";
import type { RunEvent, RunEventEnvelope } from "@paw/core";
import type { ModelStreamChunk } from "@paw/models";
import type { RunJournalEnvelopeV1 } from "@paw/protocol";
import {
  DEFAULT_FILE_DURABLE_JSON_PAYLOAD_POLICY_V1,
  createFileDurableJsonPayloadReaderV1,
} from "@paw/runtime";
import type { DesktopMonitorSnapshot } from "../src/agent/monitorTypes.js";
import { desktopFileChanges } from "./paw-next-changes.js";
import { DesktopRunMonitor } from "./paw-next-monitor.js";

/** UI projection only. The Paw Next journal remains the execution authority. */
export class DesktopNextEvents {
  readonly monitor: DesktopRunMonitor;
  private seq: number;
  private text = "";
  private thinking = "";
  private calls = new Map<string, { tool: string; args: unknown }>();
  private children = new Map<string, string>();
  private activities = new Map<string, string>();
  private planRevision = 0;
  private controls = new Map<
    string,
    { goal: string; agentId: string; cancel?: () => void }
  >();
  childControl(child: {
    id: string;
    goal: string;
    agentId: string;
    cancel?: () => void;
  }) {
    this.controls.set(child.id, child);
    if ([...this.activities.values()].includes(child.id))
      this.publishChildControl(child.id);
  }
  private publishChildControl(id: string) {
    const child = this.controls.get(id);
    if (child)
      this.emit({
        type: "child.control",
        callId: id,
        goal: child.goal,
        agentId: child.agentId,
        originalEvent: { controllable: Boolean(child.cancel) },
      });
  }
  private pending = new Set<Promise<void>>();

  async flush(): Promise<void> {
    await Promise.all([...this.pending]);
  }
  constructor(
    readonly runId: string,
    private readonly send: (event: RunEventEnvelope) => void,
    seq = 0,
    private readonly workspaceRoot = process.cwd(),
    initialMonitor?: DesktopMonitorSnapshot,
  ) {
    this.seq = seq;
    this.monitor = new DesktopRunMonitor(
      runId,
      (snapshot) => this.emit({ type: "monitor.snapshot", snapshot }),
      initialMonitor,
    );
  }

  emit(
    event:
      | RunEvent
      | { type: "monitor.snapshot"; snapshot: DesktopMonitorSnapshot }
      | { type: "run.completed"; status: string; message: string }
      | { type: "context.next_budget"; [key: string]: unknown }
      | { type: "workspace.changes"; [key: string]: unknown }
      | {
          type: "input.accepted" | "input.promoted" | "input.consumed";
          inputId: string;
          content?: string;
          attachments?: readonly { id: string; name: string; type: string }[];
        }
      | {
          type: `child.${string}`;
          callId: string;
          agentId?: string;
          goal?: string;
          originalEvent?: unknown;
        },
  ): void {
    this.send({
      runId: this.runId,
      seq: ++this.seq,
      ts: Date.now(),
      event: event as RunEvent,
    });
  }

  stream(chunk: ModelStreamChunk, identity?: { runId: string }): void {
    if (identity && identity.runId !== this.runId) return;
    if (chunk.type === "text") {
      this.text += chunk.delta;
      this.emit({ type: "model.chunk", text: this.text });
    } else if (chunk.type === "thinking") {
      this.thinking += chunk.delta;
      this.emit({ type: "model.thinking", text: this.thinking });
    } else if (chunk.type === "done") {
      this.emit({
        type: "model.done",
        text: this.text,
        thinking: this.thinking,
        ...(chunk.usage ? { usage: chunk.usage } : {}),
      });
    }
  }

  committed(envelopes: readonly RunJournalEnvelopeV1[]): void {
    for (const envelope of envelopes) {
      const childId = this.children.get(envelope.runId);
      if (envelope.runId !== this.runId && !childId) continue;
      if (envelope.record.kind !== "input_fact") continue;
      this.monitor.committed(envelope);
      const fact = envelope.record.fact;
      const key = (id: string) => `${envelope.runId}:${id}`;
      if (
        fact.type === "input.accepted" &&
        fact.delivery === "steer" &&
        !childId
      ) {
        this.emit({
          type: "input.accepted",
          inputId: fact.inputId,
          content: fact.content,
          attachments: fact.attachments?.map((a) => ({
            id: a.attachmentId,
            name: a.name,
            type: a.type,
          })),
        });
      } else if (
        fact.type === "input.promoted" &&
        fact.delivery === "steer" &&
        !childId
      ) {
        this.emit({ type: "input.promoted", inputId: fact.inputId });
      } else if (fact.type === "model.dispatch_recorded" && !childId) {
        this.text = "";
        this.thinking = "";
        this.emit({
          type: "model.request",
          label: "Paw Next",
          messageCount: 0,
        });
      } else if (
        fact.type === "model.settled" &&
        !childId &&
        fact.response?.kind === "inline"
      ) {
        const response = record(fact.response.value);
        if (typeof response.assistantContent === "string")
          this.emit({ type: "model.done", text: response.assistantContent });
      } else if (fact.type === "tool.call_observed") {
        this.calls.set(key(fact.callId), { tool: fact.tool, args: fact.args });
        const event = {
          type: "tool.call" as const,
          tool: fact.tool,
          args: fact.args,
          callId: key(fact.callId),
        };
        if (childId)
          this.emit({
            type: "child.tool_call",
            callId: childId,
            originalEvent: event,
          });
        else this.emit(event);
      } else if (fact.type === "tool.settled") {
        const call = this.calls.get(key(fact.callId));
        if (!call) continue;
        const result = record(fact.result);
        const ok =
          fact.status === "completed" &&
          result.ok !== false &&
          !fact.observation?.isError;
        const payload =
          result.payload ??
          (fact.observation?.payload?.kind === "inline"
            ? fact.observation.payload.value
            : undefined);
        const fileChanges = ok
          ? desktopFileChanges(payload, call.args, this.workspaceRoot)
          : [];
        const carrier = fact.observation?.payload;
        if (
          ok &&
          carrier?.kind === "artifact_ref" &&
          /(?:write_file|edit_file|apply_patch)$/.test(call.tool)
        ) {
          const pending = Promise.resolve()
            .then(async () => {
              const reader = createFileDurableJsonPayloadReaderV1({
                workspaceRoot: this.workspaceRoot,
                sessionId: envelope.sessionId,
                runId: envelope.runId,
                policy: DEFAULT_FILE_DURABLE_JSON_PAYLOAD_POLICY_V1,
              });
              const value = await reader.resolve(carrier, {
                originSeq: envelope.seq,
                field: { kind: "tool_observation", callId: fact.callId },
              });
              const changes = desktopFileChanges(
                value,
                call.args,
                this.workspaceRoot,
              );
              if (changes.length)
                this.emit({
                  type: "workspace.changes",
                  tool: call.tool,
                  callId: key(fact.callId),
                  ...(childId ? { childId } : {}),
                  ok: true,
                  fileChanges: changes,
                });
            })
            .catch(() => {
              this.emit({
                type: "workspace.changes",
                tool: call.tool,
                ok: false,
                summary: "无法读取已提交的文件差异，请检查运行日志。",
              });
            });
          this.pending.add(pending);
          void pending.finally(() => this.pending.delete(pending));
        }
        const event = {
          type: "tool.result" as const,
          tool: call.tool,
          callId: key(fact.callId),
          ...(fileChanges.length ? { fileChanges } : {}),
          ok:
            fact.status === "completed" &&
            result.ok !== false &&
            !fact.observation?.isError,
          summary:
            fact.observation?.summary ??
            (typeof result.summary === "string"
              ? result.summary
              : (fact.errorCode ?? fact.status)),
        };
        if (childId)
          this.emit({
            type: "child.tool_result",
            callId: childId,
            originalEvent: event,
          });
        else this.emit(event);
        if (!childId && event.ok && call.tool === "workspace.todo_write") {
          const todos = record(call.args).todos;
          if (Array.isArray(todos)) {
            const items = todos
              .map(record)
              .filter(
                (item) =>
                  typeof item.id === "string" &&
                  typeof item.content === "string",
              )
              .map((item) => ({
                id: item.id as string,
                text: item.content as string,
                status:
                  item.status === "in_progress"
                    ? "running"
                    : item.status === "done"
                      ? "completed"
                      : "pending",
              }));
            this.emit({
              type: "plan.updated",
              revision: ++this.planRevision,
              itemCount: items.length,
              reason: "Paw Next task progress",
              items,
            });
          }
        }
      } else if (fact.type === "memory.retrieval_settled" && !childId) {
        this.emit({
          type: "memory.retrieve.done",
          query: fact.queryId,
          totalCandidates: fact.cards.length,
          selectedCount: fact.cards.length,
          scores: [],
          injectedTokens: Math.ceil(
            fact.cards.reduce(
              (total, card) => total + card.statement.length,
              0,
            ) / 3,
          ),
          selectedMemories: fact.cards.map((card) => ({
            id: card.id,
            title: card.statement.slice(0, 80),
            summary: card.statement,
            source: "Paw Next · PostgreSQL",
            type: card.kind,
            relatedFiles: [],
          })),
        });
      } else if (
        fact.type === "runtime.activity_started" &&
        fact.activityKind === "collaboration_child"
      ) {
        const meta = record(fact.metadata);
        if (typeof meta.callId !== "string") continue;
        const id = key(meta.callId);
        const childKey = createHash("sha256")
          .update(
            JSON.stringify([envelope.sessionId, envelope.runId, meta.callId]),
          )
          .digest("hex")
          .slice(0, 32);
        this.children.set(`child-run-${childKey}`, id);
        this.activities.set(fact.activityId, id);
        const agent =
          typeof meta.agentId === "string" ? meta.agentId : "worker";
        this.emit({
          type: "tool.call",
          tool: "workspace.run_agent",
          callId: id,
          args: { agent_id: agent, goal: fact.label },
        });
        this.emit({
          type: "child.started",
          callId: id,
          agentId: agent,
          goal: fact.label,
        });
        this.publishChildControl(id);
      } else if (fact.type === "runtime.activity_settled") {
        const id = this.activities.get(fact.activityId);
        if (id)
          this.emit({
            type:
              fact.status === "completed" ? "child.completed" : "child.failed",
            callId: id,
            originalEvent: { message: fact.summary, status: fact.status },
          });
      }
    }
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
