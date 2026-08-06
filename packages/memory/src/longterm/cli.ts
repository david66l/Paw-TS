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

export interface MemoryCliArgs {
  subcommand: "list" | "why" | "forget" | "stats" | "diff";
  id?: string;
  kind?: MemoryKind;
  all?: boolean;
  since?: string;
  repo?: string;
  limit?: number;
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

需要 DATABASE_URL 指向记忆库（V026+ 迁移）。`;

/** 纯函数：解析 memory 子命令参数 */
export function parseMemoryArgs(args: readonly string[]): MemoryCliArgs | { error: string } {
  const sub = args[0];
  if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
    return { error: USAGE };
  }
  if (!["list", "why", "forget", "stats", "diff"].includes(sub)) {
    return { error: `未知子命令: ${sub}\n\n${USAGE}` };
  }

  const out: MemoryCliArgs = { subcommand: sub as MemoryCliArgs["subcommand"] };
  for (let i = 1; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--all") {
      out.all = true;
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
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, text: `memory ${parsed.subcommand} 失败: ${msg}\n（确认 DATABASE_URL 指向已迁移到 V028 的记忆库）` };
  } finally {
    await closeSql();
  }
}
