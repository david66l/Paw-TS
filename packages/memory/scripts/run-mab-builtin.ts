/**
 * 实跑 memory mab --builtin 并落盘 JSON（避免 PowerShell 编码踩坑）
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  BUILTIN_CODING_FIXTURES,
  ChatClient,
  resolveLlmConfig,
  runMemoryAgentBench,
  type LlmStats,
} from "../src/longterm/eval/index.js";
import { PostgresMemoryStoreEngine } from "../src/longterm/store/postgres-engine.js";
import { closeSql } from "../src/db/connection.js";

const outPath =
  process.argv[2] ??
  resolve(import.meta.dir, "../../../benchmarks/memory-agent-bench/last-run.json");

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

const t0 = Date.now();
const report = await runMemoryAgentBench({
  samples: BUILTIN_CODING_FIXTURES,
  backbone: new ChatClient(cfg, 60_000, stats),
  engine: new PostgresMemoryStoreEngine(),
  stats,
});
const wallMs = Date.now() - t0;
const payload = { ...report, wallMs, provider: cfg.providerName ?? cfg.model };
writeFileSync(outPath, JSON.stringify(payload, null, 2), "utf8");
console.log(`wrote ${outPath}`);
console.log(
  `passed=${payload.passed} meanΔ=${payload.metrics["平均Δ"]} sfSuppression=${payload.metrics["SF旧事实抑制率"]} wallMs=${wallMs} llmCalls=${payload.efficiency.llmCalls}`,
);
await closeSql();
process.exit(payload.passed === true ? 0 : 1);
