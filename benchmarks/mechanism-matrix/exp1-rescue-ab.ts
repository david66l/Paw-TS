#!/usr/bin/env bun
/**
 * Mechanism-matrix experiment 1: thinking-recovery A/B (smoke protocol).
 *
 *   bun run benchmarks/mechanism-matrix/exp1-rescue-ab.ts --arm off|on
 *     [--task queue] [--wall-ms 900000] [--calls 64] [--max-steps 48]
 *     [--label <run-label>]
 *
 * One arm per invocation, one live task per arm, fresh workspace, GLM-5.3-Flash
 * from the local Paw settings. Arm `off` disables the model-level thinking-only
 * rescue (control); arm `on` keeps the default 540s/2 policy. Both arms keep
 * the production request supervision (idle 90s / reasoning-only 600s / wall
 * 900s). Frozen task verifier (desktop-harness-ab verify.mjs) grades the
 * delivery afterwards; usage is recorded per physical request.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  type LanguageModel,
  type ModelCompleteOptions,
  createDefaultLanguageModel,
} from "../../packages/models/src/index.js";
import { runDesktopNext } from "../../apps/desktop/agent-host/paw-next.js";
import { tasks } from "../../legacy/benchmarks/desktop-harness-ab/tasks.js";
import { readVerification } from "../../legacy/benchmarks/desktop-harness-ab/verification-result.js";
import { workflowGoal } from "../../legacy/benchmarks/desktop-harness-ab/workflow-task.js";

const repo = path.resolve(import.meta.dir, "../..");
const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
};
const arm = arg("--arm") === "on" ? "on" : "off";
const taskKind = (arg("--task") ?? "queue") as keyof typeof tasks;
const wallMs = Number(arg("--wall-ms") ?? "900000");
const maxCalls = Number(arg("--calls") ?? "64");
const maxSteps = Number(arg("--max-steps") ?? "48");
const label = arg("--label") ?? `exp1-${taskKind}`;
const effortOverride = arg("--effort") === "max" ? "max" : arg("--effort") === "high" ? "high" : undefined;

const task = tasks[taskKind];
if (!task && taskKind !== "workflow")
  throw new Error(`unknown task: ${taskKind}`);
const taskGoal = taskKind === "workflow" ? workflowGoal : task!.goal;
const taskSeed =
  taskKind === "workflow" ? ({} as Record<string, string>) : task!.seed;

const runsRoot = path.join(import.meta.dir, ".runs");
fs.mkdirSync(runsRoot, { recursive: true });
const dir = path.join(runsRoot, `${label}-arm-${arm}-${Date.now()}`);
fs.mkdirSync(dir, { recursive: true });
const append = (name: string, value: unknown) =>
  fs.appendFileSync(path.join(dir, name), `${JSON.stringify(value)}\n`);

const workspace = fs.mkdtempSync(
  path.join(os.tmpdir(), `paw-exp1-${arm}-${taskKind}-`),
);
for (const [file, content] of Object.entries(taskSeed)) {
  fs.mkdirSync(path.dirname(path.join(workspace, file)), { recursive: true });
  fs.writeFileSync(path.join(workspace, file), content);
}

const base = createDefaultLanguageModel(repo);
if (base.runtimeProfile?.model.toLowerCase() !== "glm-5.3-flash")
  throw new Error("Select GLM-5.3-Flash in the Paw settings before this benchmark");

const controller = new AbortController();
const startedAt = Date.now();
const wallTimer = setTimeout(
  () => controller.abort(new Error("Benchmark wall budget exhausted")),
  wallMs,
);
let calls = 0;
let tokens = 0;

const guard = (options?: ModelCompleteOptions) => {
  controller.signal.throwIfAborted();
  if (options?.signal?.aborted) controller.abort(options.signal.reason);
  if (calls >= maxCalls)
    controller.abort(new Error("Benchmark call threshold reached"));
  if (tokens >= 2_000_000)
    controller.abort(new Error("Benchmark token threshold reached"));
};

const wrapped: LanguageModel = {
  label: base.label,
  capabilities: base.capabilities,
  runtimeProfile:
    effortOverride === undefined
      ? base.runtimeProfile
      : { ...base.runtimeProfile, reasoningEffort: effortOverride },
  async complete(messages, options) {
    guard(options);
    calls += 1;
    append("calls.jsonl", { type: "start", at: Date.now() - startedAt, call: calls });
    try {
      const result = await base.complete(messages, {
        ...options,
        signal: controller.signal,
      });
      if (result.usage) {
        tokens += result.usage.totalTokens ?? 0;
        append("calls.jsonl", { type: "usage", call: calls, usage: result.usage });
      }
      return result;
    } catch (error) {
      append("calls.jsonl", { type: "error", call: calls, error: String(error) });
      throw error;
    }
  },
  ...(base.completeStream
    ? {
        async *completeStream(messages, options) {
          guard(options);
          calls += 1;
          append("calls.jsonl", { type: "start", at: Date.now() - startedAt, call: calls });
          try {
            for await (const chunk of base.completeStream(messages, {
              ...options,
              signal: controller.signal,
            })) {
              if (chunk.type === "done" && chunk.usage) {
                tokens += chunk.usage.totalTokens ?? 0;
                append("calls.jsonl", { type: "usage", call: calls, usage: chunk.usage });
              }
              yield chunk;
            }
          } catch (error) {
            append("calls.jsonl", { type: "error", call: calls, error: String(error) });
            throw error;
          }
        },
      }
    : {}),
};

const rescueEvents: unknown[] = [];
const result = await runDesktopNext(taskGoal, {
  workspaceRoot: workspace,
  model: wrapped,
  maxSteps,
  abortSignal: controller.signal,
  resolveToolApproval: async () => true,
  onEvent: (event) => {
    append("events.jsonl", { at: Date.now() - startedAt, ...event });
  },
  ...(arm === "off" ? { thinkingRecovery: false as const } : {}),
  onThinkingRecoveryEvent: (event) => {
    append("rescue.jsonl", { at: Date.now() - startedAt, ...event });
    rescueEvents.push(event);
  },
}).catch((error: unknown) => ({ ok: false, text: String(error) }));

clearTimeout(wallTimer);
const endedAt = Date.now();

// First product-file timestamp (progress evidence beyond raw request counts).
const productFiles: Array<{ file: string; mtimeMs: number }> = [];
const walk = (entry: string) => {
  for (const item of fs.readdirSync(entry, { withFileTypes: true })) {
    if (item.name === ".paw" || item.name === "node_modules") continue;
    const full = path.join(entry, item.name);
    if (item.isDirectory()) walk(full);
    else
      productFiles.push({
        file: path.relative(workspace, full).split(path.sep).join("/"),
        mtimeMs: fs.statSync(full).mtimeMs,
      });
  }
};
walk(workspace);
productFiles.sort((a, b) => a.mtimeMs - b.mtimeMs);

let verification: ReturnType<typeof readVerification>;
if (taskKind === "workflow") {
  // The frozen 34-check grader is a separate protocol; for the stall A/B we
  // record the delivered npm test as a coarse functional signal instead.
  const testRun = spawnSync(
    process.execPath,
    ["--test", "test"],
    { cwd: workspace, encoding: "utf8", timeout: 120_000, maxBuffer: 4e6 },
  );
  const pass = /# pass (\d+)/.exec(testRun.stdout ?? "")?.[1];
  const fail = /# fail (\d+)/.exec(testRun.stdout ?? "")?.[1];
  verification = {
    measured: true,
    passed: pass ? Number(pass) : 0,
    total: Number(pass ?? 0) + Number(fail ?? 0),
    checks: [],
  } as ReturnType<typeof readVerification>;
} else {
  const verified = spawnSync(
    "node",
    [path.join(repo, "legacy/benchmarks/desktop-harness-ab/verify.mjs"), String(taskKind), workspace],
    { cwd: repo, encoding: "utf8", timeout: 60_000, maxBuffer: 2e6 },
  );
  verification = readVerification(verified);
}

const rows = fs
  .readFileSync(path.join(dir, "calls.jsonl"), "utf8")
  .trim()
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const usages = rows.filter((row) => row.type === "usage");
const sum = (key: string) =>
  usages.reduce((total, row) => total + (row.usage[key] ?? 0), 0);

const summary = {
  experiment: "exp1-thinking-recovery",
  label,
  arm,
  task: String(taskKind),
  model: base.runtimeProfile?.model,
  effort:
    effortOverride ?? base.runtimeProfile?.reasoningEffort ?? null,
  budget: { wallMs, calls: maxCalls, maxSteps },
  workspace,
  seconds: (endedAt - startedAt) / 1000,
  physicalCalls: rows.filter((row) => row.type === "start").length,
  usageReports: usages.length,
  promptTokens: sum("promptTokens"),
  completionTokens: sum("completionTokens"),
  totalTokens: sum("totalTokens") || sum("promptTokens") + sum("completionTokens"),
  rescueEventCount: rescueEvents.length,
  rescueEvents,
  firstProductFile:
    productFiles.find((file) => file.file.startsWith("src/") || file.file === "package.json") ??
    null,
  productFileCount: productFiles.length,
  verification: {
    measured: verification.measured,
    passed: verification.passed,
    total: verification.total,
  },
  runtimeOk: result.ok,
  resultTextHead: result.text.slice(0, 400),
};

fs.writeFileSync(path.join(dir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
fs.writeFileSync(
  path.join(dir, "result.json"),
  `${JSON.stringify(result, null, 2)}\n`,
);
console.log(JSON.stringify(summary, null, 2));
