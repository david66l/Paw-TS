/**
 * Real DeepSeek V3 KV-cache smoke.
 *
 * Creates a fresh isolated repository, runs a normal root or delegated V3 task,
 * writes non-secret per-call cache telemetry, and leaves the canonical Paw
 * journal intact for later benchmark inspection.
 *
 *   bun apps/cli/test/paw-next-kv-cache-smoke.driver.ts [workspaceRoot] [single|multi|advice|child-advice]
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { CostTracker, type UsageRecord } from "@paw/core";
import type {
  ChatMessage,
  LanguageModel,
  ModelCompleteOptions,
  ModelCompletionResult,
} from "@paw/models";
import { defaultSettingsPath, loadPawSettingsLocal } from "@paw/settings";

import {
  type PawModelSettlementTelemetryV1,
  runFreshPawNextTaskV3,
} from "../src/paw-next/composition.js";
import { buildPawNextTaskProfileV3 } from "../src/paw-next/product-profile-v3.js";
import {
  buildSmokeProfile,
  prepareSmokeRepository,
} from "./paw-next-real-smoke.lib.js";

type SmokeMode = "single" | "multi" | "advice" | "child-advice";

interface CacheCallLog {
  readonly call: number;
  readonly model: string;
  readonly promptTokens: number;
  readonly cachedPromptTokens: number;
  readonly cacheMissPromptTokens: number;
  readonly cacheHitRate: number;
  readonly completionTokens: number;
  readonly cumulativeCost: number;
  readonly currency: "CNY" | "USD";
}

interface PrefixRequestLog {
  readonly call: number;
  readonly requestHash: string;
  readonly messageCount: number;
  readonly leadingSystemMessages: number;
  readonly toolCount: number;
  readonly toolSchemaHash: string;
  readonly maxOutputTokens?: number;
  readonly thinkingEnabled?: boolean;
  readonly bestPriorCall?: number;
  readonly sharedLeadingMessages: number;
  readonly messages: readonly {
    readonly index: number;
    readonly role: ChatMessage["role"];
    readonly bytes: number;
    readonly contentHash: string;
    readonly messageHash: string;
    readonly serializedBytes: number;
    readonly nativeToolCalls: number;
    readonly nativeToolResults: number;
    readonly nativeToolTurnBytes: number;
    readonly nativeToolTurnHash: string;
  }[];
}

class PrefixRecordingModel implements LanguageModel {
  readonly label: string;
  readonly capabilities: LanguageModel["capabilities"];
  readonly runtimeProfile: LanguageModel["runtimeProfile"];
  readonly requests: PrefixRequestLog[] = [];

  constructor(private readonly delegate: LanguageModel) {
    this.label = delegate.label;
    this.capabilities = delegate.capabilities;
    this.runtimeProfile = delegate.runtimeProfile;
  }

  async complete(
    messages: readonly ChatMessage[],
    options?: ModelCompleteOptions,
  ): Promise<ModelCompletionResult> {
    this.requests.push(fingerprintRequest(this.requests, messages, options));
    return this.delegate.complete(messages, options);
  }
}

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
    const snapshot = this.snapshot();
    this.calls.push({
      call: this.calls.length + 1,
      model: modelLabel,
      promptTokens,
      cachedPromptTokens,
      cacheMissPromptTokens,
      cacheHitRate: promptTokens === 0 ? 0 : cachedPromptTokens / promptTokens,
      completionTokens: usage.completionTokens ?? 0,
      cumulativeCost: snapshot.estimatedCost,
      currency: snapshot.costCurrency,
    });
  }
}

const mode = parseMode(process.argv[3] ?? process.env.PAW_KV_SMOKE_MODE);
const runSuffix = Date.now().toString(36);
const workspaceRoot = path.resolve(
  process.argv[2] ?? `E:/A_Louis/paw-kv-cache-smoke-${mode}-${runSuffix}`,
);
if (fs.existsSync(workspaceRoot)) {
  throw new Error(`KV-cache smoke workspace already exists: ${workspaceRoot}`);
}
prepareSmokeRepository(workspaceRoot);
if (mode === "advice" || mode === "child-advice") {
  for (let index = 1; index <= 5; index += 1) {
    fs.writeFileSync(
      path.join(workspaceRoot, `evidence-${index}.txt`),
      `cache-advice-evidence-${index}\n`,
      "utf8",
    );
  }
}

const identity = {
  workspaceRoot,
  sessionId: `kv-cache-${mode}-session-${runSuffix}`,
  runId: `kv-cache-${mode}-run-${runSuffix}`,
  inputId: `kv-cache-${mode}-input-${runSuffix}`,
  goal: smokeGoal(mode),
};
const apiKey = readHostApiKey();
const seedProfile = buildKvCacheProfile("0".repeat(64));
const seeded = buildPawNextTaskProfileV3({
  identity,
  profile: seedProfile,
  apiKey,
});
const resolution = buildPawNextTaskProfileV3({
  identity,
  profile: buildKvCacheProfile(seeded.configHash),
  apiKey,
});
if (resolution.configHash !== seeded.configHash) {
  throw new Error("KV-cache smoke profile identity drifted");
}
const recordingModel = new PrefixRecordingModel(resolution.taskOptions.model);
const tracedResolution = Object.freeze({
  ...resolution,
  taskOptions: Object.freeze({
    ...resolution.taskOptions,
    model: recordingModel,
  }),
});

const tracker = new RecordingCostTracker();
const settlements: Array<Record<string, unknown>> = [];
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 6 * 60_000);
const startedAt = Date.now();

try {
  const result = await runFreshPawNextTaskV3({
    resolution: tracedResolution,
    costTracker: tracker,
    signal: controller.signal,
    onModelSettlement: (event) => settlements.push(safeSettlement(event)),
  });
  const elapsedMs = Date.now() - startedAt;
  const verification = Bun.spawnSync(["node", "test/calc.test.js"], {
    cwd: workspaceRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const snapshot = tracker.snapshot();
  const noCacheTracker = new CostTracker();
  noCacheTracker.record(resolution.taskOptions.model.label, {
    promptTokens: snapshot.promptTokens,
    cacheMissPromptTokens: snapshot.promptTokens,
    completionTokens: snapshot.completionTokens,
  });
  const noCacheSnapshot = noCacheTracker.snapshot();
  const report = {
    schemaVersion: "paw.kv-cache-smoke.v1",
    mode,
    workspaceRoot,
    model: resolution.taskOptions.model.label,
    startedAt,
    elapsedMs,
    decision: result.state.decision,
    modelTurns: result.state.totalModelTurns,
    settledToolCalls: result.state.totalSettledToolCalls,
    cache: {
      promptTokens: snapshot.promptTokens,
      cachedPromptTokens: snapshot.cachedPromptTokens,
      cacheMissPromptTokens: snapshot.cacheMissPromptTokens,
      cacheHitRate: snapshot.cacheHitRate,
      completionTokens: snapshot.completionTokens,
      estimatedCost: snapshot.estimatedCost,
      estimatedNoCacheCost: noCacheSnapshot.estimatedCost,
      estimatedSavings: noCacheSnapshot.estimatedCost - snapshot.estimatedCost,
      estimatedSavingsRate:
        noCacheSnapshot.estimatedCost === 0
          ? 0
          : 1 - snapshot.estimatedCost / noCacheSnapshot.estimatedCost,
      currency: snapshot.costCurrency,
    },
    calls: tracker.calls,
    requestFingerprints: recordingModel.requests,
    settlements,
    hostVerification: {
      exitCode: verification.exitCode,
      stdout: verification.stdout.toString().trim(),
      stderr: verification.stderr.toString().trim(),
    },
  };
  const reportPath = path.join(
    workspaceRoot,
    ".paw",
    "kv-cache-smoke-report.json",
  );
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(`[kv-cache] mode=${mode} workspace=${workspaceRoot}`);
  for (const call of tracker.calls) {
    console.log(
      `[kv-cache] call=${call.call} prompt=${call.promptTokens} hit=${call.cachedPromptTokens} miss=${call.cacheMissPromptTokens} rate=${(call.cacheHitRate * 100).toFixed(1)}% completion=${call.completionTokens}`,
    );
  }
  console.log(
    `[kv-cache] total prompt=${snapshot.promptTokens} hit=${snapshot.cachedPromptTokens} miss=${snapshot.cacheMissPromptTokens} rate=${(snapshot.cacheHitRate * 100).toFixed(1)}% cost=${snapshot.costCurrency} ${snapshot.estimatedCost.toFixed(6)}`,
  );
  console.log(
    `[kv-cache] decision=${JSON.stringify(result.state.decision)} hostTestExit=${verification.exitCode}`,
  );
  console.log(`[kv-cache] report=${reportPath}`);
} catch (error) {
  const reportPath = path.join(
    workspaceRoot,
    ".paw",
    "kv-cache-smoke-report.json",
  );
  const snapshot = tracker.snapshot();
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(
    reportPath,
    `${JSON.stringify(
      {
        schemaVersion: "paw.kv-cache-smoke.v1",
        mode,
        workspaceRoot,
        model: resolution.taskOptions.model.label,
        startedAt,
        elapsedMs: Date.now() - startedAt,
        failure: redactDiagnostic(
          error instanceof Error ? error.message : String(error),
        ),
        cache: snapshot,
        calls: tracker.calls,
        requestFingerprints: recordingModel.requests,
        settlements,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  console.error(`[kv-cache] failed report=${reportPath}`);
  throw error;
} finally {
  clearTimeout(timeout);
}

function parseMode(value: string | undefined): SmokeMode {
  if (value === undefined || value === "single") return "single";
  if (value === "multi") return "multi";
  if (value === "advice") return "advice";
  if (value === "child-advice") return "child-advice";
  throw new Error(`Unknown KV-cache smoke mode: ${value}`);
}

function smokeGoal(value: SmokeMode): string {
  const common = [
    "Fix the bug in src/calc.js: add(a, b) incorrectly subtracts.",
    "Inspect the file with tools, make the smallest correct edit, run node test/calc.test.js, inspect the result, and finish with a concise factual answer.",
    "Do not guess file contents and do not skip verification.",
  ];
  if (value === "multi") {
    common.unshift(
      "First delegate an independent investigator to inspect the calculator implementation and return concrete evidence. After receiving its result, complete and verify the fix in the root Agent.",
    );
  }
  if (value === "advice") {
    common.unshift(
      "Cache-advice benchmark protocol: before inspecting or editing calculator files, read evidence-1.txt through evidence-5.txt in numeric order using exactly one workspace_read_file call in each model turn. Do not batch those five reads and do not skip any of them.",
    );
  }
  if (value === "child-advice") {
    common.unshift(
      "First delegate one read-only investigator. In the delegation goal, require the child—before inspecting calculator files—to read evidence-1.txt through evidence-5.txt in numeric order using exactly one workspace_read_file call in each model turn; it must not batch or skip those five reads. Wait for its evidence before completing and verifying the fix in the root Agent.",
    );
  }
  return common.join(" ");
}

function buildKvCacheProfile(configHash: string) {
  const profile = buildSmokeProfile(configHash);
  if (mode === "single") return profile;
  return {
    ...profile,
    permission: {
      ...profile.permission,
      policyVersion: "smoke-permission-multi.v1",
      rules: [
        ...profile.permission.rules,
        {
          id: "allow-read-category",
          layer: "user" as const,
          category: "read" as const,
          action: "allow" as const,
        },
        {
          id: "allow-delegate",
          layer: "user" as const,
          tool: "workspace.run_agent",
          action: "allow" as const,
        },
      ],
    },
  };
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

function safeSettlement(
  event: PawModelSettlementTelemetryV1,
): Record<string, unknown> {
  return {
    call: settlements.length + 1,
    model: event.modelLabel,
    sessionId: event.sessionId,
    runId: event.runId,
    phase: event.phase,
    status: event.status,
    ...(event.reason === undefined
      ? {}
      : { reason: redactDiagnostic(event.reason) }),
    ...(event.usage === undefined ? {} : { usage: event.usage }),
  };
}

function redactDiagnostic(value: string): string {
  return value
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]+\b/g, "[REDACTED_API_KEY]")
    .slice(0, 1_000);
}

function fingerprintRequest(
  prior: readonly PrefixRequestLog[],
  messages: readonly ChatMessage[],
  options: ModelCompleteOptions | undefined,
): PrefixRequestLog {
  const descriptors = messages.map((message, index) => {
    const serializedMessage = canonicalJson(message);
    const serializedNativeToolTurn = canonicalJson(
      message.nativeToolTurn ?? null,
    );
    return {
      index,
      role: message.role,
      bytes: Buffer.byteLength(message.content, "utf8"),
      contentHash: sha256(message.content),
      messageHash: sha256(serializedMessage),
      serializedBytes: Buffer.byteLength(serializedMessage, "utf8"),
      nativeToolCalls: message.nativeToolTurn?.calls.length ?? 0,
      nativeToolResults: message.nativeToolTurn?.results.length ?? 0,
      nativeToolTurnBytes:
        message.nativeToolTurn === undefined
          ? 0
          : Buffer.byteLength(serializedNativeToolTurn, "utf8"),
      nativeToolTurnHash: sha256(serializedNativeToolTurn),
    };
  });
  const toolSchemaHash = sha256(canonicalJson(options?.tools ?? []));
  const firstNonSystem = messages.findIndex(
    (message) => message.role !== "system",
  );
  let bestPriorCall: number | undefined;
  let sharedLeadingMessages = 0;
  for (const candidate of prior) {
    const shared = commonLeadingMessages(candidate.messages, descriptors);
    if (shared > sharedLeadingMessages) {
      sharedLeadingMessages = shared;
      bestPriorCall = candidate.call;
    }
  }
  return Object.freeze({
    call: prior.length + 1,
    requestHash: sha256(
      canonicalJson({
        messages: descriptors.map((item) => item.messageHash),
        toolSchemaHash,
        maxOutputTokens: options?.maxOutputTokens ?? null,
        thinkingEnabled: options?.thinkingEnabled ?? null,
      }),
    ),
    messageCount: messages.length,
    leadingSystemMessages:
      firstNonSystem < 0 ? messages.length : firstNonSystem,
    toolCount: options?.tools?.length ?? 0,
    toolSchemaHash,
    ...(options?.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: options.maxOutputTokens }),
    ...(options?.thinkingEnabled === undefined
      ? {}
      : { thinkingEnabled: options.thinkingEnabled }),
    ...(bestPriorCall === undefined ? {} : { bestPriorCall }),
    sharedLeadingMessages,
    messages: Object.freeze(descriptors.map((item) => Object.freeze(item))),
  });
}

function commonLeadingMessages(
  left: PrefixRequestLog["messages"],
  right: PrefixRequestLog["messages"],
): number {
  const length = Math.min(left.length, right.length);
  let index = 0;
  while (
    index < length &&
    left[index]?.messageHash === right[index]?.messageHash
  ) {
    index += 1;
  }
  return index;
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
