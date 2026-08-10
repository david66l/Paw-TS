/**
 * M10 端到端反事实评测 harness —— 真实 orchestrator「先答→纠错」
 * ================================================================
 *
 * 【是什么】
 * 每条夹具：独立临时工作区 + 固定 repository_id → saveMemory 注入错误事实 →
 * pre-flight 检索守卫（beginTask+buildContextSection，与 orchestrator turn 0
 * 同一条检索路径）→ 真实 AgentOrchestrator 运行（记忆进 system prompt，agent
 * 真实读项目文件自纠）→ 双 rubric judge 判最终回答。
 *
 * 【关键设计】
 * 1. **per-fixture 唯一 scope**：seed 与 orchestrator 各自的 MemoryRuntime 都
 *    从 `.paw/settings.local.json` 解析到同一 repository_id → 写入隔离、可整体清理。
 * 2. **pre-flight 权威召回判定**：未召回 → 记 recalled:false + warning + 跳过
 *    真实运行（省成本，测量空转）；运行期用 memory.retrieve.done 交叉核验。
 * 3. **per-fixture 超时**：RunSpec.abortSignal + AbortController；超时 → run 返回
 *    status "aborted"，判 fail-closed。
 * 4. **全局 sql pool 生命周期**：seed runtime 与 orchestrator 内部 runtime 共享
 *    全局 pool（connection.ts getSql 单例）；orchestrator 从不关 runtime，所以
 *    跨 fixture 不 shutdown；最后 closeSql() 恰好一次（关全局池，包装 try/catch）。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { AgentOrchestrator } from "@paw/agent";
import type { RunEventEnvelope } from "@paw/core";
import {
  buildConversationAwareQuery,
  createMemoryRuntime,
  extractCleanMemoryQuery,
} from "@paw/memory";
import { closeSql, getSql } from "@paw/memory/db";
import type { LanguageModel } from "@paw/models";
import {
  LlmBudget,
  PostgresMemoryStoreEngine,
  deriveEntryId,
  type EpisodicExperience,
  type JudgeLlm,
  type LlmStats,
} from "@paw/memory/longterm";

import { M10_FIXTURES, type M10Fixture } from "./fixtures.js";
import { judgeCorrection } from "./judge.js";
import {
  summarizeAdversarial,
  type AdvItemResult,
  type MemoryAdversarialReport,
} from "./report.js";
import { cleanupFixtureRepo } from "./cleanup.js";

export interface MemoryAdversarialOptions {
  /** 真实 agent 模型（OpenAICompatibleModel / FakeLanguageModel 均可） */
  readonly model: LanguageModel;
  /** 双 rubric judge（ChatClient，JudgeLlm 形态） */
  readonly judge: JudgeLlm;
  /** agent provider 名（报告/诊断） */
  readonly provider?: string;
  readonly judgeProvider?: string;
  readonly maxSamples?: number;
  /** 保留 DB 数据与临时工作区（默认清理） */
  readonly keep?: boolean;
  /** orchestrator 步数上限（默认 20） */
  readonly maxSteps?: number;
  /** per-fixture 墙钟超时（默认 600s；超时 → fail-closed） */
  readonly fixtureTimeoutMs?: number;
  readonly now?: () => Date;
  /** 共享 judge stats（CLI 传入以聚合报告效率指标） */
  readonly stats?: LlmStats;
  /** judge 调用预算（默认 100） */
  readonly llmBudget?: number;
}

const DEFAULT_FIXTURE_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_STEPS = 20;

interface FixtureCtx {
  dir: string;
  repo: string;
}

/** 装配 per-fixture 临时工作区：settings（固定 repo scope）+ 项目文件 */
function setupWorkspace(f: M10Fixture, ts: string): FixtureCtx {
  const dir = mkdtempSync(path.join(tmpdir(), "paw-m10-"));
  const repo = `m10-${f.id}-${ts}`;
  const pawDir = path.join(dir, ".paw");
  mkdirSync(pawDir, { recursive: true });
  writeFileSync(
    path.join(pawDir, "settings.local.json"),
    JSON.stringify({
      memory_backend: "db",
      repository_id: repo,
      user_id: "m10",
    }),
    "utf8",
  );
  for (const file of f.workspaceFiles) {
    const p = path.join(dir, file.path);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, file.content, "utf8");
  }
  return { dir, repo };
}

/** 与 orchestrator turn 0 相同的检索查询推导（orchestrator.ts:2886-87） */
function retrievalQueryFor(goal: string): string {
  return buildConversationAwareQuery(goal) || extractCleanMemoryQuery(goal) || goal;
}

export async function runMemoryAdversarial(
  opts: MemoryAdversarialOptions,
): Promise<MemoryAdversarialReport> {
  const now = opts.now ?? (() => new Date());
  const ts = now().getTime().toString(36);
  const fixtures = M10_FIXTURES.slice(0, opts.maxSamples ?? M10_FIXTURES.length);
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  const timeoutMs = opts.fixtureTimeoutMs ?? DEFAULT_FIXTURE_TIMEOUT_MS;
  const stats: LlmStats = opts.stats ?? { calls: 0, retries: 0, failures: 0, totalMs: 0, estimatedTokens: 0 };
  const budget = new LlmBudget(opts.llmBudget ?? 100);
  const judge = budget.wrap(opts.judge);
  const sql = getSql();

  const items: AdvItemResult[] = [];
  const warnings: string[] = [];
  const dirs: string[] = [];

  try {
    for (const f of fixtures) {
      const started = now();
      const ctx = setupWorkspace(f, ts);
      dirs.push(ctx.dir);
      let modelCalls = 0;
      let runStatus = "skipped";

      // ── seed 反事实记忆 ──
      // v2 路径：T1 task_start 只注入 episodic/profile——semantic 种子不可见
      // （v1 的 keywordScore 守卫在 v2 无阈值，但触发点路由会滤掉 semantic）。
      // 因此：saveMemory 写 semantic（用户直写溯源），再经引擎直写一条 episodic，
      // whenToUse 回显 goal 关键短语（BM25 when_to_use 列命中），pre-flight 守卫用 episodic id。
      const runtime = await createMemoryRuntime({ workspaceRoot: ctx.dir });
      await runtime.saveMemory({
        title: f.falseMemory.title,
        summary: f.falseMemory.summary,
        content: f.falseMemory.content,
        type: f.falseMemory.type,
        relatedFiles: f.falseMemory.relatedFiles,
      });
      const nowIso = new Date().toISOString();
      const seedEntry: EpisodicExperience = {
        id: "",
        kind: "episodic",
        repo: runtime.scope.repositoryId,
        created: nowIso,
        tValid: nowIso,
        tInvalid: null,
        source: "user_statement",
        confidence: 1.0,
        evidence: [],
        freq: 0,
        utility: 0,
        whenToUse: f.falseMemory.title,
        perspective: f.falseMemory.content || f.falseMemory.summary,
        modification: [],
        issueType: "m10-fixture",
        taskId: "m10-fixture",
      };
      await new PostgresMemoryStoreEngine().put(seedEntry);
      const seedId = deriveEntryId(seedEntry);

      // ── pre-flight 检索守卫：seed 必须被注入，否则测量空转 ──
      let recalled = false;
      if (seedId) {
        const begun = await runtime.beginTask({ runId: `${ctx.repo}-preflight`, goal: f.goal, title: f.goal.slice(0, 120) });
        const section = await runtime.buildContextSection({
          taskId: begun.taskId,
          query: retrievalQueryFor(f.goal),
          tokenBudget: 1500,
          currentUserRequest: f.goal,
          limit: 8,
        });
        recalled = section.items.some((i) => i.id === seedId);
      }
      if (!recalled) {
        warnings.push(`${f.id}: seed 未被检索注入（saveMemory ${seedId ? "已写但检索阈值未过" : "失败"}）→ 跳过运行`);
        const elapsed = now().getTime() - started.getTime();
        items.push({
          id: f.id, recalled: false, status: "skipped",
          v1: "unjudged", v2: "unjudged", final: "unjudged", inconsistent: false,
          answerSnippet: "(not injected)", durationMs: elapsed, modelCalls: 0,
        });
        continue;
      }

      // ── 真实 orchestrator 运行（记忆进 system prompt，agent 读文件自纠） ──
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), timeoutMs);
      timer.unref?.();
      const events: RunEventEnvelope[] = [];
      const orchestrator = new AgentOrchestrator({
        model: opts.model,
        memoryExtraction: "off", // 废弃 no-op；completeTask 仍会写（per-fixture scope 隔离 + cleanup 回收）
        resolveToolApproval: async () => true,
        onEvent: (e) => events.push(e),
        evalHooks: {
          afterModelCall: () => { modelCalls += 1; },
        },
      });

      let finalAnswer = "";
      let runError: string | null = null;
      try {
        const result = await orchestrator.run({
          runId: `${ctx.repo}-run`,
          goal: f.goal,
          workspaceRoot: ctx.dir,
          maxSteps,
          abortSignal: abort.signal,
        });
        runStatus = result.status;
        finalAnswer = result.message ?? "";
      } catch (e) {
        runError = e instanceof Error ? e.message : String(e);
        runStatus = "error";
      } finally {
        clearTimeout(timer);
      }

      // 运行期召回交叉核验（memory.retrieve.done.selectedMemories）
      const rd = events.find((e) => e.event.type === "memory.retrieve.done");
      const injectedIds = rd && rd.event.type === "memory.retrieve.done"
        ? rd.event.selectedMemories.map((m) => m.id)
        : [];
      const runRecallOk = seedId ? injectedIds.includes(seedId) : false;
      if (!runRecallOk) {
        warnings.push(`${f.id}: 运行期 memory.retrieve.done 未见 seed（pre-flight 命中但真实运行未注入）`);
      }

      // ── 判纠错（双 rubric） ──
      let status: AdvItemResult["status"] = "unjudged";
      let v1 = "unjudged", v2 = "unjudged", final = "unjudged", inconsistent = false;
      if (runStatus === "completed") {
        const verdict = await judgeCorrection(judge, f, finalAnswer);
        v1 = verdict.v1; v2 = verdict.v2; final = verdict.final; inconsistent = verdict.inconsistent;
        status = (verdict.final === "corrected" || verdict.final === "uncorrected") ? verdict.final : "unjudged";
      } else {
        warnings.push(`${f.id}: 运行 ${runStatus}${runError ? `（${runError}）` : ""} → 无法判纠错`);
      }

      const elapsed = now().getTime() - started.getTime();
      items.push({
        id: f.id, recalled, status,
        v1, v2, final, inconsistent,
        answerSnippet: (finalAnswer || runError || `(${runStatus})`).slice(0, 120),
        durationMs: elapsed, modelCalls,
      });
    }
  } catch (e) {
    warnings.push(`套件中断: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    for (const dir of dirs) {
      try {
        if (!opts.keep) rmSync(dir, { recursive: true, force: true });
      } catch {
        /* 忽略临时目录清理失败 */
      }
    }
  }

  // 数据清理（--keep 跳过）
  if (!opts.keep) {
    for (const f of fixtures) {
      try {
        await cleanupFixtureRepo(sql, `m10-${f.id}-${ts}`);
      } catch (e) {
        warnings.push(`${f.id}: cleanup 失败: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  const summary = summarizeAdversarial(items);
  try {
    await closeSql();
  } catch {
    /* 忽略全局池关闭失败 */
  }

  return {
    suite: "memory-adversarial",
    generatedAt: now().toISOString(),
    provider: opts.provider,
    judgeProvider: opts.judgeProvider,
    passed: summary.passed,
    metrics: {
      夹具数: items.length,
      召回率: `${(summary.recallRate * 100).toFixed(1)}%`,
      纠正率: summary.correctionRate === null ? "无 judged 样本" : `${(summary.correctionRate * 100).toFixed(1)}%`,
      判定不一致: summary.inconsistent,
      平均耗时: `${(summary.avgDurationMs / 1000).toFixed(1)}s`,
      平均模型调用: summary.avgModelCalls.toFixed(1),
    },
    details: items,
    efficiency: {
      llmCalls: stats.calls,
      retries: stats.retries,
      failures: stats.failures,
      totalMs: stats.totalMs,
      estimatedTokens: stats.estimatedTokens,
      truncated: false,
    },
    warnings,
  };
}

/** 夹具列表（供 CLI/单测复用） */
export { M10_FIXTURES };
