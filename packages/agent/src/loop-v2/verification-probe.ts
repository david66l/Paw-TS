import fs from "node:fs";
import path from "node:path";

import type { ModelTokenUsage } from "@paw/core";
import { type ShellSandboxConfig, runShellInWorkspace } from "@paw/harness";
import type { LanguageModel } from "@paw/models";

import { sha256Canonical } from "./canonical.js";

/**
 * Loop v2.1 对抗式验证探针（fresh-context verification probe）。
 *
 * 认证收口前，用全新上下文（不含实施者思路）针对最终 diff 合成少量
 * 边界测试并由 host 执行；任何失败都阻止 certification。它只产事实，
 * 不拥有终局——失败反馈走既有修复循环，成功才允许 reducer 盖章。
 *
 * 动机（sklearn-25102）：实施者自选测试存在确认偏差，官方契约测试又
 * 不可见；改动波及但未被修改的下游代码（如未改行消费了被改变类型的
 * 值）恰恰是自测盲区。独立视角选测试从机制上收窄该盲区。
 */

export const LOOP_V2_VERIFICATION_PROBE_FEEDBACK_LIMIT = 1 as const;
const MAX_PROBES = 4 as const;
const PROBE_TIMEOUT_MS = 180_000 as const;
const PROBE_OUTPUT_CHARS = 1_200 as const;
const DIFF_BUDGET_CHARS = 48_000 as const;

export interface VerificationProbePlanItemV1 {
  readonly command: string;
  readonly rationale: string;
}

export interface VerificationProbeResultV1 {
  readonly command: string;
  readonly ok: boolean;
  readonly exitCode?: number;
  readonly output: string;
}

export interface VerificationProbeOnceResultV2 {
  readonly candidateInputHash: string;
  readonly mutationRevision: number;
  readonly probes: readonly VerificationProbeResultV1[];
  readonly verdict: "pass" | "fail";
  readonly note?: string;
  readonly modelCalls: number;
  readonly usage?: ModelTokenUsage;
}

export interface VerificationProbeGateDecisionV1 {
  readonly type: "accept" | "feedback" | "incomplete";
  readonly key: string;
  readonly message: string;
  readonly reason?: "feedback_exhausted" | "no_turn_budget";
}

/** Commands the probe may never issue: network, installs, or product writes. */
const PROBE_COMMAND_DENYLIST =
  /\b(?:curl|wget|nc|netcat|ssh|scp|pip3?|npm|pnpm|yarn|conda|apt|apt-get|brew|git\s+(?:push|fetch|pull|clone))\b/i;

export function buildVerificationProbePromptV1(input: {
  readonly goal: string;
  readonly diff: string;
  readonly changedFiles: readonly string[];
}): string {
  const diff =
    input.diff.length > DIFF_BUDGET_CHARS
      ? `${input.diff.slice(0, DIFF_BUDGET_CHARS)}\n... (diff truncated)`
      : input.diff;
  return [
    "You are an adversarial verification engineer. Another engineer claims the change below completes the stated task. Your ONLY job is to try to BREAK the candidate change before it ships.",
    "",
    "## Task",
    input.goal.slice(0, 4_000),
    "",
    "## Changed files",
    input.changedFiles.slice(0, 40).join(", ") || "(none)",
    "",
    "## Candidate diff",
    "```diff",
    diff,
    "```",
    "",
    "## Your mission",
    "Write 1-4 minimal executable probe commands that are MOST LIKELY to expose a defect in THIS diff — especially:",
    "- boundary conditions the diff's author would not think to test (empty/zero/one inputs, unknown categories, extreme dtypes or values);",
    "- unchanged downstream code that now consumes a changed value type or shape (the diff may break lines it never touched);",
    "- contract regressions for existing callers.",
    "Prefer exercising the changed code paths end-to-end (e.g. a `python - <<'EOF'` or `python -c` snippet that imports and drives the changed API, or a targeted `python -m pytest <existing repo test> -k ...` run).",
    "",
    "## Hard constraints",
    "- Offline only: no network, no package installation, no git remote operations.",
    "- Do not create or modify files in the repository; inline snippets only.",
    "- Each command must be a single self-contained shell invocation that exits non-zero on failure.",
    "- Only probe what the diff could plausibly affect; do not restate the happy path the author already verified.",
    "",
    'Reply with ONLY a JSON object: {"probes":[{"command":"<shell command>","rationale":"<one sentence>"}]}',
  ].join("\n");
}

export function parseVerificationProbePlanV1(
  content: string,
): readonly VerificationProbePlanItemV1[] {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.slice(start, end + 1));
  } catch {
    return [];
  }
  const probes = (parsed as { probes?: unknown }).probes;
  if (!Array.isArray(probes)) return [];
  const items: VerificationProbePlanItemV1[] = [];
  for (const raw of probes) {
    if (items.length >= MAX_PROBES) break;
    if (!raw || typeof raw !== "object") continue;
    const command = (raw as { command?: unknown }).command;
    const rationale = (raw as { rationale?: unknown }).rationale;
    if (typeof command !== "string" || !command.trim()) continue;
    const trimmed = command.trim();
    if (trimmed.length > 2_000) continue;
    if (PROBE_COMMAND_DENYLIST.test(trimmed)) continue;
    items.push({
      command: trimmed,
      rationale:
        typeof rationale === "string" && rationale.trim()
          ? rationale.trim().slice(0, 400)
          : "",
    });
  }
  return items;
}

export function executeVerificationProbesV1(input: {
  readonly workspaceRoot: string;
  readonly shellSandbox?: ShellSandboxConfig;
  readonly probes: readonly VerificationProbePlanItemV1[];
}): readonly VerificationProbeResultV1[] {
  const results: VerificationProbeResultV1[] = [];
  for (const probe of input.probes) {
    const shell = runShellInWorkspace(input.workspaceRoot, probe.command, {
      timeoutMs: PROBE_TIMEOUT_MS,
      ...(input.shellSandbox ? { shellSandbox: input.shellSandbox } : {}),
      skipApprovalGate: true,
    });
    if (shell.error) {
      results.push({
        command: probe.command,
        ok: false,
        output: `probe could not execute: ${shell.error}`.slice(
          0,
          PROBE_OUTPUT_CHARS,
        ),
      });
      continue;
    }
    const output = [
      typeof shell.stdout === "string" ? shell.stdout : "",
      typeof shell.stderr === "string" ? shell.stderr : "",
    ]
      .join("\n")
      .trim();
    const exitCode = shell.exit_code;
    const ok = exitCode === 0;
    results.push({
      command: probe.command,
      ok,
      ...(typeof exitCode === "number" ? { exitCode } : {}),
      output: output.slice(-PROBE_OUTPUT_CHARS),
    });
  }
  return results;
}

export function evaluateVerificationProbeGateV1(input: {
  readonly result: VerificationProbeOnceResultV2;
  readonly priorKey?: string;
  readonly priorNudges?: number;
  readonly noRoomForAnotherTurn: boolean;
}): VerificationProbeGateDecisionV1 {
  const key = `probe:${input.result.candidateInputHash}`;
  if (input.result.verdict === "pass") {
    return {
      type: "accept",
      key,
      message: "",
    };
  }
  const failures = input.result.probes
    .filter((probe) => !probe.ok)
    .map(
      (probe, index) =>
        `${index + 1}. command: ${probe.command}\n   output: ${probe.output.slice(0, 600) || "(no output)"}`,
    )
    .join("\n");
  const message = [
    `[LoopV2Probe:fail key=${key}]`,
    "An adversarial verification probe executed against the current candidate diff and FAILED. The candidate is not certified.",
    "Failed probe(s):",
    failures || "(probe execution failure)",
    "Fix the code so the failing behavior is corrected, then propose a new final answer. Do not merely adjust the explanation; the probe will re-run against the new candidate.",
  ].join("\n");
  const priorNudges = input.priorKey === key ? (input.priorNudges ?? 0) : 0;
  if (
    priorNudges < LOOP_V2_VERIFICATION_PROBE_FEEDBACK_LIMIT &&
    !input.noRoomForAnotherTurn
  ) {
    return { type: "feedback", key, message };
  }
  return {
    type: "incomplete",
    key,
    message,
    reason: input.noRoomForAnotherTurn
      ? "no_turn_budget"
      : "feedback_exhausted",
  };
}

interface ProbeRecordV1 {
  readonly schemaVersion: 1;
  readonly kind: "paw.loop-v2-verification-probe";
  readonly candidateInputHash: string;
  readonly mutationRevision: number;
  readonly result: VerificationProbeOnceResultV2;
}

function probeRecordPath(workspaceRoot: string, runId: string): string {
  return path.join(
    path.resolve(workspaceRoot),
    ".paw",
    "loop-v2",
    "runs",
    sha256Canonical({ runId }),
    "verification-probe-v1.json",
  );
}

/**
 * Run the probe once per candidate identity. A persisted record for the same
 * candidateInputHash is replayed without another model call (resume-safe,
 * K6-style at-most-once), mirroring the semantic review claim discipline.
 */
export async function runVerificationProbeOnceV2(input: {
  readonly model: LanguageModel;
  readonly runId: string;
  readonly workspaceRoot: string;
  readonly goal: string;
  readonly diff: string;
  readonly changedFiles: readonly string[];
  readonly candidateInputHash: string;
  readonly mutationRevision: number;
  readonly shellSandbox?: ShellSandboxConfig;
  readonly signal?: AbortSignal;
  readonly onUsage?: (modelLabel: string, usage: ModelTokenUsage) => void;
}): Promise<VerificationProbeOnceResultV2> {
  const recordPath = probeRecordPath(input.workspaceRoot, input.runId);
  try {
    const existing = JSON.parse(
      fs.readFileSync(recordPath, "utf8"),
    ) as ProbeRecordV1;
    if (
      existing?.kind === "paw.loop-v2-verification-probe" &&
      existing.candidateInputHash === input.candidateInputHash
    ) {
      return existing.result;
    }
  } catch {
    // No usable record: first probe for this run (or damaged file).
  }

  const completion = await input.model.complete(
    [
      {
        role: "user",
        content: buildVerificationProbePromptV1({
          goal: input.goal,
          diff: input.diff,
          changedFiles: input.changedFiles,
        }),
      },
    ],
    { signal: input.signal },
  );
  if (input.onUsage && completion.usage) {
    input.onUsage(input.model.label, completion.usage);
  }
  const plan = parseVerificationProbePlanV1(completion.text);
  const probes = executeVerificationProbesV1({
    workspaceRoot: input.workspaceRoot,
    ...(input.shellSandbox ? { shellSandbox: input.shellSandbox } : {}),
    probes: plan,
  });
  const result: VerificationProbeOnceResultV2 = {
    candidateInputHash: input.candidateInputHash,
    mutationRevision: input.mutationRevision,
    probes,
    verdict:
      probes.length === 0
        ? "pass"
        : probes.every((probe) => probe.ok)
          ? "pass"
          : "fail",
    ...(probes.length === 0
      ? {
          note: "probe model returned no executable probes; certification proceeds (fail-open is bounded by review and readiness)",
        }
      : {}),
    modelCalls: 1,
    ...(completion.usage ? { usage: completion.usage } : {}),
  };
  const record: ProbeRecordV1 = {
    schemaVersion: 1,
    kind: "paw.loop-v2-verification-probe",
    candidateInputHash: input.candidateInputHash,
    mutationRevision: input.mutationRevision,
    result,
  };
  fs.mkdirSync(path.dirname(recordPath), { recursive: true });
  fs.writeFileSync(recordPath, JSON.stringify(record), "utf8");
  return result;
}
