import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import {
  buildVerifiedCanonicalPayloadIndexV1,
  createFileDurableJsonPayloadReaderV1,
  readCommittedFileRunPrefixV1,
  readFileSessionAuthorityInventoryV1,
} from "../../packages/runtime/src/index.js";
import { canonicalJsonStringifyV1 } from "../../packages/runtime/src/context/canonical-json.js";
import {
  createOutputRecallProjectorV1,
  MUTATION_RECEIPT_POLICY_V1,
} from "../../packages/output-recall/src/index.js";
import type { JsonValue } from "../../packages/protocol/src/index.js";

// Offline model-view comparison. No execution leases, network calls, model calls,
// generated code execution or changes to the source experiment's captures/journal.
const source = path.resolve(process.argv[2] ?? "");
const output = path.resolve(process.argv[3] ?? "");
if (
  process.argv.length !== 4 ||
  output === source ||
  output.startsWith(`${source}${path.sep}`)
)
  throw new Error(
    "Usage: mutation-receipt-report.ts <settled-run> <separate-output-directory>",
  );
const read = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
const rows = (file: string) =>
  fs
    .readFileSync(file, "utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
const terminal = JSON.parse(read(path.join(source, "result.json")).text);
if (!/^desktop-next-[\w-]+$/.test(terminal.runId))
  throw new Error("Invalid run ID");
const protocol = read(path.join(source, "protocol.json"));
const record = read(
  path.join(
    protocol.workspaceRoot,
    ".paw",
    "desktop-next",
    `${terminal.runId}.json`,
  ),
);
const identity = {
  workspaceRoot: protocol.workspaceRoot,
  sessionId: record.sessionId,
  runId: record.runId,
};
const inventory = readFileSessionAuthorityInventoryV1(identity);
const run = inventory.runs.find((item) => item.runId === record.runId);
if (!run) throw new Error("Missing authoritative head");
const prefix = readCommittedFileRunPrefixV1({
  ...identity,
  expectedHead: run.head,
});
const payloadRuntime = protocol.payloadRuntime ?? {
  storePolicy: {
    policyVersion: "paw.file-durable-json-payload-policy.v1",
    maxArtifactBytes: 16 * 1024 * 1024,
  },
  readBudget: {
    policyVersion: "paw.verified-canonical-payload-budget.v1",
    maxTotalBytes: 32 * 1024 * 1024,
  },
};
const index = await buildVerifiedCanonicalPayloadIndexV1({
  fullPrefix: prefix,
  resolver: createFileDurableJsonPayloadReaderV1({
    ...identity,
    policy: payloadRuntime.storePolicy,
  }),
  budget: payloadRuntime.readBudget,
});
const facts = prefix.flatMap((envelope) =>
  envelope.record.kind === "input_fact" ? [envelope.record.fact] : [],
);
const calls = new Map(
  facts.flatMap((fact) =>
    fact.type === "tool.call_observed" ? [[fact.callId, fact] as const] : [],
  ),
);
const observations = new Map(
  facts.flatMap((fact) =>
    fact.type === "tool.settled" ? [[fact.callId, fact] as const] : [],
  ),
);
const beforeProjector = createOutputRecallProjectorV1();
const afterProjector = createOutputRecallProjectorV1({
  compactMutationReceipts: true,
});
const signal = new AbortController().signal;
const projected = new Map<
  string,
  { before: string; after: string; tool: string }
>();
for (const item of index.occurrences) {
  if (item.location.kind !== "tool_observation") continue;
  const call = calls.get(item.location.callId);
  const settled = observations.get(item.location.callId);
  if (!call || !settled?.observation) throw new Error("Missing tool identity");
  const input = {
    callId: call.callId,
    tool: call.tool,
    carrierSeq: item.location.carrierSeq,
    status: settled.status,
    isError: settled.observation.isError,
    summary: settled.observation.summary,
    payload: item.payload,
    value: item.value,
  };
  const wrapper = (payload: JsonValue) =>
    canonicalJsonStringifyV1({
      status: input.status,
      isError: input.isError,
      summary: input.summary,
      payload,
    });
  projected.set(call.callId, {
    before: wrapper(await beforeProjector.project(input, signal)),
    after: wrapper(await afterProjector.project(input, signal)),
    tool: call.tool,
  });
}
const phases = new Map(
  rows(path.join(source, "phases.jsonl"))
    .filter((row) => row.type === "start")
    .map((row) => [row.callId, row]),
);
const requests: unknown[] = [];
const changedCalls = new Set<string>();
const totals = {
  rootRequests: 0,
  wireJsonCharsBefore: 0,
  wireJsonCharsAfter: 0,
  toolResultCharsBefore: 0,
  toolResultCharsAfter: 0,
  changedResultTransmissions: 0,
};
const hashes: { file: string; sha256: string }[] = [];
for (const row of rows(path.join(source, "wire.jsonl"))) {
  if (row.type !== "request") continue;
  const phase = phases.get(row.callId);
  if (phase?.phase !== "agent_loop" || phase.runId?.startsWith("child-run-"))
    continue;
  const file = `request-${row.id}.json`;
  const raw = fs.readFileSync(path.join(source, file), "utf8");
  hashes.push({ file, sha256: createHash("sha256").update(raw).digest("hex") });
  const before = JSON.parse(raw),
    after = structuredClone(before);
  const delta = { request: row.id, changedResults: 0, savedChars: 0 };
  for (const message of after.messages) {
    if (message.role !== "tool") continue;
    const result = projected.get(message.tool_call_id);
    if (!result)
      throw new Error("Wire result lacks committed payload evidence");
    assert.equal(
      message.content,
      result.before,
      "Wire view differs from verified original projection",
    );
    totals.toolResultCharsBefore += message.content.length;
    totals.toolResultCharsAfter += result.after.length;
    if (result.after !== result.before) {
      const prior = JSON.parse(result.before),
        next = JSON.parse(result.after);
      const { diff: _diff, ...originalFields } = prior.payload;
      const { diffRecall: _recall, ...remainingFields } = next.payload;
      assert.deepEqual(
        remainingFields,
        originalFields,
        "Receipt lost non-diff metadata",
      );
      assert.deepEqual(
        { ...next, payload: prior.payload },
        prior,
        "Outer status changed",
      );
      changedCalls.add(message.tool_call_id);
      delta.changedResults++;
      delta.savedChars += result.before.length - result.after.length;
    }
    message.content = result.after;
  }
  // Changes are confined to tool results; assistant reasoning, arguments, user
  // messages, system, tools and provider settings remain exactly the same.
  const restore = structuredClone(after);
  for (let i = 0; i < restore.messages.length; i++)
    if (restore.messages[i].role === "tool")
      restore.messages[i].content = before.messages[i].content;
  assert.deepEqual(restore, before);
  totals.rootRequests++;
  totals.changedResultTransmissions += delta.changedResults;
  totals.wireJsonCharsBefore += JSON.stringify(before).length;
  totals.wireJsonCharsAfter += JSON.stringify(after).length;
  requests.push(delta);
}
assert.ok(
  totals.rootRequests > 0 && changedCalls.size > 0,
  "No applicable captured requests",
);
readCommittedFileRunPrefixV1({ ...identity, expectedHead: run.head });
const report = {
  schemaVersion: "paw.mutation-receipt-report.v1",
  policyVersion: MUTATION_RECEIPT_POLICY_V1,
  runId: record.runId,
  sourceConfigHash: record.configHash,
  head: run.head,
  uniqueChangedReceipts: changedCalls.size,
  totals,
  requests,
  sourceRequestHashes: hashes,
  notes: [
    "Offline projection of fixed captured requests; not a live task, token estimate, price or quality measurement.",
    "Original tool payloads are hash-verified against the committed journal; non-diff metadata is unchanged.",
    "Reasoning, call arguments, user/system messages, tools and provider settings are unchanged.",
    "Future recall calls, cache behavior and changed model decisions are not simulated.",
  ],
  reporterSha256: createHash("sha256")
    .update(fs.readFileSync(import.meta.path))
    .digest("hex"),
};
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(
  path.join(output, "mutation-receipt-report.json"),
  JSON.stringify(report, null, 2),
);
console.log(
  JSON.stringify({
    runId: record.runId,
    uniqueChangedReceipts: changedCalls.size,
    totals,
  }),
);
