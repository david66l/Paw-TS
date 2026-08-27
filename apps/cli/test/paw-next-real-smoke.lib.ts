/**
 * Shared helpers for the Paw Next V3 real-provider smoke drivers.
 * Not a bun test file. Imported by paw-next-real-smoke-*.driver.ts.
 */
import fs from "node:fs";
import path from "node:path";

import { WORK_SEGMENT_POLICY_VERSION_V1 } from "@paw/protocol";
import {
  CANONICAL_DURABLE_JSON_PAYLOAD_BINDING_VERSION_V1,
  FILE_DURABLE_JSON_PAYLOAD_CODEC_V1,
  FILE_DURABLE_JSON_PAYLOAD_POLICY_VERSION_V1,
  LOCATION_AWARE_PAYLOAD_MATERIALIZER_VERSION_V1,
  LOCATION_AWARE_PAYLOAD_SESSION_VERSION_V1,
  VERIFIED_CANONICAL_PAYLOAD_BUDGET_POLICY_VERSION_V1,
} from "@paw/runtime";

import {
  DEFAULT_PAW_NEXT_PRODUCT_PROFILE_FILE_V3,
  PAW_NEXT_PRODUCT_PROFILE_SCHEMA_VERSION_V3,
  buildPawNextTaskProfileV3,
  loadPawNextProductProfileStoreV3,
  type PawNextProductProfileV3,
} from "../src/paw-next/product-profile-v3.js";

export const SMOKE_SYSTEM_PROMPT = [
  "You are Paw, a coding agent working inside a repository.",
  "You have these tools: workspace_read_file (args: path), workspace_edit_file",
  "(args: path, old_string, new_string — exact string replacement),",
  "workspace_write_file (args: path, content), and workspace_run_shell",
  "(args: command, optional cwd, timeout_sec).",
  "Work step by step: read the relevant file before editing, keep edits minimal,",
  "and run the repository tests to verify your change.",
  "When the task is done and verified, reply with a short final answer without",
  "any further tool calls. If you cannot finish, say so plainly.",
  "Follow the latest user instructions, including any later additions.",
].join("\n");

export function payloadRuntimeFixture() {
  return {
    codec: FILE_DURABLE_JSON_PAYLOAD_CODEC_V1,
    storePolicy: {
      policyVersion: FILE_DURABLE_JSON_PAYLOAD_POLICY_VERSION_V1,
      maxArtifactBytes: 16 * 1024 * 1024,
    },
    readBudget: {
      policyVersion: VERIFIED_CANONICAL_PAYLOAD_BUDGET_POLICY_VERSION_V1,
      maxTotalBytes: 32 * 1024 * 1024,
    },
    locationBindingVersion: CANONICAL_DURABLE_JSON_PAYLOAD_BINDING_VERSION_V1,
    locationAwareSessionVersion: LOCATION_AWARE_PAYLOAD_SESSION_VERSION_V1,
    materializerVersion: LOCATION_AWARE_PAYLOAD_MATERIALIZER_VERSION_V1,
  };
}

export function buildSmokeProfile(
  configHash: string,
  heartbeat?: { readonly ttlMs: number; readonly intervalMs: number },
): PawNextProductProfileV3 {
  return {
    profileId: "smoke-deepseek-v3",
    revision: 1,
    configHash,
    model: {
      protocol: "openai-compatible",
      transport: "complete",
      model: "deepseek-v4-flash",
      baseUrl: "https://api.deepseek.com",
      capabilities: { contextWindow: 131072, maxOutputTokens: 8192 },
      thinkingEnabled: true,
      reasoningEffort: "max",
      credentialSlot: "deepseekv4flash",
    },
    control: {
      mode: "interactive",
      maxModelTurns: 24,
      naturalStop: "complete",
      maxSegments: 8,
      maxTotalModelTurns: 48,
    },
    systemPrompt: SMOKE_SYSTEM_PROMPT,
    budget: {
      contextWindowTokens: 131072,
      reservedOutputTokens: 8192,
      estimationMarginTokens: 1024,
      estimator: { id: "core:deepseek:deepseek-v4-flash", version: "v1" },
    },
    permission: {
      policyVersion: "smoke-permission.v1",
      defaultAction: "deny",
      rules: [
        {
          id: "allow-read",
          layer: "user",
          tool: "workspace.read_file",
          action: "allow",
        },
        {
          id: "allow-edit",
          layer: "user",
          tool: "workspace.edit_file",
          action: "allow",
        },
        {
          id: "allow-write",
          layer: "user",
          tool: "workspace.write_file",
          action: "allow",
        },
        {
          id: "allow-shell",
          layer: "user",
          tool: "workspace.run_shell",
          action: "allow",
        },
      ],
    },
    approval: "unavailable",
    heartbeat: {
      policyVersion: "paw.session-lease-heartbeat.v1",
      ttlMs: heartbeat?.ttlMs ?? 90_000,
      intervalMs: heartbeat?.intervalMs ?? 30_000,
    },
    shellSandbox: null,
    workSegmentPolicyVersion: WORK_SEGMENT_POLICY_VERSION_V1,
    payloadRuntime: payloadRuntimeFixture(),
  } as PawNextProductProfileV3;
}

/** Standard smoke task repository files: buggy add() + a failing test. */
export function prepareSmokeRepository(workspaceRoot: string): void {
  fs.mkdirSync(path.join(workspaceRoot, "src"), { recursive: true });
  fs.mkdirSync(path.join(workspaceRoot, "test"), { recursive: true });
  fs.writeFileSync(
    path.join(workspaceRoot, "src", "calc.js"),
    [
      "// Small calculator utility used by the smoke task.",
      "// NOTE: add() is intentionally wrong for this task.",
      "",
      "export function add(a, b) {",
      "  return a - b;",
      "}",
      "",
      "export function multiply(a, b) {",
      "  return a * b;",
      "}",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(workspaceRoot, "test", "calc.test.js"),
    [
      'import { add, multiply } from "../src/calc.js";',
      'import assert from "node:assert/strict";',
      "",
      "assert.equal(add(2, 3), 5, 'add(2,3) must be 5');",
      "assert.equal(add(-1, 1), 0, 'add(-1,1) must be 0');",
      "assert.equal(multiply(3, 4), 12, 'multiply(3,4) must be 12');",
      "",
      'console.log("all calc tests passed");',
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(workspaceRoot, "package.json"),
    JSON.stringify(
      {
        name: "paw-next-smoke",
        version: "1.0.0",
        private: true,
        type: "module",
        scripts: { test: "node test/calc.test.js" },
      },
      null,
      2,
    ),
  );
}

/** Legacy smoke workspace fixture; credentials stay in the host settings. */
export function prepareSmokeWorkspace(workspaceRoot: string): void {
  prepareSmokeRepository(workspaceRoot);
}

export function resolveSmokeProfile(options: {
  readonly workspaceRoot: string;
  readonly heartbeat?: { readonly ttlMs: number; readonly intervalMs: number };
  readonly identity: {
    readonly workspaceRoot: string;
    readonly sessionId: string;
    readonly runId: string;
    readonly inputId: string;
    readonly goal: string;
  };
}) {
  const apiKey = readSmokeApiKey(options.workspaceRoot);
  const seeded = buildPawNextTaskProfileV3({
    identity: options.identity,
    profile: buildSmokeProfile("0".repeat(64), options.heartbeat),
    apiKey,
  });
  const target = path.join(
    options.workspaceRoot,
    DEFAULT_PAW_NEXT_PRODUCT_PROFILE_FILE_V3,
  );
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(
    target,
    JSON.stringify(
      {
        schemaVersion: PAW_NEXT_PRODUCT_PROFILE_SCHEMA_VERSION_V3,
        profiles: [buildSmokeProfile(seeded.configHash, options.heartbeat)],
      },
      null,
      2,
    ),
  );
  const store = loadPawNextProductProfileStoreV3({
    workspaceRoot: options.workspaceRoot,
  });
  const profile = store.profiles.find(
    (candidate) => candidate.configHash === seeded.configHash,
  );
  if (!profile) throw new Error("written V3 profile not found in store");
  const resolution = buildPawNextTaskProfileV3({
    identity: options.identity,
    profile,
    apiKey,
  });
  if (resolution.configHash !== seeded.configHash) {
    throw new Error("V3 profile configHash mismatch after reload");
  }
  return resolution;
}

function readSmokeApiKey(workspaceRoot: string): string {
  const settingsPaths = [
    path.join(workspaceRoot, ".paw", "settings.local.json"),
    path.resolve(import.meta.dir, "../../..", ".paw", "settings.local.json"),
  ];
  for (const settingsPath of settingsPaths) {
    if (!fs.existsSync(settingsPath)) continue;
    const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as {
      models?: Record<string, { apiKey?: string }>;
    };
    const apiKey = parsed.models?.deepseekv4flash?.apiKey;
    if (typeof apiKey === "string" && apiKey.trim()) return apiKey;
  }
  throw new Error("credential slot deepseekv4flash is unavailable");
}

/**
 * Verify the durable inbox invariant on a fact array (order == journal seq):
 * a promoted input must never sit inside an open model dispatch or inside an
 * unsettled tool batch. Returns promotion diagnostics for each promoted steer.
 */
export function auditPromotionBoundaries(
  facts: readonly Record<string, unknown>[],
): {
  readonly ok: boolean;
  readonly violations: string[];
  readonly promotedSteerIndices: number[];
} {
  const violations: string[] = [];
  const promotedSteerIndices: number[] = [];
  let openModelDispatch = false;
  const openToolCalls = new Set<string>();
  const expectingTools = new Map<string, boolean>();
  facts.forEach((fact, index) => {
    switch (fact.type) {
      case "model.dispatch_recorded":
        if (openModelDispatch || openToolCalls.size > 0) {
          violations.push(`open work at dispatch index ${index}`);
        }
        openModelDispatch = true;
        break;
      case "model.settled":
        if (!openModelDispatch) {
          violations.push(`settlement without dispatch at index ${index}`);
        }
        openModelDispatch = false;
        expectingTools.set(
          String(fact.modelCallId),
          fact.hasToolCalls === true,
        );
        break;
      case "tool.call_observed":
        openToolCalls.add(String(fact.callId));
        break;
      case "tool.settled":
        openToolCalls.delete(String(fact.callId));
        break;
      case "input.promoted":
        if (fact.delivery === "steer") promotedSteerIndices.push(index);
        if (openModelDispatch) {
          violations.push(
            `steer promoted inside open model call at index ${index}`,
          );
        }
        if (openToolCalls.size > 0) {
          violations.push(
            `steer promoted inside unsettled tool batch at index ${index}`,
          );
        }
        break;
      default:
        break;
    }
  });
  if (openModelDispatch) violations.push("journal ends inside model call");
  if (openToolCalls.size > 0) violations.push("journal ends inside tool batch");
  return {
    ok: violations.length === 0,
    violations,
    promotedSteerIndices,
  };
}

export function printTimeline(
  facts: readonly Record<string, unknown>[],
): void {
  const toolNames = new Map<string, string>();
  facts.forEach((fact) => {
    switch (fact.type) {
      case "tool.call_observed":
        toolNames.set(String(fact.callId), String(fact.tool));
        console.log(
          `  [${fact.type}] turn=${fact.turn} tool=${fact.tool} args=${JSON.stringify(fact.args).slice(0, 110)}`,
        );
        break;
      case "model.settled":
        console.log(
          `  [${fact.type}] turn=${fact.turn} status=${fact.status} hasToolCalls=${fact.hasToolCalls} finish=${fact.finishReason ?? "-"}`,
        );
        break;
      case "tool.settled":
        console.log(
          `  [${fact.type}] ${toolNames.get(String(fact.callId)) ?? fact.callId} status=${fact.status}`,
        );
        break;
      case "input.accepted":
      case "input.promoted":
        console.log(
          `  [${fact.type}] id=${fact.inputId} delivery=${fact.delivery} content=${JSON.stringify(String(fact.content ?? "")).slice(0, 110)}`,
        );
        break;
      default:
        console.log(`  [${fact.type}]`);
    }
  });
}
