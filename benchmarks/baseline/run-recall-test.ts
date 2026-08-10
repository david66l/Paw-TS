/**
 * Recall 压力测试（AC-P3-11/12）——验证 P3 冷库的可寻址恢复闭环。
 *
 * 场景：模型 run_shell 输出大文件内容 → 入口闸截断 + 全文归档（[archived id=N]）→
 * 模型需要回答归档内容中的问题 → 观察是否调用 context.recall 且回答正确。
 *
 * 指标：
 *  - archivedStubs：上下文里出现过的归档引用桩数量（截断发生）
 *  - recallCalls：模型实际调用 context.recall 的次数（>0 且错误 id <20%）
 *  - recallValidIds：取回成功（id 有效）的调用数
 *  - answerCorrect：最终回答含关键符号（needle 恢复成功）
 */

import path from "node:path";

import { AgentOrchestrator } from "../../packages/agent/src/orchestrator.js";
import type { RunEventEnvelope } from "../../packages/core/src/run-events.js";
import { CostTracker } from "../../packages/core/src/cost-tracker.js";
import { createDefaultLanguageModel } from "../../packages/models/src/default-model.js";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");

const GOAL = `你必须使用 run_shell 工具执行命令（禁止用 read_file / grep / lsp 工具）：
1) 执行：cat packages/agent/src/orchestrator.ts
2) 该命令的输出会非常长，可能被截断并归档为 [archived id=N] 引用。
3) 根据输出（必要时用 context.recall 按 [archived id] 取回完整内容）找到 executeTurn 方法，它属于哪个类？
4) 最后直接回答类名。不要修改任何文件。`;

const EXPECTED = "AgentOrchestrator";

async function main(): Promise<void> {
  const realModel = createDefaultLanguageModel(REPO_ROOT);
  console.log(`[recall-test] model: ${realModel.label}\n`);

  const events: RunEventEnvelope[] = [];
  const costTracker = new CostTracker();
  let promptTokens = 0;
  let completionTokens = 0;
  let cachedPromptTokens = 0;

  const orch = new AgentOrchestrator({
    model: realModel,
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
  });

  const start = Date.now();
  let status = "failed";
  let answer = "";
  try {
    const r = await orch.run({
      runId: `recall-test-${Date.now()}`,
      goal: GOAL,
      workspaceRoot: REPO_ROOT,
      maxSteps: 12,
    });
    status = r.status;
    answer = r.message ?? "";
  } catch (err) {
    status = `error: ${err instanceof Error ? err.message : String(err)}`;
  }
  const durationMs = Date.now() - start;

  // 归档桩出现次数（截断发生）→ 从 beforeModelCall 看不到，用 tool.result 的 detail
  // 数 [archived 引用：所有 tool.result 事件 detail 含 archived 的次数
  const archivedStubs = events.filter((e) => {
    if (e.event.type !== "tool.result") return false;
    const d = (e.event as { detail?: string }).detail ?? "";
    return d.includes("[archived id=");
  }).length;
  const recallCalls = events.filter(
    (e) =>
      e.event.type === "tool.call" &&
      (e.event as { tool: string }).tool === "context.recall",
  );
  const recallOk = events.filter(
    (e) =>
      e.event.type === "tool.result" &&
      (e.event as { tool: string }).tool === "context.recall" &&
      (e.event as { ok: boolean }).ok,
  ).length;
  const recallFail = recallCalls.length - recallOk;
  const answerCorrect = answer.includes(EXPECTED);
  const totalTokens = promptTokens + completionTokens;
  const cacheHitRate =
    promptTokens > 0 ? cachedPromptTokens / promptTokens : 0;

  console.log(`status: ${status} (${(durationMs / 1000).toFixed(1)}s)`);
  console.log(`归档桩出现: ${archivedStubs} | recall 调用: ${recallCalls.length} (成功 ${recallOk} / 失败 ${recallFail})`);
  console.log(`回答正确: ${answerCorrect} | 回答: ${answer.slice(0, 120).replace(/\n/g, " ")}`);
  console.log(`token: ${totalTokens} (cached=${cachedPromptTokens}, hit=${(cacheHitRate * 100).toFixed(1)}%)`);
  console.log(`重试: ${events.filter((e) => e.event.type === "model.retry.waiting").length}`);

  const outPath = path.join(REPO_ROOT, ".paw", "recall-test.json");
  await Bun.write(
    outPath,
    JSON.stringify(
      {
        status,
        archivedStubs,
        recallCalls: recallCalls.length,
        recallOk,
        recallFail,
        answerCorrect,
        answer,
        totalTokens,
        promptTokens,
        cachedPromptTokens,
        cacheHitRate,
      },
      null,
      2,
    ),
  );
  console.log(`\n[recall-test] saved: ${outPath}`);
}

await main();
