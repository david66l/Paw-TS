import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { OpenAICompatibleModel } from "@paw/models";
import type { InputFactV1, RunJournalEnvelopeV1 } from "@paw/protocol";
import {
  CloudRunTelemetry,
  cloudTelemetryConfig,
  createCloudTelemetry,
} from "../agent-host/cloud-telemetry.js";
import { runDesktopNext } from "../agent-host/paw-next.js";

const originalFetch = globalThis.fetch;
const providers: BasicTracerProvider[] = [];
const traces: CloudRunTelemetry[] = [];
const roots: string[] = [];
afterEach(async () => {
  globalThis.fetch = originalFetch;
  for (const trace of traces.splice(0)) trace.finish("interrupted");
  for (const provider of providers.splice(0)) await provider.shutdown();
  for (const root of roots.splice(0)) {
    if (!path.resolve(root).startsWith(path.join(os.tmpdir(), "paw-cloud-test-")))
      throw new Error("Unsafe fixture path");
    fs.rmSync(root, { recursive: true, force: true });
  }
});
function fixture() {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  providers.push(provider);
  const monitor = new CloudRunTelemetry(provider.getTracer("test"));
  traces.push(monitor);
  return { monitor, exporter, provider };
}
function fact(runId: string, seq: number, fact: InputFactV1): RunJournalEnvelopeV1 {
  return {
    schemaVersion: 1,
    sessionId: "private-session",
    runId,
    seq,
    ts: Date.now(),
    record: { kind: "input_fact", fact },
  };
}
test("cloud config is opt-in, validates HTTPS and credentials, and bounds sampling", () => {
  expect(cloudTelemetryConfig({})).toBeUndefined();
  expect(() => cloudTelemetryConfig({ PAW_TELEMETRY_ENABLED: "1" })).toThrow();
  const valid = {
    PAW_TELEMETRY_ENABLED: "1",
    LANGFUSE_BASE_URL: "https://cloud.langfuse.com",
    LANGFUSE_PUBLIC_KEY: "pk-test",
    LANGFUSE_SECRET_KEY: "sk-test",
  };
  expect(cloudTelemetryConfig(valid)?.sampleRate).toBe(1);
  for (const url of [
    "http://cloud.langfuse.com",
    "https://user:pass@cloud.langfuse.com",
    "https://cloud.langfuse.com/?key=secret",
  ]) {
    expect(() => cloudTelemetryConfig({ ...valid, LANGFUSE_BASE_URL: url })).toThrow();
  }
  expect(() => cloudTelemetryConfig({ ...valid, PAW_TELEMETRY_SAMPLE_RATE: "1.5" })).toThrow();
});

test("cloud timeline links model generations, attempts, tools and child runs without private payloads", async () => {
  const { monitor, exporter, provider } = fixture();
  monitor.committed([
    fact("child-run", 1, {
      type: "model.dispatch_recorded",
      modelCallId: "model-1",
      turn: 1,
      requestHash: "PRIVATE_HASH",
    }),
  ]);
  const response = monitor.start({
    model: "glm-5.3-flash",
    runId: "child-run",
    phase: "agent_loop",
  });
  response?.event({
    type: "request",
    streaming: true,
    maxOutputTokens: 128_000,
    reasoningEffort: "max",
  });
  response?.event({ type: "headers", status: 400 });
  response?.event({
    type: "request",
    streaming: true,
    maxOutputTokens: 128_000,
    reasoningEffort: "max",
  });
  response?.event({ type: "headers", status: 200 });
  for (let i = 0; i < 10_000; i++) response?.event({ type: "delta", kind: "thinking", count: 5 });
  monitor.heartbeat();
  response?.event({ type: "tool_assembled" });
  response?.event({
    type: "result",
    usage: { promptTokens: 10, completionTokens: 20 },
    finishReason: "tool_calls",
  });
  response?.end("completed");
  monitor.committed([
    fact("child-run", 2, {
      type: "model.settled",
      modelCallId: "model-1",
      turn: 1,
      status: "completed",
      hasToolCalls: true,
      hasVisibleOutput: false,
    }),
    fact("child-run", 3, {
      type: "tool.call_observed",
      modelCallId: "model-1",
      turn: 1,
      callId: "call-1",
      tool: "read_file",
      args: { path: "PRIVATE_PATH" },
      order: 0,
    }),
    fact("child-run", 4, {
      type: "tool.permission_resolved",
      turn: 1,
      sourceIndex: 0,
      callId: "call-1",
      tool: "read_file",
      policyVersion: "1",
      resolution: "allow_once",
      source: "user_prompt",
    }),
    fact("child-run", 5, {
      type: "tool.settled",
      callId: "call-1",
      status: "completed",
      result: { text: "PRIVATE_RESULT" },
    }),
  ]);
  monitor.finish("completed");
  await provider.forceFlush();
  const spans = exporter.getFinishedSpans();
  expect(new Set(spans.map((s) => s.spanContext().traceId)).size).toBe(1);
  const turn = spans.find((s) => s.name === "model.turn");
  const generation = spans.find((s) => s.name === "model.generation");
  expect(generation?.parentSpanContext?.spanId).toBe(turn?.spanContext().spanId);
  expect(spans.find((s) => s.name === "tool.read_file")?.parentSpanContext?.spanId).toBe(
    turn?.spanContext().spanId,
  );
  expect(generation?.attributes["paw.thinking_chars"]).toBe(50_000);
  expect(spans.filter((s) => s.name === "provider.request")).toHaveLength(2);
  expect(spans.filter((s) => s.name === "model.first_thinking")).toHaveLength(1);
  expect(spans.length).toBeLessThan(25);
  expect(
    JSON.stringify(
      spans.map((s) => ({
        name: s.name,
        attrs: s.attributes,
        events: s.events,
      })),
    ),
  ).not.toMatch(/PRIVATE|private-session|child-run/);
});

test("active observations are bounded and cancelled calls close without fabricating usage", () => {
  const { monitor, exporter } = fixture();
  const opened = Array.from({ length: 200 }, () => monitor.start({ model: "glm-5.3-flash" }));
  expect(opened.filter(Boolean)).toHaveLength(128);
  opened[0]?.end("cancelled");
  monitor.finish("cancelled");
  const generations = exporter.getFinishedSpans().filter((s) => s.name === "model.generation");
  expect(generations).toHaveLength(128);
  expect(generations.every((s) => s.attributes["gen_ai.usage.output_tokens"] === undefined)).toBe(
    true,
  );
  expect(
    exporter.getFinishedSpans().find((s) => s.name === "Paw desktop task")?.attributes[
      "paw.dropped_observations"
    ],
  ).toBe(72);
});

test("real desktop host associates provider observations with journal model turns", async () => {
  const { monitor, exporter, provider } = fixture();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paw-cloud-test-"));
  roots.push(root);
  const body = `data: ${JSON.stringify({ choices: [{ delta: { content: "Hello" } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`;
  globalThis.fetch = Object.assign(async () => new Response(body), {
    preconnect: originalFetch.preconnect,
  }) as typeof fetch;
  const result = await runDesktopNext("Say hello", {
    workspaceRoot: root,
    model: new OpenAICompatibleModel({
      apiKey: "SECRET",
      model: "cloud-test",
      capabilities: { contextWindow: 128_000, maxOutputTokens: 4096 },
    }),
    telemetry: monitor,
    taskMode: "standard",
    memoryEnabled: false,
    environmentAudit: false,
    maxSteps: 2,
    resolveToolApproval: async () => true,
    onEvent: () => {},
  });
  expect(result.ok).toBe(true);
  await provider.forceFlush();
  const spans = exporter.getFinishedSpans();
  const generation = spans.find((s) => s.name === "model.generation");
  expect(generation).toBeDefined();
  expect(
    spans.some(
      (s) =>
        s.name === "model.turn" && s.spanContext().spanId === generation?.parentSpanContext?.spanId,
    ),
  ).toBe(true);
}, 30_000);

test("Bun exports real OTLP HTTP batches with metadata and auth to a loopback test collector", async () => {
  const received: {
    authorization: string | null;
    version: string | null;
    body: string;
  }[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      received.push({
        authorization: request.headers.get("authorization"),
        version: request.headers.get("x-langfuse-ingestion-version"),
        body: await request.text(),
      });
      return Response.json({});
    },
  });
  // Deliberately bypass production HTTPS config validation for an offline collector fixture.
  const cloud = createCloudTelemetry({
    baseUrl: `http://127.0.0.1:${server.port}`,
    publicKey: "pk-test",
    secretKey: "sk-test",
    sampleRate: 1,
  });
  try {
    const monitor = cloud.start();
    const response = monitor.start({ model: "glm-5.3-flash" });
    response?.event({
      type: "request",
      streaming: true,
      maxOutputTokens: 128_000,
    });
    response?.end("completed");
    monitor.finish("completed");
    await cloud.flush();
    expect(received.length).toBeGreaterThan(0);
    expect(received[0]?.authorization).toBe(
      `Basic ${Buffer.from("pk-test:sk-test").toString("base64")}`,
    );
    expect(received[0]?.version).toBe("4");
    expect(received[0]?.body).toContain("resourceSpans");
    expect(received[0]?.body).not.toContain("sk-test");
  } finally {
    await cloud.shutdown();
    server.stop(true);
  }
}, 10_000);

test("a failing collector does not delay inference and flush has a bounded timeout", async () => {
  let requests = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch() {
      requests++;
      return new Response("unavailable", { status: 503 });
    },
  });
  const cloud = createCloudTelemetry({
    baseUrl: `http://127.0.0.1:${server.port}`,
    publicKey: "pk-test",
    secretKey: "sk-test",
    sampleRate: 1,
  });
  const monitor = cloud.start();
  try {
    const pending = monitor.start({ model: "test" });
    pending?.event({ type: "request", streaming: true });
    const exporting = cloud.flush().catch(() => {});
    globalThis.fetch = Object.assign(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
          }),
        ),
      { preconnect: originalFetch.preconnect },
    ) as typeof fetch;
    const started = performance.now();
    const result = await monitor.run(() =>
      new OpenAICompatibleModel({ model: "test", apiKey: "SECRET" }).complete([]),
    );
    expect(result.text).toBe("ok");
    expect(performance.now() - started).toBeLessThan(1_000);
    await exporting;
    expect(requests).toBeGreaterThan(0);
    expect(performance.now() - started).toBeLessThan(4_000);
  } finally {
    monitor.finish("completed");
    await cloud.shutdown().catch(() => {});
    server.stop(true);
  }
}, 10_000);

test("zero sampling does not create model observations or export spans", async () => {
  let requests = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch() {
      requests++;
      return Response.json({});
    },
  });
  const cloud = createCloudTelemetry({
    baseUrl: `http://127.0.0.1:${server.port}`,
    publicKey: "pk-test",
    secretKey: "sk-test",
    sampleRate: 0,
  });
  try {
    const monitor = cloud.start();
    expect(monitor.start({ model: "test" })).toBeUndefined();
    monitor.finish("completed");
    await cloud.flush();
    expect(requests).toBe(0);
  } finally {
    await cloud.shutdown();
    server.stop(true);
  }
});
