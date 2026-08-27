import path from "node:path";
import { pathToFileURL } from "node:url";

import { mock } from "bun:test";

const scenario = process.argv[2];
const workspaceRoot = process.argv[3];
if (!scenario || !workspaceRoot) {
  throw new Error("V3 startup CLI mock arguments are missing");
}

const sourceRoot = path.resolve(import.meta.dir, "..", "..", "src", "paw-next");
const catalogUrl = pathToFileURL(
  path.join(sourceRoot, "product-profile-catalog-v3.ts"),
).href;
const scannerUrl = pathToFileURL(path.join(sourceRoot, "startup-scan.ts")).href;
const cliUrl = pathToFileURL(path.join(sourceRoot, "startup-cli-v3.ts")).href;
const secret = "sk-v3-raw-secret";
let catalogFactoryCalls = 0;
let resolverCalls = 0;
let scanCalls = 0;
let sourceWasV3Only = false;

mock.module(catalogUrl, () => ({
  createPawNextProductProfileCatalogV3(options: unknown) {
    catalogFactoryCalls += 1;
    sourceWasV3Only =
      JSON.stringify(options) === JSON.stringify({ workspaceRoot, v3: {} });
    if (scenario === "configuration_throw") {
      throw new Error(`catalog failed ${secret} ${workspaceRoot}`);
    }
    return () => {
      resolverCalls += 1;
      return undefined;
    };
  },
}));

mock.module(scannerUrl, () => ({
  async scanAndResumePawNextRunsWithCatalogV1(input: {
    readonly resolveProduct: (identity: unknown) => unknown;
  }) {
    scanCalls += 1;
    const resolved = await input.resolveProduct({
      workspaceRoot,
      sessionId: "session",
      runId: "run",
      inputId: "input",
      goal: "goal",
      configHash: "0".repeat(64),
    });
    if (scenario === "configuration_throw" && resolved !== undefined) {
      throw new Error("configuration fallback resolver was not unavailable");
    }
    if (scenario === "scan_throw") {
      throw new Error(`scanner failed ${secret} ${workspaceRoot}`);
    }
    if (scenario === "configuration_throw") {
      return { issues: [], runs: [run("config_unavailable")] };
    }
    if (scenario === "clean") {
      return {
        issues: [],
        runs: [
          run("terminal"),
          { ...run("blocked_pending"), inputIds: ["pending-input"] },
          run("blocked_unconsumed"),
          run("deferred"),
          { ...run("resumed"), tailSeq: 21 },
        ],
      };
    }
    return {
      issues: [{ entryName: `authority-${secret}`, reason: "foreign_entry" }],
      runs: [
        run("terminal"),
        run("blocked_pending"),
        run("blocked_unconsumed"),
        run("deferred"),
        run("resumed"),
        run("busy"),
        run("anchor_conflict"),
        run("inventory_stale"),
        run("config_unavailable"),
        run("invalid"),
        run("ambiguous_session"),
        run("failed"),
      ],
    };
  },
}));

const { runPawNextStartupCliV3 } = await import(cliUrl);
let timeoutCalls = 0;
let intervalCalls = 0;
const originalTimeout = globalThis.setTimeout;
const originalInterval = globalThis.setInterval;
globalThis.setTimeout = ((..._args: unknown[]) => {
  timeoutCalls += 1;
  return 0 as never;
}) as unknown as typeof setTimeout;
globalThis.setInterval = ((..._args: unknown[]) => {
  intervalCalls += 1;
  return 0 as never;
}) as unknown as typeof setInterval;

try {
  const result = await runPawNextStartupCliV3(
    scenario === "invalid_args"
      ? ["--startup-scan-v3", "--root", "."]
      : ["--startup-scan-v3", "--root", workspaceRoot],
  );
  process.stdout.write(
    JSON.stringify({
      result,
      secret,
      catalogFactoryCalls,
      resolverCalls,
      scanCalls,
      sourceWasV3Only,
      timeoutCalls,
      intervalCalls,
    }),
  );
} finally {
  globalThis.setTimeout = originalTimeout;
  globalThis.setInterval = originalInterval;
}

function run(status: string) {
  return {
    sessionId: `session-${status}`,
    runId: `run-${status}`,
    status,
    reason: `${secret}:${workspaceRoot}:${status}`,
  };
}
