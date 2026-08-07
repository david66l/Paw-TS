/**
 * 压缩压力测试（compression test）——验证 L2 压缩触发 + 压缩后信息正确性。
 *
 * 目标：基线里 3 个 e2e 任务都未触发压缩（prunes=0, compactions=0），
 * 压缩路径本身从未被端到端验证过。本脚本：
 *
 * 1. 构造长任务（连续读取 2 个长文件）强制上下文超过压缩阈值 → 触发 L2
 * 2. 从 evalHooks.beforeModelCall 抓取压缩后的摘要消息（[Context Summary] 前缀）
 * 3. 验证：
 *    a. 压缩真的触发（compression.auto_compact.done > 0）
 *    b. 摘要保留了关键信息（任务目标 / 关键符号 / 用户约束）
 *    c. 压缩后模型仍能正确回答（信息未丢失）
 *    d. 约束在压缩路径上存活
 *
 * 用法：bun run benchmarks/baseline/run-compression-test.ts
 */

import path from "node:path";

import { AgentOrchestrator } from "../../packages/agent/src/orchestrator.js";
import type { RunEventEnvelope } from "../../packages/core/src/run-events.js";
import { CostTracker } from "../../packages/core/src/cost-tracker.js";
import { createDefaultLanguageModel } from "../../packages/models/src/default-model.js";
import type { ChatMessage } from "../../packages/core/src/context/manager.js";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");
const SUMMARY_PREFIX = "[Context Summary]";

const GOAL = `依次阅读这两个文件的完整内容：
1. packages/agent/src/orchestrator.ts
2. packages/harness/src/registry/execution.ts

要求：
1. 找出 orchestrator.ts 中 executeTurn 方法所属的类名
2. 找出 execution.ts 中 executeTool 真正执行前校验工具参数用的函数名
3. 最后用两行分别回答这两个答案，不要多写。

约束：不要修改任何文件，不要执行任何命令。`;

const CONSTRAINT_KEYWORDS = ["不要修改", "不要执行"];
const EXPECTED_KEYWORDS = ["AgentOrchestrator", "validateArgs"];

interface CompressionTestResult {
  readonly triggered: boolean;
  readonly compactCount: number;
  readonly skippedCount: number;
  readonly afterTokens: number;
  readonly summaryTokens: number;
  readonly summaryFound: boolean;
  readonly summaryExcerpt: string;
  readonly summaryHasConstraint: boolean;
  readonly summaryHasExpected: boolean;
  readonly answerCorrect: boolean;
  readonly answerExcerpt: string;
  readonly totalTokens: number;
  readonly promptTokens: number;
  readonly cachedPromptTokens: number;
  readonly cacheHitRate: number;
  readonly retries: number;
  readonly budgetTrims: number;
  readonly status: string;
  readonly modelCalls: number;
}

async function main(): Promise<void> {
  const realModel = createDefaultLanguageModel(REPO_ROOT);
  // deepseek-v4 注册为 1M 窗口 → L2 阈值 690k，实际永不触发。
  // 覆盖为 32k 窗口（阈值 0.7*32k-10k ≈ 12.4k）强制触发压缩路径，
  // 摘要仍由真实模型生成。
  const model: LanguageModel = {
    label: `${realModel.label} (window-override 32k)`,
    capabilities: { contextWindow: 32_000 },
    complete: (m, o) => realModel.complete(m, o),
    completeStream: realModel.completeStream
      ? (m, o) => realModel.completeStream!(m, o)
      : undefined,
  };
  console.log(`[compression-test] model: ${model.label} (real=${realModel.label})\n`);

  const events: RunEventEnvelope[] = [];
  const summaries: string[] = [];
  const costTracker = new CostTracker();
  let promptTokens = 0;
  let completionTokens = 0;
  let cachedPromptTokens = 0;

  const orch = new AgentOrchestrator({
    model,
    costTracker,
    memoryExtraction: "off",
    resolveToolApproval: async () => true,
    onEvent: (e) => {
      events.push(e);
      if (e.event.type === "cost.update") {
        promptTokens += e.event.turnPromptTokens ?? 0;
        completionTokens += e.event.turnCompletionTokens ?? 0;
        cachedPromptTokens += e.event.cachedPromptTokens ?? 0;
      }
    },
    evalHooks: {
      beforeModelCall: ({ messages }) => {
        // 诊断：消息分布（压缩边界计算的输入）
        if (process.env.COMPRESSION_DEBUG === "1") {
          const sizes = (messages as ChatMessage[]).map(
            (m) => `${m.role}:${m.content.length}`,
          );
          console.log(
            `[debug] ${(messages as ChatMessage[]).length} msgs: ${sizes.join(", ")}`,
          );
        }
        for (const m of messages) {
          if (m.role === "user" && m.content.includes(SUMMARY_PREFIX)) {
            summaries.push(m.content);
          }
        }
      },
    },
  });

  const start = Date.now();
  let status = "failed";
  let answer = "";
  try {
    const r = await orch.run({
      runId: `compression-test-${Date.now()}`,
      goal: GOAL,
      workspaceRoot: REPO_ROOT,
      maxSteps: 15,
    });
    status = r.status;
    answer = r.message ?? "";
  } catch (err) {
    status = `error: ${err instanceof Error ? err.message : String(err)}`;
  }
  const durationMs = Date.now() - start;

  const compactions = events.filter(
    (e) => e.event.type === "compression.auto_compact.done",
  );
  const skips = events.filter((e) => e.event.type === "compression.skipped");
  const skipReasons = skips
    .map((e) =>
      e.event.type === "compression.skipped"
        ? `${e.event.reason}${
            e.event.beforeTokens !== undefined
              ? ` (${e.event.beforeTokens}→${e.event.afterTokens})`
              : ""
          }`
        : "",
    )
    .filter(Boolean);
  const trims = events.filter((e) => e.event.type === "context.budget.trimmed");
  const retries = events.filter((e) => e.event.type === "model.retry.waiting");

  const lastCompact = compactions.at(-1);
  const afterTokens = lastCompact?.event.afterTokens ?? 0;
  const summaryTokens = lastCompact?.event.summaryTokens ?? 0;

  const summary = summaries.at(-1) ?? "";
  const summaryHasConstraint = CONSTRAINT_KEYWORDS.some((k) =>
    summary.includes(k),
  );
  const summaryHasExpected = EXPECTED_KEYWORDS.some((k) => summary.includes(k));
  const answerCorrect = EXPECTED_KEYWORDS.every((k) => answer.includes(k));

  const totalTokens = promptTokens + completionTokens;
  const cacheHitRate =
    promptTokens > 0 ? cachedPromptTokens / promptTokens : 0;

  const result: CompressionTestResult = {
    triggered: compactions.length > 0,
    compactCount: compactions.length,
    skippedCount: skips.length,
    afterTokens,
    summaryTokens,
    summaryFound: summary.length > 0,
    summaryExcerpt: summary.slice(0, 300).replace(/\n/g, " "),
    summaryHasConstraint,
    summaryHasExpected,
    answerCorrect,
    answerExcerpt: answer.slice(0, 200).replace(/\n/g, " "),
    totalTokens,
    promptTokens,
    cachedPromptTokens,
    cacheHitRate,
    retries: retries.length,
    budgetTrims: trims.length,
    status,
    modelCalls: events.filter((e) => e.event.type === "model.request").length,
  };

  // ── 输出 ──
  console.log(`status: ${status} (${(durationMs / 1000).toFixed(1)}s)`);
  console.log(`压缩触发: ${result.triggered} (compact=${result.compactCount}, skipped=${result.skippedCount})`);
  console.log(`跳过原因: ${skipReasons.join(" | ") || "(none)"}`);
  console.log(`压缩后 tokens: ${afterTokens}, 摘要 tokens: ${summaryTokens}`);
  console.log(`摘要抓到: ${result.summaryFound}`);
  console.log(`摘要含约束: ${result.summaryHasConstraint} | 摘要含关键符号: ${result.summaryHasExpected}`);
  console.log(`回答正确: ${result.answerCorrect}`);
  console.log(`token: ${totalTokens} (cached=${cachedPromptTokens}, hit=${(cacheHitRate * 100).toFixed(1)}%)`);
  console.log(`重试: ${result.retries} | L3 截断: ${result.budgetTrims}`);
  console.log(`\n摘要摘录: ${result.summaryExcerpt}`);
  console.log(`\n回答摘录: ${result.answerExcerpt}`);

  const outPath = path.join(REPO_ROOT, ".paw", "compression-test.json");
  await Bun.write(
    outPath,
    JSON.stringify({ ...result, summaries }, null, 2),
  );
  console.log(`\n[compression-test] saved: ${outPath}`);
}

await main();
