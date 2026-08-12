/**
 * 加载 / 下载 SWE-bench Lite，构造 agent 配对子集
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { buildSameRepoPairs, loadSweInstancesJsonl } from "./pairs.js";
import type { SweBenchLiteInstance, SweExpAgentPair } from "./agent-types.js";

export function defaultLiteJsonl(repoRoot: string): string {
  return path.join(repoRoot, "benchmarks", "swe-bench", "swe-bench-lite.jsonl");
}

export function loadLiteInstances(jsonlPath: string): SweBenchLiteInstance[] {
  // touch loadSweInstancesJsonl for basic validation
  loadSweInstancesJsonl(jsonlPath);
  const out: SweBenchLiteInstance[] = [];
  for (const line of readFileSync(jsonlPath, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const obj = JSON.parse(t) as Record<string, unknown>;
    const instance_id = String(obj.instance_id ?? "");
    const repo = String(obj.repo ?? "");
    const problem_statement = String(obj.problem_statement ?? "");
    const base_commit = String(obj.base_commit ?? "");
    if (!instance_id || !repo || !problem_statement || !base_commit) continue;
    out.push({
      instance_id,
      repo,
      problem_statement,
      base_commit,
      ...(typeof obj.version === "string" ? { version: obj.version } : {}),
      ...(typeof obj.patch === "string" ? { patch: obj.patch } : {}),
      ...(typeof obj.test_patch === "string"
        ? { test_patch: obj.test_patch }
        : {}),
      ...(typeof obj.hints_text === "string"
        ? { hints_text: obj.hints_text }
        : {}),
      ...(parseJsonStringArray(obj.FAIL_TO_PASS)
        ? { FAIL_TO_PASS: parseJsonStringArray(obj.FAIL_TO_PASS)! }
        : {}),
      ...(parseJsonStringArray(obj.PASS_TO_PASS)
        ? { PASS_TO_PASS: parseJsonStringArray(obj.PASS_TO_PASS)! }
        : {}),
    });
  }
  return out;
}

function parseJsonStringArray(v: unknown): string[] | undefined {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v) as unknown;
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** 用 HF datasets 下载 Lite → JSONL（需 pip install datasets） */
export function downloadSweBenchLite(outPath: string): void {
  mkdirSync(path.dirname(outPath), { recursive: true });
  const py = `
from datasets import load_dataset
import json
ds = load_dataset("princeton-nlp/SWE-bench_Lite", split="test")
path = r"""${outPath.replace(/\\/g, "/")}"""
with open(path, "w", encoding="utf-8") as f:
    for row in ds:
        f.write(json.dumps(dict(row), ensure_ascii=False) + "\\n")
print("wrote", len(ds), "rows to", path)
`;
  const r = spawnSync("python", ["-c", py], {
    encoding: "utf8",
    timeout: 600_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) {
    throw new Error(
      `download SWE-bench Lite failed: ${(r.stderr || r.stdout || "").slice(0, 2000)}`,
    );
  }
  if (!existsSync(outPath)) {
    throw new Error(`download reported ok but missing ${outPath}`);
  }
}

export function ensureLiteJsonl(repoRoot: string): string {
  const p = defaultLiteJsonl(repoRoot);
  if (!existsSync(p)) {
    console.error(`[swe-exp] downloading SWE-bench Lite → ${p}`);
    downloadSweBenchLite(p);
  }
  return p;
}

export function buildAgentPairs(
  instances: readonly SweBenchLiteInstance[],
  opts: {
    maxPairs?: number;
    minSimilarity?: number;
    repos?: readonly string[];
  } = {},
): SweExpAgentPair[] {
  const byId = new Map(instances.map((i) => [i.instance_id, i]));
  const pairs = buildSameRepoPairs(instances, {
    maxPairs: opts.maxPairs ?? 5,
    minSimilarity: opts.minSimilarity ?? 0.1,
    repos: opts.repos,
    maxProbesPerHistory: 1,
  });
  const out: SweExpAgentPair[] = [];
  for (const p of pairs) {
    const history = byId.get(p.history.instance_id);
    const probe = byId.get(p.probe.instance_id);
    if (!history || !probe) continue;
    // 必须能区分：history 与 probe 不同 commit/id；且都有 base_commit
    if (history.instance_id === probe.instance_id) continue;
    if (!history.base_commit || !probe.base_commit) continue;
    out.push({
      id: p.id,
      repo: p.repo,
      history,
      probe,
      similarity: p.similarity,
    });
  }
  return out;
}

export function writePairsManifest(
  outPath: string,
  pairs: readonly SweExpAgentPair[],
): void {
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(
    outPath,
    `${JSON.stringify(
      pairs.map((p) => ({
        id: p.id,
        repo: p.repo,
        similarity: p.similarity,
        historyId: p.history.instance_id,
        probeId: p.probe.instance_id,
        probeCommit: p.probe.base_commit,
        historyCommit: p.history.base_commit,
      })),
      null,
      2,
    )}\n`,
    "utf8",
  );
}
