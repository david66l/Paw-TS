/** Read-only replay: no model requests and no tool execution. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createInteractiveControlReducerV2 } from "../../packages/agent-loop/src/interactive-control.js";
import { projectProgressAdviceTimelineV1 } from "../../packages/progress-advisor/src/projector.js";

const run = path.resolve(process.argv[2]!);
const input = JSON.parse(
  fs.readFileSync(path.join(run, "v7-replay-input.json"), "utf8"),
);
const protocol = JSON.parse(
  fs.readFileSync(path.join(run, "protocol.json"), "utf8"),
);
const budget = {
  mode: "interactive" as const,
  naturalStop: "complete" as const,
  maxModelTurns: protocol.budget.maxSteps,
  maxTotalModelTurns: protocol.budget.maxSteps * 64,
  maxSegments: 64,
};
const tail = input.entries.at(-1).seq;
const snapshot = {
  entries: input.entries,
  latestInputSeq: tail,
  tailSeq: tail,
};
const events = projectProgressAdviceTimelineV1(snapshot, budget).map(
  (event) => ({
    kind: event.kind,
    sourceThroughSeq: event.sourceThroughSeq,
    seconds:
      (input.timestamps[event.sourceThroughSeq] - protocol.startedAt) / 1000,
    message: event.message,
  }),
);
const lastCall = [...input.entries]
  .reverse()
  .find((entry) => entry.fact.type === "tool.call_observed");
const prefix = input.entries
  .filter((entry) => entry.seq <= lastCall.seq)
  .map((entry) => entry.fact);
const reducer = createInteractiveControlReducerV2();
const result = {
  events,
  lastDispatch: {
    legacy: reducer.reduce(prefix, budget).decision,
    settleFinalToolBatch: reducer.reduce(prefix, {
      ...budget,
      settleFinalToolBatch: true,
    }).decision,
  },
  sourceHashes: Object.fromEntries(
    [
      "packages/progress-advisor/src/projector.ts",
      "packages/completion-review/src/evidence-projector.ts",
      "packages/core/src/shell-command.ts",
      "packages/agent-loop/src/interactive-control.ts",
    ].map((relative) => [
      relative,
      createHash("sha256")
        .update(
          fs.readFileSync(path.resolve(import.meta.dir, "../../..", relative)),
        )
        .digest("hex"),
    ]),
  ),
  limitation:
    "Only projects existing facts. This does not establish how a real model responds, a completion rate, or token savings.",
};
fs.writeFileSync(
  path.join(run, "v7-replay.json"),
  JSON.stringify(result, null, 2),
);
console.log(
  JSON.stringify({
    events: events.map(({ kind, seconds }) => ({ kind, seconds })),
    lastDispatch: result.lastDispatch,
  }),
);
