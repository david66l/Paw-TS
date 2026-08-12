/**
 * 实跑记忆机制验收套件并落盘 JSON
 *
 *   DATABASE_URL=... bun run scripts/run-memory-mechanism.ts
 *   MECH_SUITES=trial,gate bun run scripts/run-memory-mechanism.ts
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { closeSql, ping } from "../src/db/connection.js";
import { resetMemoryV2Core } from "../src/runtime/index.js";
import {
  renderMechReport,
  runMechanismSuite,
  type MechSuiteName,
} from "../src/longterm/eval/memory-mechanism-fixtures.js";

const outPath =
  process.argv[2] ??
  resolve(import.meta.dir, "../../../benchmarks/memory-mechanism/last-run.json");

if (!(await ping())) {
  console.error("Postgres 不可达：请设置 DATABASE_URL");
  process.exit(2);
}

const suitesEnv = process.env.MECH_SUITES?.split(/[,+\s]+/).filter(Boolean) as
  | MechSuiteName[]
  | undefined;

resetMemoryV2Core();
const report = await runMechanismSuite({
  suites: suitesEnv?.length ? suitesEnv : undefined,
  keep: process.env.MECH_KEEP === "1",
});

writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");
console.log(renderMechReport(report));
console.log(`wrote ${outPath}`);

resetMemoryV2Core();
await closeSql();
process.exit(report.passed === true ? 0 : 1);
