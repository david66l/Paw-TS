import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  type Attributes,
  ROOT_CONTEXT,
  type Span,
  SpanStatusCode,
  type Tracer,
  trace,
} from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace-base";
import {
  type ModelObservation,
  type ModelObservationEvent,
  type ModelObserver,
  withModelObserver,
} from "@paw/models";
import type { RunJournalEnvelopeV1 } from "@paw/protocol";

const LIMIT = 128;
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex").slice(0, 24);
// Names are metadata. Never accept arbitrary provider errors, prompts or paths.
const identifier = (value: string) =>
  /^[a-zA-Z0-9_.:/-]{1,100}$/.test(value) ? value : "custom";
export interface CloudTelemetryConfig {
  baseUrl: string;
  publicKey: string;
  secretKey: string;
  sampleRate: number;
}
export function cloudTelemetryConfig(
  env: NodeJS.ProcessEnv,
): CloudTelemetryConfig | undefined {
  if (env.PAW_TELEMETRY_ENABLED !== "1") return undefined;
  if (
    !env.LANGFUSE_BASE_URL ||
    !env.LANGFUSE_PUBLIC_KEY ||
    !env.LANGFUSE_SECRET_KEY
  )
    throw new Error(
      "Cloud monitoring requires LANGFUSE_BASE_URL, LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY.",
    );
  const url = new URL(env.LANGFUSE_BASE_URL);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error(
      "Cloud monitoring requires an HTTPS origin without credentials, a path or a query.",
    );
  const sampleRate = Number(env.PAW_TELEMETRY_SAMPLE_RATE ?? "1");
  if (!Number.isFinite(sampleRate) || sampleRate < 0 || sampleRate > 1)
    throw new Error("PAW_TELEMETRY_SAMPLE_RATE must be between 0 and 1.");
  return {
    baseUrl: url.origin,
    publicKey: env.LANGFUSE_PUBLIC_KEY,
    secretKey: env.LANGFUSE_SECRET_KEY,
    sampleRate,
  };
}

/** A private provider: no global hooks, environment/resource discovery or unrelated spans. */
export function createCloudTelemetry(config: CloudTelemetryConfig) {
  const exporter = new OTLPTraceExporter({
    url: `${config.baseUrl}/api/public/otel/v1/traces`,
    headers: {
      Authorization: `Basic ${Buffer.from(`${config.publicKey}:${config.secretKey}`).toString("base64")}`,
      "x-langfuse-ingestion-version": "4",
    },
    timeoutMillis: 2_000,
    concurrencyLimit: 1,
  });
  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({
      "service.name": "paw-desktop",
      "service.version": "1",
    }),
    sampler: new TraceIdRatioBasedSampler(config.sampleRate),
    spanLimits: {
      attributeCountLimit: 48,
      attributeValueLengthLimit: 128,
      eventCountLimit: 16,
    },
    spanProcessors: [
      new BatchSpanProcessor(exporter, {
        maxQueueSize: 256,
        maxExportBatchSize: 64,
        scheduledDelayMillis: 5_000,
        exportTimeoutMillis: 2_500,
      }),
    ],
  });
  return {
    start: () => new CloudRunTelemetry(provider.getTracer("paw.desktop")),
    flush: () => provider.forceFlush(),
    shutdown: () => provider.shutdown(),
  };
}
let client: ReturnType<typeof createCloudTelemetry> | undefined;
let configured = false;
export function loadCloudTelemetryConfig(
  env: NodeJS.ProcessEnv,
  file: string | URL = new URL(
    "../../../.paw/telemetry.local.json",
    import.meta.url,
  ),
) {
  const merged: NodeJS.ProcessEnv = {};
  if (existsSync(file)) {
    const local = JSON.parse(readFileSync(file, "utf8"));
    if (!local || typeof local !== "object" || Array.isArray(local))
      throw new Error("Invalid monitoring config.");
    merged.PAW_TELEMETRY_ENABLED = local.enabled === true ? "1" : "0";
    for (const [key, target] of [
      ["baseUrl", "LANGFUSE_BASE_URL"],
      ["publicKey", "LANGFUSE_PUBLIC_KEY"],
      ["secretKey", "LANGFUSE_SECRET_KEY"],
    ])
      if (key && target && typeof local[key] === "string")
        merged[target] = local[key];
    if (typeof local.sampleRate === "number")
      merged.PAW_TELEMETRY_SAMPLE_RATE = String(local.sampleRate);
  }
  return cloudTelemetryConfig({ ...merged, ...env });
}
export function desktopCloudTelemetry() {
  if (!configured) {
    configured = true;
    try {
      const config = loadCloudTelemetryConfig(process.env);
      if (config) client = createCloudTelemetry(config);
    } catch {
      // Never echo configuration values or exporter errors into chat/stdout.
      process.stderr.write(
        "[paw] Cloud monitoring is disabled: invalid or incomplete configuration.\n",
      );
    }
  }
  return client;
}
export async function shutdownDesktopCloudTelemetry(): Promise<void> {
  try {
    await client?.shutdown();
  } catch {
    /* Best effort on host exit. */
  }
}

/** Lightweight, bounded metadata projection. Canonical journals remain the recovery authority. */
export class CloudRunTelemetry implements ModelObserver {
  private readonly root: Span;
  private readonly runs = new Map<string, Span>();
  private readonly seq = new Map<string, number>();
  private readonly models = new Map<
    string,
    { id: string; span: Span; ended: boolean }
  >();
  private readonly pending = new Map<string, Span>();
  private readonly active = new Set<{ heartbeat(): void; stop(): void }>();
  private readonly timer: ReturnType<typeof setInterval>;
  private closed = false;
  private dropped = 0;
  constructor(private readonly tracer: Tracer) {
    this.root = tracer.startSpan(
      "Paw desktop task",
      {
        attributes: {
          "langfuse.observation.type": "agent",
          "paw.capture": "metadata_only",
        },
      },
      ROOT_CONTEXT,
    );
    this.timer = setInterval(() => this.heartbeat(), 30_000);
    this.timer.unref();
  }
  run<T>(action: () => T): T {
    return withModelObserver(this, action);
  }
  heartbeat(): void {
    for (const item of this.active) {
      try {
        item.heartbeat();
      } catch {
        /* Best effort. */
      }
    }
  }
  private span(
    name: string,
    parent: Span,
    attributes: Attributes = {},
    type = "span",
  ): Span {
    return this.tracer.startSpan(
      name,
      {
        attributes: {
          "langfuse.observation.type": type,
          ...attributes,
        },
      },
      trace.setSpan(ROOT_CONTEXT, parent),
    );
  }
  private runSpan(runId?: string): Span {
    if (!runId) return this.root;
    const existing = this.runs.get(runId);
    if (existing) return existing;
    if (this.runs.size >= LIMIT) {
      this.dropped++;
      return this.root;
    }
    const span = this.span(
      "runtime.run",
      this.root,
      { "paw.run.id": hash(runId) },
      "agent",
    );
    this.runs.set(runId, span);
    return span;
  }
  private instant(name: string, parent: Span, attrs: Attributes = {}): void {
    this.span(name, parent, attrs, "event").end();
  }
  committed(events: readonly RunJournalEnvelopeV1[]): void {
    if (this.closed || !this.root.isRecording()) return;
    try {
      for (const event of events) {
        if (event.seq <= (this.seq.get(event.runId) ?? 0)) continue;
        if (!this.seq.has(event.runId) && this.seq.size >= LIMIT) {
          this.dropped++;
          continue;
        }
        this.seq.set(event.runId, event.seq);
        if (event.record.kind !== "input_fact") continue;
        const f = event.record.fact;
        const parent = this.runSpan(event.runId);
        const key = (id: string) => `${event.runId}:${id}`;
        const start = (
          id: string,
          name: string,
          attrs: Attributes = {},
          kind = "span",
          ancestor = parent,
        ) => {
          if (this.pending.size >= LIMIT || this.pending.has(key(id))) {
            this.dropped++;
            return;
          }
          this.pending.set(key(id), this.span(name, ancestor, attrs, kind));
        };
        const finish = (id: string, status: string) => {
          const span = this.pending.get(key(id));
          if (span) {
            this.endSpan(span, status);
            this.pending.delete(key(id));
          }
        };
        switch (f.type) {
          case "model.dispatch_recorded": {
            const previous = this.models.get(event.runId);
            if (previous && !previous.ended)
              this.endSpan(previous.span, "interrupted");
            const span = this.span("model.turn", parent, {
              "paw.model_call.id": hash(f.modelCallId),
              "paw.turn": f.turn,
            });
            this.models.set(event.runId, {
              id: f.modelCallId,
              span,
              ended: false,
            });
            break;
          }
          case "model.settled": {
            const model = this.models.get(event.runId);
            if (model?.id === f.modelCallId && !model.ended) {
              this.endSpan(model.span, f.status);
              model.ended = true;
            }
            break;
          }
          case "tool.call_observed":
            start(
              f.callId,
              `tool.${identifier(f.tool)}`,
              { "paw.tool_call.id": hash(f.callId) },
              "tool",
              this.models.get(event.runId)?.span ?? parent,
            );
            break;
          case "tool.dispatch_recorded":
            this.pending.get(key(f.callId))?.addEvent("execution.dispatched");
            break;
          case "tool.permission_resolved":
            this.pending.get(key(f.callId))?.addEvent("permission.resolved", {
              resolution: f.resolution,
              source: f.source,
            });
            break;
          case "tool.settled":
            finish(f.callId, f.status);
            break;
          case "runtime.activity_started":
            start(f.activityId, "runtime.activity", {
              "paw.activity.kind": identifier(f.activityKind),
            });
            break;
          case "runtime.activity_settled":
            finish(f.activityId, f.status);
            break;
          case "completion.review_claimed":
            start(f.reviewId, "completion.review", {}, "evaluator");
            break;
          case "completion.review_settled":
            this.pending
              .get(key(f.reviewId))
              ?.setAttribute("paw.verdict", f.verdict);
            finish(f.reviewId, f.status);
            break;
          case "context.checkpoint_distillation_claimed":
            start(f.claimId, "context.compaction");
            break;
          case "context.checkpoint_distillation_settled":
            finish(f.claimId, f.status);
            break;
          case "memory.retrieval_settled":
            this.instant("memory.retrieval.settled", parent);
            break;
          case "context.checkpoint_recorded":
            this.instant("context.checkpoint.recorded", parent);
            break;
        }
      }
    } catch {
      /* Observability is not an execution dependency. */
    }
  }
  private endSpan(span: Span, status: string): void {
    span.setAttribute("paw.status", identifier(status));
    if (["failed", "unknown", "interrupted"].includes(status))
      span.setStatus({ code: SpanStatusCode.ERROR });
    span.end();
  }
  start(
    input: Parameters<ModelObserver["start"]>[0],
  ): ModelObservation | undefined {
    if (this.closed || !this.root.isRecording()) return undefined;
    if (this.active.size >= LIMIT) {
      this.dropped++;
      return undefined;
    }
    const parent =
      input.runId && input.phase === "agent_loop"
        ? this.models.get(input.runId)?.span
        : undefined;
    const generation = this.span(
      "model.generation",
      parent ?? this.runSpan(input.runId),
      {
        "gen_ai.request.model": identifier(input.model),
        "paw.phase": identifier(input.phase ?? "auxiliary"),
        ...(input.protocol
          ? { "paw.protocol": identifier(input.protocol) }
          : {}),
      },
      "generation",
    );
    let attempt: Span | undefined;
    let attemptNumber = 0;
    let statusCode: number | undefined;
    let state = "waiting_for_provider";
    let lastDataAt: number | undefined;
    const started = performance.now();
    let bytes = 0;
    let thinking = 0;
    let text = 0;
    let fragments = 0;
    let tools = 0;
    const first = new Set<string>();
    const milestone = (kind: string) => {
      if (first.has(kind)) return;
      first.add(kind);
      this.instant(`model.first_${kind}`, attempt ?? generation, {
        "paw.elapsed_ms": performance.now() - started,
      });
    };
    const counters = (): Attributes => ({
      "paw.bytes": bytes,
      "paw.thinking_chars": thinking,
      "paw.text_chars": text,
      "paw.tool_fragments": fragments,
      "paw.assembled_tool_calls": tools,
      "paw.attempts": attemptNumber,
      "paw.state": state,
      "paw.elapsed_ms": performance.now() - started,
      ...(lastDataAt === undefined
        ? {}
        : { "paw.since_last_data_ms": performance.now() - lastDataAt }),
    });
    const finishAttempt = (status: string) => {
      if (attempt) {
        this.endSpan(attempt, status);
        attempt = undefined;
      }
    };
    const live = {
      heartbeat: () =>
        this.instant("model.progress", attempt ?? generation, counters()),
      stop: () => finish("interrupted"),
    };
    const finish = (status: Parameters<ModelObservation["end"]>[0]) => {
      if (!this.active.delete(live)) return;
      finishAttempt(status);
      generation.setAttributes(counters());
      this.endSpan(generation, status);
    };
    this.active.add(live);
    return {
      event: (event: ModelObservationEvent) => {
        if (this.closed || !this.active.has(live)) return;
        switch (event.type) {
          case "request":
            finishAttempt(
              statusCode && statusCode >= 400 ? "failed" : "interrupted",
            );
            statusCode = undefined;
            lastDataAt = undefined;
            first.clear();
            state = "waiting_for_provider";
            attempt = this.span("provider.request", generation, {
              "paw.attempt": ++attemptNumber,
              "paw.streaming": event.streaming,
              ...(event.maxOutputTokens === undefined
                ? {}
                : { "gen_ai.request.max_tokens": event.maxOutputTokens }),
              ...(event.reasoningEffort
                ? { "paw.reasoning_effort": identifier(event.reasoningEffort) }
                : {}),
            });
            this.instant("provider.request.started", attempt);
            break;
          case "headers":
            statusCode = event.status;
            attempt?.setAttribute("http.response.status_code", event.status);
            state = "waiting_for_body";
            milestone("headers");
            break;
          case "bytes":
            bytes += event.count;
            lastDataAt = performance.now();
            milestone("bytes");
            break;
          case "delta":
            lastDataAt = performance.now();
            if (event.kind === "thinking") {
              thinking += event.count;
              state = "thinking";
            }
            if (event.kind === "text") {
              text += event.count;
              state = "writing";
            }
            if (event.kind === "tool_fragment") {
              fragments += event.count;
              state = "building_tool_call";
            }
            milestone(event.kind);
            break;
          case "tool_assembled":
            tools++;
            milestone("assembled_tool_call");
            break;
          case "result":
            if (event.toolCalls !== undefined) tools = event.toolCalls;
            if (event.finishReason)
              generation.setAttribute(
                "paw.finish_reason",
                identifier(event.finishReason),
              );
            if (event.usage?.promptTokens !== undefined)
              generation.setAttribute(
                "gen_ai.usage.input_tokens",
                event.usage.promptTokens,
              );
            if (event.usage?.completionTokens !== undefined)
              generation.setAttribute(
                "gen_ai.usage.output_tokens",
                event.usage.completionTokens,
              );
            state = "settled";
            break;
          case "failure":
            generation.setAttribute("error.type", event.kind);
            attempt?.setAttribute("error.type", event.kind);
            state = event.kind;
            break;
        }
      },
      end: finish,
    };
  }
  finish(status: string): void {
    if (this.closed) return;
    clearInterval(this.timer);
    for (const active of this.active) active.stop();
    for (const span of this.pending.values()) this.endSpan(span, "interrupted");
    for (const model of this.models.values())
      if (!model.ended) this.endSpan(model.span, "interrupted");
    for (const run of this.runs.values()) this.endSpan(run, status);
    this.root.setAttribute("paw.dropped_observations", this.dropped);
    this.endSpan(this.root, status);
    this.closed = true;
    this.pending.clear();
    this.models.clear();
    this.runs.clear();
    this.seq.clear();
  }
}
