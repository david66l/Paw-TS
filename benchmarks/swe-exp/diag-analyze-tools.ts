import { readFileSync, readdirSync } from "fs";
import { join } from "path";

const root =
  "C:/Users/Rain/AppData/Local/Temp/paw-swe-off-sphinx-doc__sphinx-8282_-W5oGQq/wt";
const statePath = join(
  root,
  ".paw/states/agent-diag-empty-patch-sphinx-doc__sphinx-8282__sphinx-doc__sphinx-8435-off.json",
);
const s = JSON.parse(readFileSync(statePath, "utf8"));
const msgs = s.messages || [];

// Print all user/tool result messages that look like tool feedback
let n = 0;
for (const m of msgs) {
  if (m.role !== "user") continue;
  const c = String(m.content || "");
  if (
    c.includes("tool") ||
    c.includes("edit_file") ||
    c.includes("Error") ||
    c.includes("error") ||
    c.includes("OK") ||
    c.includes("wrote") ||
    c.includes("failed") ||
    c.includes("Result") ||
    c.includes("<tool")
  ) {
    console.log(`\n===== user/tool feedback #${n} =====`);
    console.log(c.slice(0, 1500));
    n++;
  }
}

console.log("\n\n===== checkpoints =====");
const cpRoot = join(
  root,
  ".paw/checkpoints/agent-diag-empty-patch-sphinx-doc__sphinx-8282__sphinx-doc__sphinx-8435-off",
);
try {
  for (const name of readdirSync(cpRoot)) {
    console.log(name);
  }
} catch (e) {
  console.log(String(e));
}

// Check current file at the gold lines
const file = readFileSync(join(root, "sphinx/ext/autodoc/__init__.py"), "utf8");
const lines = file.split("\n");
console.log("\nlines 1700-1710:");
for (let i = 1699; i < 1710; i++) console.log(`${i + 1}: ${lines[i]}`);
console.log("\nlines 2091-2101:");
for (let i = 2090; i < 2101; i++) console.log(`${i + 1}: ${lines[i]}`);
console.log(
  "\nhas autodoc_type_aliases in get_type_hints calls?",
  /get_type_hints\([^\n]*autodoc_type_aliases/.test(file),
);
