/**
 * Real DeepSeek smoke for cache reuse across two independent child runs.
 *
 * Both children share one workspace, model, capability surface, and stable
 * system prefix, while their delegated task envelopes are deliberately
 * different. The report contains usage telemetry only; credentials are never
 * serialized.
 *
 *   bun apps/cli/test/paw-child-prefix-cache-smoke.driver.ts [workspaceRoot]
 */
import fs from "node:fs";
import path from "node:path";

import { DefaultSubAgentLauncher } from "@paw/agent";
import { CostTracker, type UsageRecord } from "@paw/core";
import { defaultSettingsPath, loadPawSettingsLocal } from "@paw/settings";

import { buildPawNextTaskProfileV3 } from "../src/paw-next/product-profile-v3.js";
import {
  buildSmokeProfile,
  prepareSmokeRepository,
} from "./paw-next-real-smoke.lib.js";

interface CacheCallLog {
  readonly call: number;
  readonly promptTokens: number;
  readonly cachedPromptTokens: number;
  readonly cacheMissPromptTokens: number;
  readonly cacheHitRate: number;
  readonly completionTokens: number;
}

const CHILD_MAX_STEPS = 8;

class RecordingCostTracker extends CostTracker {
  readonly calls: CacheCallLog[] = [];

  override record(modelLabel: string, usage: UsageRecord): void {
    super.record(modelLabel, usage);
    const promptTokens = usage.promptTokens ?? 0;
    const cachedPromptTokens = Math.min(
      Math.max(usage.cachedPromptTokens ?? 0, 0),
      promptTokens,
    );
    const cacheMissPromptTokens = Math.min(
      Math.max(
        usage.cacheMissPromptTokens ?? promptTokens - cachedPromptTokens,
        0,
      ),
      promptTokens - cachedPromptTokens,
    );
    this.calls.push({
      call: this.calls.length + 1,
      promptTokens,
      cachedPromptTokens,
      cacheMissPromptTokens,
      cacheHitRate: promptTokens === 0 ? 0 : cachedPromptTokens / promptTokens,
      completionTokens: usage.completionTokens ?? 0,
    });
  }
}

const runSuffix = Date.now().toString(36);
const workspaceRoot = path.resolve(
  process.argv[2] ?? `E:/A_Louis/paw-kv-cache-child-prefix-${runSuffix}`,
);
if (fs.existsSync(workspaceRoot)) {
  throw new Error(
    `Child-prefix smoke workspace already exists: ${workspaceRoot}`,
  );
}
prepareSmokeRepository(workspaceRoot);

const identity = {
  workspaceRoot,
  sessionId: `child-prefix-session-${runSuffix}`,
  runId: `child-prefix-profile-${runSuffix}`,
  inputId: `child-prefix-input-${runSuffix}`,
  goal: "Measure cache reuse across independent child tasks.",
};
const apiKey = readHostApiKey();
const seeded = buildPawNextTaskProfileV3({
  identity,
  profile: buildSmokeProfile("0".repeat(64)),
  apiKey,
});
const resolution = buildPawNextTaskProfileV3({
  identity,
  profile: buildSmokeProfile(seeded.configHash),
  apiKey,
});
if (resolution.configHash !== seeded.configHash) {
  throw new Error("Child-prefix smoke profile identity drifted");
}

const tracker = new RecordingCostTracker();
const launcher = new DefaultSubAgentLauncher({
  workspaceRoot,
  model: resolution.taskOptions.model,
  maxSteps: CHILD_MAX_STEPS,
  costTracker: tracker,
});
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 6 * 60_000);
const startedAt = Date.now();

try {
  const first = await launcher.launchStreaming({
    goal: "Inspect src/calc.js and report the exact arithmetic defect with file evidence. Do not edit files.",
    parentRunId: "cache-prefix-parent",
    agentId: "cache-prefix-child-a",
    signal: controller.signal,
    onEvent: () => {},
    sharedContext: {
      role: "Act as a read-only implementation investigator.",
      task: "Locate the calculator implementation defect.",
      facts: ["The add function fails its test."],
      constraints: ["Do not modify files."],
      artifacts: [],
      state: { completed: [], pending: ["Inspect src/calc.js."] },
      outputFormat: "Return a concise evidence-backed finding.",
      childPolicy: "read_only",
    },
  });
  const secondStart = tracker.calls.length;
  const second = await launcher.launchStreaming({
    goal: "Inspect test/calc.test.js and report the expected behavior and assertion evidence. Do not edit files.",
    parentRunId: "cache-prefix-parent",
    agentId: "cache-prefix-child-b",
    signal: controller.signal,
    onEvent: () => {},
    sharedContext: {
      role: "Act as a read-only test investigator.",
      task: "Identify the calculator test contract.",
      facts: ["The implementation and tests disagree."],
      constraints: ["Do not modify files."],
      artifacts: [],
      state: { completed: [], pending: ["Inspect test/calc.test.js."] },
      outputFormat: "Return expected behavior and exact assertion evidence.",
      childPolicy: "read_only",
    },
  });

  const snapshot = tracker.snapshot();
  const report = {
    schemaVersion: "paw.child-prefix-cache-smoke.v1",
    workspaceRoot,
    model: resolution.taskOptions.model.label,
    startedAt,
    elapsedMs: Date.now() - startedAt,
    maxSteps: CHILD_MAX_STEPS,
    childResults: [
      { id: "cache-prefix-child-a", status: first.status },
      { id: "cache-prefix-child-b", status: second.status },
    ],
    secondChildFirstCall: tracker.calls[secondStart] ?? null,
    secondChildCallStart: secondStart + 1,
    cache: {
      promptTokens: snapshot.promptTokens,
      cachedPromptTokens: snapshot.cachedPromptTokens,
      cacheMissPromptTokens: snapshot.cacheMissPromptTokens,
      cacheHitRate: snapshot.cacheHitRate,
      completionTokens: snapshot.completionTokens,
      estimatedCost: snapshot.estimatedCost,
      currency: snapshot.costCurrency,
    },
    calls: tracker.calls,
  };
  const reportPath = path.join(
    workspaceRoot,
    ".paw",
    "child-prefix-cache-smoke-report.json",
  );
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  for (const call of tracker.calls) {
    const child = call.call <= secondStart ? "a" : "b";
    console.log(
      `[child-prefix-cache] child=${child} call=${call.call} prompt=${call.promptTokens} hit=${call.cachedPromptTokens} miss=${call.cacheMissPromptTokens} rate=${(call.cacheHitRate * 100).toFixed(1)}%`,
    );
  }
  const warmCall = tracker.calls[secondStart];
  console.log(
    `[child-prefix-cache] second-child-first-call=${warmCall ? `${(warmCall.cacheHitRate * 100).toFixed(1)}%` : "missing"}`,
  );
  console.log(`[child-prefix-cache] report=${reportPath}`);
} finally {
  clearTimeout(timeout);
}

function readHostApiKey(): string {
  const hostRoot = path.resolve(import.meta.dir, "../../..");
  const settings = loadPawSettingsLocal(defaultSettingsPath(hostRoot));
  const apiKey = settings.models?.deepseekv4flash?.apiKey;
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    throw new Error("Host credential slot deepseekv4flash is unavailable");
  }
  return apiKey;
}
