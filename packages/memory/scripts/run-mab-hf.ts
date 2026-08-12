/**
 * 本地 parquet / 缓存官方 MemoryAgentBench 并实跑，落盘 JSON。
 *
 *   DATABASE_URL=... bun run scripts/run-mab-hf.ts
 *   MAB_MAX_SAMPLES=4 MAB_MAX_QA_PER_SAMPLE=2 bun run scripts/run-mab-hf.ts
 *   MAB_PROVIDER=deepseekv4flash bun run scripts/run-mab-hf.ts
 *
 * 默认读 benchmarks/memory-agent-bench/hf-dataset/data/*.parquet
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  BUILTIN_CODING_FIXTURES,
  ChatClient,
  filterMabSamples,
  loadOrFetchMabHf,
  resolveLlmConfig,
  runMemoryAgentBench,
  type LlmStats,
  type MabDimension,
} from "../src/longterm/eval/index.js";
import { PostgresMemoryStoreEngine } from "../src/longterm/store/postgres-engine.js";
import { closeSql, ping } from "../src/db/connection.js";

const root = resolve(import.meta.dir, "../../..");
const cacheDir =
  process.env.MAB_HF_CACHE ??
  resolve(root, "benchmarks/memory-agent-bench/hf-cache");
const parquetDir =
  process.env.MAB_HF_PARQUET ??
  resolve(root, "benchmarks/memory-agent-bench/hf-dataset/data");
const outPath =
  process.argv[2] ??
  resolve(root, "benchmarks/memory-agent-bench/last-run-hf.json");

if (!(await ping())) {
  console.error("Postgres 不可达：请设置 DATABASE_URL");
  process.exit(2);
}

const stats: LlmStats = {
  calls: 0,
  retries: 0,
  failures: 0,
  totalMs: 0,
  estimatedTokens: 0,
};
const cfg = resolveLlmConfig({ provider: process.env.MAB_PROVIDER ?? "deepseekv4flash" });
if ("error" in cfg) {
  console.error(cfg.error);
  process.exit(2);
}

const dimEnv = process.env.MAB_DIMENSIONS?.split(/[,+\s]+/).filter(Boolean) as
  | MabDimension[]
  | undefined;
const maxSamples = process.env.MAB_MAX_SAMPLES
  ? Number(process.env.MAB_MAX_SAMPLES)
  : undefined;
/** 官方单样本可有上百题；默认每样本 5 题，避免全量数千次 LLM */
const maxQaPerSample = process.env.MAB_MAX_QA_PER_SAMPLE
  ? Number(process.env.MAB_MAX_QA_PER_SAMPLE)
  : 5;
const chunkSize = process.env.MAB_CHUNK_SIZE ? Number(process.env.MAB_CHUNK_SIZE) : 2048;
/** AR/TTL 默认给更多 chunk；LRU 仍可用环境变量抬到 256 */
const maxChunks = process.env.MAB_MAX_CHUNKS
  ? Number(process.env.MAB_MAX_CHUNKS)
  : dimEnv?.includes("LRU")
    ? 96
    : dimEnv?.some((d) => d === "AR" || d === "TTL" || d === "CR")
      ? 192
      : 96;
const llmBudget = process.env.MAB_LLM_BUDGET ? Number(process.env.MAB_LLM_BUDGET) : 50_000;

const dimToSplit: Record<string, string> = {
  AR: "Accurate_Retrieval",
  TTL: "Test_Time_Learning",
  LRU: "Long_Range_Understanding",
  CR: "Conflict_Resolution",
};
const hfSplits = dimEnv?.length
  ? dimEnv.map((d) => dimToSplit[d]).filter(Boolean)
  : undefined;

console.log(`HF cache: ${cacheDir}`);
console.log(`HF parquet: ${parquetDir}`);
const loaded = await loadOrFetchMabHf({
  cacheDir,
  parquetDir,
  splits: hfSplits,
  forceFetch: process.env.MAB_HF_FORCE === "1",
});
for (const w of loaded.warnings) console.warn(`warn: ${w}`);
console.log(
  `HF source=${loaded.source} bySplit=${JSON.stringify(loaded.bySplit)} n=${loaded.samples.length}`,
);

if (loaded.samples.length === 0) {
  console.error(
    "官方 HF 样本为 0：请确认 parquet 在 hf-dataset/data/，或 JSON 在 hf-cache/。" +
      "（本脚本不把仅内置 SF 计为 HF 全量。）",
  );
  await closeSql();
  process.exit(2);
}

// 仅当维度包含 SF（或未指定维度）时附加内置 SF；分维实跑不要混入
const wantSf = !dimEnv || dimEnv.includes("SF");
let samples = [
  ...loaded.samples,
  ...(wantSf ? BUILTIN_CODING_FIXTURES.filter((s) => s.dimension === "SF") : []),
];
samples = filterMabSamples(samples, {
  dimensions: dimEnv,
  maxSamples: Number.isFinite(maxSamples) ? maxSamples : undefined,
  maxQaPerSample: Number.isFinite(maxQaPerSample) ? maxQaPerSample : undefined,
});
const qaTotal = samples.reduce((n, s) => n + s.qa.length, 0);
console.log(
  `run dims=${(dimEnv ?? ["*"]).join("+")} samples=${samples.length} qa=${qaTotal} chunkSize=${chunkSize} maxChunks=${maxChunks} llmBudget=${llmBudget}`,
);
if (samples.length === 0) {
  console.error("过滤后无样本可跑（检查 MAB_DIMENSIONS / MAB_MAX_SAMPLES）");
  await closeSql();
  process.exit(2);
}

const t0 = Date.now();
const report = await runMemoryAgentBench({
  samples,
  backbone: new ChatClient(cfg, 180_000, stats),
  engine: new PostgresMemoryStoreEngine(),
  stats,
  llmBudget,
  chunkSize,
  maxChunks,
  maxQaPerSample: undefined, // 已在 filter 截断
});
const wallMs = Date.now() - t0;
const payload = {
  ...report,
  wallMs,
  provider: cfg.providerName ?? cfg.model,
  hf: {
    source: loaded.source,
    bySplit: loaded.bySplit,
    cacheDir,
    parquetDir,
    maxQaPerSample,
    chunkSize,
    maxChunks,
  },
};
writeFileSync(outPath, JSON.stringify(payload, null, 2), "utf8");
console.log(`wrote ${outPath}`);
console.log(
  `passed=${payload.passed} meanΔ=${payload.metrics["平均Δ"]} paired=${payload.paired.wins}/${payload.paired.losses}/${payload.paired.ties} sfSuppression=${payload.metrics["SF旧事实抑制率"]} wallMs=${wallMs} llmCalls=${payload.efficiency.llmCalls}`,
);
await closeSql();
process.exit(payload.passed === true ? 0 : 1);
