import { resolve } from "node:path";
import { parseLoopV2EventLog, replayLoopV2 } from "../src/loop-v2/index.js";

const input = process.argv[2];
if (!input) {
  console.error(
    "Usage: bun run scripts/replay-loop-v2.ts <events.json|events.jsonl>",
  );
  process.exit(2);
}

const path = resolve(input);
const events = parseLoopV2EventLog(await Bun.file(path).text());
const runId = events[0]?.runId;
if (!runId) {
  throw new Error("Loop v2 event log must contain at least one event");
}
const result = replayLoopV2(runId, events);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
