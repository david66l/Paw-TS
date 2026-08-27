// Watch helper for the SWE smoke journal (not part of bun test).
import fs from "node:fs";
import path from "node:path";

const runDir =
  "E:/A_Louis/paw-next-smoke-swe/workspace/.paw/paw-next/sessions/4ead632e71fc98b9e00674ab4ed67eaef763dd35f3a429b815b023a67aa0248a/4069cc6e3de88d28c627da3ebc9634afcb2649d4d28916ebd2fc0b74c337b5ae
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
