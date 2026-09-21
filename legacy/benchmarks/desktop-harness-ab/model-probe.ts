import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runDesktopNext } from "../../apps/desktop/agent-host/paw-next.js";
import {
  type LanguageModel,
  type ModelCompleteOptions,
  createDefaultLanguageModel,
} from "../../packages/models/src/index.js";
import {
  type ProbeVariant,
  applyProbeRequest,
  probeVariants,
} from "./model-probe-options.js";
import { tasks } from "./tasks.js";

const repo = path.resolve(import.meta.dir, "../../..");
const budget = {
  wallMs: 720000,
  calls: 40,
  reportedTokens: 160000,
  maxSteps: 32,
};
const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const read = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
const write = (file: string, value: unknown) =>
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
const sourceFiles = [
  "packages/paw-next/src/composition.ts",
  "packages/paw-next/src/child-permissions.ts",
  "apps/desktop/agent-host/paw-next.ts",
  "packages/models/src/openai-compatible.ts",
  "packages/collaboration/src/delegation.ts",
  "packages/collaboration/src/tool-plugin.ts",
  "packages/workspace/src/path-guard.ts",
  "legacy/benchmarks/desktop-harness-ab/tasks.ts",
  "legacy/benchmarks/desktop-harness-ab/verify.mjs",
  "legacy/benchmarks/desktop-harness-ab/model-probe.ts",
  "legacy/benchmarks/desktop-harness-ab/model-probe-options.ts",
];
const sourceHashes = () =>
  Object.fromEntries(
    sourceFiles.map((file) => [
      file,
      hash(fs.readFileSync(path.join(repo, file))),
    ]),
  );

if (process.argv[2] === "--worker") {
  const dir = path.resolve(process.argv[3]);
  const manifest = read(path.join(dir, "manifest.json"));
  const root: string = manifest.workspaceRoot;
  const variant = manifest.variant as ProbeVariant;
  const append = (file: string, value: unknown) =>
    fs.appendFileSync(path.join(dir, file), `${JSON.stringify(value)}\n`);
  const base = createDefaultLanguageModel(repo);
  if (
    base.runtimeProfile?.model !== "glm-5.3-flash" ||
    base.runtimeProfile.reasoningEffort !== "max"
  )
    throw new Error("Probe requires the unchanged GLM max baseline profile");
  const profile = {
    ...base.runtimeProfile,
    reasoningEffort: probeVariants[variant].effort,
  };
  write(path.join(dir, "model.json"), {
    label: base.label,
    runtimeProfile: profile,
    baselineProfile: base.runtimeProfile,
    budget,
    variant,
    override: probeVariants[variant],
  });
  const controller = new AbortController();
  const remaining = Math.max(
    1,
    budget.wallMs - (Date.now() - manifest.startedAt),
  );
  const timer = setTimeout(
    () => controller.abort(new Error("Benchmark wall budget exhausted")),
    remaining,
  );
  let calls = 0;
  let reportedTokens = 0;
  let firstProductWriteMs: number | null = null;
  const watchProduct = setInterval(() => {
    if (firstProductWriteMs !== null) return;
    if (
      ["src/queue.js", "src/store.js", "src/cli.js"].some((file) =>
        fs.existsSync(path.join(root, file)),
      )
    ) {
      firstProductWriteMs = Date.now() - manifest.startedAt;
      append("events.jsonl", {
        type: "probe.first_product_file",
        at: Date.now(),
        firstProductWriteMs,
      });
    }
  }, 250);
  const nativeFetch = globalThis.fetch;
  const endpoint = `${base.runtimeProfile.baseUrl.replace(/\/$/, "")}/chat/completions`;
  let wireId = 0;
  // Intercept only this worker's model endpoint. Never log headers, credentials or messages.
  globalThis.fetch = (async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (url !== endpoint) return nativeFetch(input, init);
    if (typeof init?.body !== "string")
      throw new Error("Unexpected model request body");
    const original = JSON.parse(init.body);
    const body = applyProbeRequest(original, variant);
    append("wire.jsonl", {
      id: ++wireId,
      at: Date.now(),
      originalMaxTokens: original.max_tokens,
      maxTokens: body.max_tokens,
      originalEffort: original.reasoning_effort,
      effort: body.reasoning_effort,
      stream: body.stream,
      thinking: body.thinking,
      toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
    });
    return nativeFetch(input, { ...init, body: JSON.stringify(body) });
  }) as typeof fetch;
  const prepare = (options?: ModelCompleteOptions) => {
    controller.signal.throwIfAborted();
    if (calls >= budget.calls || reportedTokens >= budget.reportedTokens) {
      controller.abort(new Error("Benchmark call/token threshold reached"));
      controller.signal.throwIfAborted();
    }
    const id = ++calls;
    append("calls.jsonl", {
      type: "start",
      id,
      at: Date.now(),
      requestedMaxOutputTokens: options?.maxOutputTokens,
    });
    return {
      id,
      opts: {
        ...options,
        signal: options?.signal
          ? AbortSignal.any([options.signal, controller.signal])
          : controller.signal,
      },
    };
  };
  const finish = (
    id: number,
    result: { usage?: any; finishReason?: string },
  ) => {
    if (result.usage) {
      const usage = result.usage;
      reportedTokens +=
        usage.totalTokens ??
        (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0);
      append("calls.jsonl", { type: "usage", id, at: Date.now(), usage });
    }
    append("calls.jsonl", {
      type: "finish",
      id,
      at: Date.now(),
      reason: result.finishReason,
    });
  };
  const model: LanguageModel = {
    label: base.label,
    capabilities: base.capabilities,
    runtimeProfile: profile,
    async complete(messages, options) {
      const { id, opts } = prepare(options);
      try {
        const result = await base.complete(messages, opts);
        finish(id, result);
        return result;
      } catch (error) {
        append("calls.jsonl", {
          type: "error",
          id,
          at: Date.now(),
          error: String(error).slice(0, 400),
        });
        throw error;
      }
    },
    ...(base.completeStream
      ? {
          async *completeStream(
            messages: Parameters<LanguageModel["complete"]>[0],
            options?: ModelCompleteOptions,
          ) {
            const { id, opts } = prepare(options);
            const counts = { thinkingChars: 0, textChars: 0, toolCalls: 0 };
            try {
              for await (const chunk of base.completeStream!(messages, opts)) {
                if (chunk.type === "thinking")
                  counts.thinkingChars += chunk.delta.length;
                if (chunk.type === "text")
                  counts.textChars += chunk.delta.length;
                if (chunk.type === "tool_use") counts.toolCalls++;
                if (chunk.type === "done") finish(id, chunk);
                yield chunk;
              }
            } catch (error) {
              append("calls.jsonl", {
                type: "error",
                id,
                at: Date.now(),
                error: String(error).slice(0, 400),
              });
              throw error;
            } finally {
              append("calls.jsonl", {
                type: "output_counts",
                id,
                at: Date.now(),
                ...counts,
              });
            }
          },
        }
      : {}),
  };
  try {
    const result = await runDesktopNext(tasks.queue.goal, {
      workspaceRoot: root,
      conversationId: "benchmark",
      taskMode: "standard",
      intent: "continue",
      model,
      settings: {},
      memoryEnabled: false,
      maxSteps: budget.maxSteps,
      abortSignal: controller.signal,
      resolveToolApproval: async () => true,
      onEvent(envelope) {
        const event: any = envelope.event;
        const e = event.originalEvent ?? event;
        if (
          ["tool.call", "tool.result", "run.completed", "run.failed"].includes(
            e.type,
          )
        )
          append("events.jsonl", {
            at: Date.now(),
            type: e.type,
            tool: e.tool,
            ok: e.ok,
            summary: e.summary,
            callId: e.callId,
            committedChanges: e.fileChanges ?? [],
          });
      },
    });
    write(path.join(dir, "result.json"), {
      ...result,
      finishedAt: Date.now(),
      firstProductWriteMs,
    });
  } catch (error) {
    write(path.join(dir, "result.json"), {
      error: String(error),
      finishedAt: Date.now(),
      firstProductWriteMs,
    });
  } finally {
    clearTimeout(timer);
    clearInterval(watchProduct);
    globalThis.fetch = nativeFetch;
  }
  process.exit(0);
}

const output = path.resolve(
  process.argv[2] ??
    path.join(
      import.meta.dir,
      ".runs",
      `model-probe-${new Date().toISOString().replace(/[:.]/g, "-")}`,
    ),
);
if (fs.existsSync(output))
  throw new Error(
    "Use a fresh experiment directory; do not overwrite previous evidence",
  );
fs.mkdirSync(output, { recursive: true });
const frozen = sourceHashes();
write(path.join(output, "protocol.json"), {
  version: "model-probe-1",
  createdAt: new Date().toISOString(),
  budget,
  variants: probeVariants,
  kind: "queue",
  mode: "standard",
  replicates: 1,
  goalHash: hash(tasks.queue.goal),
  sourceHashes: frozen,
  notes: [
    "Sequential max-native, high-native, max-32768; one sample per condition, order is not randomized",
    "Same desktop host, task, tools, initial files and final verifier; no Manager changes",
    "Experimental worker-only wire overrides; local settings unchanged; auxiliary caps below 8192 preserved",
    "Output floor applies to ordinary and recovery requests >=8192; context planner reservation remains native, so this is not a production configuration recommendation",
    "All calls share wall/call/reported-token limits; missing usage is not zero cost",
    "External grading and own tests run independently after cases settle; no recovery injection",
  ],
});
const summaries: any[] = [];
for (const variant of Object.keys(probeVariants) as ProbeVariant[]) {
  if (JSON.stringify(sourceHashes()) !== JSON.stringify(frozen))
    throw new Error("Frozen source changed during experiment");
  const name = `queue-${variant}`;
  const dir = path.join(output, name);
  fs.mkdirSync(dir);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paw-model-probe-"));
  fs.writeFileSync(path.join(root, "REQUIREMENTS.md"), tasks.queue.goal);
  fs.writeFileSync(path.join(root, ".gitignore"), ".paw/\n");
  for (const args of [
    ["init", "-q"],
    ["add", "."],
    [
      "-c",
      "user.name=Paw Benchmark",
      "-c",
      "user.email=benchmark@localhost",
      "commit",
      "-q",
      "-m",
      "test: seed isolated benchmark workspace",
    ],
  ]) {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
  }
  const gitRoot = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: root,
    encoding: "utf8",
  });
  if (
    gitRoot.status !== 0 ||
    fs.realpathSync(gitRoot.stdout.trim()).toLowerCase() !==
      fs.realpathSync(root).toLowerCase()
  )
    throw new Error("Expected isolated Git root");
  const startedAt = Date.now();
  write(path.join(dir, "manifest.json"), {
    name,
    variant,
    kind: "queue",
    mode: "standard",
    workspaceRoot: root,
    startedAt,
    goalHash: hash(tasks.queue.goal),
    budget,
  });
  console.log(
    JSON.stringify({
      event: "case.start",
      name,
      at: new Date().toISOString(),
      output,
    }),
  );
  const stdout = fs.openSync(path.join(dir, "worker.stdout.log"), "a");
  const stderr = fs.openSync(path.join(dir, "worker.stderr.log"), "a");
  const proc = Bun.spawn(
    [process.execPath, import.meta.filename, "--worker", dir],
    { cwd: repo, stdout, stderr },
  );
  const timeout = setTimeout(() => proc.kill(), budget.wallMs + 10000);
  const code = await proc.exited;
  clearTimeout(timeout);
  fs.closeSync(stdout);
  fs.closeSync(stderr);
  const result = fs.existsSync(path.join(dir, "result.json"))
    ? read(path.join(dir, "result.json"))
    : { error: `worker exit ${code}` };
  const callsFile = path.join(dir, "calls.jsonl");
  const records = fs.existsSync(callsFile)
    ? fs
        .readFileSync(callsFile, "utf8")
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
  const usages = records.filter((row) => row.type === "usage");
  const sum = (key: string) =>
    usages.reduce((n, row) => n + (row.usage[key] ?? 0), 0);
  let parsed: any;
  try {
    parsed = JSON.parse(result.text);
  } catch {}
  const summary = {
    name,
    kind: "queue",
    mode: "standard",
    variant,
    seconds: (Date.now() - startedAt) / 1000,
    calls: records.filter((row) => row.type === "start").length,
    usageReports: usages.length,
    promptTokens: sum("promptTokens"),
    completionTokens: sum("completionTokens"),
    totalTokens:
      sum("totalTokens") || sum("promptTokens") + sum("completionTokens"),
    cachedPromptTokens: sum("cachedPromptTokens"),
    truncatedResponses: records.filter(
      (row) => row.type === "finish" && row.reason === "length",
    ).length,
    firstProductWriteMs: result.firstProductWriteMs ?? null,
    runtimeStatus: parsed?.status,
    acceptance: parsed?.acceptance,
    error: result.error,
    verificationMeasured: false,
    passed: null,
    total: null,
    goalUnchanged:
      hash(fs.readFileSync(path.join(root, "REQUIREMENTS.md"))) ===
      hash(tasks.queue.goal),
  };
  write(path.join(dir, "summary.json"), summary);
  summaries.push(summary);
  write(path.join(output, "summary.json"), summaries);
  console.log(JSON.stringify({ event: "case.done", ...summary }));
}
const unchanged = JSON.stringify(sourceHashes()) === JSON.stringify(frozen);
write(path.join(output, "integrity.json"), {
  unchanged,
  checkedAt: new Date().toISOString(),
  sourceHashes: sourceHashes(),
});
if (!unchanged) throw new Error("Frozen source changed during experiment");
console.log(JSON.stringify({ event: "probe.done", output }));
