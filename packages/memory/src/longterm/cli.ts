/**
 * paw memory CLI（spec v2 §9.2，M3 可观测性基座）
 *
 * 子命令：list / why / forget / stats / diff。
 * parseMemoryArgs 是纯函数（单测友好）；runMemoryCommand 由 apps/cli 调用。
 * DB 不可用时返回 ok:false + 友好文案，不抛异常。
 */

import { PostgresMemoryStoreEngine } from "./store/postgres-engine.js";
import { closeSql } from "../db/connection.js";
import type { MemoryEntry, MemoryKind } from "./store/engine.js";
import { appendOpLog } from "./observability/op-log.js";
import { collectMemoryStats, renderMemoryStats } from "./observability/stats.js";
import { collectMemoryDiff, renderMemoryDiff } from "./observability/diff.js";
import { collectWhy, renderWhy } from "./observability/why.js";
import {
  runLifecycleOnce,
  listReviewQueue,
  approveReview,
  rejectReview,
} from "./lifecycle/janitor.js";
import { collectGarbage } from "./lifecycle/gc.js";
import { parseReplayJsonl, runReplay, renderReplayReport } from "./eval/replay.js";
import { exportMemories } from "./export.js";
import { loadMemoryConfig, saveMemoryConfig } from "./config.js";

export interface MemoryCliArgs {
  subcommand: "list" | "why" | "forget" | "stats" | "diff" | "gc" | "replay" | "export" | "readonly";
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
}

export interface MemoryCliResult {
  ok: boolean;
  text: string;
}

const KINDS: readonly MemoryKind[] = ["semantic", "episodic", "profile", "vault_ref"];

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

需要 DATABASE_URL 指向记忆库（V026+ 迁移）。`;

/** 纯函数：解析 memory 子命令参数 */
export function parseMemoryArgs(args: readonly string[]): MemoryCliArgs | { error: string } {
  const sub = args[0];
  if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
    return { error: USAGE };
  }
  if (!["list", "why", "forget", "stats", "diff", "gc", "replay", "export", "readonly"].includes(sub)) {
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
    } else if (a === "--kind") {
      const v = args[++i];
      if (!v || !KINDS.includes(v as MemoryKind)) return { error: `--kind 需为 ${KINDS.join("|")}` };
      out.kind = v as MemoryKind;
    } else if (a === "--repo") {
      const v = args[++i];
      if (!v) return { error: "--repo 缺值" };
      out.repo = v;
    } else if (a === "--since") {
      const v = args[++i];
      if (!v || Number.isNaN(Date.parse(v))) return { error: `--since 需为可解析时间，收到: ${v ?? "(缺)"}` };
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

export async function runMemoryCommand(args: readonly string[]): Promise<MemoryCliResult> {
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
          const s = summarize(e);
          return `${e.id}  [${e.kind}]  freq=${e.freq} util=${e.utility}  ${s.length > 70 ? `${s.slice(0, 69)}…` : s}${dead}`;
        });
        return { ok: true, text: lines.join("\n") };
      }

      case "why": {
        const provenance = await collectWhy(engine, parsed.id!);
        if (!provenance.entry) return { ok: false, text: `条目不存在: ${parsed.id}` };
        return { ok: true, text: renderWhy(provenance) };
      }

      case "forget": {
        const entry = await engine.get(parsed.id!);
        if (!entry) return { ok: false, text: `条目不存在: ${parsed.id}` };
        if (entry.tInvalid) return { ok: true, text: `${parsed.id} 已于 ${entry.tInvalid} 失效，无需重复操作` };
        const now = new Date().toISOString();
        await engine.invalidate(parsed.id!, now);
        await appendOpLog("governed", {
          entryIds: [parsed.id!],
          detail: { op: "INVALIDATE", reason: "user_forget", by: "cli" },
        });
        return { ok: true, text: `已软失效: ${parsed.id}（tInvalid=${now}；永不注入但可通过 why/list --all 查询）` };
      }

      case "stats": {
        const stats = await collectMemoryStats();
        return { ok: true, text: renderMemoryStats(stats) };
      }

      case "diff": {
        const since = parsed.since ?? new Date(Date.now() - 24 * 3600 * 1000).toISOString();
        const diff = await collectMemoryDiff(since);
        return { ok: true, text: renderMemoryDiff(diff) };
      }

      case "gc": {
        if (parsed.review) {
          const rows = await listReviewQueue();
          if (rows.length === 0) return { ok: true, text: "复核队列为空" };
          const lines = rows.map((r) =>
            `${r.entryId}\n    ${r.reason}\n    入队: ${r.createdAt}    决议: gc --approve ${r.entryId} | gc --reject ${r.entryId}`);
          return { ok: true, text: [`删除候选复核队列（${rows.length} 条）:`, ...lines].join("\n") };
        }
        if (parsed.approve) {
          const done = await approveReview(parsed.approve, { engine });
          return done
            ? { ok: true, text: `已批准并软失效: ${parsed.approve}` }
            : { ok: false, text: `复核队列中无 pending 条目: ${parsed.approve}` };
        }
        if (parsed.reject) {
          const done = await rejectReview(parsed.reject);
          return done
            ? { ok: true, text: `已拒绝删除: ${parsed.reject}（不再进入复核队列）` }
            : { ok: false, text: `复核队列中无 pending 条目: ${parsed.reject}` };
        }
        if (parsed.sweep) {
          const report = await runLifecycleOnce({ config: { repo: parsed.repo } });
          return { ok: true, text: [
            "生命周期批处理完成",
            `  删除候选: ${report.candidates.length}（进复核队列 ${report.enqueuedForReview.length}，自动软失效 ${report.autoInvalidated.length}，已在队列 ${report.alreadyInQueue.length}）`,
            `  模式: ${report.autoMode ? "全自动" : "灰度人工复核"}`,
            `  容量: episodic 软失效 ${report.capacity.episodicInvalidated.length}，semantic 软失效 ${report.capacity.semanticInvalidated.length}，trial 丢弃 ${report.capacity.trialDropped.length}，profile 超限 ${report.capacity.profileOverCap}`,
          ].join("\n") };
        }
        const report = await collectGarbage({ dryRun: parsed.dryRun, exportDir: parsed.exportDir, repo: parsed.repo });
        const lines = [
          report.dryRun ? "gc（dry-run，未动数据）" : "gc 完成",
          `  待清理（已软失效）: ${report.eligible}`,
        ];
        if (!report.dryRun) {
          lines.push(`  已归档: ${report.archived}    已物理删除: ${report.deleted}`);
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
          return { ok: false, text: `读取回放输入失败: ${e instanceof Error ? e.message : String(e)}` };
        }
        const report = await runReplay(trajectories, { engine, repo: parsed.repo });
        return {
          ok: true,
          text: parsed.json ? JSON.stringify(report, null, 2) : renderReplayReport(report),
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
        for (const s of report.skippedSecret) lines.push(`  跳过: ${s.id}（${s.pattern}）`);
        for (const f of report.files) lines.push(`  文件: ${f}`);
        return { ok: true, text: lines.join("\n") };
      }

      case "readonly": {
        // 配置落在 .paw/memory-config.json（见 config.ts 的落点说明）
        if (!parsed.id) {
          const cfg = await loadMemoryConfig();
          return { ok: true, text: `readonly: ${cfg.readonly ? "on" : "off"}    shadow: ${cfg.shadow ? "on" : "off"}` };
        }
        if (parsed.id !== "on" && parsed.id !== "off") {
          return { ok: false, text: `memory readonly 需要 on|off，收到: ${parsed.id}` };
        }
        const cfg = await saveMemoryConfig({ readonly: parsed.id === "on" });
        return {
          ok: true,
          text: cfg.readonly
            ? "readonly 已开启：写入事件将全部丢弃（记 op-log write.dropped），检索只读正常"
            : "readonly 已关闭：写入管线恢复",
        };
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, text: `memory ${parsed.subcommand} 失败: ${msg}\n（确认 DATABASE_URL 指向已迁移到 V028 的记忆库）` };
  } finally {
    await closeSql();
  }
}
