/**
 * 上下文管理基线测量（baseline）——优化前基准数据采集。
 *
 * 用法：bun run benchmarks/baseline/run-baseline.ts [--e2e] [--constraint]
 * 默认两个都跑。需要工作区配置了模型（.paw/settings.local.json）。
 *
 * 6 项指标：
 *  1. token 消耗/任务   → cost.update 事件累加（prompt+completion）
 *  2. cache 命中率      → cost.update 的 cachedPromptTokens / promptTokens
 *  3. recall 使用率     → N/A（工具不存在，基线 = 0）
 *  4. 超窗/重试次数     → model.retry.waiting（API 错误重试）+ context.budget.trimmed（L3 驱逐）
 *  5. 成功率            → 任务 completed 且答案含关键符号
 *  6. 约束存活率        → 真实 LLM 摘要（runCompressionAgent）后约束关键词存活比例
 *
 * 优化后跑同一脚本对比（docs/problems/05 的验证指标）。
 */

import path from "node:path";

import { AgentOrchestrator } from "../../packages/agent/src/orchestrator.js";
import { runCompressionAgent } from "../../packages/agent/src/compression-agent.js";
import type { RunEventEnvelope } from "../../packages/core/src/run-events.js";
import { CostTracker } from "../../packages/core/src/cost-tracker.js";
import { createDefaultLanguageModel } from "../../packages/models/src/default-model.js";
import type { LanguageModel } from "../../packages/models/src/types.js";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");

// ═══════════════════════════════════════════════════════════
// 端到端任务（长文件 + 确定性答案，触发 L1/L2 压缩）
// ═══════════════════════════════════════════════════════════

interface E2ETask {
  readonly id: string;
  readonly goal: string;
  /** 答案必须包含的符号（宽松判定：completed 且 message 含任一） */
  readonly keywords: readonly string[];
}

const E2E_TASKS: readonly E2ETask[] = [
  {
    id: "orchestrator-loop",
    goal:
      "阅读 packages/agent/src/orchestrator.ts，找出：executeTurn 方法在哪个类中定义？它的步骤 6（动作分发）调用哪个函数？直接回答，不用修改任何文件。",
    keywords: ["handleAction", "AgentOrchestrator"],
  },
  {
    id: "execution-validate",
    goal:
      "阅读 packages/harness/src/registry/execution.ts，找出：executeTool 在真正执行工具前用什么函数校验工具参数？直接回答函数名，不用修改任何文件。",
    keywords: ["validateArgs"],
  },
  {
    id: "useagentrun-hook",
    goal:
      "阅读 apps/desktop/src/agent/useAgentRun.ts 的前 400 行，找出：这个自定义 React hook 主要管理 agent 运行的哪些状态？概括回答，不用修改任何文件。",
    keywords: ["run", "agent", "status"],
  },
];

// ═══════════════════════════════════════════════════════════
// 约束存活场景（管线级：真实 LLM 摘要）
// ═══════════════════════════════════════════════════════════

interface ConstraintScenario {
  readonly id: string;
  /** 用户明确给出的约束（必须逐字存活） */
  readonly constraint: string;
  /** 存活判定关键词（摘要中必须包含） */
  readonly checkKeywords: readonly string[];
  /** 摘要 prompt 的正文（模拟真实对话，含噪音） */
  readonly conversation: string;
}

function buildNoiseTurn(n: number): string {
  return `[User]\n继续处理第 ${n} 个文件的读取结果，检查其中的错误日志。\n[Assistant]\n已读取第 ${n} 个文件，发现 ${n} 处可以优化，先记录到工作记忆，继续下一个文件。`;
}

function buildMidConversation(constraint: string): string {
  // v3 P0 验收：约束埋在对话中段（第 7 条消息附近），非 prompt 顶部——
  // 这是真实场景（用户中途补充约束），也是摘要器最容易丢约束的位置
  const turns = Array.from({ length: 12 }, (_, i) => buildNoiseTurn(i + 1));
  turns.splice(6, 0, `[User]\n补充一个约束：${constraint}。后续所有操作必须遵守。`);
  return turns.join("\n\n");
}

const CONSTRAINT_SCENARIOS: readonly ConstraintScenario[] = [
  {
    id: "cn-do-not-modify",
    constraint: "不要修改 src/index.ts",
    checkKeywords: ["src/index.ts"],
    conversation: buildMidConversation("不要修改 src/index.ts"),
  },
  {
    id: "en-no-force-push",
    constraint: "Never run git push --force",
    checkKeywords: ["git push", "force"],
    conversation: buildMidConversation("Never run git push --force"),
  },
  {
    id: "cn-must-use-format",
    constraint: "所有新增代码必须使用 2 空格缩进",
    checkKeywords: ["2 空格", "缩进"],
    conversation: buildMidConversation("所有新增代码必须使用 2 空格缩进"),
  },
];

// ═══════════════════════════════════════════════════════════
// 指标收集
// ═══════════════════════════════════════════════════════════

interface E2EMetrics {
  readonly id: string;
  readonly status: string;
  readonly ok: boolean;
  readonly answerContainsKeyword: boolean;
  readonly durationMs: number;
  readonly modelCalls: number;
  readonly toolCalls: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly cachedPromptTokens: number;
  readonly totalTokens: number;
  readonly cacheHitRate: number;
  readonly retries: number;
  readonly budgetTrims: number;
  readonly prunes: number;
  readonly compactions: number;
  readonly truncations: number;
}

async function runE2ETask(
  task: E2ETask,
  model: LanguageModel,
): Promise<E2EMetrics> {
  const events: RunEventEnvelope[] = [];
  let promptTokens = 0;
  let completionTokens = 0;
  let cachedPromptTokens = 0;
  const costTracker = new CostTracker();
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
  });

  const start = Date.now();
  let status = "failed";
  let message = "";
  try {
    const result = await orch.run({
      runId: `baseline-${task.id}-${Date.now()}`,
      goal: task.goal,
      workspaceRoot: REPO_ROOT,
      maxSteps: 10,
    });
    status = result.status;
    message = result.message ?? "";
  } catch (err) {
    status = `error: ${err instanceof Error ? err.message : String(err)}`;
  }
  const durationMs = Date.now() - start;

  const totalTokens = promptTokens + completionTokens;
  const cacheHitRate =
    promptTokens > 0 ? cachedPromptTokens / promptTokens : 0;

  const retries = events.filter((e) => e.event.type === "model.retry.waiting").length;
  const budgetTrims = events.filter((e) => e.event.type === "context.budget.trimmed").length;
  const prunes = events.filter((e) => e.event.type === "compression.prune.done").length;
  const compactions = events.filter(
    (e) => e.event.type === "compression.auto_compact.done",
  ).length;
  const truncations = events.filter((e) => e.event.type === "model.truncated").length;

  return {
    id: task.id,
    status,
    ok: status === "completed",
    answerContainsKeyword: task.keywords.some((k) => message.includes(k)),
    durationMs,
    modelCalls: events.filter((e) => e.event.type === "model.request").length,
    toolCalls: events.filter((e) => e.event.type === "tool.call").length,
    promptTokens,
    completionTokens,
    cachedPromptTokens,
    totalTokens,
    cacheHitRate,
    retries,
    budgetTrims,
    prunes,
    compactions,
    truncations,
  };
}

// ═══════════════════════════════════════════════════════════
// 约束存活
// ═══════════════════════════════════════════════════════════

async function runConstraintScenario(
  s: ConstraintScenario,
  model: LanguageModel,
): Promise<{ id: string; survived: boolean; summary: string }> {
  const prompt = `Summarize the following conversation. The user's explicit constraints MUST be preserved verbatim in the summary.

Conversation:
${s.conversation}`;
  const { summary } = await runCompressionAgent(
    model,
    prompt,
    `baseline-constraint-${s.id}-${Date.now()}`,
  );
  // v3 P0 验收：约束**整句逐字**存活（忽略空白差异），非关键词命中
  const normalizedConstraint = s.constraint.replace(/\s+/g, " ").trim();
  const normalizedSummary = summary.replace(/\s+/g, " ");
  const survived = normalizedSummary.includes(normalizedConstraint);
  return { id: s.id, survived, summary };
}

// ═══════════════════════════════════════════════════════════
// 主入口
// ═══════════════════════════════════════════════════════════

const runE2E = !process.argv.includes("--no-e2e");
const runConstraint = !process.argv.includes("--no-constraint");

const model = createDefaultLanguageModel(REPO_ROOT);
console.log(`[baseline] model: ${model.label}`);
console.log(`[baseline] repo: ${REPO_ROOT}\n`);

const out: Record<string, unknown> = {
  date: new Date().toISOString(),
  model: model.label,
  e2e: [],
  constraint: [],
};

if (runE2E) {
  for (const task of E2E_TASKS) {
    console.log(`[e2e] running: ${task.id} ...`);
    const m = await runE2ETask(task, model);
    out.e2e.push(m);
    console.log(
      `  status=${m.status} ok=${m.ok} keyword=${m.answerContainsKeyword}`,
      `tokens=${m.totalTokens} (prompt=${m.promptTokens}, cached=${m.cachedPromptTokens})`,
      `cacheHit=${(m.cacheHitRate * 100).toFixed(1)}%`,
      `calls=${m.modelCalls} tools=${m.toolCalls} retries=${m.retries} trims=${m.budgetTrims}`,
      `prunes=${m.prunes} compactions=${m.compactions} trunc=${m.truncations}`,
      `${(m.durationMs / 1000).toFixed(1)}s\n`,
    );
  }

  const done = (out.e2e as E2EMetrics[]).filter((m) => m.ok);
  const tok = (out.e2e as E2EMetrics[]).reduce((s, m) => s + m.totalTokens, 0);
  const ret = (out.e2e as E2EMetrics[]).reduce((s, m) => s + m.retries, 0);
  const trim = (out.e2e as E2EMetrics[]).reduce((s, m) => s + m.budgetTrims, 0);
  const cache = (out.e2e as E2EMetrics[]).reduce(
    (s, m) => s + m.cachedPromptTokens,
    0,
  );
  const prompt = (out.e2e as E2EMetrics[]).reduce(
    (s, m) => s + m.promptTokens,
    0,
  );
  console.log(
    `[e2e] SUMMARY: success=${done.length}/${(out.e2e as E2EMetrics[]).length}`,
    `avgTokens=${Math.round(tok / Math.max(1, (out.e2e as E2EMetrics[]).length))}`,
    `retries=${ret} budgetTrims=${trim}`,
    `cacheHitRate=${prompt > 0 ? ((cache / prompt) * 100).toFixed(1) : "n/a"}%`,
  );
}

if (runConstraint) {
  for (const s of CONSTRAINT_SCENARIOS) {
    console.log(`[constraint] running: ${s.id} ...`);
    const r = await runConstraintScenario(s, model);
    out.constraint.push(r);
    console.log(
      `  survived=${r.survived} keyword=${s.constraint}\n  summary-head: ${r.summary.slice(0, 120).replace(/\n/g, " ")}\n`,
    );
  }
  const survived = (out.constraint as { survived: boolean }[]).filter(
    (r) => r.survived,
  ).length;
  console.log(
    `[constraint] SUMMARY: survived=${survived}/${(out.constraint as { survived: boolean }[]).length}`,
  );
}

// 落盘基线结果，便于优化后对比
const outPath = path.join(REPO_ROOT, ".paw", "baseline-context.json");
await Bun.write(outPath, JSON.stringify(out, null, 2));
console.log(`\n[baseline] saved: ${outPath}`);
