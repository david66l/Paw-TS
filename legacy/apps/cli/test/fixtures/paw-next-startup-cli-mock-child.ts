import { mock } from "bun:test";
import path from "node:path";
import { pathToFileURL } from "node:url";

const scenario = process.argv[2];
const workspaceRoot = process.argv[3];
if (!scenario || !workspaceRoot) {
  throw new Error("startup CLI mock child arguments are missing");
}

const sourceRoot = path.resolve(import.meta.dir, "..", "..", "src", "paw-next");
const productProfileUrl = pathToFileURL(
  path.join(sourceRoot, "product-profile.ts"),
).href;
const startupScanUrl = pathToFileURL(
  path.join(sourceRoot, "startup-scan.ts"),
).href;
const startupCliUrl = pathToFileURL(
  path.join(sourceRoot, "startup-cli.ts"),
).href;
const secret = "sk-do-not-leak-raw-reason";
let resolverFactoryCalls = 0;
let resolverCalls = 0;
let scanCalls = 0;

mock.module(productProfileUrl, () => ({
  createPawNextProductProfileResolverV1() {
    resolverFactoryCalls += 1;
    if (scenario === "configuration_throw") {
      throw new Error(`profile failed with ${secret}`);
    }
    return () => {
      resolverCalls += 1;
      return undefined;
    };
  },
}));

mock.module(startupScanUrl, () => ({
  async scanAndResumePawNextRunsV1(input: {
    readonly resolveOptions: (identity: unknown) => unknown;
  }) {
    scanCalls += 1;
    const resolved = await input.resolveOptions({
      workspaceRoot,
      sessionId: "session",
      runId: "run",
      inputId: "input",
      goal: "goal",
      configHash: "0".repeat(64),
    });
    if (scenario === "configuration_throw" && resolved !== undefined) {
      throw new Error("fallback resolver was not unavailable");
    }
    if (scenario === "scan_throw") {
      throw new Error(`scan failed with ${secret}`);
    }
    if (scenario === "configuration_throw") {
      return {
        issues: [],
        runs: [run("config_unavailable")],
      };
    }
    if (scenario === "clean") {
      return {
        issues: [],
        runs: [
          run("terminal"),
          { ...run("blocked_pending"), inputIds: ["pending-input"] },
          { ...run("blocked_unconsumed"), inputIds: ["promoted-input"] },
          run("deferred"),
          { ...run("resumed"), tailSeq: 19 },
        ],
      };
    }
    return {
      issues: [{ entryName: "foreign-entry", reason: "foreign_entry" }],
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

const { runPawNextStartupCliV1 } = await import(startupCliUrl);
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
  const result = await runPawNextStartupCliV1([
    "--startup-scan",
    "--root",
    workspaceRoot,
  ]);
  process.stdout.write(
    JSON.stringify({
      result,
      secret,
      resolverFactoryCalls,
      resolverCalls,
      scanCalls,
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
    reason: `${secret}:${status}`,
  };
}
