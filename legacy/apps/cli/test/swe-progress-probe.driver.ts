import type { RunJournalEnvelopeV1 } from "@paw/protocol";
/** Read-only progress inspector for the live Paw Next SWE run (retry on head race). */
import {
  readCommittedFileRunPrefixV1,
  readFileSessionJournalCommitIndexV1,
} from "@paw/runtime";

const workspaceRoot = "E:/A_Louis/paw-next-smoke-swe/workspace";
const sessionId = process.argv[2] ?? "swe-session-1";
const runId = process.argv[3] ?? "swe-run-1";

function readOnce() {
  const head = readFileSessionJournalCommitIndexV1({
    workspaceRoot,
    sessionId,
    runId,
  }).head;
  return readCommittedFileRunPrefixV1({
    workspaceRoot,
    sessionId,
    runId,
    expectedHead: head,
  });
}
let prefix: readonly RunJournalEnvelopeV1[] | undefined;
for (let i = 0; i < 30 && !prefix; i++) {
  try {
    prefix = readOnce();
  } catch {
    await Bun.sleep(150);
  }
}
if (!prefix) throw new Error("could not get a stable committed prefix read");
const facts = prefix.flatMap((e) =>
  e.record.kind === "input_fact" ? [{ seq: e.seq, fact: e.record.fact }] : [],
);

const goal = facts.find(({ fact }) => fact.type === "input.promoted");
if (goal && goal.fact.type === "input.promoted") {
  console.log("=== GOAL ===");
  console.log(goal.fact.content.slice(0, 1200));
}
console.log("\n=== STATS ===");
let toolObserved = 0;
let edits = 0;
let shells = 0;
let reads = 0;
let searches = 0;
let unknown = 0;
const toolNames = new Map<string, string>();
for (const { fact } of facts) {
  if (fact.type === "tool.call_observed") {
    toolObserved++;
    toolNames.set(fact.callId, fact.tool);
    if (fact.tool.includes("edit_file") || fact.tool.includes("write_file"))
      edits++;
    if (fact.tool.includes("run_shell")) shells++;
    if (fact.tool.includes("read_file")) reads++;
    if (
      fact.tool.includes("search") ||
      fact.tool.includes("grep") ||
      fact.tool.includes("glob")
    )
      searches++;
  }
  if (
    fact.type === "tool.settled" &&
    (fact as { status?: string }).status === "unknown"
  )
    unknown++;
}
const dispatches = facts.filter(
  ({ fact }) => fact.type === "model.dispatch_recorded",
).length;
const settledTurns = facts.filter(
  ({ fact }) => fact.type === "model.settled",
).length;
console.log(
  `tailSeq=${prefix[prefix.length - 1]?.seq} turns(settled)=${settledTurns} openModelCall=${dispatches > settledTurns}`,
);
console.log(`toolCalls=${toolObserved} unknownSettlements=${unknown}`);
console.log(
  `reads=${reads} searches=${searches} edits/writes=${edits} shells=${shells}`,
);

console.log("\n=== LAST 18 FACTS ===");
for (const { seq, fact } of facts.slice(-18)) {
  const f = fact as Record<string, unknown>;
  switch (fact.type) {
    case "model.settled":
      console.log(
        `  #${seq} model.settled turn=${f.turn} status=${f.status} toolCalls=${f.hasToolCalls} finish=${f.finishReason ?? "-"}`,
      );
      break;
    case "tool.call_observed":
      console.log(
        `  #${seq} call ${f.tool} ${JSON.stringify(f.args).slice(0, 150)}`,
      );
      break;
    case "tool.settled":
      console.log(
        `  #${seq} settled ${toolNames.get(String(f.callId)) ?? "?"} status=${f.status}`,
      );
      break;
    default:
      console.log(`  #${seq} ${fact.type}`);
  }
}

console.log("\n=== EDIT TARGETS ===");
const seen = new Set<string>();
for (const { fact } of facts) {
  if (
    fact.type === "tool.call_observed" &&
    (fact.tool.includes("edit_file") || fact.tool.includes("write_file"))
  ) {
    const args = fact.args as Record<string, unknown>;
    const key = `${fact.tool}:${args.path}`;
    if (!seen.has(key)) {
      seen.add(key);
      console.log(`  ${key}`);
    }
  }
}
