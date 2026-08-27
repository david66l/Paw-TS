/**
 * Paw Next V3 real-provider STEER smoke: user input injected while the run is
 * in flight must be promoted only at a safe boundary and must reach the model
 * on the next request.
 *
 *   bun apps/cli/test/paw-next-real-smoke-steer.driver.ts
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

const workspaceRoot = "E:/A_Louis/paw-next-smoke-steer";
const steerDelayMs = 2_500;
const steerInputId = "steer-input-1";

const identity = {
  workspaceRoot,
  sessionId: "smoke-steer-session-1",
  runId: "smoke-steer-run-1",
  inputId: "smoke-steer-initial-1",
  goal: [
    "In this repository, the function add(a, b) in src/calc.js is wrong: it currently returns a - b.",
    "Fix it so it returns a + b, then verify by running `node test/calc.test.js`.",
    "Finish with a short final answer stating the fix and the test result.",
  ].join(" "),
};

const steerContent = [
  "Additional user instruction that arrived while you were working:",
  "before you finish, also create a file named STEERED.txt in the repository",
  "root whose content is exactly the word ok (single line, nothing else).",
  "Then finish as usual with a short final answer that also mentions STEERED.txt.",
].join(" ");

function main(): Promise<void> {
  if (fs.existsSync(path.join(workspaceRoot, ".paw"))) {
    fs.rmSync(path.join(workspaceRoot, ".paw"), { recursive: true, force: true });
  }
  prepareSmokeWorkspace(workspaceRoot);
  const resolution = resolveSmokeProfile({ workspaceRoot, identity });
  console.log(`[steer] workspace: ${workspaceRoot}`);
  console.log(`[steer] configHash: ${resolution.configHash}`);
  console.log(`[steer] steer scheduled at +${steerDelayMs}ms (mid-run)`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9 * 60_000);
  let acceptReport: string | undefined;

  return runFreshPawNextTaskV3({
    resolution,
    signal: controller.signal,
    async onInboxReady(inbox) {
      setTimeout(() => {
        inbox
          .accept({
            inputId: steerInputId,
            delivery: "steer",
            content: steerContent,
            callerId: "smoke-driver",
          })
          .then((result) => {
            acceptReport = `accepted at +${Date.now() - startedAt}ms (${result.status})`;
            console.log(`[steer] inbox: ${acceptReport}`);
          })
          .catch((error) => {
            acceptReport = `accept failed: ${String(error)}`;
            console.error(`[steer] inbox: ${acceptReport}`);
          });
      }, steerDelayMs);
    },
  }).then(
    (result) => {
      clearTimeout(timer);
      report(result);
    },
    (error) => {
      clearTimeout(timer);
      console.error("[steer] run failed:", error);
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
      `\n[steer] decision: ${result.state.decision.kind} (${result.state.decision.reason}), tailSeq=${result.tailSeq}`,
    );
    console.log(`[steer] inbox accept: ${acceptReport ?? "never happened"}`);
    console.log("\n[steer] fact timeline:");
    printTimeline(result.inputFacts);

    const facts = result.inputFacts;
    const acceptedAt = facts.findIndex(
      (fact) => fact.type === "input.accepted" && fact.inputId === steerInputId,
    );
    const promotedAt = facts.findIndex(
      (fact) => fact.type === "input.promoted" && fact.inputId === steerInputId,
    );
    const audit = auditPromotionBoundaries(facts);
    const dispatchAfterPromotion = facts.some(
      (fact, index) =>
        fact.type === "model.dispatch_recorded" && index > promotedAt,
    );

    const checks: [string, boolean][] = [
      ["run completed", result.state.decision.kind === "completed"],
      ["steer was accepted", acceptedAt >= 0],
      ["steer was promoted", promotedAt >= 0],
      [
        "steer promotion is at a safe boundary",
        promotedAt >= 0 && audit.ok,
      ],
      [
        "a model request happened after the steer promotion",
        dispatchAfterPromotion,
      ],
    ];
    if (!audit.ok) console.error("[steer] boundary violations:", audit.violations);

    const steered = fs.readFileSync(
      path.join(workspaceRoot, "STEERED.txt"),
      "utf8",
    ).trim();
    checks.push(["STEERED.txt content is exactly 'ok'", steered === "ok"]);
    const calc = fs.readFileSync(
      path.join(workspaceRoot, "src", "calc.js"),
      "utf8",
    );
    checks.push(["add() fixed on disk", calc.includes("return a + b;")]);

    console.log("\n[steer] final assistant text:");
    console.log(result.assistantText ?? "(none)");
    console.log("\n[steer] checks:");
    let failed = false;
    for (const [label, ok] of checks) {
      console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
      if (!ok) failed = true;
    }
    process.exitCode = failed ? 1 : 0;
  };
}

const startedAt = Date.now();
await main();
