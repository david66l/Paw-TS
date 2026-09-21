import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runDesktopNext } from "../../apps/desktop/agent-host/paw-next.js";
import {
  type LanguageModel,
  type ModelCompleteOptions,
  type ModelCompletionResult,
  createDefaultLanguageModel,
  createDeepSeekFlashModel,
  withModelObserver,
} from "../../packages/models/src/index.js";
import { applyProbeRequest } from "./model-probe-options.js";
import { PAW_NEXT_PRODUCT_COMPOSITION_VERSION_V3 } from "../../../packages/paw-next/src/product-manifest-v3.js";
import { ENVIRONMENT_AUDIT_MAX_TURNS, ENVIRONMENT_AUDIT_SINGLE_PASS_TIMEOUT_MS } from "../../../packages/paw-next/src/environment-audit.js";

import { queueCoreStageGoal } from "./queue-core-stage.js";
import { tasks } from "./tasks.js";
import { workflowGoal, workflowBudget, workflowImage } from "./workflow-task.js";
import { benchmarkSandbox, verifyDockerIsolation } from "./docker-preflight.js";
import {
  createThinkingRecoveryModel,
  THINKING_RECOVERY_POLICY,
} from "../../packages/models/src/thinking-recovery.js";

// The queue variant preserves the original task and model-probe budget.
const workflow = process.argv[3] === "--workflow";
const queue = process.argv[3] === "--queue";
const coreStage = process.argv[3] === "--queue-core";
if (process.argv[3] && !queue && !workflow && !coreStage && process.argv[3] !== "--minimal")
  throw new Error("Unknown probe task option");
const projectTask = queue || coreStage || workflow;
const thinkingRecovery = process.argv.includes("--thinking-recovery");
const journalRecovery = process.argv.includes("--journal-recovery");
if (thinkingRecovery && journalRecovery)
  throw new Error("Choose one recovery policy per experiment");
const deepseekFlash = process.argv.includes("--deepseek-flash");
const highEffort = process.argv.includes("--high");
const configuredProfile = process.argv.includes("--configured-profile");
const explicitEnvironmentAudit = process.argv.includes("--environment-audit");
const desktopChainBudget = process.argv.includes("--desktop-chain-budget");
if (desktopChainBudget && !explicitEnvironmentAudit)
  throw new Error("--desktop-chain-budget requires --environment-audit");
const memoryEnabled = process.argv.includes("--memory");
const backgroundMemory = process.argv.includes("--background-memory");
if (backgroundMemory && !memoryEnabled)
  throw new Error("--background-memory requires --memory");
if (memoryEnabled && !process.env.DATABASE_URL)
  throw new Error("--memory requires a configured DATABASE_URL");
const recoverFlags = process.argv.filter((flag) =>
  flag.startsWith("--recover-from="),
);
if (recoverFlags.length > 1 || (recoverFlags.length && !queue))
  throw new Error("Recovery requires one prior queue probe");
const recoverFrom = recoverFlags[0]?.slice("--recover-from=".length);
const seedFlags = process.argv.filter(flag => flag.startsWith("--seed-from="));
if (seedFlags.length > 1 || (seedFlags.length && (!workflow || recoverFrom)))
  throw new Error("Artifact continuation requires one workflow seed and cannot recover a journal");
const seedFrom = seedFlags[0]?.slice("--seed-from=".length);
if (seedFlags.length && !seedFrom) throw new Error("Empty artifact seed");
if (configuredProfile && highEffort)
  throw new Error("Choose the configured profile or the high wire override");
if (deepseekFlash && highEffort)
  throw new Error("--high is a GLM-only comparison");
const wallAndCallBudget = process.argv.includes("--wall-and-call-budget");
const docker = process.argv.includes("--docker");
if (!docker)
  throw new Error(
    "Automatic tool approval requires --docker; host execution is disabled for this probe",
  );
const singleAgent =
  thinkingRecovery ||
  journalRecovery ||
  process.argv.includes("--single-agent");
for (const flag of process.argv.slice(4))
  if (
    flag !== "--thinking-recovery" &&
    flag !== "--journal-recovery" &&
    flag !== "--single-agent" &&
    flag !== "--deepseek-flash" &&
    flag !== "--wall-and-call-budget" &&
    flag !== "--docker" &&
    flag !== "--high" &&
    flag !== "--configured-profile" &&
    flag !== "--environment-audit" &&
    flag !== "--desktop-chain-budget" &&
    flag !== "--memory" &&
    flag !== "--background-memory" &&
    !flag.startsWith("--recover-from=") &&
    !flag.startsWith("--seed-from=")
  )
    throw new Error(`Unknown flag: ${flag}`);
const recoveryPolicy = { noActionMs: 90000, maxRecoveries: 2 };
const repo = path.resolve(import.meta.dir, "../../..");
process.env.PAW_TELEMETRY_ENABLED = "0";
const output = path.resolve(
  process.argv[2] ??
    path.join(
      import.meta.dir,
      ".runs",
      `tool-wire-${new Date().toISOString().replace(/[:.]/g, "-")}`,
    ),
);
if (fs.existsSync(output)) throw new Error("Use a fresh output directory");
const base = deepseekFlash
  ? createDeepSeekFlashModel(repo)
  : createDefaultLanguageModel(repo);
if (
  !base ||
  base.runtimeProfile?.model !==
    (deepseekFlash ? "deepseek-v4-flash" : "glm-5.3-flash") ||
  (configuredProfile
    ? !["high", "max"].includes(base.runtimeProfile.reasoningEffort ?? "")
    : base.runtimeProfile.reasoningEffort !== "max") ||
  !base.completeStream
)
  throw new Error(
    `Configure the requested streaming ${deepseekFlash ? "DeepSeek V4 Flash" : "GLM-5.3-Flash"} ${configuredProfile ? "high/max" : "max"} preset before this probe`,
  );
fs.mkdirSync(output, { recursive: true });
const effectiveProfile = configuredProfile
  ? base.runtimeProfile
  : {
      ...base.runtimeProfile,
      reasoningEffort: highEffort ? ("high" as const) : ("max" as const),
    };
const environmentAudit =
  explicitEnvironmentAudit || (projectTask && !singleAgent);
const isolation = await verifyDockerIsolation(workflow ? workflowImage : undefined);
const sandboxSettings = { ...benchmarkSandbox, image: isolation.imageId };
fs.writeFileSync(
  path.join(output, "isolation.json"),
  JSON.stringify(isolation, null, 2),
);
const priorRun = recoverFrom ? path.resolve(recoverFrom) : undefined;
const prior = priorRun
  ? JSON.parse(fs.readFileSync(path.join(priorRun, "protocol.json"), "utf8"))
  : undefined;
if (prior && Boolean(prior.memory) !== memoryEnabled)
  throw new Error("Recovery memory profile changed");
if (prior && Boolean(prior.backgroundMemory) !== backgroundMemory)
  throw new Error("Recovery memory delivery mode changed");
if (
  prior &&
  (!fs.existsSync(path.join(priorRun!, "result.json")) ||
    prior.taskVariant !== "queue" ||
    !prior.isolation?.ok ||
    prior.isolation.imageId !== isolation.imageId ||
    JSON.stringify(prior.runtimeProfile) !== JSON.stringify(effectiveProfile))
)
  throw new Error(
    "Recovery requires a settled queue probe with matching model and isolation",
  );
const root = prior
  ? fs.realpathSync(prior.workspaceRoot)
  : fs.mkdtempSync(path.join(os.tmpdir(), "paw-tool-wire-"));
if (
  prior &&
  (path.dirname(root).toLowerCase() !==
    fs.realpathSync(os.tmpdir()).toLowerCase() ||
    !path.basename(root).startsWith("paw-tool-wire-"))
)
  throw new Error(
    "Recovery workspace must remain inside the benchmark temporary directory",
  );
if (prior) {
  const existing = JSON.parse(
    fs.readFileSync(path.join(root, ".paw", "settings.local.json"), "utf8"),
  );
  if (JSON.stringify(existing) !== JSON.stringify({ sandbox: sandboxSettings }))
    throw new Error("Recovery sandbox settings changed");
} else {
  fs.mkdirSync(path.join(root, ".paw"));
  fs.writeFileSync(
    path.join(root, ".paw", "settings.local.json"),
    JSON.stringify({ sandbox: sandboxSettings }),
  );
}
const originalGoal = workflow ? workflowGoal : coreStage
  ? queueCoreStageGoal
  : queue
    ? tasks.queue.goal
    : "Create probe.txt in this workspace with exactly PAW_TOOL_PROBE_OK followed by one newline. Use a file-writing tool to create the file, then read it back to verify the exact content. Do not create any other files. No planning document, tests or delegation are needed for this single-file task. Finish with a brief confirmation.";
const goal = `${originalGoal}\nExecution environment: file tools use workspace-relative paths. Shell commands run in a Linux container at /workspace with sh, Node.js 24 and npm, no network, a writable workspace and ephemeral /tmp. Use POSIX shell syntax and relative project paths. Only the workspace is mounted. The container root is read-only. Do not change .paw/settings.local.json.`;
if (prior && prior.goal !== goal) throw new Error("Recovery goal changed");
let seedArtifactHashes: Record<string, string> | undefined;
if (seedFrom) {
  const seedRun = fs.realpathSync(path.resolve(seedFrom));
  const seed = JSON.parse(fs.readFileSync(path.join(seedRun, "protocol.json"), "utf8"));
  if (!fs.existsSync(path.join(seedRun, "result.json")) || seed.taskVariant !== "workflow" ||
      seed.goal !== goal || seed.isolation?.imageId !== isolation.imageId ||
      JSON.stringify(seed.runtimeProfile) !== JSON.stringify(effectiveProfile) ||
      seed.memory !== memoryEnabled || seed.environmentAudit !== environmentAudit || seed.singleAgent !== singleAgent)
    throw new Error("Artifact seed requires a settled matching workflow run");
  const grade = JSON.parse(fs.readFileSync(path.join(seedRun, "threeway-grade.json"), "utf8"));
  const archive = fs.realpathSync(path.join(seedRun, "delivery"));
  seedArtifactHashes = grade.artifactHashes;
  if (!seedArtifactHashes || !Object.keys(seedArtifactHashes).length) throw new Error("Missing seed artifact hashes");
  for (const [name, hash] of Object.entries(seedArtifactHashes)) {
    if (path.isAbsolute(name) || name.split(/[\\/]/u).some(part => !part || part.startsWith(".")))
      throw new Error("Invalid seed artifact path");
    const source = fs.realpathSync(path.join(archive, name));
    const relative = path.relative(archive, source);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Seed artifact escapes archive");
    const bytes = fs.readFileSync(source);
    if (createHash("sha256").update(bytes).digest("hex") !== hash) throw new Error("Seed artifact hash mismatch");
    const destination = path.join(root, name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, bytes);
  }
  if (fs.readFileSync(path.join(root, "REQUIREMENTS.md"), "utf8") !== goal)
    throw new Error("Seed requirements changed");
}
if (!prior) {
  fs.writeFileSync(path.join(root, "REQUIREMENTS.md"), goal);
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
      "test: seed isolated tool probe",
    ],
  ]) {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
  }
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
const write = (file: string, value: unknown) =>
  fs.writeFileSync(path.join(output, file), JSON.stringify(value, null, 2));
const append = (file: string, value: unknown) =>
  fs.appendFileSync(path.join(output, file), `${JSON.stringify(value)}\n`);
const baseBudget = workflow ? workflowBudget : coreStage
  ? { wallMs: 180000, calls: 12, reportedTokens: 80000, maxSteps: 12 }
  : queue
    ? { wallMs: 720000, calls: 40, reportedTokens: 160000, maxSteps: 32 }
    : { wallMs: 180000, calls: 8, reportedTokens: 60000, maxSteps: 4 };
// Legacy probe caps predate the full desktop chain. Make the additional audit
// allowance explicit; preserve failed legacy-budget samples and root turn limits.
const budget = desktopChainBudget ? {
  ...baseBudget,
  wallMs: baseBudget.wallMs + ENVIRONMENT_AUDIT_SINGLE_PASS_TIMEOUT_MS + (memoryEnabled && !backgroundMemory ? 30_000 : 0),
  calls: baseBudget.calls + ENVIRONMENT_AUDIT_MAX_TURNS + (memoryEnabled ? 1 : 0),
} : baseBudget;
const tokenThresholdEnforced = !wallAndCallBudget;
const startedAt = Date.now();
write("protocol.json", {
  startedAt,
  workspaceRoot: root,
  goal,
  budget,
  tokenThresholdEnforced,
  isolation,
  runtimeProfile: effectiveProfile,
  baselineRuntimeProfile: base.runtimeProfile,
  compositionVersion: PAW_NEXT_PRODUCT_COMPOSITION_VERSION_V3,
  reasoningOverride: highEffort ? "high-native" : null,
  capabilities: base.capabilities,
  taskMode: "standard",
  environmentAudit,
  configuredProfile,
  recoveryFrom: priorRun ?? null,
  ...(seedFrom ? { seedFrom: path.resolve(seedFrom), seedArtifactHashes,
    seedSemantics: "Fresh desktop conversation on a hash-verified copy of prior delivered files. No journal recovery or operator repair. Additional budget; exclude from fresh-task comparisons." } : {}),
  singleAgent,
  journalReasoningRecovery: journalRecovery
    ? {
        maxPerRun: 1,
        policy:
          "paw.product-composition.v3.23:journal-reasoning-recovery-opt-in",
      }
    : null,
  thinkingRecovery: thinkingRecovery
    ? { policyVersion: THINKING_RECOVERY_POLICY, ...recoveryPolicy }
    : null,
  taskVariant: workflow ? "workflow" : coreStage ? "queue-core-stage" : queue ? "queue" : "minimal",
  memory: memoryEnabled,
  backgroundMemory,
  desktopChainBudget,
  toolChoiceOverride: false,
  notes: [
    ...(wallAndCallBudget
      ? [
          "Diagnostic budget ablation: cumulative reported-token cutoff disabled; wall/call/step limits remain. Token usage including cache hits is still recorded. This is not a matched efficiency score.",
        ]
      : []),
    ...(singleAgent
      ? [
          `Single-agent experiment: delegation removed from requests and rejected in responses; environment audit ${environmentAudit ? "enabled" : "disabled"}. Completion review retained. Compare against matching controls.`,
        ]
      : []),
    workflow
      ? "Workflow comparison: 20 minutes / 64 physical requests / 48 root steps; same task for three native runtimes"
      : coreStage
      ? "Only the first queue milestone, explicit remaining milestones excluded; not full-task completion or a system-prompt-only ablation"
      : queue
        ? `Original queue task and 12-minute budget; environment audit ${environmentAudit ? "enabled" : "disabled"}`
        : "Minimal file-write/read task; environment audit disabled",
    "Langfuse explicitly disabled for this diagnostic run",
    highEffort
      ? "Benchmark-only high-native wire override; bounded auxiliary requests unchanged; local settings unchanged"
      : "No model parameter overrides; output follows the selected model capability",
    "Raw SSE bytes are copied before Paw parsing; request JSON excludes HTTP headers and credentials",
    "Chunk times are local receipt times, not server generation timestamps",
    "The model wrapper records parsed tools before runtime output recovery and execution",
    "Token threshold checked between calls; missing usage is not zero cost; isolated workspace retained",
  ],
  sourceHashes: Object.fromEntries(
    [
      "packages/models/src/openai-compatible.ts",
      "packages/models/src/auxiliary-model.ts",
      "packages/models/src/agent-loop-adapter.ts",
      "packages/models/src/request-supervision.ts",
      "packages/core/src/workspace-effect.ts",
      "packages/core/src/token-estimator.ts",
      "packages/core/src/token-count-cache.ts",
      "packages/runtime/src/session/file-run-session.ts",
      "packages/runtime/src/session/session-execution-lease.ts",
      "packages/runtime/src/payload/file-durable-json-payload-store.ts",
      "packages/harness/src/workspace-revision.ts",
      "packages/harness/src/registry/execution.ts",
      "packages/harness/src/registry/definitions.ts",
      "packages/output-recall/src/index.ts",
      "packages/output-recall/src/mutation-receipt.ts",
      "packages/task-progress/src/plugin.ts",
      "apps/desktop/agent-host/project-context.ts",
      "apps/desktop/agent-host/paw-next-events.ts",
      "packages/agent-loop/src/work-segment.ts",
      "packages/agent-loop/src/interactive-control.ts",
      "packages/runtime/src/inbox/start-work-segment.ts",
      "packages/paw-next/src/product-manifest-v3.ts",
      "packages/paw-next/src/product-profile-v3.ts",
      "packages/agent-loop/src/agent-loop.ts",
      "packages/core/src/model-request.ts",
      "apps/desktop/agent-host/paw-next.ts",
      "packages/paw-next/src/composition.ts",
      "packages/paw-next/src/execution-budget.ts",
      "packages/paw-next/src/delivery-ledger.ts",
      "packages/paw-next/src/index.ts",
      "packages/runtime/src/tools/agent-loop-tool-executor.ts",
      "packages/protocol/src/run-journal.ts",
      "packages/paw-next/src/environment-audit.ts",
      "packages/paw-next/src/audit-evidence.ts",
      "packages/models/src/thinking-recovery.ts",
      "packages/models/src/openai-stream-parse.ts",
      "packages/model-output-recovery/src/index.ts",
      "apps/desktop/agent-host/paw-next-profile.ts",
      "apps/desktop/agent-host/agent-system-prompt.ts",
      "legacy/benchmarks/desktop-harness-ab/tool-wire-probe.ts",
      "legacy/benchmarks/desktop-harness-ab/docker-preflight.ts",
      "legacy/benchmarks/desktop-harness-ab/single-agent-report.py",
      "packages/progress-advisor/src/projector.ts",
      "packages/harness/src/sandbox/docker-runner.ts",
      "packages/harness/src/shell/execute.ts",
      "legacy/benchmarks/desktop-harness-ab/tasks.ts",
      "legacy/benchmarks/desktop-harness-ab/workflow-task.ts",
      "legacy/benchmarks/desktop-harness-ab/verify-workflow.mjs",
      "legacy/benchmarks/desktop-harness-ab/workflow-storage-adjudication.mjs",
      "legacy/benchmarks/desktop-harness-ab/workflow-isolation-adjudication.mjs",
      "legacy/benchmarks/desktop-harness-ab/threeway-grade.py",
      "legacy/benchmarks/desktop-harness-ab/threeway-adjudicate.py",
      "legacy/benchmarks/desktop-harness-ab/queue-core-stage.ts",
      "legacy/benchmarks/desktop-harness-ab/verify.mjs",
      "legacy/benchmarks/desktop-harness-ab/verify-queue-core.mjs",
      "packages/completion-review/src/evidence-packet.ts",
      "packages/completion-review/src/evidence-projector.ts",
      "packages/completion-review/src/reviewer.ts",
      "packages/completion-review/src/controller.ts",
      "packages/completion-review/src/continuation.ts",
      "packages/workspace/src/files/read.ts",
      "legacy/benchmarks/desktop-harness-ab/model-probe-options.ts",
      "packages/paw-next/src/request-guidance.ts",
      "packages/paw-next/src/working-state.ts",
      "packages/runtime/src/context/journal-context.ts",
      "packages/runtime/src/context/journal-context-annotations.ts",
      "packages/core/src/operation-deadline.ts",
      "packages/memory-plugin/src/memory-maintenance.ts",
      "packages/memory-plugin/src/memory-context.ts",
      "packages/memory-plugin/src/retrieval-input-port.ts",
      "packages/memory-plugin/src/memory-writer.ts",
      "packages/memory-plugin/src/topic-organizer.ts",
    ].map((file) => [
      file,
      createHash("sha256")
        .update(fs.readFileSync(path.join(repo, file)))
        .digest("hex"),
    ]),
  ),
});
const frozenProtocol = JSON.parse(
  fs.readFileSync(path.join(output, "protocol.json"), "utf8"),
);
for (const [relative, hash] of Object.entries(frozenProtocol.sourceHashes)) {
  const contents = fs.readFileSync(path.join(repo, relative));
  if (createHash("sha256").update(contents).digest("hex") !== hash)
    throw new Error(`Source changed while freezing experiment: ${relative}`);
  const target = path.join(output, "source-snapshot", relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}
console.log(
  JSON.stringify({ event: "probe.start", output, workspaceRoot: root }),
);
const controller = new AbortController();
const timer = setTimeout(
  () => controller.abort(new Error("Tool probe wall budget exhausted")),
  budget.wallMs,
);
const hardTimer = setTimeout(() => process.exit(124), budget.wallMs + 15000);
const nativeFetch = globalThis.fetch;
const endpoint = `${base.runtimeProfile.baseUrl.replace(/\/$/, "")}/chat/completions`;
const fds = new Set<number>();
let physical = 0;
let calls = 0;
let tokens = 0;
let activeCall = 0;
const close = (fd: number) => {
  if (fds.delete(fd)) fs.closeSync(fd);
};
globalThis.fetch = Object.assign(
  async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (url !== endpoint) return nativeFetch(input, init);
    if (typeof init?.body !== "string")
      throw new Error("Unexpected model request body");
    const id = ++physical;
    const callId = activeCall;
    const originalRequest = JSON.parse(init.body);
    const request = highEffort
      ? applyProbeRequest(originalRequest, "high-native")
      : originalRequest;
    write(`request-${id}.json`, request);
    append("wire.jsonl", {
      type: "request",
      id,
      callId,
      at: Date.now(),
      maxTokens: request.max_tokens,
      effort: request.reasoning_effort,
      toolChoice: request.tool_choice ?? "omitted",
      toolCount: request.tools?.length ?? 0,
    });
    const response = await nativeFetch(
      input,
      highEffort ? { ...init, body: JSON.stringify(request) } : init,
    );
    append("wire.jsonl", {
      type: "headers",
      id,
      callId,
      at: Date.now(),
      status: response.status,
    });
    if (!response.body) return response;
    const fd = fs.openSync(path.join(output, `response-${id}.sse`), "wx");
    fds.add(fd);
    const body = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, destination) {
          fs.writeSync(fd, chunk);
          append("wire.jsonl", {
            type: "chunk",
            id,
            callId,
            at: Date.now(),
            bytes: chunk.byteLength,
          });
          destination.enqueue(chunk);
        },
        flush() {
          close(fd);
          append("wire.jsonl", { type: "end", id, callId, at: Date.now() });
        },
      }),
    );
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  },
  { preconnect: nativeFetch.preconnect },
) as typeof fetch;

const prepare = (options?: ModelCompleteOptions) => {
  controller.signal.throwIfAborted();
  if (
    calls >= budget.calls ||
    (tokenThresholdEnforced && tokens >= budget.reportedTokens)
  ) {
    controller.abort(new Error("Tool probe call/token threshold reached"));
    controller.signal.throwIfAborted();
  }
  activeCall = ++calls;
  append("parsed.jsonl", { type: "start", id: activeCall, at: Date.now() });
  return {
    id: activeCall,
    opts: {
      ...options,
      ...(singleAgent && options?.tools
        ? {
            tools: options.tools.filter(
              (tool) => tool.function.name !== "workspace_delegate",
            ),
          }
        : {}),
      signal: options?.signal
        ? AbortSignal.any([options.signal, controller.signal])
        : controller.signal,
    },
  };
};
const finish = (
  id: number,
  result: Pick<ModelCompletionResult, "usage" | "finishReason">,
) => {
  if (result.usage)
    tokens +=
      result.usage.totalTokens ??
      (result.usage.promptTokens ?? 0) + (result.usage.completionTokens ?? 0);
  append("parsed.jsonl", {
    type: "finish",
    id,
    at: Date.now(),
    usage: result.usage,
    finishReason: result.finishReason,
  });
};
const stream = base.completeStream.bind(base);
const model: LanguageModel = {
  label: base.label,
  capabilities: base.capabilities,
  runtimeProfile: effectiveProfile,
  async complete(messages, options) {
    const { id, opts } = prepare(options);
    const result = await base.complete(messages, opts);
    if (
      singleAgent &&
      result.toolCalls?.some((tool) => tool.name === "workspace_delegate")
    )
      throw new Error("Delegation is disabled for the single-agent experiment");
    for (const tool of result.toolCalls ?? [])
      append("parsed.jsonl", { type: "tool", id, at: Date.now(), ...tool });
    finish(id, result);
    return result;
  },
  async *completeStream(messages, options) {
    const { id, opts } = prepare(options);
    const counts = { thinkingChars: 0, textChars: 0, toolCalls: 0 };
    const first = new Set<string>();
    try {
      for await (const chunk of stream(messages, opts)) {
        if (!first.has(chunk.type)) {
          first.add(chunk.type);
          append("parsed.jsonl", {
            type: "first",
            kind: chunk.type,
            id,
            at: Date.now(),
          });
        }
        if (chunk.type === "thinking")
          counts.thinkingChars += chunk.delta.length;
        if (chunk.type === "text") counts.textChars += chunk.delta.length;
        if (chunk.type === "tool_use") {
          if (singleAgent && chunk.name === "workspace_delegate")
            throw new Error(
              "Delegation is disabled for the single-agent experiment",
            );
          counts.toolCalls++;
          append("parsed.jsonl", {
            type: "tool",
            id,
            at: Date.now(),
            toolId: chunk.id,
            name: chunk.name,
            input: chunk.input,
            sourceIndex: chunk.sourceIndex,
          });
        }
        if (chunk.type === "done") finish(id, chunk);
        yield chunk;
      }
    } catch (error) {
      append("parsed.jsonl", {
        type: "error",
        id,
        at: Date.now(),
        error: String(error),
      });
      throw error;
    } finally {
      append("parsed.jsonl", { type: "counts", id, at: Date.now(), ...counts });
    }
  },
};
const executionModel = thinkingRecovery
  ? createThinkingRecoveryModel(model, {
      ...recoveryPolicy,
      onEvent(event) {
        append("recovery.jsonl", { ...event, at: Date.now() });
        console.log(JSON.stringify({ event: "thinking.recovery", ...event }));
      },
    })
  : model;
try {
  const result = await withModelObserver(
    {
      start(metadata) {
        const callId = activeCall;
        const first = new Set<string>();
        append("phases.jsonl", {
          type: "start",
          callId,
          at: Date.now(),
          ...metadata,
        });
        return {
          event(event) {
            const key =
              event.type === "delta" ? `delta:${event.kind}` : event.type;
            if (first.has(key) && !["result", "failure"].includes(event.type))
              return;
            first.add(key);
            append("phases.jsonl", {
              type: "observation",
              callId,
              at: Date.now(),
              event,
            });
          },
          end(status) {
            append("phases.jsonl", {
              type: "end",
              callId,
              at: Date.now(),
              status,
            });
          },
        };
      },
    },
    () =>
      runDesktopNext(goal, {
        workspaceRoot: root,
        conversationId: "tool-wire",
        ...(!prior ? { executionDeadline: { deadlineAtMs: startedAt + budget.wallMs, reserveMs: Math.min(180_000, Math.floor(budget.wallMs * 0.2)) } } : {}),
        ...(prior ? { intent: "recover" as const } : {}),
        taskMode: "standard",
        model: executionModel,
        settings: { sandbox: sandboxSettings },
        memoryEnabled,
        backgroundMemory,
        memoryQueueDirectory: path.join(output, "memory-ingress"),
        environmentAudit,
        maxSteps: budget.maxSteps,
        ...(journalRecovery
          ? { experimentalReasoningRecovery: true as const }
          : {}),
        abortSignal: controller.signal,
        resolveToolApproval: async () => true,
        onEvent(envelope) {
          const event = envelope.event as unknown as Record<string, unknown>;
          if (
            [
              "tool.call",
              "tool.result",
              "run.completed",
              "run.failed",
              "memory.maintenance",
              "context.next_budget",
            ].includes(String(event.type))
          )
            append("events.jsonl", { at: Date.now(), event });
        },
      }),
  );
  write("result.json", { ...result, finishedAt: Date.now() });
} catch (error) {
  write("result.json", {
    ok: false,
    error: String(error),
    finishedAt: Date.now(),
  });
} finally {
  clearTimeout(timer);
  clearTimeout(hardTimer);
  globalThis.fetch = nativeFetch;
  for (const fd of [...fds]) close(fd);
}
const file = path.join(root, "probe.txt");
write("verification.json", {
  exists: fs.existsSync(file),
  exactBytes:
    !projectTask &&
    fs.existsSync(file) &&
    fs.readFileSync(file).equals(Buffer.from("PAW_TOOL_PROBE_OK\n")),
  file,
  seconds: (Date.now() - startedAt) / 1000,
  calls,
  physicalRequests: physical,
  reportedTokens: tokens,
});
// Grade separately with native Node via wire-grade.py; Bun spawnSync can time out on Windows.
console.log(JSON.stringify({ event: "probe.done", output }));
