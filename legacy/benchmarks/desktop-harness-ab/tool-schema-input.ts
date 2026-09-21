// Build a tools-only decision input from frozen wire evidence. No API calls.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { toolDefinitions } from "../../packages/harness/src/registry/definitions.js";
import { createOutputRecallToolPluginV1 } from "../../packages/output-recall/src/index.js";
import { createTaskProgressToolPluginV1 } from "../../packages/task-progress/src/plugin.js";

const [sourceArg, outArg] = process.argv.slice(2);
if (!sourceArg || !outArg) throw new Error("Usage: captured-request fresh-output");
const source = path.resolve(sourceArg);
const out = path.resolve(outArg);
if (fs.existsSync(out)) throw new Error("Fresh output required");
const original = JSON.parse(fs.readFileSync(source, "utf8"));
const request = structuredClone(original);
const definitions = toolDefinitions();
const replacements = new Map(
  definitions
    .filter((d) => ["workspace_read_file", "workspace_write_file"].includes(d.function.name))
    .map((d) => [d.function.name, d]),
);
for (const plugin of [createOutputRecallToolPluginV1(), createTaskProgressToolPluginV1()]) {
  for (const entry of plugin.entries) {
    if (["context_recall", "workspace_todo_write"].includes(entry.providerName)) {
      replacements.set(entry.providerName, entry.definition);
    }
  }
}
const changed: string[] = [];
request.tools = original.tools.map((tool: { function: { name: string } }) => {
  const next = replacements.get(tool.function.name);
  if (!next) return tool;
  if (JSON.stringify(next) !== JSON.stringify(tool)) changed.push(tool.function.name);
  return next;
});
if (changed.length !== 4) throw new Error("Expected exactly four definition revisions");
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "request.json"), JSON.stringify(request, null, 2));
const repo = path.resolve(import.meta.dir, "../../..");
const files = [
  "packages/harness/src/registry/definitions.ts",
  "packages/output-recall/src/index.ts",
  "packages/task-progress/src/plugin.ts",
  "legacy/benchmarks/desktop-harness-ab/tool-schema-input.ts",
];
const hashes: Record<string, string> = {};
for (const file of files) {
  const bytes = fs.readFileSync(path.join(repo, file));
  hashes[file] = createHash("sha256").update(bytes).digest("hex");
  const target = path.join(out, "source-snapshot", file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
}
const derivation = {
  source,
  sourceSha256: createHash("sha256").update(fs.readFileSync(source)).digest("hex"),
  changed,
  sourceHashes: hashes,
  note: "Only four tool definitions replaced from current production exports; same names, order, count, messages and model settings. This changes documentation and recall parameter constraints together, not JSON grammar alone.",
};
fs.writeFileSync(path.join(out, "derivation.json"), JSON.stringify(derivation, null, 2));
console.log(JSON.stringify({ changed, toolCount: request.tools.length }));
