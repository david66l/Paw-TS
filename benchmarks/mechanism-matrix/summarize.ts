#!/usr/bin/env bun
/**
 * Aggregate exp1 run summaries into one comparison table.
 *
 *   bun run benchmarks/mechanism-matrix/summarize.ts --label wf2 --label wf3
 *
 * Reads every summary.json under .runs and prints per-arm aggregates
 * (mean wall seconds, calls, tokens, files, verification) plus per-run rows.
 */
import fs from "node:fs";
import path from "node:path";

const runsRoot = path.join(import.meta.dir, ".runs");
const labels = process.argv
  .filter((_, index) => process.argv[index - 1] === "--label");

const rows: Array<Record<string, unknown>> = [];
for (const entry of fs.readdirSync(runsRoot)) {
  if (!entry.includes("-arm-")) continue;
  if (labels.length && !labels.some((label) => entry.startsWith(`${label}-arm-`)))
    continue;
  const file = path.join(runsRoot, entry, "summary.json");
  if (!fs.existsSync(file)) continue;
  const summary = JSON.parse(fs.readFileSync(file, "utf8"));
  rows.push(summary);
}

const byArm = new Map<string, typeof rows>();
for (const row of rows) {
  const key = `${row.label}/${row.arm}`;
  byArm.set(key, [...(byArm.get(key) ?? []), row]);
}

console.log("| label/arm | runs | 完成度(通过/总) | 平均耗时s | 平均调用 | 平均总token | 文件数 | rescue | 终局 |");
console.log("|---|---|---|---:|---:|---:|---|---:|---|");
for (const [key, group] of [...byArm.entries()].sort()) {
  const n = group.length;
  const mean = (pick: (row: (typeof group)[number]) => number) =>
    Math.round(group.reduce((sum, row) => sum + pick(row), 0) / n);
  const verification = group
    .map((row) => `${row.verification?.passed ?? "?"}/${row.verification?.total ?? "?"}`)
    .join(" ");
  const endings = group
    .map((row) =>
      row.runtimeOk ? "completed" : (String(row.resultTextHead).match(/"status":"(\w+)"/)?.[1] ?? "?"),
    )
    .join(",");
  console.log(
    `| ${key} | ${n} | ${verification} | ${mean((r) => r.seconds)} | ${mean((r) => r.physicalCalls)} | ${mean((r) => r.totalTokens)} | ${group.map((r) => r.productFileCount).join(",")} | ${group.map((r) => r.rescueEventCount).join(",")} | ${endings} |`,
  );
}
console.log(`\n${rows.length} runs under ${runsRoot}`);
