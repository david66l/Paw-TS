/**
 * paw memory CLI（spec v2 §9.2，M3 可观测性基座）
 *
 * 子命令：list / why / forget / stats / diff。
 * parseMemoryArgs 是纯函数（单测友好）；runMemoryCommand 由 apps/cli 调用。
 * DB 不可用时返回 ok:false + 友好文案，不抛异常。
 */

import { join } from "node:path";
import { closeSql } from "../db/connection.js";
import { loadMemoryConfig, saveMemoryConfig } from "./config.js";
import {
  ChatClient,
  type LlmStats,
  type RedteamSuiteName,
  renderBackboneSmokeReport,
  renderRedteamReport,
  resolveLlmConfig,
  runBackboneSmoke,
  runRedteamSuite,
  BUILTIN_CODING_FIXTURES,
  filterMabSamples,
  loadMabSamplesFromFile,
  loadOrFetchMabHf,
  renderMabReport,
  runMemoryAgentBench,
  type MabDimension,
  renderMechReport,
  runMechanismSuite,
  type MechSuiteName,
} from "./eval/index.js";
import { resetMemoryV2Core } from "../runtime/index.js";
import {
  parseReplayJsonl,
  renderReplayReport,
  runReplay,
} from "./eval/replay.js";
import { exportMemories } from "./export.js";
import { collectGarbage } from "./lifecycle/gc.js";
import {
  approveReview,
  listReviewQueue,
  rejectReview,
  runLifecycleOnce,
} from "./lifecycle/janitor.js";
import { migrateV1ToV2 } from "./migrate-v1-to-v2.js";
import { collectMemoryDiff, renderMemoryDiff } from "./observability/diff.js";
import { appendOpLog } from "./observability/op-log.js";
import {
  collectMemoryStats,
  renderMemoryStats,
} from "./observability/stats.js";
import { collectWhy, renderWhy } from "./observability/why.js";
import type { MemoryEntry, MemoryKind } from "./store/engine.js";
import { PostgresMemoryStoreEngine } from "./store/postgres-engine.js";

export interface MemoryCliArgs {
  subcommand:
    | "list"
    | "why"
    | "forget"
    | "stats"
    | "diff"
    | "gc"
    | "replay"
    | "export"
    | "readonly"
    | "reindex"
    | "redteam"
    | "smoke"
    | "mab"
    | "mechanism"
    | "migrate-v1-to-v2"
    | "enable";
  id?: string;
  kind?: MemoryKind;
  all?: boolean;
  since?: string;
  repo?: string;
  limit?: number;
  dryRun?: boolean;
  /** gc --review：列出人工复核队列 */
  review?: boolean;
  /** gc --approve/--reject <entryId>：复核决议 */
  approve?: string;
  reject?: string;
  /** gc --export <dir>：归档额外导出 JSONL */
  exportDir?: string;
  /** gc --sweep：手动触发一次生命周期批处理（效用删除扫描 + 容量检查） */
  sweep?: boolean;
  /** replay：输出 JSON 而非表格 */
  json?: boolean;
  /** export --dir <path>：导出目录（默认 .paw/shared-memory） */
  dir?: string;
  /** redteam：LLM provider 名（settings.local.json 的 models.<name>） */
  provider?: string;
  /** redteam：judge 专用 provider（缺省与 backbone 同） */
  judgeProvider?: string;
  /** redteam --keep：保留种子数据不清理 */
  keep?: boolean;
  /** redteam --max-samples N：每套件最多跑 N 条 fixture */
  maxSamples?: number;
  /** smoke --auto-readonly：未达标时自动写入降级只读（默认仅提示） */
  autoReadonly?: boolean;
  /** smoke --no-governed：注入真实 Governor（默认 true，走完整五道关） */
  noGoverned?: boolean;
  /** mab：使用内置 coding-mini 夹具（默认，若未传 --data/--hf） */
  builtin?: boolean;
  /** mab：从 HuggingFace 拉取/缓存官方四维 */
  hf?: boolean;
  /** mab：HF 缓存目录（默认 benchmarks/memory-agent-bench/hf-cache） */
  hfCache?: string;
  /** mab：强制重拉 HF（忽略缓存内容仍会写回） */
  hfForce?: boolean;
  /** mab：数据文件路径（JSON / JSONL / {data:[]}） */
  data?: string;
  /** mab / mechanism：维度或套件过滤，逗号分隔 */
  dimensions?: string;
  /** mab：chunk 字符预算 */
  chunkSize?: number;
}

export interface MemoryCliResult {
  ok: boolean;
  text: string;
}

const KINDS: readonly MemoryKind[] = [
  "semantic",
  "episodic",
  "profile",
  "vault_ref",
];

const USAGE = `paw memory — 长期记忆库（spec v2）

Usage:
  paw-ts memory list [--kind semantic|episodic|profile|vault_ref] [--all] [--repo <id>] [--limit <n>]
  paw-ts memory why <id>        来源溯源：创建时间、证据、裁决历史、注入次数
  paw-ts memory forget <id>     立即软失效（用户最高优先级）
  paw-ts memory stats           库规模 / 删除候选 / unverified 占比 / 采纳率
  paw-ts memory diff [--since <ISO时间>]   两时点间变更（默认近 24 小时）
  paw-ts memory gc [--dry-run] [--export <dir>]   物理清理已软失效条目（先归档）
  paw-ts memory gc --sweep        手动跑一轮生命周期批处理（效用删除扫描 + 容量检查）
  paw-ts memory gc --review       列出删除候选人工复核队列
  paw-ts memory gc --approve <entryId> | --reject <entryId>   复核决议（approve 即软失效）
  paw-ts memory replay <input.jsonl> [--json]   轨迹回放 Δ 代理评测（shadow 检索 + 判定汇总）
  paw-ts memory export [--dir <path>] [--all]   导出到 .paw/shared-memory/（导出前全量密钥扫描）
  paw-ts memory readonly [on|off]   只读模式切换（CI 场景；不带参数显示当前状态）
  paw-ts memory reindex             重建派生索引（embedding）+ 冒烟回归（结果记 op-log）
  paw-ts memory redteam <all|counterfactual|noise|negation> [--provider <name>] [--judge-provider <name>] [--json] [--keep] [--max-samples N]
                                  §11.4 扰动评测（反事实纠正/噪声抗压/否定句保持，真实 LLM）
  paw-ts memory smoke [--provider <name>] [--json] [--keep] [--no-governed] [--auto-readonly]
                                  §11.5 backbone 冒烟（10 条写入/检索：schema 合格率、检索命中率、弱模型专项）
  paw-ts memory mab [--builtin] [--hf] [--hf-cache <dir>] [--hf-force] [--data <path>]
                    [--dimension AR,TTL,LRU,CR,SF] [--chunk-size N]
                    [--provider <name>] [--json] [--keep] [--max-samples N]
                                  §11.3 MemoryAgentBench（正增益+配对；--hf 官方全量）
  paw-ts memory mechanism [--suite trial,gate,profile,cap] [--json] [--keep]
                                  §12.3 机制验收（Trial→Gate→Profile→Cap，DB 闭环）
  paw-ts memory migrate-v1-to-v2 [--dry-run] [--repo <id>]
                                  v1 存量迁移到 v2（type→kind 映射 + payload 规范化 + 重算 embedding；幂等）
  paw-ts memory enable [on|off]  记忆总开关（orchestrator 零调用语义；不带参数显示当前状态）

需要 DATABASE_URL 指向记忆库（V026+ 迁移）。`;

/** 纯函数：解析 memory 子命令参数 */
export function parseMemoryArgs(
  args: readonly string[],
): MemoryCliArgs | { error: string } {
  const sub = args[0];
  if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
    return { error: USAGE };
  }
  if (
    ![
      "list",
      "why",
      "forget",
      "stats",
      "diff",
      "gc",
      "replay",
      "export",
      "readonly",
      "reindex",
      "redteam",
      "smoke",
      "mab",
      "mechanism",
      "migrate-v1-to-v2",
      "enable",
    ].includes(sub)
  ) {
    return { error: `未知子命令: ${sub}\n\n${USAGE}` };
  }

  const out: MemoryCliArgs = { subcommand: sub as MemoryCliArgs["subcommand"] };
  for (let i = 1; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--all") {
      out.all = true;
    } else if (a === "--dry-run") {
      out.dryRun = true;
    } else if (a === "--json") {
      out.json = true;
    } else if (a === "--review") {
      out.review = true;
    } else if (a === "--sweep") {
      out.sweep = true;
    } else if (a === "--builtin") {
      out.builtin = true;
    } else if (a === "--hf") {
      out.hf = true;
    } else if (a === "--hf-cache") {
      const v = args[++i];
      if (!v) return { error: "--hf-cache 缺路径" };
      out.hfCache = v;
    } else if (a === "--hf-force") {
      out.hfForce = true;
    } else if (a === "--approve") {
      const v = args[++i];
      if (!v) return { error: "--approve 缺 entryId" };
      out.approve = v;
    } else if (a === "--reject") {
      const v = args[++i];
      if (!v) return { error: "--reject 缺 entryId" };
      out.reject = v;
    } else if (a === "--export") {
      const v = args[++i];
      if (!v) return { error: "--export 缺目录" };
      out.exportDir = v;
    } else if (a === "--dir") {
      const v = args[++i];
      if (!v) return { error: "--dir 缺路径" };
      out.dir = v;
    } else if (a === "--data") {
      const v = args[++i];
      if (!v) return { error: "--data 缺路径" };
      out.data = v;
    } else if (a === "--dimension" || a === "--dimensions" || a === "--suite" || a === "--suites") {
      const v = args[++i];
      if (!v) return { error: "--dimension/--suite 缺值" };
      out.dimensions = v;
    } else if (a === "--chunk-size") {
      const v = Number(args[++i]);
      if (!Number.isFinite(v) || v <= 0) return { error: "--chunk-size 需为正整数" };
      out.chunkSize = v;
    } else if (a === "--keep") {
      out.keep = true;
    } else if (a === "--auto-readonly") {
      out.autoReadonly = true;
    } else if (a === "--no-governed") {
      out.noGoverned = true;
    } else if (a === "--provider") {
      const v = args[++i];
      if (!v) return { error: "--provider 缺名称" };
      out.provider = v;
    } else if (a === "--judge-provider") {
      const v = args[++i];
      if (!v) return { error: "--judge-provider 缺名称" };
      out.judgeProvider = v;
    } else if (a === "--max-samples") {
      const v = Number(args[++i]);
      if (!Number.isFinite(v) || v <= 0)
        return { error: "--max-samples 需为正整数" };
      out.maxSamples = v;
    } else if (a === "--kind") {
      const v = args[++i];
      if (!v || !KINDS.includes(v as MemoryKind))
        return { error: `--kind 需为 ${KINDS.join("|")}` };
      out.kind = v as MemoryKind;
    } else if (a === "--repo") {
      const v = args[++i];
      if (!v) return { error: "--repo 缺值" };
      out.repo = v;
    } else if (a === "--since") {
      const v = args[++i];
      if (!v || Number.isNaN(Date.parse(v)))
        return { error: `--since 需为可解析时间，收到: ${v ?? "(缺)"}` };
      out.since = v;
    } else if (a === "--limit") {
      const v = Number(args[++i]);
      if (!Number.isFinite(v) || v <= 0) return { error: "--limit 需为正整数" };
      out.limit = v;
    } else if (!a.startsWith("--")) {
      if (out.id !== undefined) return { error: `多余的位置参数: ${a}` };
      out.id = a;
    } else {
      return { error: `未知参数: ${a}` };
    }
  }

  if ((sub === "why" || sub === "forget") && !out.id) {
    return { error: `memory ${sub} 需要 <id>` };
  }
  if (sub === "replay" && !out.id) {
    return { error: "memory replay 需要 <input.jsonl> 文件路径" };
  }
  return out;
}

/** 条目的单行摘要（list 用） */
function summarize(e: MemoryEntry): string {
  switch (e.kind) {
    case "semantic":
      return e.fact;
    case "episodic":
      return e.perspective;
    case "profile":
      return e.insight;
    case "vault_ref":
      return e.refDescription;
  }
}

export async function runMemoryCommand(
  args: readonly string[],
): Promise<MemoryCliResult> {
  const parsed = parseMemoryArgs(args);
  if ("error" in parsed) return { ok: false, text: parsed.error };

  const engine = new PostgresMemoryStoreEngine();
  try {
    switch (parsed.subcommand) {
      case "list": {
        const entries = await engine.query({
          kind: parsed.kind,
          repo: parsed.repo,
          includeInvalidated: parsed.all,
          limit: parsed.limit ?? 50,
        });
        if (entries.length === 0) return { ok: true, text: "(无条目)" };
        const lines = entries.map((e) => {
          const dead = e.tInvalid ? "  [已失效]" : "";
          const degraded =
            (e as { degraded?: boolean }).degraded === true ? "  [降级]" : "";
          const s = summarize(e);
          return `${e.id}  [${e.kind}]  freq=${e.freq} util=${e.utility}  ${s.length > 70 ? `${s.slice(0, 69)}…` : s}${dead}${degraded}`;
        });
        return { ok: true, text: lines.join("\n") };
      }

      case "why": {
        const provenance = await collectWhy(engine, parsed.id!);
        if (!provenance.entry)
          return { ok: false, text: `条目不存在: ${parsed.id}` };
        return { ok: true, text: renderWhy(provenance) };
      }

      case "forget": {
        const entry = await engine.get(parsed.id!);
        if (!entry) return { ok: false, text: `条目不存在: ${parsed.id}` };
        if (entry.tInvalid)
          return {
            ok: true,
            text: `${parsed.id} 已于 ${entry.tInvalid} 失效，无需重复操作`,
          };
        const now = new Date().toISOString();
        await engine.invalidate(parsed.id!, now);
        await appendOpLog("governed", {
          entryIds: [parsed.id!],
          detail: { op: "INVALIDATE", reason: "user_forget", by: "cli" },
        });
        return {
          ok: true,
          text: `已软失效: ${parsed.id}（tInvalid=${now}；永不注入但可通过 why/list --all 查询）`,
        };
      }

      case "stats": {
        const stats = await collectMemoryStats();
        return { ok: true, text: renderMemoryStats(stats) };
      }

      case "diff": {
        const since =
          parsed.since ?? new Date(Date.now() - 24 * 3600 * 1000).toISOString();
        const diff = await collectMemoryDiff(since);
        return { ok: true, text: renderMemoryDiff(diff) };
      }

      case "gc": {
        if (parsed.review) {
          const rows = await listReviewQueue();
          if (rows.length === 0) return { ok: true, text: "复核队列为空" };
          const lines = rows.map(
            (r) =>
              `${r.entryId}\n    ${r.reason}\n    入队: ${r.createdAt}    决议: gc --approve ${r.entryId} | gc --reject ${r.entryId}`,
          );
          return {
            ok: true,
            text: [`删除候选复核队列（${rows.length} 条）:`, ...lines].join(
              "\n",
            ),
          };
        }
        if (parsed.approve) {
          const done = await approveReview(parsed.approve, { engine });
          return done
            ? { ok: true, text: `已批准并软失效: ${parsed.approve}` }
            : {
                ok: false,
                text: `复核队列中无 pending 条目: ${parsed.approve}`,
              };
        }
        if (parsed.reject) {
          const done = await rejectReview(parsed.reject);
          return done
            ? {
                ok: true,
                text: `已拒绝删除: ${parsed.reject}（不再进入复核队列）`,
              }
            : {
                ok: false,
                text: `复核队列中无 pending 条目: ${parsed.reject}`,
              };
        }
        if (parsed.sweep) {
          const report = await runLifecycleOnce({
            config: { repo: parsed.repo },
          });
          return {
            ok: true,
            text: [
              "生命周期批处理完成",
              `  删除候选: ${report.candidates.length}（进复核队列 ${report.enqueuedForReview.length}，自动软失效 ${report.autoInvalidated.length}，已在队列 ${report.alreadyInQueue.length}）`,
              `  模式: ${report.autoMode ? "全自动" : "灰度人工复核"}`,
              `  容量: episodic 软失效 ${report.capacity.episodicInvalidated.length}，semantic 软失效 ${report.capacity.semanticInvalidated.length}，trial 丢弃 ${report.capacity.trialDropped.length}，profile 超限 ${report.capacity.profileOverCap}`,
            ].join("\n"),
          };
        }
        const report = await collectGarbage({
          dryRun: parsed.dryRun,
          exportDir: parsed.exportDir,
          repo: parsed.repo,
        });
        const lines = [
          report.dryRun ? "gc（dry-run，未动数据）" : "gc 完成",
          `  待清理（已软失效）: ${report.eligible}`,
        ];
        if (!report.dryRun) {
          lines.push(
            `  已归档: ${report.archived}    已物理删除: ${report.deleted}`,
          );
          if (report.exportPath) lines.push(`  导出: ${report.exportPath}`);
        }
        return { ok: true, text: lines.join("\n") };
      }

      case "replay": {
        const { readFile } = await import("node:fs/promises");
        let trajectories;
        try {
          trajectories = parseReplayJsonl(await readFile(parsed.id!, "utf-8"));
        } catch (e) {
          return {
            ok: false,
            text: `读取回放输入失败: ${e instanceof Error ? e.message : String(e)}`,
          };
        }
        const report = await runReplay(trajectories, {
          engine,
          repo: parsed.repo,
        });
        return {
          ok: true,
          text: parsed.json
            ? JSON.stringify(report, null, 2)
            : renderReplayReport(report),
        };
      }

      case "export": {
        const report = await exportMemories({
          engine,
          dir: parsed.dir,
          repo: parsed.repo,
          includeInvalidated: parsed.all,
        });
        const lines = [
          `导出完成: ${report.dir}`,
          `  扫描: ${report.total}    导出: ${report.exported}    打码: ${report.redacted}    跳过（疑似密钥）: ${report.skippedSecret.length}`,
        ];
        for (const s of report.skippedSecret)
          lines.push(`  跳过: ${s.id}（${s.pattern}）`);
        for (const f of report.files) lines.push(`  文件: ${f}`);
        return { ok: true, text: lines.join("\n") };
      }

      case "reindex": {
        const report = await engine.reindex();
        return {
          ok: true,
          text: [
            "reindex 完成",
            `  扫描: ${report.scanned}    重建: ${report.indexed}    失败: ${report.failed}`,
            `  冒烟: ${report.smoke.passed}/${report.smoke.total} 通过${report.smoke.failedIds.length > 0 ? `    未召回: ${report.smoke.failedIds.join(", ")}` : ""}`,
          ].join("\n"),
        };
      }

      case "redteam": {
        const suite = parsed.id;
        if (
          !suite ||
          !["all", "counterfactual", "noise", "negation"].includes(suite)
        ) {
          return {
            ok: false,
            text: `memory redteam 需要 <all|counterfactual|noise|negation>${suite ? `，收到: ${suite}` : ""}`,
          };
        }
        const stats: LlmStats = {
          calls: 0,
          retries: 0,
          failures: 0,
          totalMs: 0,
          estimatedTokens: 0,
        };
        const backboneCfg = resolveLlmConfig({ provider: parsed.provider });
        if ("error" in backboneCfg)
          return { ok: false, text: backboneCfg.error };
        const judgeCfg =
          parsed.judgeProvider && parsed.judgeProvider !== parsed.provider
            ? resolveLlmConfig({ provider: parsed.judgeProvider })
            : backboneCfg;
        if ("error" in judgeCfg) return { ok: false, text: judgeCfg.error };
        const reports = await runRedteamSuite(
          suite as RedteamSuiteName | "all",
          {
            engine,
            backbone: new ChatClient(backboneCfg, 60_000, stats),
            judge: new ChatClient(judgeCfg, 60_000, stats),
            stats,
            keep: parsed.keep,
            maxSamples: parsed.maxSamples,
          },
        );
        const text = parsed.json
          ? JSON.stringify(reports, null, 2)
          : reports.map((r) => renderRedteamReport(r)).join("\n\n");
        return { ok: true, text };
      }

      case "smoke": {
        const stats: LlmStats = {
          calls: 0,
          retries: 0,
          failures: 0,
          totalMs: 0,
          estimatedTokens: 0,
        };
        const backboneCfg = resolveLlmConfig({ provider: parsed.provider });
        if ("error" in backboneCfg)
          return { ok: false, text: backboneCfg.error };
        const report = await runBackboneSmoke({
          engine,
          backbone: new ChatClient(backboneCfg, 60_000, stats),
          stats,
          provider: backboneCfg.providerName,
          keep: parsed.keep,
          maxSamples: parsed.maxSamples,
          governed: !parsed.noGoverned,
        });
        // 未达标/无法判定：fail-closed（ok:false，CI 可 gate）+ 只读提示（防静默腐蚀，spec §11.5）
        if (report.passed !== true) {
          // --auto-readonly 仅在确实写入过未达标数据时触发（passed=false；null=无写入，无腐蚀风险）
          if (parsed.autoReadonly && report.passed === false) {
            await saveMemoryConfig({ readonly: true });
            // 通知进 warnings 字段：--json 下仍是合法 JSON，不与人话拼接破坏 JSON.parse
            report.warnings.push(
              "已自动开启 readonly：写入事件将全部丢弃（如需恢复：memory readonly off）",
            );
          }
        }
        const text = parsed.json
          ? JSON.stringify(report, null, 2)
          : renderBackboneSmokeReport(report);
        return report.passed === true
          ? { ok: true, text }
          : { ok: false, text };
      }

      case "mab": {
        const stats: LlmStats = {
          calls: 0,
          retries: 0,
          failures: 0,
          totalMs: 0,
          estimatedTokens: 0,
        };
        const backboneCfg = resolveLlmConfig({ provider: parsed.provider });
        if ("error" in backboneCfg)
          return { ok: false, text: backboneCfg.error };

        const dimAllowed = new Set<MabDimension>(["AR", "TTL", "LRU", "CR", "SF"]);
        let dimensions: MabDimension[] | undefined;
        if (parsed.dimensions) {
          dimensions = [];
          for (const part of parsed.dimensions.split(/[,+\s]+/).filter(Boolean)) {
            const d = part.toUpperCase() as MabDimension;
            if (!dimAllowed.has(d)) {
              return {
                ok: false,
                text: `未知维度: ${part}（允许 AR,TTL,LRU,CR,SF）`,
              };
            }
            dimensions.push(d);
          }
        }

        const warnings: string[] = [];
        let samples =
          parsed.data
            ? loadMabSamplesFromFile(parsed.data, {
                defaultDimension: dimensions?.length === 1 ? dimensions[0] : undefined,
              })
            : [];
        if (parsed.data && samples.length === 0) {
          return {
            ok: false,
            text: `未能从 ${parsed.data} 解析出样本（需 context + questions/qa；可加 --dimension 注入维度）`,
          };
        }

        if (parsed.hf) {
          const cacheDir =
            parsed.hfCache ??
            join(process.cwd(), "benchmarks", "memory-agent-bench", "hf-cache");
          const parquetDir = join(
            process.cwd(),
            "benchmarks",
            "memory-agent-bench",
            "hf-dataset",
            "data",
          );
          const hfDims = (dimensions ?? ["AR", "TTL", "LRU", "CR"]).filter((d) => d !== "SF");
          const splits = hfDims
            .map((d) =>
              (
                {
                  AR: "Accurate_Retrieval",
                  TTL: "Test_Time_Learning",
                  LRU: "Long_Range_Understanding",
                  CR: "Conflict_Resolution",
                } as const
              )[d as "AR" | "TTL" | "LRU" | "CR"],
            )
            .filter(Boolean);
          const loaded = await loadOrFetchMabHf({
            cacheDir,
            parquetDir,
            splits,
            forceFetch: parsed.hfForce,
          });
          warnings.push(...loaded.warnings);
          samples = [...samples, ...loaded.samples];
          if (loaded.samples.length === 0 && !parsed.builtin && !parsed.data) {
            return {
              ok: false,
              text: `HF 无样本（source=${loaded.source}）。警告:\n${warnings.join("\n") || "(无)"}`,
            };
          }
        }

        // 默认 / --builtin：内置 coding-mini（含 SF）；与 --hf/--data 可叠加
        if (parsed.builtin || (!parsed.data && !parsed.hf)) {
          samples = [...samples, ...BUILTIN_CODING_FIXTURES];
        } else if (parsed.builtin === undefined && parsed.hf) {
          // HF 全量默认仍附带 SF 内置条，否则 SF 断言缺席
          const wantSf = !dimensions || dimensions.includes("SF");
          if (wantSf) samples = [...samples, ...BUILTIN_CODING_FIXTURES.filter((s) => s.dimension === "SF")];
        }

        samples = filterMabSamples(samples, {
          dimensions,
          maxSamples: parsed.maxSamples,
          maxQaPerSample: parsed.hf ? 5 : undefined,
        });
        if (samples.length === 0) {
          return { ok: false, text: "过滤后无样本可跑" };
        }

        const report = await runMemoryAgentBench({
          samples,
          backbone: new ChatClient(backboneCfg, parsed.hf ? 180_000 : 60_000, stats),
          engine,
          stats,
          keep: parsed.keep,
          maxSamples: undefined, // 已在 filter 阶段截断
          chunkSize: parsed.chunkSize ?? (parsed.hf ? 4096 : undefined),
          maxChunks: parsed.hf ? 48 : undefined,
          llmBudget: parsed.hf ? 50_000 : undefined,
          dimensions,
        });
        const finalReport =
          warnings.length > 0
            ? { ...report, warnings: [...report.warnings, ...warnings] }
            : report;
        const text = parsed.json
          ? JSON.stringify(finalReport, null, 2)
          : renderMabReport(finalReport);
        return finalReport.passed === true
          ? { ok: true, text }
          : { ok: false, text };
      }

      case "mechanism": {
        resetMemoryV2Core();
        const allowed = new Set<MechSuiteName>(["trial", "gate", "profile", "cap"]);
        let suites: MechSuiteName[] | undefined;
        if (parsed.dimensions) {
          suites = [];
          for (const part of parsed.dimensions.split(/[,+\s]+/).filter(Boolean)) {
            const s = part.toLowerCase() as MechSuiteName;
            if (!allowed.has(s)) {
              return {
                ok: false,
                text: `未知套件: ${part}（允许 trial,gate,profile,cap）`,
              };
            }
            suites.push(s);
          }
        }
        const report = await runMechanismSuite({
          suites,
          keep: parsed.keep,
        });
        resetMemoryV2Core();
        const text = parsed.json
          ? JSON.stringify(report, null, 2)
          : renderMechReport(report);
        return report.passed === true
          ? { ok: true, text }
          : { ok: false, text };
      }

      case "enable": {
        // 记忆总开关（.paw/memory-config.json）：orchestrator 零调用语义
        if (!parsed.id) {
          const cfg = await loadMemoryConfig();
          return { ok: true, text: `enable: ${cfg.enable ? "on" : "off"}` };
        }
        if (parsed.id !== "on" && parsed.id !== "off") {
          return { ok: false, text: `memory enable 需要 on|off，收到: ${parsed.id}` };
        }
        const cfg = await saveMemoryConfig({ enable: parsed.id === "on" });
        return {
          ok: true,
          text: cfg.enable
            ? "记忆已开启：orchestrator 将构造记忆运行时"
            : "记忆已关闭：orchestrator 零调用（不构造运行时，检索/写入全部跳过）",
        };
      }

      case "readonly": {
        // 配置落在 .paw/memory-config.json（见 config.ts 的落点说明）
        if (!parsed.id) {
          const cfg = await loadMemoryConfig();
          return {
            ok: true,
            text: `enable: ${cfg.enable ? "on" : "off"}    readonly: ${cfg.readonly ? "on" : "off"}    shadow: ${cfg.shadow ? "on" : "off"}`,
          };
        }
        if (parsed.id !== "on" && parsed.id !== "off") {
          return {
            ok: false,
            text: `memory readonly 需要 on|off，收到: ${parsed.id}`,
          };
        }
        const cfg = await saveMemoryConfig({ readonly: parsed.id === "on" });
        return {
          ok: true,
          text: cfg.readonly
            ? "readonly 已开启：写入事件将全部丢弃（记 op-log write.dropped），检索只读正常"
            : "readonly 已关闭：写入管线恢复",
        };
      }

      case "migrate-v1-to-v2": {
        const result = await migrateV1ToV2({
          dryRun: parsed.dryRun,
          repo: parsed.repo,
        });
        const lines = [
          `${parsed.dryRun ? "[dry-run 预览，未写库]" : "迁移完成"}`,
          `扫描 v1 行: ${result.scanned}    迁移: ${result.migrated}    跳过: ${result.skipped}    失败: ${result.failed}`,
        ];
        const byType = Object.entries(result.byType);
        if (byType.length > 0) {
          lines.push(
            `按原类型: ${byType.map(([t, n]) => `${t}=${n}`).join(", ")}`,
          );
        }
        if (result.failedIds.length > 0) {
          lines.push(`失败条目: ${result.failedIds.join(", ")}`);
        }
        return { ok: result.failed === 0, text: lines.join("\n") };
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      text: `memory ${parsed.subcommand} 失败: ${msg}\n（确认 DATABASE_URL 指向已迁移到 V028 的记忆库）`,
    };
  } finally {
    await closeSql();
  }
}
