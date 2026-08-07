/**
 * Backbone 敏感性冒烟评测（spec v2 §11.5，红队第二层后续扩展）
 *
 * 换 backbone 后跑 10 条写入/检索冒烟，验证新 backbone 的蒸馏能力与检索协同：
 * - schema 合格率：真实 distiller 走写入管线（task_succeeded + test passed），
 *   记录每条写入的 status（written/degraded/rejected/noop）
 * - 检索命中率：对 written 条目用 keyword/query 探针跑 hybridRecall，检查命中
 * - 弱模型专项：unverified 占比 <30%（spec §5.7 红线）+ 降级路径生效
 *   （degraded 条目必须带 memoryId——证明走了 storeDegraded append-only 而非丢弃）
 * - 达标判定：schema 合格率 ≥0.8 且 检索命中率 ≥0.7 且 unverified <0.3
 *
 * 关键约束（源码确认）：
 * - 降级条目（payload.degraded=true）不进检索池（postgres-engine searchText/
 *   searchVector 硬默认）→ degraded 条目检索天然 miss，是"双惩罚"设计意图：
 *   弱模型同时压低 schema 与 recall，冒烟响亮失败
 * - unverified 可纯从 ProcessResult.status 推导（degraded→unverified，
 *   written→verified），无需查库 → 可单测
 * - consolidate 的成本熔断读全库当日 write.distill op-log，满 budget 会虚假
 *   降级 → 冒烟管线必须抬高 dailyBudget（500）
 * - processEvent 直接调用（不经 outbox worker），与 perturbation.seedViaPipeline 同模式
 */

import type { MemoryStoreEngine } from "../store/engine.js";
import { PostgresMemoryStoreEngine } from "../store/postgres-engine.js";
import { MemoryWritePipeline, type ProcessResult } from "../write/pipeline.js";
import { MemoryDistiller } from "../write/distiller.js";
import { hybridRecall } from "../retrieval/hybrid.js";
import { appendOpLog } from "../observability/op-log.js";
import { getSql } from "../../db/connection.js";
import { LlmBudget } from "./perturbation.js";
import type { JudgeLlm } from "./replay.js";
import type { LlmStats } from "./llm-client.js";

// ═══════════════════════════════════════════════════════════════
// 夹具
// ═══════════════════════════════════════════════════════════════

export interface SmokeFixture {
  id: string;
  /** 报告里的人类可读标签 */
  description: string;
  /** distill input.goal */
  goal: string;
  /** distill input.trajectory（3-6 步，含独特技术名词） */
  trajectory: string;
  /** 自然语言检索探针 */
  query: string;
  /** 检索词探针；与 query 一样须在 NGram 口径下（非字母数字→空格保留进 gram）与 trajectory 共享 ≥1 个 3-gram。
   *  启发式：探针的独特技术名词须逐字出现在轨迹里，蒸馏才可能保留并命中（非召回保证）。 */
  keywords: string[];
}

/**
 * 10 条合成任务 + 相关轨迹。
 *
 * 设计原则（单测固化）：
 * 1. 领域互异（构建/测试/依赖/迁移/配置/缓存/连接池/构建产物/日志/队列），
 *    避免 governor 跨 fixture 判 NOOP/UPDATE 混淆 schema 合格率
 * 2. 独特技术名词（bun/构建/缓存…），distiller 去具体化纪律 1 允许保留 → 检索可命中
 * 3. query/keywords/trajectory 三者共享 ≥1 个 3 字 trigram（NGram 召回硬前提）
 * 4. 不触发密钥拦截（scanForSecrets().action !== "reject"）
 * 5. smoke-06/07/10 刻意含"报错"失败→成功转折，触发 failureFixPair 纪律——
 *    弱模型常在此 validate 失败降级，是弱模型敏感性的强探针
 */
export const SMOKE_FIXTURES: SmokeFixture[] = [
  {
    id: "smoke-01",
    description: "项目构建命令",
    goal: "配置并验证本项目的构建命令",
    trajectory: "在构建配置中声明构建脚本，脚本内容为 bun run build，执行 bun run build 构建命令执行成功并生成构建产物目录",
    query: "本项目的构建命令是什么？",
    keywords: ["构建", "命令", "build"],
  },
  {
    id: "smoke-02",
    description: "单元测试运行方式",
    goal: "配置本仓库的单元测试运行命令",
    trajectory: "安装测试依赖后，在 scripts 中添加入口为 test 的脚本，用 bun test 运行全部单元测试并全部通过",
    query: "仓库跑单元测试用什么命令？",
    keywords: ["测试", "命令", "bun"],
  },
  {
    id: "smoke-03",
    description: "依赖安装包管理器",
    goal: "确定本仓库的依赖安装方式",
    trajectory: "发现仓库根目录存在 bun.lock 文件，用 bun install 安装依赖成功，并把安装命令记录到 README",
    query: "安装依赖应该用哪个包管理器？",
    keywords: ["bun", "安装", "依赖"],
  },
  {
    id: "smoke-04",
    description: "生产库结构变更",
    goal: "通过迁移脚本变更生产数据库结构",
    trajectory: "创建数据库迁移脚本，用迁移命令应用该脚本，表结构变更成功生效",
    query: "生产数据库结构变更怎么做？",
    keywords: ["迁移", "数据库", "脚本"],
  },
  {
    id: "smoke-05",
    description: "服务配置管理",
    goal: "建立服务配置管理方式",
    trajectory: "创建环境变量模板文件，配置模块负责加载环境变量，真实值不提交到仓库",
    query: "项目的配置模块放在哪里管理？",
    keywords: ["配置", "环境变量", "模板"],
  },
  {
    id: "smoke-06",
    description: "缓存穿透修复",
    goal: "修复接口缓存穿透导致数据库压力过大的问题",
    trajectory: "接口反复穿透缓存导致数据库报错，添加负缓存并设置短过期时间后数据库压力恢复稳定",
    query: "缓存穿透导致数据库报错怎么办？",
    keywords: ["缓存", "穿透", "数据库"],
  },
  {
    id: "smoke-07",
    description: "连接池耗尽排查",
    goal: "排查服务连接池耗尽问题",
    trajectory: "连接池报错耗尽，检查发现存在泄漏的事务未释放，修复后连接池恢复正常",
    query: "连接池耗尽怎么排查？",
    keywords: ["连接池", "事务", "泄漏"],
  },
  {
    id: "smoke-08",
    description: "构建产物陈旧",
    goal: "解决增量构建产物陈旧问题",
    trajectory: "增量构建产物内容陈旧导致输出不一致，清空构建缓存后重新构建，产物输出一致",
    query: "构建产物不一致怎么排查？",
    keywords: ["构建", "缓存", "产物"],
  },
  {
    id: "smoke-09",
    description: "日志占满磁盘",
    goal: "处理日志轮转占满磁盘的问题",
    trajectory: "日志轮转保留过期日志导致磁盘被打满，调整保留窗口后磁盘占用恢复稳定",
    query: "日志轮转保留过期日志打满磁盘怎么处理？",
    keywords: ["日志轮转", "磁盘"],
  },
  {
    id: "smoke-10",
    description: "队列积压缓解",
    goal: "缓解消息队列积压问题",
    trajectory: "消费者处理速度跟不上导致队列积压报错，扩容消费者后积压逐渐消化恢复正常",
    query: "消息队列积压怎么缓解？",
    keywords: ["队列", "积压", "消费者"],
  },
];

// ═══════════════════════════════════════════════════════════════
// 达标阈值（spec §11.5）
// ═══════════════════════════════════════════════════════════════

export const SMOKE_SCHEMA_RATE_MIN = 0.8;
/** NGram 中文召回有碎片性，故取 0.7 而非 0.8 */
export const SMOKE_RECALL_RATE_MIN = 0.7;
/** spec §5.7 弱模型红线 */
export const SMOKE_UNVERIFIED_MAX = 0.3;

// ═══════════════════════════════════════════════════════════════
// 纯函数：unverified 推导 / 探针 / 汇总 / 达标
// ═══════════════════════════════════════════════════════════════

export type SmokeProbeMode = "keyword" | "query";

/** 检索探针：keyword 模式 join(keywords," ")；query 模式返回自然语言查询 */
export function smokeProbe(f: SmokeFixture, mode: SmokeProbeMode): string {
  return mode === "keyword" ? f.keywords.join(" ") : f.query;
}

export type SmokeWriteStatus = "written" | "degraded" | "rejected" | "noop";

export interface SmokeItemResult {
  fixtureId: string;
  status: SmokeWriteStatus;
  /** written → 全部候选 id；degraded → [memoryId]；其余 [] */
  memoryIds: string[];
  recalledByKeyword: boolean;
  recalledByQuery: boolean;
  /** noop/rejected 的原因或备注 */
  detail: string;
}

export interface SmokeSummary {
  schemaRate: number;
  keywordRecall: number;
  /** 诊断指标（不进 passed）：NL 探针的端到端现实度 */
  queryRecall: number;
  /** 诊断指标（不进 passed）：把"蒸馏失败导致的天然 miss"从"检索层 miss"里拆出来 */
  writtenOnlyRecall: number;
  /** 弱模型红线：degraded / (written + degraded)；全 rejected/noop → null */
  unverifiedRatio: number | null;
  /** 降级路径生效：degraded>0 时每条都带非空 memoryId，否则真空成立 */
  degradedPathOk: boolean;
  passed: boolean | null;
}

/** 纯函数：汇总冒烟指标与达标判定 */
export function summarizeSmoke(items: readonly SmokeItemResult[]): SmokeSummary {
  const total = items.length;
  const written = items.filter((i) => i.status === "written");
  const degraded = items.filter((i) => i.status === "degraded");
  const schemaRate = total > 0 ? written.length / total : 0;
  const keywordHits = items.filter((i) => i.recalledByKeyword).length;
  const queryHits = items.filter((i) => i.recalledByQuery).length;
  const unverifiedRatio = written.length + degraded.length > 0 ? degraded.length / (written.length + degraded.length) : null;
  const degradedPathOk = degraded.length > 0 ? degraded.every((i) => i.memoryIds.length > 0) : true;

  const passed =
    total === 0 || unverifiedRatio === null
      ? null
      : schemaRate >= SMOKE_SCHEMA_RATE_MIN && keywordRecallRate(keywordHits, total) >= SMOKE_RECALL_RATE_MIN && unverifiedRatio < SMOKE_UNVERIFIED_MAX;

  return {
    schemaRate,
    keywordRecall: keywordRecallRate(keywordHits, total),
    queryRecall: keywordRecallRate(queryHits, total),
    writtenOnlyRecall: written.length > 0 ? keywordHits / written.length : 0,
    unverifiedRatio,
    degradedPathOk,
    passed,
  };
}

function keywordRecallRate(hits: number, total: number): number {
  return total > 0 ? hits / total : 0;
}

/**
 * 达标判定（spec §11.5）。unverifiedRatio 为 null（无写入）→ null（样本不足）。
 */
export function smokePassed(
  schemaRate: number,
  keywordRecall: number,
  unverifiedRatio: number | null,
): boolean | null {
  if (unverifiedRatio === null) return null;
  return schemaRate >= SMOKE_SCHEMA_RATE_MIN && keywordRecall >= SMOKE_RECALL_RATE_MIN && unverifiedRatio < SMOKE_UNVERIFIED_MAX;
}

// ═══════════════════════════════════════════════════════════════
// 报告
// ═══════════════════════════════════════════════════════════════

export interface BackboneSmokeReport {
  suite: "backbone-smoke";
  generatedAt: string;
  /** 诊断用（模型名，不含密钥） */
  provider?: string;
  passed: boolean | null;
  metrics: Record<string, number | string | boolean | null>;
  details: SmokeItemResult[];
  efficiency: {
    llmCalls: number;
    retries: number;
    failures: number;
    totalMs: number;
    estimatedTokens: number;
    truncated: boolean;
  };
  warnings: string[];
}

const READONLY_HINT = "为防止弱模型腐蚀记忆库（spec §5.7/§11.5），建议运行：paw-ts memory readonly on";

/** 纯函数：渲染报告文本 */
export function renderBackboneSmokeReport(r: BackboneSmokeReport): string {
  const lines = [
    `Backbone 冒烟 [${r.provider ?? "?"}]    ${r.passed === null ? "判定: 无法判定（无写入）" : r.passed ? "判定: ✅ 达标" : "判定: ❌ 未达标"}`,
    `  生成时间: ${r.generatedAt}`,
  ];
  for (const [k, v] of Object.entries(r.metrics)) {
    lines.push(`  ${k}: ${typeof v === "number" && !Number.isInteger(v) ? (v * 100).toFixed(1) + "%" : v}`);
  }
  lines.push(
    `  效率: LLM 调用 ${r.efficiency.llmCalls} 次（重试 ${r.efficiency.retries}，失败 ${r.efficiency.failures}），` +
    `耗时 ${(r.efficiency.totalMs / 1000).toFixed(1)}s，估算 ~${r.efficiency.estimatedTokens} tokens` +
    (r.efficiency.truncated ? "，⚠ 预算截断" : ""),
  );
  // passed !== true（未达标或无法判定）都给只读提示：全拒/无写入也是弱模型信号（fail-closed）
  if (r.passed !== true) lines.push(`  ⚠ ${READONLY_HINT}`);
  for (const w of r.warnings) lines.push(`  ⚠ ${w}`);
  if (r.details.length > 0) {
    lines.push("  ── 明细 ──");
    for (const d of r.details) {
      const recalled = d.recalledByKeyword ? "k✓" : "k✗";
      lines.push(`  ${d.fixtureId}  ${d.status}  ${recalled}${d.recalledByQuery ? "/q✓" : "/q✗"}  ${d.memoryIds.length} 条${d.detail ? `  ${d.detail}` : ""}`);
    }
  }
  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════
// 运行
// ═══════════════════════════════════════════════════════════════

export interface BackboneSmokeOptions {
  engine?: MemoryStoreEngine;
  /** ChatClient 同时满足 distiller 与 governor 接口 */
  backbone: JudgeLlm;
  stats?: LlmStats;
  /** 报告诊断用（模型名，不含密钥） */
  provider?: string;
  /** 保留 smoke repo 数据不清理 */
  keep?: boolean;
  maxSamples?: number;
  /** LLM 调用硬上限，默认 100 */
  llmBudget?: number;
  /** 整体墙钟上限（毫秒），默认 15 分钟；超时 → 中断 + passed=null fail-closed */
  timeoutMs?: number;
  now?: () => Date;
  /** 注入真实 LongtermGovernor（走完整五道关）；默认 true，--no-governed 逃生口 */
  governed?: boolean;
  /** 测试注入 */
  pipelineFactory?: (backbone: JudgeLlm) => MemoryWritePipeline;
}

function truncate<T>(xs: readonly T[], maxSamples?: number): T[] {
  return maxSamples !== undefined ? xs.slice(0, maxSamples) : [...xs];
}

function statusOf(r: ProcessResult): SmokeWriteStatus {
  switch (r.status) {
    case "written": return "written";
    case "degraded": return "degraded";
    case "rejected": return "rejected";
    case "corrected": return "written"; // 用户纠正直写路径（冒烟不走，防御性映射）
    case "trialed": return "noop";
    case "noop": return "noop";
  }
}

function memoryIdsOf(r: ProcessResult): string[] {
  switch (r.status) {
    case "written": return r.memoryIds;
    case "degraded": return r.memoryId ? [r.memoryId] : [];
    case "corrected": return [r.memoryId];
    default: return [];
  }
}

function detailOf(r: ProcessResult): string {
  switch (r.status) {
    case "rejected": return `reason=${r.reason}`;
    case "noop": return `reason=${r.reason}`;
    case "degraded": return "storeDegraded append-only";
    default: return "";
  }
}

/**
 * 冒烟整体墙钟上限（毫秒）：endpoint 挂起时防无限阻塞（每次 complete 最坏 60s×重试）。
 * 取 20 分钟以容纳 API 慢响应（实跑曾见单次蒸馏 110s）；超时 → 冒烟中断 + passed=null fail-closed。
 * LlmBudget 限调用次数、不限墙钟，故需此护栏。
 */
const SMOKE_DEFAULT_TIMEOUT_MS = 20 * 60_000;

/**
 * 同 repo 密封检索（红队第三层 S 修复）。
 * 共享库上 hybridRecall 的 searchText/searchVector 不按 repo 过滤，跨 repo 旧条目会挤掉
 * 自身写入的候选 → 检索命中率被库污染误判。这里放大原始候选池，再过滤到 smoke repo 内
 * 按融合分取前 10 判命中，隔离库内容对"backbone 蒸馏→检索协同"测量的干扰。
 * 注意：governor 的相似召回（pipeline.ts 内）仍跨 repo——生产行为，接受（实跑 0 NOOP 验证）。
 */
const SMOKE_RECALL_POOL = 50;

async function recallInRepo(
  engine: MemoryStoreEngine,
  probe: string,
  repo: string,
  memoryIds: string[],
): Promise<boolean> {
  const r = await hybridRecall(engine, probe, { candidates: SMOKE_RECALL_POOL });
  const inRepo = r.items.filter((i) => i.entry.repo === repo).slice(0, 10);
  return inRepo.some((i) => memoryIds.includes(i.entry.id));
}

export async function runBackboneSmoke(
  opts: BackboneSmokeOptions & { stats?: LlmStats },
): Promise<BackboneSmokeReport> {
  const engine = opts.engine ?? new PostgresMemoryStoreEngine();
  const now = (opts.now ?? (() => new Date()))();
  const repo = `smoke-${now.getTime().toString(36)}`;
  const fixtures = truncate(SMOKE_FIXTURES, opts.maxSamples);
  const budget = new LlmBudget(opts.llmBudget ?? 100);
  const backbone = budget.wrap(opts.backbone);
  const pipeline = opts.pipelineFactory
    ? opts.pipelineFactory(backbone)
    : new MemoryWritePipeline({
        distiller: new MemoryDistiller(backbone),
        // governed 默认 true：真实 LongtermGovernor 走完整五道关
        // （--no-governed 逃生口：隔离蒸馏质量，对齐 redteam 种子直接 ADD）
        governorLlm: opts.governed === false ? undefined : backbone,
        // 关键：抬高每日蒸馏预算，隔离共享当日 op-log，防开发库满 budget 虚假降级
        dailyBudget: 500,
      });
  const warnings: string[] = [];
  const items: SmokeItemResult[] = [];

  // 整体墙钟护栏（红队第三层 M3）：endpoint 挂起时防 CI 无限阻塞（每次调用最坏 60s×重试）。
  // LlmBudget 限调用次数、不限墙钟；超时置位后循环中断 → passed=null fail-closed。
  const timeoutMs = opts.timeoutMs ?? SMOKE_DEFAULT_TIMEOUT_MS;
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; }, timeoutMs);
  timer.unref?.();

  try {
    // ── 写入阶段：真实蒸馏，每条 fixture 独立跑 processEvent ──
    for (const f of fixtures) {
      if (timedOut) {
        warnings.push(`整体超时（>${Math.round(timeoutMs / 60_000)} 分钟）：冒烟中断，结果不完整，fail-closed`);
        break;
      }
      let r: ProcessResult;
      try {
        r = await pipeline.processEvent({
          type: "task_succeeded",
          runId: `${repo}-${f.id}`,
          trajectoryRef: `runs/${repo}-${f.id}`,
          repo,
          goal: f.goal,
          trajectory: f.trajectory,
          verdict: { kind: "test", passed: true }, // 走验证门控 → consolidate
        });
      } catch (e) {
        warnings.push(`${f.id}: 写入抛错 ${e instanceof Error ? e.message : String(e)}`);
        items.push({ fixtureId: f.id, status: "noop", memoryIds: [], recalledByKeyword: false, recalledByQuery: false, detail: "processEvent threw" });
        continue;
      }
      const memoryIds = memoryIdsOf(r);
      // ── 检索阶段：对 written/degraded 带 id 的条目用 keyword/query 探针（同 repo 密封）──
      let recalledByKeyword = false;
      let recalledByQuery = false;
      if (memoryIds.length > 0) {
        try {
          [recalledByKeyword, recalledByQuery] = await Promise.all([
            recallInRepo(engine, smokeProbe(f, "keyword"), repo, memoryIds),
            recallInRepo(engine, smokeProbe(f, "query"), repo, memoryIds),
          ]);
        } catch (e) {
          warnings.push(`${f.id}: 检索抛错 ${e instanceof Error ? e.message : String(e)}（该项计 miss）`);
        }
      }
      items.push({
        fixtureId: f.id,
        status: statusOf(r),
        memoryIds,
        recalledByKeyword,
        recalledByQuery,
        detail: detailOf(r),
      });
    }

    const summary = summarizeSmoke(items);
    // 审计留痕（spec §9.6 best-effort）：passed !== true（未达标或无法判定）都留痕——
    // 全拒/无写入/超时同样是弱模型或环境失效信号，须回溯 provider 归因（provider 恒为 opts.provider，勿依赖 stats）
    const passed = timedOut ? null : summary.passed;
    if (passed !== true) {
      await appendOpLog("write.smoke_failed", {
        detail: {
          provider: opts.provider,
          schemaRate: summary.schemaRate,
          recallRate: summary.keywordRecall,
          unverifiedRatio: summary.unverifiedRatio,
          degraded: items.filter((i) => i.status === "degraded").length,
        },
      });
    }
    return {
      suite: "backbone-smoke",
      generatedAt: now.toISOString(),
      provider: opts.provider,
      passed,
      metrics: {
        条目数: items.length,
        "schema合格率": summary.schemaRate,
        "检索命中率(keyword)": summary.keywordRecall,
        "检索命中率(query)": summary.queryRecall,
        "检索命中率(仅written)": summary.writtenOnlyRecall,
        "unverified占比": summary.unverifiedRatio,
        降级路径生效: summary.degradedPathOk,
      },
      details: items,
      efficiency: efficiencyOf(opts.stats, budget),
      warnings,
    };
  } finally {
    clearTimeout(timer);
    if (!opts.keep) {
      // 清理失败不吞报告（红队第三层 M5）：只记 warning；残留需人工清理
      try {
        await cleanupCtx(repo);
      } catch (e) {
        warnings.push(`清理 smoke repo 失败: ${e instanceof Error ? e.message : String(e)}（可能残留 smoke-* 数据，需人工清理）`);
      }
    }
  }
}

function efficiencyOf(stats: LlmStats | undefined, budget: LlmBudget): BackboneSmokeReport["efficiency"] {
  return {
    llmCalls: stats?.calls ?? budget.used,
    retries: stats?.retries ?? 0,
    failures: stats?.failures ?? 0,
    totalMs: stats?.totalMs ?? 0,
    estimatedTokens: stats?.estimatedTokens ?? 0,
    truncated: budget.used >= budget.max,
  };
}

/** 清理：embeddings / items / op-log 按 repo scope（对齐 perturbation.cleanupCtx） */
async function cleanupCtx(repo: string): Promise<void> {
  const sql = getSql();
  await sql`DELETE FROM memory_embeddings WHERE memory_id IN (SELECT id FROM memory_items WHERE scope->>'repositoryId' = ${repo})`;
  await sql`DELETE FROM memory_items WHERE scope->>'repositoryId' = ${repo}`;
  await sql`DELETE FROM memory_op_log WHERE run_id LIKE ${repo + "%"}`;
}
