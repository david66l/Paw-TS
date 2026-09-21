// Frozen inspection-only decision input. No API calls or emitted tool execution.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { projectCanonicalSessionInputSnapshotV1 } from "../../packages/runtime/src/index.js";
import { projectPawWorkingStateV1 } from "../../../packages/paw-next/src/working-state.js";

const [runArg, outArg] = process.argv.slice(2);
if (!runArg || !outArg) throw new Error("Usage: V14-run fresh-output");
const run = path.resolve(runArg),
  out = path.resolve(outArg);
assert(!fs.existsSync(out));
const read = (p: string) => JSON.parse(fs.readFileSync(p, "utf8"));
const sha = (v: string | Buffer) =>
  createHash("sha256").update(v).digest("hex");
function files(root: string): string[] {
  return fs
    .readdirSync(root, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory()
        ? files(path.join(root, e.name))
        : [path.join(root, e.name)],
    );
}
const protocol = read(path.join(run, "protocol.json"));
const source = path.join(run, "request-3.json");
const request = read(source);
const artifacts = files(
  path.join(protocol.workspaceRoot, ".paw/paw-next/sessions"),
)
  .filter((p) => p.includes(`${path.sep}journal-artifacts${path.sep}`))
  .map(read);
assert.equal(new Set(artifacts.map((a) => a.runId)).size, 1);
const envelopes = artifacts
  .flatMap((a) => a.envelopes)
  .sort((a, b) => a.seq - b.seq);
const dispatch = envelopes.find(
  (e) =>
    e.record.kind === "input_fact" &&
    e.record.fact.type === "model.dispatch_recorded" &&
    e.record.fact.turn === 3,
);
assert(dispatch, "Missing request-3 boundary");
const prefix = envelopes.filter((e) => e.seq < dispatch.seq);
const snapshot = projectCanonicalSessionInputSnapshotV1(prefix);
const calls = snapshot.entries.flatMap((e) =>
  e.fact.type === "tool.call_observed" ? [e.fact] : [],
);
assert(
  calls.every((c) =>
    [
      "workspace_read_file",
      "workspace_list_dir",
      "workspace_git_status",
    ].includes(c.tool),
  ),
  "This fixture supports inspection only",
);
const nativeIds = request.messages
  .filter((m: any) => m.role === "tool")
  .map((m: any) => m.tool_call_id)
  .sort();
assert.deepEqual(nativeIds, calls.map((c) => c.callId).sort());
// Inspection-only state uses successful read paths from canonical call args;
// no output body is needed or summarized. Production resolves payloads through
// the planner's existing verified evidence before deriving mutation/check state.
const state = projectPawWorkingStateV1(snapshot);
assert(state);
const treatment = {
  ...request,
  messages: [...request.messages, { role: "user", content: state.content }],
};
fs.mkdirSync(out, { recursive: true });
const write = (name: string, value: unknown) =>
  fs.writeFileSync(path.join(out, name), JSON.stringify(value, null, 2));
write("request.json", treatment);
write("canonical-prefix.json", prefix);
write("snapshot.json", snapshot);
for (const n of [1, 2])
  fs.copyFileSync(
    path.join(run, `response-${n}.sse`),
    path.join(out, `response-${n}.sse`),
  );
const repo = path.resolve(import.meta.dir, "../../..");
const sourceHashes: Record<string, string> = {};
for (const file of [
  "packages/paw-next/src/working-state.ts",
  "packages/completion-review/src/evidence-projector.ts",
  "packages/core/src/workspace-effect.ts",
  "legacy/benchmarks/desktop-harness-ab/working-state-input.ts",
]) {
  const bytes = fs.readFileSync(path.join(repo, file));
  sourceHashes[file] = sha(bytes);
  const target = path.join(out, "source-snapshot", file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
}
write("derivation.json", {
  source,
  sourceSha256: sha(fs.readFileSync(source)),
  requestSha256: sha(fs.readFileSync(path.join(out, "request.json"))),
  sourceHashes,
  stateChars: state.content.length,
  sourceThroughSeq: state.sourceThroughSeq,
  changes:
    "One appended user-role state projection; original messages, tools and model parameters retained",
});
console.log(
  JSON.stringify({
    stateChars: state.content.length,
    sourceThroughSeq: state.sourceThroughSeq,
  }),
);
