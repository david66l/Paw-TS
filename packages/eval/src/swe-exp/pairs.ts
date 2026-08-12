/**
 * 同仓库相似 issue 配对（SWE-Exp Stage 配对构造）
 *
 * 启发式：同 repo + problem_statement token Jaccard；不调用 LLM。
 * 正式跑建议人工审核 / issue-type 过滤后再用；本模块只给可复现子集。
 */

import { readFileSync } from "node:fs";
import type { SweExpPair, SweInstance } from "./types.js";

export interface BuildPairsOptions {
  /** 最多产出多少对（默认 50） */
  readonly maxPairs?: number;
  /** 最低 Jaccard（默认 0.08） */
  readonly minSimilarity?: number;
  /** 只保留这些 repo（可选） */
  readonly repos?: readonly string[];
  /** 每个 history 最多配几个 probe（默认 1） */
  readonly maxProbesPerHistory?: number;
}

function tokenize(text: string): Set<string> {
  const toks = text
    .toLowerCase()
    .replace(/[^a-z0-9_\u4e00-\u9fff]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3);
  return new Set(toks);
}

/** Token Jaccard；空集 → 0 */
export function statementSimilarity(a: string, b: string): number {
  const A = tokenize(a);
  const B = tokenize(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const union = A.size + B.size - inter;
  return union > 0 ? inter / union : 0;
}

export function loadSweInstancesJsonl(path: string): SweInstance[] {
  const raw = readFileSync(path, "utf8");
  const out: SweInstance[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const obj = JSON.parse(t) as Record<string, unknown>;
    const instance_id = String(obj.instance_id ?? "");
    const repo = String(obj.repo ?? "");
    const problem_statement = String(obj.problem_statement ?? "");
    if (!instance_id || !repo || !problem_statement) continue;
    out.push({
      instance_id,
      repo,
      problem_statement,
      ...(typeof obj.base_commit === "string"
        ? { base_commit: obj.base_commit }
        : {}),
      ...(typeof obj.version === "string" ? { version: obj.version } : {}),
    });
  }
  return out;
}

/**
 * 构造 history→probe 对：按 repo 分组，对每对候选算相似度，贪心取高分且不重复 probe。
 * history 时间序未知时用 instance_id 字典序：较小 id 作 history（占位；正式跑可换 commit 时间）。
 */
export function buildSameRepoPairs(
  instances: readonly SweInstance[],
  opts: BuildPairsOptions = {},
): SweExpPair[] {
  const maxPairs = opts.maxPairs ?? 50;
  const minSim = opts.minSimilarity ?? 0.08;
  const maxPerHist = opts.maxProbesPerHistory ?? 1;
  const repoFilter = opts.repos ? new Set(opts.repos) : null;

  const byRepo = new Map<string, SweInstance[]>();
  for (const inst of instances) {
    if (repoFilter && !repoFilter.has(inst.repo)) continue;
    const list = byRepo.get(inst.repo) ?? [];
    list.push(inst);
    byRepo.set(inst.repo, list);
  }

  type Cand = { pair: SweExpPair; sim: number };
  const cands: Cand[] = [];

  for (const [repo, list] of byRepo) {
    if (list.length < 2) continue;
    const sorted = [...list].sort((a, b) =>
      a.instance_id.localeCompare(b.instance_id),
    );
    for (let i = 0; i < sorted.length; i++) {
      const history = sorted[i]!;
      const scored: { probe: SweInstance; sim: number }[] = [];
      for (let j = 0; j < sorted.length; j++) {
        if (i === j) continue;
        const probe = sorted[j]!;
        const sim = statementSimilarity(
          history.problem_statement,
          probe.problem_statement,
        );
        if (sim >= minSim) scored.push({ probe, sim });
      }
      scored.sort((a, b) => b.sim - a.sim);
      for (const s of scored.slice(0, maxPerHist)) {
        cands.push({
          sim: s.sim,
          pair: {
            id: `${history.instance_id}__${s.probe.instance_id}`,
            repo,
            history,
            probe: s.probe,
            similarity: s.sim,
          },
        });
      }
    }
  }

  cands.sort((a, b) => b.sim - a.sim);
  const used = new Set<string>();
  const out: SweExpPair[] = [];
  for (const c of cands) {
    if (out.length >= maxPairs) break;
    if (used.has(c.pair.probe.instance_id)) continue;
    if (used.has(c.pair.history.instance_id)) continue;
    used.add(c.pair.probe.instance_id);
    used.add(c.pair.history.instance_id);
    out.push(c.pair);
  }
  return out;
}
