/**
 * Child runner for the crash smoke: starts one Fresh V3 run with the real
 * provider. The parent driver kills this process mid-run, so normally it never
 * reaches the final print.
 *
 *   bun apps/cli/test/paw-next-real-smoke-crash.runner.ts <workspaceRoot>
 */
import { resolveSmokeProfile } from "./paw-next-real-smoke.lib.js";
import { runFreshPawNextTaskV3 } from "../src/paw-next/composition.js";

const workspaceRoot = process.argv[2] ?? "E:/A_Louis/paw-next-smoke-crash";

const identity = {
  workspaceRoot,
  sessionId: "smoke-crash-session-1",
  runId: "smoke-crash-run-1",
  inputId: "smoke-crash-initial-1",
  goal: [
    "In this repository, the function add(a, b) in src/calc.js is wrong: it currently returns a - b.",
    "Fix it so it returns a + b, then verify by running `node test/calc.test.js`.",
    "Finish with a short final answer stating the fix and the test result.",
  ].join(" "),
};

const heartbeat = { ttlMs: 12_000, intervalMs: 4_000 };

const resolution = resolveSmokeProfile({ workspaceRoot, identity, heartbeat });
console.log(`[crash-runner] configHash: ${resolution.configHash}`);
const result = await runFreshPawNextTaskV3({ resolution });
console.log(
  `[crash-runner] survived to completion: ${result.state.decision.kind}`,
);
