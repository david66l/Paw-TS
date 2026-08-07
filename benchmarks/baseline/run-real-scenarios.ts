/**
 * 真实场景全测（real scenarios）——用真实 DeepSeek API 验证各机制的端到端效果。
 *
 * 场景：
 *  S1 P3 冷库+recall：web_fetch 大响应（GitHub API 581K chars）→ 截断归档 →
 *     模型用 context.recall 取回回答
 *  S2 约束生命周期：run1 带约束 → run2 反转意图 → 真实 LLM 调和 → 红线区更新
 *  S3 L1 prune：连续读取 8 个文件 → 超 keepRecentTools(5) → 落盘 + persisted-output
 *  S4 硬守卫：32k 窗口覆盖 + 长历史 → context.guard 事件 + [Context guard] 提示
 *  S5 侧信道 monitor：长任务观察 compression.monitor.trigger（10% 采样，观察为主）
 *  S6 L2 压缩+生命周期驱逐：32k 覆盖长任务 → compact 触发 + 摘要 + 回答正确性
 */

import path from "node:path";

import { AgentOrchestrator } from "../../packages/agent/src/orchestrator.js";
import type { RunEventEnvelope } from "../../packages/core/src/run-events.js";
import { InMemoryAppStateStore } from "../../packages/core/src/app-state.js";
import { CostTracker } from "../../packages/core/src/cost-tracker.js";
import { createDefaultLanguageModel } from "../../packages/models/src/default-model.js";
import type { LanguageModel } from "../../packages/models/src/types.js";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");

function collect(events: RunEventEnvelope[], type: string): unknown[] {
  return events.filter((e) => e.event.type === type).map((e) => e.event);
}

function windowOverride(base: LanguageModel, window: number): LanguageModel {
  return {
    label: `${base.label} (window-override ${window})`,
    capabilities: { contextWindow: window },
    complete: (m, o) => base.complete(m, o),
    completeStream: base.completeStream
      ? (m, o) => base.completeStream!(m, o)
      : undefined,
  };
}

async function run(opts: {
  name: string;
  goal: string;
  runId: string;
  maxSteps: number;
  model?: LanguageModel;
  appStateStore?: InMemoryAppStateStore;
  resumeFromState?: unknown;
  evalHooks?: import("@paw/core").EvalHooks;
}): Promise<{
  events: RunEventEnvelope[];
  status: string;
  message: string;
  tokens: number;
  cached: number;
}> {
  const events: RunEventEnvelope[] = [];
  const costTracker = new CostTracker();
  let promptTokens = 0;
  let cachedPromptTokens = 0;
  const orch = new AgentOrchestrator({
    model: opts.model,
    costTracker,
    memoryExtraction: "off",
    resolveToolApproval: async () => true,
    appStateStore: opts.appStateStore,
    evalHooks: opts.evalHooks,
    onEvent: (e) => {
      events.push(e);
      if (e.event.type === "cost.update") {
        promptTokens += e.event.turnPromptTokens ?? 0;
        cachedPromptTokens += e.event.cachedPromptTokens ?? 0;
      }
    },
  });
  const r = await orch.run({
    runId: opts.runId,
    goal: opts.goal,
    workspaceRoot: REPO_ROOT,
    maxSteps: opts.maxSteps,
    ...(opts.resumeFromState ? { resumeFromState: opts.resumeFromState } : {}),
  });
  return {
    events,
    status: r.status,
    message: r.message ?? "",
    tokens: promptTokens,
    cached: cachedPromptTokens,
  };
}

const realModel = createDefaultLanguageModel(REPO_ROOT);
const out: Record<string, unknown> = { date: new Date().toISOString() };

async function main(): Promise<void> {
  console.log(`[real-scenarios] model: ${realModel.label}\n`);

  // ── S1: P3 冷库 + recall（web_fetch 大响应）──
  {
    console.log("── S1: P3 冷库 + recall ──");
    const r = await run({
      name: "s1",
      goal: `1) 用 web_fetch 抓取 https://api.github.com/search/repositories?q=typescript&per_page=100 的完整内容（该响应很大，会被截断归档为 [archived id=N]）。
2) 找出第 5 个仓库的 full_name 字段值。
3) 如果输出被截断看不到第 5 个，用 context.recall 工具按 [archived id] 取回完整内容再回答。
4) 直接回答 full_name 的值。`,
      runId: `real-s1-${Date.now()}`,
      maxSteps: 12,
    });
    const archived = collect(r.events, "tool.result").filter((e) =>
      JSON.stringify(e).includes("[archived id="),
    ).length;
    const recalls = collect(r.events, "tool.call").filter(
      (e) => (e as { tool: string }).tool === "context.recall",
    ).length;
    const recallOk = collect(r.events, "tool.result").filter(
      (e) =>
        (e as { tool: string }).tool === "context.recall" &&
        (e as { ok: boolean }).ok,
    ).length;
    out.s1 = {
      status: r.status,
      archivedStubs: archived,
      recallCalls: recalls,
      recallOk,
      answer: r.message.slice(0, 200),
    };
    console.log(
      `  状态=${r.status} 归档桩=${archived} recall=${recalls}(成功${recallOk}) token=${r.tokens}`,
    );
    console.log(`  回答: ${r.message.slice(0, 120).replace(/\n/g, " ")}`);
  }

  // ── S2: 约束生命周期（真实 LLM 调和，多轮反转）──
  {
    console.log("\n── S2: 约束生命周期（反转意图）──");
    const store = new InMemoryAppStateStore();
    const runId = `real-s2-${Date.now()}`;
    const r1 = await run({
      name: "s2-1",
      goal: "不要修改 packages/agent/src/orchestrator.ts，只阅读它并告诉我 executeTurn 属于哪个类",
      runId,
      maxSteps: 4,
      appStateStore: store,
    });
    const saved = await store.load(runId);
    const r2 = await run({
      name: "s2-2",
      goal: "反转之前的决定：现在可以修改 packages/agent/src/orchestrator.ts 了，请把 executeTurn 的步骤 6 重构为独立函数",
      runId,
      maxSteps: 6,
      appStateStore: store,
      resumeFromState: saved,
    });
    const updates = collect(r2.events, "task.constraints.updated") as Array<{
      active: readonly string[];
      superseded: readonly string[];
      ok: boolean;
    }>;
    const last = updates.at(-1);
    out.s2 = {
      status1: r1.status,
      status2: r2.status,
      reconcileEvents: updates.length,
      lastActive: last?.active ?? [],
      lastSuperseded: last?.superseded ?? [],
      reconcileOk: last?.ok,
      answer: r2.message.slice(0, 200),
    };
    console.log(`  调和事件=${updates.length} ok=${last?.ok}`);
    console.log(`  active: ${(last?.active ?? []).join(" | ") || "(空)"}`);
    console.log(`  superseded: ${(last?.superseded ?? []).join(" | ") || "(空)"}`);
    console.log(`  回答: ${r2.message.slice(0, 120).replace(/\n/g, " ")}`);
  }

  // ── S3: L1 prune（>5 个工具结果落盘）──
  {
    console.log("\n── S3: L1 prune ──");
    const r = await run({
      name: "s3",
      goal: `依次读取以下 8 个文件，每个文件用一句话说明它的职责，最后汇总：
1. packages/agent/src/orchestrator.ts
2. packages/agent/src/orchestrator/action-handlers.ts
3. packages/agent/src/orchestrator/tool-runner.ts
4. packages/agent/src/orchestrator/types.ts
5. packages/agent/src/orchestrator/truncate-payload.ts
6. packages/agent/src/task-state.ts
7. packages/agent/src/compression-agent.ts
8. packages/agent/src/auxiliary-complete.ts`,
      runId: `real-s3-${Date.now()}`,
      maxSteps: 20,
    });
    const prunes = collect(r.events, "compression.prune.done").length;
    const persisted = collect(r.events, "tool.result").filter((e) =>
      JSON.stringify(e).includes("persisted-output"),
    ).length;
    out.s3 = { status: r.status, prunes, persistedOutputs: persisted };
    console.log(`  状态=${r.status} prune 事件=${prunes} persisted-output=${persisted} token=${r.tokens}`);
  }

  // ── S4+S6: 硬守卫 + L2 压缩（32k 窗口覆盖，长历史）──
  {
    console.log("\n── S4+S6: 硬守卫 + L2 压缩（32k 覆盖）──");
    const r = await run({
      name: "s4",
      goal: `依次完整阅读两个大文件并回答问题：
1. 阅读 packages/agent/src/orchestrator.ts 的完整内容（分块读完）
2. 阅读 packages/harness/src/registry/execution.ts 的完整内容
3. executeTurn 属于哪个类？executeTool 执行前用什么函数校验参数？
4. 两行回答。不要修改任何文件。`,
      runId: `real-s4-${Date.now()}`,
      maxSteps: 18,
      model: windowOverride(realModel, 32_000),
    });
    const guards = collect(r.events, "context.guard");
    const compacts = collect(r.events, "compression.auto_compact.done");
    const monitor = collect(r.events, "compression.monitor.trigger");
    const correct =
      r.message.includes("AgentOrchestrator") && r.message.includes("validateArgs");
    out.s4 = {
      status: r.status,
      guardEvents: guards.length,
      compactions: compacts.length,
      monitorTriggers: monitor.length,
      answerCorrect: correct,
      answer: r.message.slice(0, 200),
    };
    console.log(
      `  状态=${r.status} 硬守卫=${guards.length} 压缩=${compacts.length} monitor=${monitor.length} 回答正确=${correct}`,
    );
    console.log(`  回答: ${r.message.slice(0, 120).replace(/\n/g, " ")}`);
  }

  // ── S5: 侧信道 monitor 观察（长任务）──
  {
    console.log("\n── S5: 侧信道 monitor（观察）──");
    const r = await run({
      name: "s5",
      goal: `分三步完成任务：
第一步：阅读 packages/agent/src/orchestrator/truncate-payload.ts 并总结截断规则
第二步：阅读 packages/agent/src/orchestrator/context-summarizer.ts 并总结摘要策略
第三步：阅读 packages/agent/src/child-system-prompt.ts 并总结子 Agent 提示词结构
最后用三行分别总结这三步的要点。`,
      runId: `real-s5-${Date.now()}`,
      maxSteps: 15,
    });
    const monitor = collect(r.events, "compression.monitor.trigger");
    const compacts = collect(r.events, "compression.auto_compact.done");
    out.s5 = {
      status: r.status,
      monitorTriggers: monitor.length,
      compactions: compacts.length,
      skips: collect(r.events, "compression.skipped").length,
    };
    console.log(
      `  状态=${r.status} monitor=${monitor.length} 压缩=${compacts.length} token=${r.tokens}`,
    );
    if (monitor.length > 0) {
      console.log(
        `  monitor 触发: ${(monitor as Array<{ reason: string }>).map((m) => m.reason).join(", ")}`,
      );
    }
  }

  const outPath = path.join(REPO_ROOT, ".paw", "real-scenarios.json");
  await Bun.write(outPath, JSON.stringify(out, null, 2));
  console.log(`\n[real-scenarios] saved: ${outPath}`);
  // 强制退出：避免悬挂句柄（tiktoken WASM/网络连接）导致进程不退出
  process.exit(0);
}

await main();
