/**
 * Paw Next V3 real-provider smoke driver (read -> edit -> shell -> final).
 *
 * Not part of `bun test` (no *.test.ts suffix). Run explicitly:
 *
 *   bun apps/cli/test/paw-next-real-smoke.driver.ts <workspaceRoot>
 *
 * It builds a strict V3 product profile for the DeepSeek provider,
 * writes the profile store with the exact computed configHash, resolves it
 * back through the strict loader (production-like path), then drives one
 * Fresh V3 run and prints the durable fact timeline.
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
  runFreshPawNextTaskV3,
} from "../src/paw-next/composition.js";
import {
  DEFAULT_PAW_NEXT_PRODUCT_PROFILE_FILE_V3,
  PAW_NEXT_PRODUCT_PROFILE_SCHEMA_VERSION_V3,
  buildPawNextTaskProfileV3,
  loadPawNextProductProfileStoreV3,
  type PawNextProductProfileV3,
} from "../src/paw-next/product-profile-v3.js";

const workspaceRoot = path.resolve(
  process.argv[2] ?? "E:/A_Louis/paw-next-smoke",
);
const identity = {
  workspaceRoot,
  sessionId: "smoke-session-1",
  runId: "smoke-run-1",
  inputId: "smoke-input-1",
  goal: [
    "In this repository, the function add(a, b) in src/calc.js is wrong: it currently returns a - b.",
    "Fix it so it returns a + b.",
    "Then verify by running the repository test: `node test/calc.test.js` (you may also use `npm test`).",
    "Finish with a short final answer stating the fix and the test result.",
    "Use the provided tools for every step; do not guess file contents.",
  ].join(" "),
};

const SYSTEM_PROMPT = [
  "You are Paw, a coding agent working inside a repository.",
  "You have these tools: workspace_read_file (args: path), workspace_edit_file",
  "(args: path, old_string, new_string — exact string replacement),",
  "workspace_write_file (args: path, content), and workspace_run_shell",
  "(args: command, optional cwd, timeout_sec).",
  "Work step by step: read the relevant file before editing, keep edits minimal,",
  "and run the repository tests to verify your change.",
  "When the task is done and verified, reply with a short final answer without",
  "any further tool calls. If you cannot finish, say so plainly.",
].join("\n");

function payloadRuntime() {
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

function buildProfile(configHash: string): PawNextProductProfileV3 {
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
      maxSegments: 1,
      maxTotalModelTurns: 24,
    },
    systemPrompt: SYSTEM_PROMPT,
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
      ttlMs: 90_000,
      intervalMs: 30_000,
    },
    shellSandbox: null,
    workSegmentPolicyVersion: WORK_SEGMENT_POLICY_VERSION_V1,
    payloadRuntime: payloadRuntime(),
  } as PawNextProductProfileV3;
}

function readApiKey(): string {
  const settingsPath = path.join(workspaceRoot, ".paw", "settings.local.json");
  const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as {
    models?: Record<string, { apiKey?: string }>;
  };
  const apiKey = parsed.models?.["deepseekv4flash"]?.apiKey;
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    throw new Error("credential slot deepseekv4flash is unavailable");
  }
  return apiKey;
}

function writeProfileStore(configHash: string): void {
  const target = path.join(workspaceRoot, DEFAULT_PAW_NEXT_PRODUCT_PROFILE_FILE_V3);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(
    target,
    JSON.stringify(
      {
        schemaVersion: PAW_NEXT_PRODUCT_PROFILE_SCHEMA_VERSION_V3,
        profiles: [buildProfile(configHash)],
      },
      null,
      2,
    ),
  );
}

async function main(): Promise<void> {
  console.log(`[smoke] workspace: ${workspaceRoot}`);

  const apiKey = readApiKey();
  console.log("[smoke] credential slot deepseekv4flash: present");

  // 1. Compute the exact configHash, then persist the profile with it.
  const seeded = buildPawNextTaskProfileV3({
    identity,
    profile: buildProfile("0".repeat(64)),
    apiKey,
  });
  writeProfileStore(seeded.configHash);
  console.log(`[smoke] configHash: ${seeded.configHash}`);

  // 2. Resolve back through the strict loader (production-like path).
  const store = loadPawNextProductProfileStoreV3({ workspaceRoot });
  const profile = store.profiles.find(
    (candidate) => candidate.configHash === seeded.configHash,
  );
  if (!profile) throw new Error("written V3 profile not found in store");
  const resolution = buildPawNextTaskProfileV3({ identity, profile, apiKey });
  if (resolution.configHash !== seeded.configHash) {
    throw new Error("V3 profile configHash mismatch after reload");
  }
  console.log("[smoke] strict reload ok; starting Fresh V3 run");

  // 3. Drive the run with a hard wall-clock guard.
  const timeoutMs = 8 * 60_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const result = await runFreshPawNextTaskV3({
      resolution,
      signal: controller.signal,
    });
    const elapsed = Date.now() - startedAt;

    console.log(`\n[smoke] finished in ${elapsed}ms, tailSeq=${result.tailSeq}`);
    console.log(
      `[smoke] decision: ${JSON.stringify(result.state.decision)}`,
    );
    console.log(
      `[smoke] turns: segment=${result.state.segmentModelTurns} total=${result.state.totalModelTurns}, settledToolCalls=${result.state.totalSettledToolCalls}`,
    );

    console.log("\n[smoke] fact timeline:");
    const toolNames = new Map<string, string>();
    for (const fact of result.inputFacts) {
      const record = fact as Record<string, unknown>;
      switch (record.type) {
        case "tool.call_observed":
          toolNames.set(String(record.callId), String(record.tool));
          console.log(
            `  [${record.type}] turn=${record.turn} tool=${record.tool} args=${JSON.stringify(record.args).slice(0, 140)}`,
          );
          break;
        case "model.settled":
          console.log(
            `  [${record.type}] turn=${record.turn} status=${record.status} hasToolCalls=${record.hasToolCalls} hasVisibleOutput=${record.hasVisibleOutput} finishReason=${record.finishReason ?? "-"}`,
          );
          break;
        case "tool.settled": {
          const settled = record.result as
            | { ok?: boolean; summary?: string }
            | undefined;
          console.log(
            `  [${record.type}] ${toolNames.get(String(record.callId)) ?? record.callId} status=${record.status} ok=${settled?.ok} :: ${String(settled?.summary ?? "").slice(0, 140)}`,
          );
          break;
        }
        default:
          console.log(`  [${record.type}] ${JSON.stringify(record).slice(0, 160)}`);
      }
    }

    console.log("\n[smoke] final assistant text:");
    console.log(
      result.assistantText ??
        "(none — run may have ended without a final natural stop)",
    );

    const decision = result.state.decision as { kind?: string };
    const completed = decision?.kind === "completed";
    console.log(`\n[smoke] outcome: ${decision?.kind ?? "?"}`);
    process.exitCode = completed ? 0 : 1;
  } catch (error) {
    console.error("[smoke] run failed:", error);
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
  }
}

await main();
