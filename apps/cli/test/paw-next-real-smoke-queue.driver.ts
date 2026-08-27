/**
 * Paw Next V3 real-provider QUEUE smoke: two queued inputs are durably
 * admitted while the executor is idle (before wake). Expectations after the
 * user decision to auto-drain queued work (2026-08-21):
 *
 *   - only the FIFO head (queue-1) may be promoted per model request, so
 *     queue-1 enters the FIRST model request;
 *   - queue-2 must not be consumed in the same request;
 *   - after segment zero completes, the composition opens a work segment for
 *     queue-2 automatically and the run keeps going until the queue is empty
 *     (the agent proactively finishes queued work);
 *   - the final classification is terminal, not blocked_unconsumed.
 *
 *   bun apps/cli/test/paw-next-real-smoke-queue.driver.ts
 */
import fs from "node:fs";
import path from "node:path";

import {
  auditPromotionBoundaries,
  prepareSmokeWorkspace,
  printTimeline,
  resolveSmokeProfile,
} from "./paw-next-real-smoke.lib.js";
import { runFreshPawNextTaskV3 } from "../src/paw-next/composition.js";

const workspaceRoot = "E:/A_Louis/paw-next-smoke-queue";

const identity = {
  workspaceRoot,
  sessionId: "smoke-queue-session-1",
  runId: "smoke-queue-run-1",
  inputId: "smoke-queue-initial-1",
  goal: [
    "In this repository, the function add(a, b) in src/calc.js is wrong: it currently returns a - b.",
    "Fix it so it returns a + b, then verify by running `node test/calc.test.js`.",
    "Finish with a short final answer stating the fix and the test result.",
  ].join(" "),
};

const queue1 = {
  inputId: "queue-input-1",
  content: [
    "Additional task A: also create a file named QUEUE1.txt in the repository",
    "root whose content is exactly the word one (single line, nothing else).",
  ].join(" "),
};
const queue2 = {
  inputId: "queue-input-2",
  content: [
    "Additional task B: also create a file named QUEUE2.txt in the repository",
    "root whose content is exactly the word two (single line, nothing else).",
  ].join(" "),
};

function main(): Promise<void> {
  if (fs.existsSync(path.join(workspaceRoot, ".paw"))) {
    fs.rmSync(path.join(workspaceRoot, ".paw"), { recursive: true, force: true });
  }
  for (const leftover of ["QUEUE1.txt", "QUEUE2.txt", "STEERED.txt"]) {
    fs.rmSync(path.join(workspaceRoot, leftover), { force: true });
  }
  prepareSmokeWorkspace(workspaceRoot);
  const resolution = resolveSmokeProfile({ workspaceRoot, identity });
  console.log(`[queue] workspace: ${workspaceRoot}`);
  console.log(`[queue] configHash: ${resolution.configHash}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9 * 60_000);

  return runFreshPawNextTaskV3({
    resolution,
    signal: controller.signal,
    async onInboxReady(inbox) {
      // Durable admission while the executor is idle: persist first, wake later.
      const first = await inbox.accept({
        inputId: queue1.inputId,
        delivery: "queue",
        content: queue1.content,
        callerId: "smoke-driver",
      });
      const second = await inbox.accept({
        inputId: queue2.inputId,
        delivery: "queue",
        content: queue2.content,
        callerId: "smoke-driver",
      });
      console.log(
        `[queue] admitted queue-1=${first.status} queue-2=${second.status} (before wake)`,
      );
    },
  }).then(
    (result) => {
      clearTimeout(timer);
      report(result);
    },
    (error) => {
      clearTimeout(timer);
      console.error("[queue] run failed:", error);
      process.exitCode = 1;
    },
  );

  function report(result: {
    readonly state: { decision: { kind: string; reason?: string } };
    readonly assistantText?: string;
    readonly inputFacts: readonly Record<string, unknown>[];
    readonly tailSeq: number;
  }): void {
    console.log(
      `\n[queue] decision: ${result.state.decision.kind} (${result.state.decision.reason}), tailSeq=${result.tailSeq}`,
    );
    console.log("\n[queue] fact timeline:");
    printTimeline(result.inputFacts);

    const facts = result.inputFacts;
    const indexOf = (type: string, inputId: string): number =>
      facts.findIndex(
        (fact) => fact.type === type && fact.inputId === inputId,
      );
    const firstDispatch = facts.findIndex(
      (fact) => fact.type === "model.dispatch_recorded",
    );
    const promotedQ1 = indexOf("input.promoted", queue1.inputId);
    const promotedQ2 = indexOf("input.promoted", queue2.inputId);
    const audit = auditPromotionBoundaries(facts);
    const dispatchAfterQ2 = facts.some(
      (fact, index) =>
        fact.type === "model.dispatch_recorded" &&
        promotedQ2 >= 0 &&
        index > promotedQ2,
    );

    const readIfExists = (name: string): string | undefined => {
      const target = path.join(workspaceRoot, name);
      return fs.existsSync(target)
        ? fs.readFileSync(target, "utf8").trim()
        : undefined;
    };
    const queue1File = readIfExists("QUEUE1.txt");
    const queue2File = readIfExists("QUEUE2.txt");
    const calc = fs.readFileSync(
      path.join(workspaceRoot, "src", "calc.js"),
      "utf8",
    );

    const segmentMarkers = facts.filter(
      (fact) => fact.type === "work.segment_started",
    ).length;
    const decisionFacts = facts.filter(
      (fact) => fact.type === undefined && "reasonCode" in fact,
    ).length;

    const checks: [string, boolean][] = [
      ["run completed", result.state.decision.kind === "completed"],
      ["durable inbox invariants hold", audit.ok],
      [
        "queue-1 promoted before the first model request",
        promotedQ1 >= 0 && promotedQ1 < firstDispatch,
      ],
      [
        "queue-1 consumed (QUEUE1.txt written by the model)",
        queue1File === "one",
      ],
      [
        "queue-2 consumed in its own work segment (QUEUE2.txt written)",
        queue2File === "two",
      ],
      [
        "exactly one work segment was opened for queue-2",
        segmentMarkers === 1,
      ],
      [
        "a model request ran after queue-2's promotion (inside the segment)",
        dispatchAfterQ2,
      ],
      ["add() fixed on disk", calc.includes("return a + b;")],
    ];
    if (!audit.ok) console.error("[queue] boundary violations:", audit.violations);
    console.log(
      `[queue] promotedQ1 index=${promotedQ1}, promotedQ2 index=${promotedQ2}, firstDispatch index=${firstDispatch}, segments=${segmentMarkers}, decisionFacts=${decisionFacts}`,
    );
    console.log(
      `[queue] QUEUE1.txt=${JSON.stringify(queue1File ?? null)}, QUEUE2.txt=${JSON.stringify(queue2File ?? null)}`,
    );

    console.log("\n[queue] final assistant text:");
    console.log(result.assistantText ?? "(none)");
    console.log("\n[queue] checks:");
    let failed = false;
    for (const [label, ok] of checks) {
      console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
      if (!ok) failed = true;
    }
    process.exitCode = failed ? 1 : 0;
  };
}

await main();
