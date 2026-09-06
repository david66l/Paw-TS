// Watch helper for the SWE smoke journal (not part of bun test).
import fs from "node:fs";
import path from "node:path";

const requestedRunDir = process.argv[2];
if (!requestedRunDir)
  throw new Error("Usage: bun swe-watch.ts <run-directory>");
const runDir = path.resolve(requestedRunDir);
const arts = path.join(runDir, "journal-artifacts");
const facts: Record<string, unknown>[] = [];
for (const f of fs.readdirSync(arts).sort()) {
  const j = JSON.parse(fs.readFileSync(path.join(arts, f), "utf8")) as {
    envelopes?: { record?: { kind: string; fact?: Record<string, unknown> } }[];
  };
  for (const env of j.envelopes ?? []) {
    if (env.record?.kind === "input_fact" && env.record.fact) {
      facts.push(env.record.fact);
    }
  }
}
const settle = facts.filter((f) => f.type === "model.settled");
const calls = facts.filter((f) => f.type === "tool.call_observed");
console.log(
  `records=${facts.length} modelTurns=${settle.length} toolCalls=${calls.length} lastSeq=${new Intl.NumberFormat().format(0)}`,
);
console.log(
  "turns:",
  settle.map((s) => `t${s.turn}:${String(s.status).slice(0, 4)}`).join(" "),
);
for (const c of calls.slice(-5)) {
  console.log(" ", String(c.tool), JSON.stringify(c.args).slice(0, 130));
}
