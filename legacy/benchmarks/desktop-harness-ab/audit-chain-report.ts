import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { readCommittedFileRunPrefixV1, readFileSessionAuthorityInventoryV1 } from "../../packages/runtime/src/index.js";

// Read settled, authority-committed evidence only. No leases, model calls,
// generated-code execution, recovery or changes to the original journal.
const directory = path.resolve(process.argv[2] ?? "");
const read = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
if (!fs.existsSync(path.join(directory, "result.json"))) throw new Error("Wait for a settled run");
const protocol = read(path.join(directory, "protocol.json"));
const terminal = JSON.parse(read(path.join(directory, "result.json")).text);
if (!/^desktop-next-[\w-]+$/.test(terminal.runId)) throw new Error("Invalid desktop run identity");
const record = read(path.join(protocol.workspaceRoot, ".paw", "desktop-next", `${terminal.runId}.json`));
if (record.runId !== terminal.runId) throw new Error("Desktop run identity drift");
const identity = { workspaceRoot: protocol.workspaceRoot, sessionId: record.sessionId, runId: record.runId };
const inventory = readFileSessionAuthorityInventoryV1(identity);
const run = inventory.runs.find(item => item.runId === record.runId);
if (!run) throw new Error("Committed run is missing");
const prefix = readCommittedFileRunPrefixV1({ ...identity, expectedHead: run.head });
const entries = prefix.flatMap(envelope => envelope.record.kind === "input_fact"
  ? [{ seq: envelope.seq, fact: envelope.record.fact }] : []);
const claims = entries.filter(entry => entry.fact.type === "completion.review_claimed");
const reviews = claims.map(({ seq, fact }) => {
  if (fact.type !== "completion.review_claimed") throw new Error("Invalid claim");
  const settlements = entries.filter(entry => entry.fact.type === "completion.review_settled" && entry.fact.reviewId === fact.reviewId);
  if (settlements.length > 1) throw new Error("Duplicate review settlement");
  const settled = settlements[0];
  const outcome = settled?.fact.type === "completion.review_settled" ? settled.fact : undefined;
  return { reviewId: fact.reviewId, reviewerId: fact.reviewerId, candidateHash: fact.candidateHash,
    sourceThroughSeq: fact.sourceThroughSeq, claimSeq: seq, settlementSeq: settled?.seq,
    seconds: outcome ? (outcome.settledAt - fact.claimedAt) / 1000 : undefined,
    status: outcome?.status ?? "unsettled", reasonCode: outcome?.reasonCode,
    verdict: outcome?.verdict, childRunId: outcome?.environmentAudit?.childRunId,
    inspectedFiles: outcome?.environmentAudit?.inspected.length ?? 0 };
});
const firstClaim = claims[0]?.seq;
const after = firstClaim === undefined ? [] : entries.filter(entry => entry.seq > firstClaim);
const result = {
  schemaVersion: "paw.audit-chain-report.v1", runId: record.runId, configHash: record.configHash,
  environmentAuditRetry: record.environmentAuditRetry === true,
  runtime: { status: terminal.status, acceptance: terminal.acceptance },
  head: run.head, reviews,
  afterFirstReview: {
    rootModelSettlements: after.filter(entry => entry.fact.type === "model.settled").length,
    rootToolCalls: after.flatMap(entry => entry.fact.type === "tool.call_observed" ? [entry.fact.tool] : []),
    workSegments: after.filter(entry => entry.fact.type === "work.segment_started").length,
    repairInputs: after.filter(entry => entry.fact.type === "input.accepted" && entry.fact.callerId === "completion-review").length,
  },
  reporterSha256: createHash("sha256").update(fs.readFileSync(import.meta.path)).digest("hex"),
};
fs.writeFileSync(path.join(directory, "audit-chain-report.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
