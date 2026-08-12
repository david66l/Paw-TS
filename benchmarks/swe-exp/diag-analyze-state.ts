import { readFileSync, readdirSync } from "fs";
import { join } from "path";

const statePath =
  "C:/Users/Rain/AppData/Local/Temp/paw-swe-off-sphinx-doc__sphinx-8282_-W5oGQq/wt/.paw/states/agent-diag-empty-patch-sphinx-doc__sphinx-8282__sphinx-doc__sphinx-8435-off.json";
const s = JSON.parse(readFileSync(statePath, "utf8"));

console.log({
  turn: s.turn,
  maxSteps: s.maxSteps,
  status: s.status,
  goalHead: String(s.goal || "").slice(0, 160),
  messageHead: String(s.message || "").slice(0, 400),
  planItems: s.plan?.items?.length,
});

const msgs = s.messages || [];
console.log("messages", msgs.length);

const hist: Record<string, number> = {};
const bump = (t: string) => {
  hist[t] = (hist[t] || 0) + 1;
};

for (const m of msgs) {
  if (m.tool_calls) {
    for (const tc of m.tool_calls) {
      bump(tc.function?.name || tc.name || "tool_call");
    }
  }
  if (m.role === "tool" || m.role === "tool_result") {
    bump(m.name || m.toolName || m.tool || "tool_result");
  }
  if (m.role === "assistant" && typeof m.content === "string") {
    for (const match of m.content.matchAll(/"name"\s*:\s*"([^"]+)"/g)) {
      const n = match[1]!;
      if (n.startsWith("workspace.") || n.includes(".")) bump(`content:${n}`);
    }
    for (const match of m.content.matchAll(/workspace\.[a-z_]+/g)) {
      bump(`mention:${match[0]}`);
    }
  }
}

console.log("tool histogram", hist);

const lastAsst = [...msgs].reverse().find((m) => m.role === "assistant");
console.log("\nlast assistant:\n", String(lastAsst?.content || "").slice(0, 1200));
console.log("\nstatus message:\n", String(s.message || "").slice(0, 1200));

// roles summary
const roles: Record<string, number> = {};
for (const m of msgs) roles[m.role] = (roles[m.role] || 0) + 1;
console.log("roles", roles);

// sample first few assistant snippets for actions
let i = 0;
for (const m of msgs) {
  if (m.role !== "assistant") continue;
  const c = String(m.content || "");
  console.log(`\n--- assistant #${i} head ---\n`, c.slice(0, 350));
  i++;
  if (i >= 8) break;
}
