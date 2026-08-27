/**
 * Real Postgres + DeepSeek smoke for the topic-evidence memory architecture.
 *
 * The run is intentionally split into three independent Sessions sharing one
 * exact memory scope:
 *   1. seed an explicit durable preference and organize it into a topic;
 *   2. recall it with one query;
 *   3. recall it with a different query so DeepSeek can detect and persist the
 *      common prefix;
 *   4. recall it once more and verify the persisted topic-index prefix can be
 *      reused by the provider cache.
 *
 * The report contains hashes, revisions, counts, usage and status only. It
 * never persists prompt text, memory statements, model output, or credentials.
 *
 *   $env:DATABASE_URL='postgresql://postgres@127.0.0.1:54329/paw_memory_test'
 *   bun apps/cli/test/paw-next-memory-topic-smoke.driver.ts [workspaceRoot]
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { CostTracker } from "@paw/core";
import {
  PAW_NEXT_MEMORY_PLUGIN_POLICY_VERSION_V1,
  PAW_NEXT_MEMORY_V2_PROVIDER_VERSION_V1,
  memoryScopeFingerprintV1,
} from "@paw/memory-plugin";
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

type RunLabel = "seed" | "recall-a" | "recall-b" | "recall-c";

interface MemoryMessageFingerprint {
  readonly index: number;
  readonly kind:
    | "cards"
    | "topic_index"
    | "topic_evidence"
    | "raw_evidence"
    | "evidence_coverage";
  readonly bytes: number;
  readonly messageHash: string;
  readonly contentHash?: string;
  /** Hash through content=..., excluding the volatile sourceSeqRange line. */
  readonly stablePrefixHash: string;
}

interface RequestFingerprint {
  readonly call: number;
  readonly run: RunLabel;
  readonly requestHash: string;
  readonly messageCount: number;
  readonly leadingSystemMessages: number;
  readonly sharedLeadingMessages: number;
  readonly bestPriorCall?: number;
  readonly toolSchemaHash: string;
  readonly memoryMessages: readonly MemoryMessageFingerprint[];
}

interface SettlementLog {
  readonly call: number;
  readonly run: RunLabel;
  readonly phase: string;
  readonly status: string;
  readonly reason?: string;
  readonly promptTokens: number;
  readonly cachedPromptTokens: number;
  readonly cacheMissPromptTokens: number;
  readonly completionTokens: number;
}

const runSuffix = Date.now().toString(36);
const workspaceRoot = path.resolve(
  process.argv[2] ?? `E:/A_Louis/paw-memory-topic-smoke-${runSuffix}`,
);
if (fs.existsSync(workspaceRoot)) {
  throw new Error(
    `Memory topic smoke workspace already exists: ${workspaceRoot}`,
  );
}
prepareSmokeRepository(workspaceRoot);

const memoryScope = Object.freeze({
  tenantId: `smoke-tenant-${runSuffix}`,
  userId: `smoke-user-${runSuffix}`,
  workspaceId: `smoke-workspace-${runSuffix}`,
  repositoryId: `smoke-repository-${runSuffix}`,
});
const scopeFingerprint = memoryScopeFingerprintV1(memoryScope);
const apiKey = readHostApiKey();
const tracker = new CostTracker();
const requests: RequestFingerprint[] = [];
const requestMessageHashes = new Map<number, readonly string[]>();
const settlements: SettlementLog[] = [];
const runReports: Record<string, unknown>[] = [];
const startedAt = Date.now();

const goals: Readonly<Record<RunLabel, string>> = Object.freeze({
  seed: [
    "请长期记住这两个明确的用户偏好：在 TypeScript 项目中默认使用 bun test 验证；最终摘要使用简洁中文。",
    "只确认你已理解，不要修改文件，也不要调用工具。",
  ].join(" "),
  "recall-a": [
    "请根据长期记忆回答：这个用户在 TypeScript 项目中默认使用什么测试命令？",
    "最终摘要偏好什么语言和风格？不要读取工作区，不要调用工具。",
  ].join(" "),
  "recall-b": [
    "请只根据已有长期记忆，简洁回答我的 TypeScript 测试命令偏好和最终摘要偏好。",
    "不要读取工作区，不要调用工具。",
  ].join(" "),
  "recall-c": [
    "请复述该用户运行 TypeScript 测试时采用的命令，以及该用户要求的最终摘要表达方式。",
    "直接回答，不要读取工作区，不要调用工具。",
  ].join(" "),
});

try {
  for (const label of ["seed", "recall-a", "recall-b", "recall-c"] as const) {
    const result = await runSession(label);
    runReports.push(summarizeRun(label, result));
  }

  const report = buildReport();
  const reportPath = path.join(
    workspaceRoot,
    ".paw",
    "memory-topic-smoke-report.json",
  );
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(`[memory-topic-smoke] workspace=${workspaceRoot}`);
  console.log(`[memory-topic-smoke] scopeFingerprint=${scopeFingerprint}`);
  for (const run of runReports) {
    console.log(
      `[memory-topic-smoke] run=${run.run} decision=${run.decision} retrieval=${run.retrievalStatus ?? "-"} evidence=${run.evidenceStatus ?? "-"} index=${run.indexCount ?? 0} states=${run.evidenceStateCount ?? 0} coverage=${run.coverageStatus ?? "-"} requirements=${run.coverageRequirementCount ?? 0} covered=${run.coverageCoveredCount ?? 0} partial=${run.coveragePartialCount ?? 0} missing=${run.coverageMissingCount ?? 0} revision=${run.indexRevision ?? "-"}`,
    );
  }
  for (const settlement of settlements) {
    console.log(
      `[memory-topic-smoke] call=${settlement.call} run=${settlement.run} phase=${settlement.phase} prompt=${settlement.promptTokens} hit=${settlement.cachedPromptTokens} miss=${settlement.cacheMissPromptTokens}`,
    );
  }
  console.log(
    `[memory-topic-smoke] cacheHitRate=${(report.cache.cacheHitRate * 100).toFixed(1)}% stableIndex=${report.invariants.stableIndexRevision && report.invariants.stableIndexPrefix} passed=${report.invariants.passed}`,
  );
  console.log(`[memory-topic-smoke] report=${reportPath}`);
  if (!report.invariants.passed) process.exitCode = 1;
} catch (error) {
  const reportPath = path.join(
    workspaceRoot,
    ".paw",
    "memory-topic-smoke-report.json",
  );
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(
    reportPath,
    `${JSON.stringify(
      {
        schemaVersion: "paw.memory-topic-smoke.v1",
        workspaceRoot,
        scopeFingerprint,
        elapsedMs: Date.now() - startedAt,
        failure: redactDiagnostic(
          error instanceof Error ? error.message : String(error),
        ),
        runs: runReports,
        requests,
        settlements,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  console.error(`[memory-topic-smoke] failed report=${reportPath}`);
  throw error;
}

async function runSession(label: RunLabel) {
  const identity = {
    workspaceRoot,
    sessionId: `memory-topic-${label}-session-${runSuffix}`,
    runId: `memory-topic-${label}-run-${runSuffix}`,
    inputId: `memory-topic-${label}-input-${runSuffix}`,
    goal: goals[label],
  };
  const seedProfile = buildMemoryProfile("0".repeat(64));
  const seeded = buildPawNextTaskProfileV3({
    identity,
    profile: seedProfile,
    apiKey,
  });
  const resolution = buildPawNextTaskProfileV3({
    identity,
    profile: buildMemoryProfile(seeded.configHash),
    apiKey,
  });
  if (resolution.configHash !== seeded.configHash) {
    throw new Error(`Memory topic smoke profile drifted for ${label}`);
  }
  const recordingModel = new RequestRecordingModel(
    label,
    resolution.taskOptions.model,
  );
  const tracedResolution = Object.freeze({
    ...resolution,
    taskOptions: Object.freeze({
      ...resolution.taskOptions,
      model: recordingModel,
    }),
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6 * 60_000);
  try {
    return await runFreshPawNextTaskV3({
      resolution: tracedResolution,
      costTracker: tracker,
      signal: controller.signal,
      onModelSettlement: (event) => recordSettlement(label, event),
    });
  } finally {
    clearTimeout(timeout);
  }
}

function buildMemoryProfile(configHash: string) {
  return {
    ...buildSmokeProfile(configHash),
    profileId: "memory-topic-smoke-deepseek-v3",
    control: {
      mode: "interactive" as const,
      maxModelTurns: 8,
      naturalStop: "complete" as const,
      maxSegments: 1,
      maxTotalModelTurns: 8,
    },
    memory: {
      policyVersion: PAW_NEXT_MEMORY_PLUGIN_POLICY_VERSION_V1,
      mode: "read_write" as const,
      providerVersion: PAW_NEXT_MEMORY_V2_PROVIDER_VERSION_V1,
      scope: memoryScope,
      maxCards: 4,
      maxInjectedTokens: 1_024,
      writer: {
        policyVersion: "paw.memory-writer.v1" as const,
        extractorVersion: "paw.memory-atom-extractor.json.v1" as const,
        maxAtoms: 8,
        maxSourceChars: 24_000,
        topicOrganizer: {
          policyVersion: "paw.memory-topic-organization.v1" as const,
          extractorVersion: "paw.memory-topic-extractor.json.v1" as const,
          maxTopics: 8,
        },
        personaProjector: {
          policyVersion: "paw.memory-persona-evidence-projector.v1" as const,
          maxClaims: 8,
          maxChars: 2_048,
          minimumConfidence: 0.7,
        },
        rawEvidenceResolver: {
          policyVersion: "paw.memory-raw-evidence-resolver.v1" as const,
          maxSpans: 6,
          maxChars: 6_000,
        },
        coveragePlanner: {
          policyVersion: "paw.memory-evidence-coverage-planner.v1" as const,
          extractorVersion:
            "paw.memory-evidence-requirement-planner.json.v1" as const,
          maxRequirements: 4,
          maxExpansionTopics: 3,
          maxSupplementalStates: 8,
          maxSupplementalChars: 4_096,
        },
        evidencePlanner: {
          policyVersion: "paw.memory-topic-evidence-planner.v1" as const,
          maxIndexTopics: 96,
          maxSelectedTopics: 3,
          maxStates: 16,
          maxEvidenceChars: 8_000,
        },
      },
    },
  };
}

class RequestRecordingModel implements LanguageModel {
  readonly label: string;
  readonly capabilities: LanguageModel["capabilities"];
  readonly runtimeProfile: LanguageModel["runtimeProfile"];

  constructor(
    private readonly run: RunLabel,
    private readonly delegate: LanguageModel,
  ) {
    this.label = delegate.label;
    this.capabilities = delegate.capabilities;
    this.runtimeProfile = delegate.runtimeProfile;
  }

  complete(
    messages: readonly ChatMessage[],
    options?: ModelCompleteOptions,
  ): Promise<ModelCompletionResult> {
    requests.push(fingerprintRequest(this.run, messages, options));
    return this.delegate.complete(messages, options);
  }
}

function fingerprintRequest(
  run: RunLabel,
  messages: readonly ChatMessage[],
  options: ModelCompleteOptions | undefined,
): RequestFingerprint {
  const messageHashes = messages.map((message) =>
    sha256(canonicalJson(message)),
  );
  let bestPriorCall: number | undefined;
  let sharedLeadingMessages = 0;
  for (const prior of requests) {
    const priorHashes = requestMessageHashes.get(prior.call) ?? [];
    const shared = commonPrefixLength(priorHashes, messageHashes);
    if (shared > sharedLeadingMessages) {
      sharedLeadingMessages = shared;
      bestPriorCall = prior.call;
    }
  }
  const call = requests.length + 1;
  requestMessageHashes.set(call, messageHashes);
  const firstNonSystem = messages.findIndex(
    (message) => message.role !== "system",
  );
  return Object.freeze({
    call,
    run,
    requestHash: sha256(
      canonicalJson({
        messages: messageHashes,
        tools: options?.tools ?? [],
        maxOutputTokens: options?.maxOutputTokens ?? null,
        thinkingEnabled: options?.thinkingEnabled ?? null,
      }),
    ),
    messageCount: messages.length,
    leadingSystemMessages:
      firstNonSystem < 0 ? messages.length : firstNonSystem,
    sharedLeadingMessages,
    ...(bestPriorCall === undefined ? {} : { bestPriorCall }),
    toolSchemaHash: sha256(canonicalJson(options?.tools ?? [])),
    memoryMessages: Object.freeze(
      messages.flatMap((message, index) => {
        if (
          message.role !== "system" ||
          !message.content.startsWith("[Paw Memory Evidence]\n")
        ) {
          return [];
        }
        const contentHash = lineValue(message.content, "contentHash=");
        const stableContent = message.content
          .split("\n")
          .filter((line) => !line.startsWith("sourceSeqRange="))
          .join("\n");
        const kind = message.content.includes(
          '"schemaVersion":"paw.memory-topic-index.v1"',
        )
          ? "topic_index"
          : message.content.includes(
                '"schemaVersion":"paw.memory-evidence-coverage.v1"',
              )
            ? "evidence_coverage"
            : message.content.includes(
                  '"schemaVersion":"paw.memory-raw-evidence.v1"',
                )
              ? "raw_evidence"
              : message.content.includes(
                    '"schemaVersion":"paw.memory-topic-evidence.v1"',
                  )
                ? "topic_evidence"
                : "cards";
        return [
          Object.freeze({
            index,
            kind,
            bytes: Buffer.byteLength(message.content, "utf8"),
            messageHash: sha256(message.content),
            ...(contentHash === undefined ? {} : { contentHash }),
            stablePrefixHash: sha256(stableContent),
          }),
        ];
      }),
    ),
  });
}

function recordSettlement(
  run: RunLabel,
  event: PawModelSettlementTelemetryV1,
): void {
  const usage = event.usage;
  const promptTokens = usage?.promptTokens ?? 0;
  const cachedPromptTokens = Math.min(
    Math.max(usage?.cachedPromptTokens ?? 0, 0),
    promptTokens,
  );
  settlements.push({
    call: settlements.length + 1,
    run,
    phase: event.phase,
    status: event.status,
    ...(event.reason === undefined
      ? {}
      : { reason: redactDiagnostic(event.reason) }),
    promptTokens,
    cachedPromptTokens,
    cacheMissPromptTokens: Math.min(
      Math.max(
        usage?.cacheMissPromptTokens ?? promptTokens - cachedPromptTokens,
        0,
      ),
      promptTokens - cachedPromptTokens,
    ),
    completionTokens: usage?.completionTokens ?? 0,
  });
}

function summarizeRun(
  run: RunLabel,
  result: Awaited<ReturnType<typeof runFreshPawNextTaskV3>>,
): Record<string, unknown> {
  const facts = result.inputFacts as readonly Record<string, unknown>[];
  const retrieval = facts.findLast(
    (fact) => fact.type === "memory.retrieval_settled",
  );
  const evidence = facts.findLast(
    (fact) => fact.type === "memory.topic_evidence_settled",
  );
  const write = facts.findLast((fact) => fact.type === "memory.write_settled");
  const rawEvidence = facts.findLast(
    (fact) => fact.type === "memory.raw_evidence_settled",
  );
  const coverage = facts.findLast(
    (fact) => fact.type === "memory.evidence_coverage_settled",
  );
  const organization = facts.findLast(
    (fact) => fact.type === "memory.topic_organization_settled",
  );
  return {
    run,
    decision: (result.state.decision as { kind?: string }).kind ?? "unknown",
    totalModelTurns: result.state.totalModelTurns,
    retrievalStatus: retrieval?.status,
    retrievalCardCount: Array.isArray(retrieval?.cards)
      ? retrieval.cards.length
      : 0,
    evidenceStatus: evidence?.status,
    indexRevision: evidence?.indexRevision,
    indexCount: Array.isArray(evidence?.indexEntries)
      ? evidence.indexEntries.length
      : 0,
    evidenceStateCount: Array.isArray(evidence?.evidenceStates)
      ? evidence.evidenceStates.length
      : 0,
    evidenceChars: Array.isArray(evidence?.evidenceStates)
      ? JSON.stringify(evidence.evidenceStates).length
      : 0,
    rawEvidenceStatus: rawEvidence?.status,
    rawEvidenceSpanCount: Array.isArray(rawEvidence?.spans)
      ? rawEvidence.spans.length
      : 0,
    rawEvidenceChars: Array.isArray(rawEvidence?.spans)
      ? rawEvidence.spans.reduce(
          (total, span) =>
            total +
            (typeof (span as { content?: unknown }).content === "string"
              ? ((span as { content: string }).content.length ?? 0)
              : 0),
          0,
        )
      : 0,
    coverageStatus: coverage?.status,
    coverageRequirementCount: Array.isArray(coverage?.requirements)
      ? coverage.requirements.length
      : 0,
    coverageCoveredCount: Array.isArray(coverage?.coverage)
      ? coverage.coverage.filter(
          (item) => (item as { status?: unknown }).status === "covered",
        ).length
      : 0,
    coveragePartialCount: Array.isArray(coverage?.coverage)
      ? coverage.coverage.filter(
          (item) => (item as { status?: unknown }).status === "partial",
        ).length
      : 0,
    coverageMissingCount: Array.isArray(coverage?.coverage)
      ? coverage.coverage.filter(
          (item) => (item as { status?: unknown }).status === "missing",
        ).length
      : 0,
    coverageSupplementalStateCount: Array.isArray(coverage?.supplementalStates)
      ? coverage.supplementalStates.length
      : 0,
    coverageSpanCount: Array.isArray(coverage?.spans)
      ? coverage.spans.length
      : 0,
    coverageChars: Array.isArray(coverage?.spans)
      ? coverage.spans.reduce(
          (total, span) =>
            total +
            (typeof (span as { content?: unknown }).content === "string"
              ? (span as { content: string }).content.length
              : 0),
          0,
        )
      : 0,
    writeStatus: write?.status,
    storedCount: Array.isArray(write?.storedIds) ? write.storedIds.length : 0,
    organizationStatus: organization?.status,
    topicCount: Array.isArray(organization?.topicIds)
      ? organization.topicIds.length
      : 0,
  };
}

function buildReport() {
  const snapshot = tracker.snapshot();
  const recallRuns = runReports.filter((run) => run.run !== "seed");
  const recallRevisions = recallRuns.map((run) => run.indexRevision);
  const indexMessages = new Map<RunLabel, MemoryMessageFingerprint>();
  for (const request of requests) {
    const index = request.memoryMessages.find(
      (item) => item.kind === "topic_index",
    );
    if (index && !indexMessages.has(request.run))
      indexMessages.set(request.run, index);
  }
  const recallIndexes = ["recall-a", "recall-b", "recall-c"].map((run) =>
    indexMessages.get(run as RunLabel),
  );
  const seed = runReports.find((run) => run.run === "seed");
  const recallCompleted = recallRuns.every(
    (run) =>
      run.decision === "completed" &&
      run.evidenceStatus === "completed" &&
      Number(run.indexCount) > 0 &&
      Number(run.evidenceStateCount) > 0 &&
      Number(run.evidenceChars) <= 8_000 &&
      run.rawEvidenceStatus === "completed" &&
      Number(run.rawEvidenceSpanCount) > 0 &&
      Number(run.rawEvidenceChars) <= 6_000 &&
      run.coverageStatus === "completed" &&
      Number(run.coverageRequirementCount) > 0 &&
      Number(run.coverageCoveredCount) + Number(run.coveragePartialCount) > 0 &&
      Number(run.coverageSpanCount) <= 6 &&
      Number(run.coverageChars) <= 6_000,
  );
  const recallReadOnly = recallRuns.every(
    (run) => run.writeStatus === undefined && Number(run.storedCount) === 0,
  );
  const stableIndexRevision =
    recallRevisions.length === 3 &&
    typeof recallRevisions[0] === "string" &&
    recallRevisions.every((revision) => revision === recallRevisions[0]);
  const stableIndexPrefix =
    recallIndexes.every((index) => index !== undefined) &&
    recallIndexes.every(
      (index) =>
        index?.contentHash === recallIndexes[0]?.contentHash &&
        index?.stablePrefixHash === recallIndexes[0]?.stablePrefixHash,
    );
  const recallSettlements = settlements.filter(
    (settlement) =>
      settlement.phase === "agent_loop" && settlement.run !== "seed",
  );
  const recallCachedPromptTokens = recallSettlements.reduce(
    (total, settlement) => total + settlement.cachedPromptTokens,
    0,
  );
  const seedCompleted =
    seed?.decision === "completed" &&
    seed.writeStatus === "completed" &&
    Number(seed.storedCount) > 0 &&
    seed.organizationStatus === "completed" &&
    Number(seed.topicCount) > 0;
  const invariants = {
    seedCompleted,
    recallCompleted,
    recallReadOnly,
    stableIndexRevision,
    stableIndexPrefix,
    providerReportedCacheHit: snapshot.cachedPromptTokens > 0,
    providerReportedRecallCacheHit: recallCachedPromptTokens > 0,
    recallCachedPromptTokens,
    passed:
      seedCompleted &&
      recallCompleted &&
      recallReadOnly &&
      stableIndexRevision &&
      stableIndexPrefix,
  };
  return {
    schemaVersion: "paw.memory-topic-smoke.v1",
    workspaceRoot,
    model: "deepseek-v4-flash",
    scopeFingerprint,
    elapsedMs: Date.now() - startedAt,
    runs: runReports,
    cache: {
      promptTokens: snapshot.promptTokens,
      cachedPromptTokens: snapshot.cachedPromptTokens,
      cacheMissPromptTokens: snapshot.cacheMissPromptTokens,
      cacheHitRate: snapshot.cacheHitRate,
      completionTokens: snapshot.completionTokens,
      estimatedCost: snapshot.estimatedCost,
      currency: snapshot.costCurrency,
    },
    settlements,
    requests,
    invariants,
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

function lineValue(content: string, prefix: string): string | undefined {
  const line = content
    .split("\n")
    .find((candidate) => candidate.startsWith(prefix));
  return line?.slice(prefix.length);
}

function commonPrefixLength(
  left: readonly string[],
  right: readonly string[],
): number {
  const length = Math.min(left.length, right.length);
  let index = 0;
  while (index < length && left[index] === right[index]) index += 1;
  return index;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function redactDiagnostic(value: string): string {
  return value
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]+\b/g, "[REDACTED_API_KEY]")
    .slice(0, 1_000);
}
