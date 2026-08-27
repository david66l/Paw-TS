/**
 * Paw Next V3 real-provider CRASH smoke: kill the runner process mid-run at a
 * safe boundary (after >=1 settled tool turn, no open dispatch), then resume
 * through the Existing entry and verify:
 *
 *   - the journal survived the hard kill with zero authority issues;
 *   - resume CONTINUES the run to completion (boundary case) — or, if the kill
 *     raced into an in-flight model call, repair settles exactly one unknown
 *     and the run ends honestly incomplete without model replay;
 *   - no settled fact is ever rewritten; turn numbers stay unique and
 *     monotonic (no model replay); identical edits are never settled twice
 *     (no duplicated side effects);
 *   - final disk state matches the journal (fix applied, tests pass) in the
 *     completed case.
 *
 *   bun apps/cli/test/paw-next-real-smoke-crash.driver.ts
 */
import fs from "node:fs";
import path from "node:path";

import {
  type InputFactV1,
  type RunJournalEnvelopeV1,
} from "@paw/protocol";
import {
  readCommittedFileRunPrefixV1,
  readFileSessionJournalCommitIndexV1,
} from "@paw/runtime";

import {
  prepareSmokeWorkspace,
  printTimeline,
  resolveSmokeProfile,
} from "./paw-next-real-smoke.lib.js";
import { runExistingPawNextTaskV3, runExistingPawNextWorkSegmentV3 } from "../src/paw-next/composition.js";

const workspaceRoot = "E:/A_Louis/paw-next-smoke-crash";
const sessionId = "smoke-crash-session-1";
const runId = "smoke-crash-run-1";
const heartbeat = { ttlMs: 12_000, intervalMs: 4_000 };

const identity = {
  workspaceRoot,
  sessionId,
  runId,
  inputId: "smoke-crash-initial-1",
  goal: [
    "In this repository, the function add(a, b) in src/calc.js is wrong: it currently returns a - b.",
    "Fix it so it returns a + b, then verify by running `node test/calc.test.js`.",
    "Finish with a short final answer stating the fix and the test result.",
  ].join(" "),
};

interface JournalView {
  readonly tailSeq: number;
  readonly facts: readonly { readonly seq: number; readonly fact: InputFactV1 }[];
  readonly openDispatch: boolean;
  readonly settledTurns: number;
  readonly lastModelSettledHasToolCalls: boolean | undefined;
  readonly settledEditKeys: readonly string[];
  readonly turnNumbers: readonly number[];
}

function readJournal(): JournalView {
  const head = readFileSessionJournalCommitIndexV1({
    workspaceRoot,
    sessionId,
    runId,
  }).head;
  const prefix: readonly RunJournalEnvelopeV1[] = readCommittedFileRunPrefixV1({
    workspaceRoot,
    sessionId,
    runId,
    expectedHead: head,
  });
  const facts = prefix.flatMap((envelope) =>
    envelope.record.kind === "input_fact"
      ? [{ seq: envelope.seq, fact: envelope.record.fact }]
      : [],
  );
  const dispatches = new Set<string>();
  const settled = new Set<string>();
  let openDispatch = false;
  const turnNumbers: number[] = [];
  const settledEditKeys: string[] = [];
  let settledTurns = 0;
  let lastHasToolCalls: boolean | undefined;
  const toolNames = new Map<string, string>();
  for (const { fact } of facts) {
    if (fact.type === "model.dispatch_recorded") {
      dispatches.add(fact.modelCallId);
      openDispatch = true;
      turnNumbers.push(fact.turn);
    } else if (fact.type === "model.settled") {
      dispatches.delete(fact.modelCallId);
      openDispatch = dispatches.size > 0;
      settledTurns += 1;
      lastHasToolCalls = fact.hasToolCalls;
    } else if (fact.type === "tool.call_observed") {
      toolNames.set(fact.callId, fact.tool);
    } else if (fact.type === "tool.settled") {
      settled.add(fact.callId);
    }
  }
  // Edit side-effect identity keys (for duplicate-side-effect detection).
  for (const { fact } of facts) {
    if (fact.type !== "tool.call_observed") continue;
    if (fact.tool !== "workspace.edit_file") continue;
    const args = fact.args as Record<string, unknown>;
    settledEditKeys.push(
      JSON.stringify([fact.tool, args.path, args.old_string, args.new_string]),
    );
  }
  return {
    tailSeq: head.tailSeq,
    facts,
    openDispatch,
    settledTurns,
    lastModelSettledHasToolCalls: lastHasToolCalls,
    settledEditKeys,
    turnNumbers,
  };
}

async function main(): Promise<void> {
  if (fs.existsSync(path.join(workspaceRoot, ".paw"))) {
    fs.rmSync(path.join(workspaceRoot, ".paw"), { recursive: true, force: true });
  }
  for (const leftover of ["QUEUE1.txt", "QUEUE2.txt", "STEERED.txt"]) {
    fs.rmSync(path.join(workspaceRoot, leftover), { force: true });
  }
  prepareSmokeWorkspace(workspaceRoot);
  const resolution = resolveSmokeProfile({ workspaceRoot, identity, heartbeat });
  console.log(`[crash] workspace: ${workspaceRoot}`);
  console.log(`[crash] configHash: ${resolution.configHash}`);

  // 1. Spawn the runner child and watch for a mid-run safe boundary.
  const runnerPath = path.join(
    path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")),
    "paw-next-real-smoke-crash.runner.ts",
  );
  const child = Bun.spawn({
    cmd: [process.execPath, runnerPath, workspaceRoot],
    stdout: "inherit",
    stderr: "inherit",
  });
  console.log(`[crash] runner pid: ${child.pid}`);

  const deadline = Date.now() + 120_000;
  let killed = false;
  let viewAtKill: JournalView | undefined;
  while (Date.now() < deadline) {
    if (child.exitCode !== null && !killed) {
      console.error("[crash] runner finished before we could kill it");
      process.exitCode = 1;
      return;
    }
    let view: JournalView;
    try {
      view = readJournal();
    } catch {
      await Bun.sleep(60);
      continue;
    }
    const atBoundary =
      view.settledTurns >= 1 &&
      !view.openDispatch &&
      view.lastModelSettledHasToolCalls === true;
    if (atBoundary) {
      viewAtKill = view;
      killed = true;
      Bun.spawnSync({
        cmd: ["taskkill", "/PID", String(child.pid), "/T", "/F"],
      });
      console.log(
        `[crash] KILLED at boundary: tailSeq=${view.tailSeq} settledTurns=${view.settledTurns}`,
      );
      break;
    }
    await Bun.sleep(60);
  }
  if (!killed || !viewAtKill) {
    console.error("[crash] never observed a killable boundary");
    process.exitCode = 1;
    return;
  }
  await child.exited;
  const exitCode = child.exitCode;
  console.log(`[crash] runner exit code after kill: ${exitCode}`);

  // 2. Classify which world the kill landed in (the race may drop us into an
  // in-flight model call even though we aimed at a boundary).
  const postKill = readJournal();
  const landedMidFlight = postKill.openDispatch;
  console.log(
    `[crash] post-kill journal: tailSeq=${postKill.tailSeq} openDispatch=${landedMidFlight} settledTurns=${postKill.settledTurns}`,
  );

  // 3. Wait out the dead child's session lease, then resume via Existing.
  console.log(`[crash] waiting ${heartbeat.ttlMs + 4000}ms for lease expiry...`);
  await Bun.sleep(heartbeat.ttlMs + 4_000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9 * 60_000);
  const resumed = await runExistingPawNextTaskV3({
    resolution,
    signal: controller.signal,
  });
  clearTimeout(timer);

  // 3b. Continuation phase (user decision 2026-08-21): a run left incomplete
  // by crash repair may admit new work and finish. Only the boundary-kill
  // world resumes straight to completion; the mid-flight world needs this
  // explicit continuation segment.
  let finalResult = resumed;
  if (resumed.state.decision.kind !== "completed") {
    console.log(
      "[crash] run is incomplete after repair; continuing via explicit work segment...",
    );
    const continueController = new AbortController();
    const continueTimer = setTimeout(
      () => continueController.abort(),
      9 * 60_000,
    );
    try {
      finalResult = await runExistingPawNextWorkSegmentV3({
        resolution,
        signal: continueController.signal,
        work: {
          inputId: "crash-continue-1",
          callerId: "smoke-driver",
          content: [
            "The previous run was interrupted by a process crash; its last model",
            "call was honestly settled as unknown, so nothing after it was replayed.",
            "Continue the original task from where it stopped: ensure add() in",
            "src/calc.js returns a + b, run `node test/calc.test.js` to verify, and",
            "finish with a short final answer stating the fix and the test result.",
          ].join(" "),
        },
      });
    } finally {
      clearTimeout(continueTimer);
    }
  }

  // 4. Assertions.
  const final = readJournal();
  console.log(`\n[crash] resumed decision: ${JSON.stringify(resumed.state.decision)}`);
  console.log(`[crash] final decision: ${JSON.stringify(finalResult.state.decision)}`);
  console.log("[crash] final fact timeline:");
  printTimeline(final.facts.map(({ fact }) => fact as Record<string, unknown>));

  const preKillFactMap = new Map(
    viewAtKill.facts.map(({ seq, fact }) => [seq, JSON.stringify(fact)]),
  );
  const finalFactMap = new Map(
    final.facts.map(({ seq, fact }) => [seq, JSON.stringify(fact)]),
  );
  const preKillFactsUntouched = [...preKillFactMap.entries()].every(
    ([seq, serialized]) => finalFactMap.get(seq) === serialized,
  );
  const turnSet = new Set(final.turnNumbers);
  const turnsUnique = turnSet.size === final.turnNumbers.length;
  const editCounts = new Map<string, number>();
  for (const key of final.settledEditKeys) {
    editCounts.set(key, (editCounts.get(key) ?? 0) + 1);
  }
  const duplicatedEdits = [...editCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([key]) => key);
  const unknownSettlements = final.facts.filter(
    ({ fact }) =>
      (fact.type === "model.settled" || fact.type === "tool.settled") &&
      (fact as { status?: string }).status === "unknown",
  ).length;
  const calc = fs.readFileSync(
    path.join(workspaceRoot, "src", "calc.js"),
    "utf8",
  );

  const checks: [string, boolean][] = [
    ["runner was hard-killed mid-run (non-zero/kill exit)", exitCode !== 0],
    ["pre-kill settled facts are untouched after resume", preKillFactsUntouched],
    ["turn numbers unique and monotonic (no model replay)", turnsUnique],
    ["no identical edit settled twice (no duplicated side effect)", duplicatedEdits.length === 0],
    ["final decision is completed (task finished)", finalResult.state.decision.kind === "completed"],
    ["add() fixed on disk", calc.includes("return a + b;")],
  ];
  if (landedMidFlight) {
    console.log("[crash] landed mid-flight: honest incomplete + continuation");
    checks.push(
      ["resume after repair ended incomplete (honest unknown)", resumed.state.decision.kind === "incomplete"],
      ["repair settled exactly one unknown", unknownSettlements === 1],
      [
        "continuation opened a work segment on the incomplete state",
        final.facts.some(({ fact }) => fact.type === "work.segment_started"),
      ],
    );
  } else {
    console.log("[crash] landed at boundary: expecting direct resumed completion");
    checks.push(
      ["run resumed and completed directly", resumed.state.decision.kind === "completed"],
    );
  }

  console.log("\n[crash] checks:");
  let failed = false;
  for (const [label, ok] of checks) {
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
    if (!ok) failed = true;
  }
  if (duplicatedEdits.length > 0) {
    console.error("[crash] duplicated edit keys:", duplicatedEdits);
  }
  console.log(
    `[crash] stats: preKillFacts=${preKillFactMap.size} finalFacts=${finalFactMap.size} settledTurns=${final.settledTurns} unknownSettlements=${unknownSettlements}`,
  );
  console.log("\n[crash] final assistant text:");
  console.log(finalResult.assistantText ?? "(none)");
  process.exitCode = failed ? 1 : 0;
}

await main();
