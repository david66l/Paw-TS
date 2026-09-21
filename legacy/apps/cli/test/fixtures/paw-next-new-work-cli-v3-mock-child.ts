import path from "node:path";
import { pathToFileURL } from "node:url";

import { mock } from "bun:test";

const scenarioArg = process.argv[2];
const workspaceRootArg = process.argv[3];
if (!scenarioArg || !workspaceRootArg) {
  throw new Error("V3 new-work CLI mock arguments are missing");
}
const scenario = scenarioArg;
const workspaceRoot = workspaceRootArg;

const sourceRoot = path.resolve(import.meta.dir, "..", "..", "src", "paw-next");
const catalogUrl = pathToFileURL(
  path.join(sourceRoot, "product-profile-catalog-v3.ts"),
).href;
const preflightUrl = pathToFileURL(
  path.join(sourceRoot, "existing-run-preflight.ts"),
).href;
const compositionUrl = pathToFileURL(
  path.join(sourceRoot, "composition.ts"),
).href;
const cliUrl = pathToFileURL(path.join(sourceRoot, "new-work-cli-v3.ts")).href;
const secret = "sk-v3-new-work-secret";
let catalogFactoryCalls = 0;
let resolverCalls = 0;
let inventoryReads = 0;
let prefixReads = 0;
let productCalls = 0;

mock.module("@paw/runtime", () => ({
  readFileSessionAuthorityInventoryV1() {
    inventoryReads += 1;
    return {
      runs: [
        {
          runId: "run-v3",
          head: { tailSeq: 2, prefixHash: "a".repeat(64) },
        },
      ],
    };
  },
  readCommittedFileRunPrefixV1() {
    prefixReads += 1;
    return Object.freeze([]);
  },
}));

mock.module(catalogUrl, () => ({
  createPawNextProductProfileCatalogV3(options: unknown) {
    catalogFactoryCalls += 1;
    if (JSON.stringify(options) !== JSON.stringify({ workspaceRoot, v3: {} })) {
      throw new Error(`catalog source drifted ${secret}`);
    }
    return () => {
      resolverCalls += 1;
      if (scenario === "config_missing") return undefined;
      return { productVersion: "v3", taskOptions: { marker: "resolution" } };
    };
  },
}));

mock.module(preflightUrl, () => ({
  readPawNextExistingBootstrapIdentityV1() {
    return {
      inputId: "initial-input",
      goal: "secret historical goal",
      configHash: "0".repeat(64),
    };
  },
}));

mock.module(compositionUrl, () => ({
  async runExistingPawNextWorkSegmentV3() {
    throw new Error("default product invocation must not run in mock child");
  },
}));

const { runPawNextNewWorkCliV3 } = await import(cliUrl);
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
  const result = await runPawNextNewWorkCliV3(args(), {
    stdin: chunks([JSON.stringify({ content: `private ${secret}` })]),
    async invokeProduct(input: {
      readonly work: { readonly inputId: string };
    }) {
      productCalls += 1;
      if (scenario === "runtime_throw") {
        throw new Error(`runtime failed ${secret} ${workspaceRoot}`);
      }
      const controlStatus =
        scenario === "attention" ? "await_user" : "completed";
      return {
        state: { decision: { kind: controlStatus } },
        inputAcceptance: {
          status: scenario === "retry" ? "already_accepted" : "accepted",
          inputId: input.work.inputId,
        },
        segmentStart: {
          status: scenario === "retry" ? "already_started" : "started",
          inputId: input.work.inputId,
          segmentIndex: 2,
        },
        tailSeq: 17,
      } as never;
    },
  });
  process.stdout.write(
    JSON.stringify({
      result,
      secret,
      workspaceRoot,
      catalogFactoryCalls,
      resolverCalls,
      inventoryReads,
      prefixReads,
      productCalls,
      timeoutCalls,
      intervalCalls,
    }),
  );
} finally {
  globalThis.setTimeout = originalTimeout;
  globalThis.setInterval = originalInterval;
}

function args(): readonly string[] {
  return [
    "--new-work-v3",
    "--root",
    workspaceRoot,
    "--session-id",
    "session-v3",
    "--run-id",
    "run-v3",
    "--input-id",
    "queued-input",
    "--caller-id",
    "cli-caller",
    "--stdin-json",
  ];
}

async function* chunks(values: readonly string[]): AsyncIterable<Uint8Array> {
  for (const value of values) yield new TextEncoder().encode(value);
}
