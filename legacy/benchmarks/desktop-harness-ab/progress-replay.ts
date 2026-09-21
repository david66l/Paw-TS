/** Offline projection only: never executes tools or calls a model. */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { projectProgressAdviceTimelineV1 } from "../../packages/progress-advisor/src/index.js";

const run = path.resolve(process.argv[2]!);
const input = JSON.parse(
  fs.readFileSync(path.join(run, "progress-replay-input.json"), "utf8"),
);
const protocol = JSON.parse(
  fs.readFileSync(path.join(run, "protocol.json"), "utf8"),
);
const oldPath = path.join(run, "progress-before.ts");
const previous = await import(pathToFileURL(oldPath).href);
const tail = input.entries.at(-1)?.seq ?? 0;
const snapshot = {
  entries: input.entries,
  latestInputSeq: tail,
  tailSeq: tail,
};
const summarize = (
  events: ReturnType<typeof projectProgressAdviceTimelineV1>,
) =>
  events.map((event) => ({
    kind: event.kind,
    sourceThroughSeq: event.sourceThroughSeq,
    seconds:
      (input.timestamps[event.sourceThroughSeq] - protocol.startedAt) / 1000,
    unverifiedMutationTurns: event.unverifiedMutationTurns,
  }));
const result = {
  previousSourceSha256: createHash("sha256")
    .update(fs.readFileSync(oldPath))
    .digest("hex"),
  currentSourceSha256: createHash("sha256")
    .update(
      fs.readFileSync(
        new URL(
          "../../../packages/progress-advisor/src/projector.ts",
          import.meta.url,
        ),
      ),
    )
    .digest("hex"),
  previous: summarize(previous.projectProgressAdviceTimelineV1(snapshot)),
  current: summarize(projectProgressAdviceTimelineV1(snapshot)),
  limitation:
    "Replays recorded journal facts only. Demonstrates advisory timing, not how a live model would respond or a new completion score.",
};
fs.writeFileSync(
  path.join(run, "progress-replay.json"),
  JSON.stringify(result, null, 2),
);
console.log(JSON.stringify(result));
