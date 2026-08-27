/**
 * Paw Next V3 real-provider SWE-bench smoke: one frozen instance
 * (django__django-15098) driven as a NORMAL user task through the fresh V3
 * entry, with the official instance image as the shell sandbox — the same
 * environment contract the old runtime used for its SWE runs.
 *
 *   bun apps/cli/test/paw-next-real-smoke-swe.driver.ts
 */
import { execFileSync } from "node:child_process";
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
import { defaultSettingsPath, loadPawSettingsLocal } from "@paw/settings";

import { runFreshPawNextTaskV3 } from "../src/paw-next/composition.js";
import {
  type PawNextProductProfileV3,
  buildPawNextTaskProfileV3,
} from "../src/paw-next/product-profile-v3.js";
import { printTimeline } from "./paw-next-real-smoke.lib.js";

const hostWorkspaceRoot = path.resolve(import.meta.dir, "../../..");
const workspaceRoot = path.resolve(
  process.env.PAW_SWE_WORKSPACE_ROOT ??
    "E:/A_Louis/paw-next-smoke-swe/workspace",
);
const artifactRoot = path.resolve(
  process.env.PAW_SWE_ARTIFACT_ROOT ?? "E:/A_Louis/paw-next-smoke-swe",
);
const sandboxImage =
  process.env.PAW_SWE_IMAGE ??
  "swebench/sweb.eval.x86_64.django_1776_django-15098:latest";
const testHint =
  process.env.PAW_SWE_TEST_HINT ??
  "source activate testbed && cd /testbed && python tests/runtests.py <test-module> -v 1";
const collaborationInstruction =
  process.env.PAW_SWE_COLLABORATION_INSTRUCTION?.trim();
const runSuffix = Date.now().toString(36);
const identity = {
  workspaceRoot,
  sessionId: `swe-session-${runSuffix}`,
  runId: `swe-run-${runSuffix}`,
  inputId: `swe-input-${runSuffix}`,
  goal: "", // built from instance.json below
};

const requestedInstanceId = process.env.PAW_SWE_INSTANCE_ID;
const instance = (
  requestedInstanceId
    ? fs
        .readFileSync(
          path.join(
            hostWorkspaceRoot,
            "benchmarks",
            "swe-bench",
            "swe-bench-verified.jsonl",
          ),
          "utf8",
        )
        .split(/\r?\n/u)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((row) => row.instance_id === requestedInstanceId)
    : JSON.parse(
        fs.readFileSync(path.join(artifactRoot, "instance.json"), "utf8"),
      )
) as
  | {
      readonly instance_id: string;
      readonly problem_statement?: string;
      readonly problemStatement?: string;
    }
  | undefined;
if (!instance) {
  throw new Error(`SWE-bench instance not found: ${requestedInstanceId}`);
}
const problemStatement =
  instance.problemStatement ?? instance.problem_statement ?? "";
if (!problemStatement.trim()) {
  throw new Error(
    `SWE-bench problem statement is missing: ${instance.instance_id}`,
  );
}
/* Instance data is host-owned benchmark input, not model-discovered context. */
const instanceIdentity = instance as {
  readonly instance_id: string;
};

identity.goal = [
  "Fix the bug described below so that the relevant tests pass.",
  "Work directly in the checked-out repository and modify existing tracked source files.",
  "Do not create helper scripts or patch files. Do not only describe a solution.",
  "Do not access the network, fetch remotes, inspect upstream branches/commits, or search for an existing solution.",
  "Make a minimal change. Do not modify unrelated files or any test files.",
  "When a fix requires accepting more inputs (URLs, formats, codes), expand the existing behavior rather than replacing it with a stricter validator. Inputs the old code accepted must still be accepted.",
  "After editing, run the narrowest relevant tests that are feasible in this environment.",
  "Finish only after inspecting the final diff and reporting the verification performed.",
  "Environment notes:",
  "- Shell commands run inside a Linux container with this repository mounted at /testbed (no network).",
  `- Use the container's test environment for Python. A suitable starting command is: \`${testHint}\`.`,
  ...(collaborationInstruction ? [collaborationInstruction] : []),
  "",
  problemStatement,
]
  .filter(Boolean)
  .join("\n");

const SWE_SYSTEM_PROMPT = [
  "You are Paw, a coding agent working inside a repository.",
  "Use workspace_read_file, workspace_search, and workspace_glob to inspect code;",
  "use workspace_edit_file or workspace_apply_patch to change it.",
  "Use workspace_git_status and workspace_git_diff for Git inspection.",
  "Do not run git commands through workspace_run_shell: this Windows-mounted",
  "benchmark makes container-side Git work-tree scans very slow.",
  "Use workspace_run_shell only for narrow test or interpreter commands in /testbed.",
  "Work step by step: locate the relevant code before editing, keep edits minimal,",
  "and run the narrowest relevant tests to verify your change.",
  "Handle narrow work directly. Use workspace_delegate only when an independent",
  "specialist investigation, implementation, test, or review materially reduces risk.",
  "File tools operate on the repository directly; shell commands run in the",
  "container described in the task.",
  "When the task is done and verified, reply with a short final answer without",
  "any further tool calls. If you cannot finish, say so plainly.",
].join("\n");

const SWE_ALLOWED_TOOLS = [
  "workspace.read_file",
  "workspace.edit_file",
  "workspace.write_file",
  "workspace.run_shell",
  "workspace.run_agent",
  "workspace.job_start",
  "workspace.job_list",
  "workspace.job_read",
  "workspace.job_wait",
  "workspace.job_kill",
  "workspace.list_dir",
  "workspace.search",
  "workspace.glob",
  "workspace.git_status",
  "workspace.git_diff",
  "workspace.git_log",
  "workspace.apply_patch",
  "workspace.symbol_search",
  "workspace.lsp",
  "workspace.todo_write",
  "workspace.progress_read",
  "context.recall",
] as const;

function buildSweProfile(configHash: string): PawNextProductProfileV3 {
  return {
    profileId: `swe-deepseek-v3-${instanceIdentity.instance_id}`,
    revision: 1,
    configHash,
    model: {
      protocol: "openai-compatible",
      transport: "complete",
      model: "deepseek-v4-flash",
      baseUrl: "https://api.deepseek.com",
      capabilities: { contextWindow: 200_000, maxOutputTokens: 384_000 },
      thinkingEnabled: true,
      reasoningEffort: "max",
      credentialSlot: "deepseekv4flash",
    },
    control: {
      mode: "interactive",
      maxModelTurns: 96,
      naturalStop: "complete",
      maxSegments: 8,
      maxTotalModelTurns: 128,
    },
    systemPrompt: SWE_SYSTEM_PROMPT,
    budget: {
      contextWindowTokens: 200_000,
      reservedOutputTokens: 32_000,
      estimationMarginTokens: 1024,
      estimator: { id: "core:deepseek:deepseek-v4-flash", version: "v1" },
    },
    permission: {
      policyVersion: "swe-permission.v1",
      defaultAction: "deny",
      rules: SWE_ALLOWED_TOOLS.map((tool, index) => ({
        id: `allow-${index + 1}`,
        layer: "user" as const,
        tool,
        action: "allow" as const,
      })),
    },
    approval: "unavailable",
    heartbeat: {
      policyVersion: "paw.session-lease-heartbeat.v1",
      ttlMs: 90_000,
      intervalMs: 30_000,
    },
    shellSandbox: {
      mode: "workspace",
      network: "deny",
      runtime: "docker",
      image: sandboxImage,
      memoryMb: 8192,
      cpus: 4,
      containerWorkspaceRoot: "/testbed",
      commandShell: "bash",
      pullPolicy: "never",
      workspaceReadOnly: false,
    },
    workSegmentPolicyVersion: WORK_SEGMENT_POLICY_VERSION_V1,
    payloadRuntime: {
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
    },
  } as PawNextProductProfileV3;
}

function resolveSweProfile() {
  const settings = loadPawSettingsLocal(defaultSettingsPath(hostWorkspaceRoot));
  const apiKey = settings.models?.deepseekv4flash?.apiKey;
  if (!apiKey) {
    throw new Error(
      "deepseekv4flash credential is unavailable in host settings",
    );
  }
  const seeded = buildPawNextTaskProfileV3({
    identity,
    profile: buildSweProfile("0".repeat(64)),
    apiKey,
  });
  const resolution = buildPawNextTaskProfileV3({
    identity,
    profile: buildSweProfile(seeded.configHash),
    apiKey,
  });
  if (resolution.configHash !== seeded.configHash) {
    throw new Error("SWE V3 profile configHash mismatch after reload");
  }
  return resolution;
}

function git(...args: string[]): string {
  return execFileSync("git", args, {
    cwd: workspaceRoot,
    encoding: "utf8",
    timeout: 300_000,
    maxBuffer: 32 * 1024 * 1024,
  }).trim();
}

function collectTrackedPatch(): string {
  return git("diff", "--binary", "--no-ext-diff", "--diff-filter=ACMRTUXB");
}

const startedAt = Date.now();
const resolution = resolveSweProfile();
console.log(`[swe] instance: ${instanceIdentity.instance_id}`);
console.log(`[swe] configHash: ${resolution.configHash}`);
console.log(`[swe] goal chars: ${identity.goal.length}`);
console.log(`[swe] baseline git: ${git("log", "--oneline", "-1")}`);
console.log(
  `[swe] baseline status clean: ${git("status", "--porcelain").length === 0}`,
);

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 45 * 60_000);
try {
  const result = await runFreshPawNextTaskV3({
    resolution,
    signal: controller.signal,
  });
  clearTimeout(timer);
  const elapsedMin = ((Date.now() - startedAt) / 60_000).toFixed(1);

  console.log(`\n[swe] finished in ${elapsedMin} min`);
  console.log(`[swe] decision: ${JSON.stringify(result.state.decision)}`);
  console.log(
    `[swe] turns: segment=${result.state.segmentModelTurns} total=${result.state.totalModelTurns}, settledToolCalls=${result.state.totalSettledToolCalls}, tailSeq=${result.tailSeq}`,
  );
  const delegationCalls = result.inputFacts.filter(
    (fact) =>
      fact.type === "tool.call_observed" && fact.tool === "workspace_delegate",
  );
  const delegatedChildren = result.inputFacts.filter(
    (fact) =>
      fact.type === "runtime.activity_started" &&
      fact.activityKind === "collaboration_child",
  );
  const collaborationActivities = delegatedChildren.map((fact) =>
    fact.type === "runtime.activity_started"
      ? {
          activityId: fact.activityId,
          label: fact.label,
          metadata: fact.metadata,
        }
      : undefined,
  );
  console.log(
    `[swe] collaboration: delegateCalls=${delegationCalls.length}, children=${delegatedChildren.length}`,
  );
  console.log("\n[swe] fact timeline:");
  printTimeline(
    result.inputFacts.map((fact) => fact as Record<string, unknown>),
  );

  const patch = collectTrackedPatch();
  console.log(`\n[swe] patch (${patch.length} chars):`);
  console.log(patch || "(empty)");

  console.log("\n[swe] final assistant text:");
  console.log(result.assistantText ?? "(none)");

  fs.writeFileSync(
    path.join(artifactRoot, "paw-next-result.json"),
    JSON.stringify(
      {
        instanceId: instanceIdentity.instance_id,
        decision: result.state.decision,
        totalModelTurns: result.state.totalModelTurns,
        settledToolCalls: result.state.totalSettledToolCalls,
        delegationCalls: delegationCalls.length,
        delegatedChildren: delegatedChildren.length,
        collaborationActivities,
        tailSeq: result.tailSeq,
        patch,
        assistantText: result.assistantText ?? null,
        elapsedMs: Date.now() - startedAt,
      },
      null,
      2,
    ),
  );
  process.exitCode = result.state.decision.kind === "completed" ? 0 : 1;
} catch (error) {
  clearTimeout(timer);
  console.error("[swe] run failed:", error);
  process.exitCode = 1;
}
