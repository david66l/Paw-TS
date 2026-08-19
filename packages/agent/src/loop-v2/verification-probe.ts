import fs from "node:fs";
import path from "node:path";

import { type ModelTokenUsage, atomicWrite } from "@paw/core";
import { type ShellSandboxConfig, runShellInWorkspace } from "@paw/harness";
import type { LanguageModel } from "@paw/models";

import { sha256Canonical } from "./canonical.js";

/**
 * Loop v2.1 对抗式验证探针（fresh-context verification probe）。
 *
 * 认证收口前，用全新上下文（不含实施者思路）针对最终 diff 合成少量
 * 边界测试并由 host 执行；代码级失败（fail）阻止 certification。它只产
 * 事实，不拥有终局——失败反馈走既有修复循环，成功才允许 reducer 盖章。
 *
 * 统一不变量（与语义评审门共用）：候选绑定的对抗性发现只被候选身份变
 * 化解除；相同候选重交不消耗名额、直接回弹；环境类失败（error）不冒
 * 充代码缺陷、不拦截、不缓存终局；唯一退出边界是运行预算。
 *
 * 动机（sklearn-25102）：实施者自选测试存在确认偏差，官方契约测试又
 * 不可见；改动波及但未被修改的下游代码（如未改行消费了被改变类型的
 * 值）恰恰是自测盲区。独立视角选测试从机制上收窄该盲区。
 */
const MAX_PROBES = 4 as const;
const PROBE_TIMEOUT_MS = 180_000 as const;
const PROBE_OUTPUT_CHARS = 1_200 as const;
const DIFF_BUDGET_CHARS = 48_000 as const;

export interface VerificationProbePlanItemV1 {
  readonly command: string;
  readonly rationale: string;
}

/**
 * pass：探针执行成功（exit 0）。
 * fail：探针真实执行且断言失败（exit ≠ 0）——代码级缺陷事实。
 * error：探针命令无法执行（沙箱/守卫/超时等环境原因）——不是代码问题，
 * 不得冒充代码缺陷拦截认证，也不作为终局缓存。
 */
export type VerificationProbeStatusV1 = "pass" | "fail" | "error";

export interface VerificationProbeResultV1 {
  readonly command: string;
  readonly status: VerificationProbeStatusV1;
  readonly exitCode?: number;
  readonly output: string;
}

export interface VerificationProbeOnceResultV2 {
  readonly candidateInputHash: string;
  readonly mutationRevision: number;
  readonly probes: readonly VerificationProbeResultV1[];
  readonly verdict: "pass" | "fail" | "error";
  readonly note?: string;
  readonly modelCalls: number;
  /** A durable claim existed without a settled record; never re-execute it. */
  readonly interrupted?: true;
  readonly usage?: ModelTokenUsage;
}

export interface VerificationProbeGateDecisionV1 {
  readonly type: "accept" | "feedback" | "incomplete";
  readonly key: string;
  readonly message: string;
  readonly reason?: "no_turn_budget";
}

/** Commands the probe may never issue: network, installs, or product writes. */
interface RegexNarrowingRisk {
  readonly oldPattern: string;
  readonly newPattern: string;
}

interface ProtocolFallbackRisk {
  readonly broadCatch: string;
  readonly fallback: string;
}

/**
 * 检测 diff 中的正则/模式改动是否可能收窄行为（拒绝旧实现接受的输入）。
 * 这不是精确的语义比较——是给对抗探针的风险提示，让它重点测试
 * 旧模式接受但新模式可能拒绝的边界输入。
 *
 * 动机（django-15098）：模型把宽松的 \w+ 正则改为严格的 BCP 47
 * 结构，导致 i-mingo、de-1996 等旧实现接受的标签被拒绝。
 */
export function detectRegexNarrowing(
  diff: string,
): RegexNarrowingRisk | undefined {
  // 匹配 diff 中的 - 行（旧正则）和 + 行（新正则）
  // 常见模式：r'...' 或 r"..." 或 re.compile(...)
  const regexRe =
    /-\s*(?:language_code_prefix_re\s*=\s*)?_?lazy_re_compile\(\s*\n?\s*(r['"`][^'"`]+['"`])/;
  const oldMatch = regexRe.exec(diff);
  const newRegexRe =
    /\+\s*(?:language_code_prefix_re\s*=\s*)?_?lazy_re_compile\(\s*\n?\s*(r['"`][^'"`]+['"`])/;
  const newMatch = newRegexRe.exec(diff);
  if (oldMatch?.[1] && newMatch?.[1] && oldMatch[1] !== newMatch[1]) {
    return { oldPattern: oldMatch[1], newPattern: newMatch[1] };
  }
  // 通用模式：任何 - 行包含 r'...' 且 + 行包含不同的 r'...'
  const genericOld = /^-\s+.*?(r['"`][^'"`\n]{5,}['"`])/m.exec(diff);
  const genericNew = /^\+\s+.*?(r['"`][^'"`\n]{5,}['"`])/m.exec(diff);
  if (genericOld?.[1] && genericNew?.[1] && genericOld[1] !== genericNew[1]) {
    return { oldPattern: genericOld[1], newPattern: genericNew[1] };
  }
  return undefined;
}

/**
 * Detect a newly-added broad exception boundary that falls back to a protocol
 * sentinel. This is only a probe-planning hint: the executable probe must
 * establish whether the fallback is correct for participants that do and do
 * not actually implement the competing protocol.
 */
export function detectProtocolFallbackRisk(
  diff: string,
): ProtocolFallbackRisk | undefined {
  const chunks: string[][] = [];
  let current: string[] = [];
  for (const line of diff.split(/\r?\n/)) {
    if (/^(?:diff --git |@@ )/.test(line) && current.length > 0) {
      chunks.push(current);
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) chunks.push(current);
  for (const chunk of chunks) {
    const added = chunk
      .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
      .map((line) => line.slice(1));
    const broadCatch = added.find((line) =>
      /^\s*except\s*(?::|(?:Exception|BaseException)\b)/.test(line),
    );
    const fallback = added.find((line) =>
      /^\s*return\s+NotImplemented\b/.test(line),
    );
    if (broadCatch && fallback) {
      return { broadCatch: broadCatch.trim(), fallback: fallback.trim() };
    }
  }
  return undefined;
}

const EXTENSION_POINT_NAME =
  /^(?:handlers?|dispatch(?:es)?|plugins?|registr(?:y|ies))(?:\.[cm]?[jt]s|\.py)?$/i;

/**
 * Read-only, shallow discovery around changed files. It does not infer that a
 * handler is correct; it only tells the fresh reviewer which established
 * extension mechanisms are close enough to inspect before widening a base.
 */
export function discoverRepositoryExtensionPointsV1(
  workspaceRoot: string,
  changedFiles: readonly string[],
): readonly string[] {
  const root = path.resolve(workspaceRoot);
  let realRoot = root;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    // Missing workspaces yield no entries; lexical containment still applies.
  }
  const searchDirs = new Set<string>();
  for (const changedFile of changedFiles.slice(0, 40)) {
    if (!changedFile.trim() || path.isAbsolute(changedFile)) continue;
    const absolute = path.resolve(root, changedFile);
    const relative = path.relative(root, absolute);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      continue;
    }
    let current = path.dirname(absolute);
    for (let depth = 0; depth < 3; depth += 1) {
      const currentRelative = path.relative(root, current);
      if (
        currentRelative.startsWith("..") ||
        path.isAbsolute(currentRelative)
      ) {
        break;
      }
      try {
        const realCurrent = fs.realpathSync(current);
        const realRelative = path.relative(realRoot, realCurrent);
        if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
          break;
        }
      } catch {
        break;
      }
      searchDirs.add(current);
      if (current === root) break;
      current = path.dirname(current);
    }
  }
  const hints = new Set<string>();
  for (const directory of searchDirs) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!EXTENSION_POINT_NAME.test(entry.name)) continue;
      const relative = path
        .relative(root, path.join(directory, entry.name))
        .replace(/\\/g, "/");
      if (relative && !relative.startsWith("..")) hints.add(relative);
    }
  }
  return [...hints].sort().slice(0, 12);
}

const PROBE_COMMAND_DENYLIST =
  /\b(?:curl|wget|nc|netcat|ssh|scp|pip3?|npm|pnpm|yarn|conda|apt|apt-get|brew|git\s+(?:push|fetch|pull|clone))\b/i;

const ADDED_CALLABLE =
  /^\+\s*(?:(?:async\s+)?def\s+|(?:public\s+|protected\s+|private\s+)?(?:async\s+)?(?:function\s+)?[A-Za-z_$][\w$]*\s*\()/;

function changedCallableFilesV1(
  diff: string,
  fallbackChangedFiles: readonly string[],
): readonly string[] {
  const files = new Set<string>();
  let currentPath: string | undefined;
  for (const line of diff.split(/\r?\n/)) {
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (header?.[2]) {
      currentPath = header[2].replace(/\\/g, "/");
      continue;
    }
    if (!ADDED_CALLABLE.test(line)) continue;
    if (currentPath) {
      files.add(currentPath);
    } else {
      for (const changedFile of fallbackChangedFiles) {
        files.add(changedFile.replace(/\\/g, "/"));
      }
    }
  }
  return [...files].sort();
}

function isInsideExtensionPointV1(
  changedFile: string,
  extensionPointHints: readonly string[],
): boolean {
  const normalized = changedFile.replace(/\\/g, "/").replace(/^\.\//, "");
  return extensionPointHints.some((hint) => {
    const point = hint.replace(/\\/g, "/").replace(/^\.\//, "");
    return normalized === point || normalized.startsWith(`${point}/`);
  });
}

export function buildVerificationProbePromptV1(input: {
  readonly goal: string;
  readonly diff: string;
  readonly changedFiles: readonly string[];
  /** Layer 3 增强：受影响的既有测试清单（来自代码-测试依赖图）。 */
  readonly impactedTests?: readonly string[];
  /** Nearby repository-owned handler/dispatch/registry mechanisms. */
  readonly extensionPointHints?: readonly string[];
}): string {
  const diffText =
    input.diff.length > DIFF_BUDGET_CHARS
      ? `${input.diff.slice(0, DIFF_BUDGET_CHARS)}\n... (diff truncated)`
      : input.diff;
  // 检测 diff 中的正则/模式改动，提取行为收窄风险
  const narrowingRisk = detectRegexNarrowing(input.diff);
  const protocolFallbackRisk = detectProtocolFallbackRisk(input.diff);
  const extensionPointHints = input.extensionPointHints ?? [];
  const callableFiles = changedCallableFilesV1(input.diff, input.changedFiles);
  const extensionPointRisk =
    extensionPointHints.length > 0 &&
    callableFiles.some(
      (changedFile) =>
        !isInsideExtensionPointV1(changedFile, extensionPointHints),
    );
  const simplifyVisible = /simplif(?:y|ied|ication)\b/i.test(
    `${input.goal}\n${input.diff}`,
  );
  const protocolVariantVisible =
    /\b(?:out(?:put)?|in[-_ ]?place|reflected)\b|__r[a-z_]+__/i.test(
      `${input.goal}\n${input.diff}`,
    );
  return [
    "You are an adversarial verification engineer. Another engineer claims the change below completes the stated task. Your ONLY job is to try to BREAK the candidate change before it ships.",
    "",
    "## Task",
    input.goal.slice(0, 4_000),
    "",
    "## Changed files",
    input.changedFiles.slice(0, 40).join(", ") || "(none)",
    ...(input.impactedTests && input.impactedTests.length > 0
      ? [
          "",
          "## Existing tests linked to the change surface (from the code-test dependency map)",
          "These tests already exist in the repository and are linked to the files you changed. They represent known behavioral contracts — probe whether the change breaks them:",
          ...input.impactedTests.slice(0, 8).map((t) => `- ${t}`),
          ...(input.impactedTests.length > 8
            ? [`(and ${input.impactedTests.length - 8} more)`]
            : []),
        ]
      : []),
    ...(narrowingRisk
      ? [
          "",
          "## ⚠ Behavioral narrowing risk detected",
          "The diff modifies a pattern/regex. The OLD pattern accepted inputs that the NEW pattern might reject:",
          `  OLD: ${narrowingRisk.oldPattern}`,
          `  NEW: ${narrowingRisk.newPattern}`,
          "",
          "Generate probe commands that test inputs the OLD pattern accepted. If the NEW pattern rejects any previously-accepted input without the task explicitly requiring it, that is a blocking defect.",
        ]
      : []),
    ...(protocolFallbackRisk
      ? [
          "",
          "## ⚠ Protocol fallback ownership risk detected",
          "The diff adds a broad exception boundary that returns a protocol fallback sentinel:",
          `  CATCH: ${protocolFallbackRisk.broadCatch}`,
          `  FALLBACK: ${protocolFallbackRisk.fallback}`,
          "",
          "Generate a minimal ownership matrix, not only the happy path: (1) a participant that really implements the competing protocol and (2) a look-alike with similar metadata but no explicit protocol handler. Verify the fallback occurs only when another implementation can own the operation, and that only expected conversion/type exceptions are caught.",
          ...(protocolVariantVisible
            ? [
                "The visible protocol also exposes an out/output, in-place, reflected, or related dispatch variant; cover each applicable path.",
              ]
            : []),
        ]
      : []),
    ...(extensionPointRisk
      ? [
          "",
          "## ⚠ Existing extension-point bypass risk detected",
          "The repository has these nearby candidate handler/dispatch/registry mechanisms:",
          ...extensionPointHints.slice(0, 12).map((hint) => `- ${hint}`),
          "First determine whether one of these mechanisms owns the changed behavior. If it does, compare the candidate with the smallest registered handler/plugin instead of assuming a broad base-class special case is necessary. Probe the earliest public dispatch/evaluation path and any downstream normalization or post-processing path visible in the task or diff.",
          ...(simplifyVisible
            ? [
                "Simplification is visible in this candidate: explicitly compare direct construction/evaluation with the simplify/post-processing path; passing only the latter can hide a wrong dispatch layer.",
              ]
            : []),
        ]
      : []),
    "",
    "## Candidate diff",
    "```diff",
    diffText,
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
        status: "error",
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
    results.push({
      command: probe.command,
      status: exitCode === 0 ? "pass" : "fail",
      ...(typeof exitCode === "number" ? { exitCode } : {}),
      output: output.slice(-PROBE_OUTPUT_CHARS),
    });
  }
  return results;
}

/**
 * 统一不变量（评审/探针两门共用）：候选绑定的对抗性发现只被"候选身份
 * 变化"这一事实解除。相同候选的重交不消耗任何名额——它不构成新事件，
 * 直接回弹；只有真实代码修改产生新 candidateInputHash，才触发新探针。
 * 唯一的诚实退出边界是运行预算（no turn budget），没有任何计数阈值。
 */
export function evaluateVerificationProbeGateV1(input: {
  readonly result: VerificationProbeOnceResultV2;
  readonly noRoomForAnotherTurn: boolean;
}): VerificationProbeGateDecisionV1 {
  const key = `probe:${input.result.candidateInputHash}`;
  if (input.result.interrupted) {
    const message = [
      `[LoopV2Probe:interrupted key=${key}]`,
      "The host found a durable verification-probe claim without a settled result. The prior probe may already have executed model or shell work, so it will not be run again.",
      "Treat this candidate as not certified. Make a real code change before requesting another probe, or end honestly as incomplete if the result cannot be recovered.",
    ].join("\n");
    return input.noRoomForAnotherTurn
      ? { type: "incomplete", key, message, reason: "no_turn_budget" }
      : { type: "feedback", key, message };
  }
  if (input.result.verdict !== "fail") {
    // pass 或 error（环境原因无法执行）都不拦截：error 不冒充代码缺陷。
    return {
      type: "accept",
      key,
      message: "",
    };
  }
  const failures = input.result.probes
    .filter((probe) => probe.status === "fail")
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
    "Fix the code so the failing behavior is corrected, then propose a new final answer. Resubmitting the same code is pointless: the failed probe is bound to this exact candidate, so an identical resubmission will replay the same failure. Only a real code change produces a new candidate and a fresh probe.",
  ].join("\n");
  if (!input.noRoomForAnotherTurn) {
    return { type: "feedback", key, message };
  }
  return {
    type: "incomplete",
    key,
    message,
    reason: "no_turn_budget",
  };
}

interface ProbeRecordV1 {
  readonly schemaVersion: 1;
  readonly kind: "paw.loop-v2-verification-probe";
  readonly candidateInputHash: string;
  readonly mutationRevision: number;
  readonly result: VerificationProbeOnceResultV2;
}

interface ProbeClaimV1 {
  readonly schemaVersion: 1;
  readonly kind: "paw.loop-v2-verification-probe-claim";
  readonly candidateInputHash: string;
  readonly mutationRevision: number;
  readonly claimKey: string;
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

function probeClaimPath(workspaceRoot: string, runId: string): string {
  return path.join(
    path.dirname(probeRecordPath(workspaceRoot, runId)),
    "verification-probe-claim-v1.json",
  );
}

function parseProbeRecordV1(value: unknown): ProbeRecordV1 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const record = value as Partial<ProbeRecordV1>;
  const result = record.result;
  if (
    record.schemaVersion !== 1 ||
    record.kind !== "paw.loop-v2-verification-probe" ||
    typeof record.candidateInputHash !== "string" ||
    !record.candidateInputHash.trim() ||
    !Number.isSafeInteger(record.mutationRevision) ||
    (record.mutationRevision ?? -1) < 0 ||
    !result ||
    result.candidateInputHash !== record.candidateInputHash ||
    result.mutationRevision !== record.mutationRevision ||
    !["pass", "fail", "error"].includes(result.verdict) ||
    !Array.isArray(result.probes) ||
    !result.probes.every(
      (probe) =>
        probe &&
        typeof probe === "object" &&
        typeof probe.command === "string" &&
        ["pass", "fail", "error"].includes(probe.status) &&
        (probe.exitCode === undefined ||
          Number.isSafeInteger(probe.exitCode)) &&
        typeof probe.output === "string",
    ) ||
    !Number.isSafeInteger(result.modelCalls) ||
    result.modelCalls < 0 ||
    (result.interrupted !== undefined && result.interrupted !== true) ||
    (result.interrupted === true &&
      (result.verdict !== "error" ||
        result.modelCalls !== 0 ||
        result.probes.length !== 0)) ||
    (!result.interrupted &&
      result.verdict !==
        (result.probes.some((probe) => probe.status === "fail")
          ? "fail"
          : result.probes.some((probe) => probe.status === "error")
            ? "error"
            : "pass"))
  )
    return undefined;
  return record as ProbeRecordV1;
}

function parseProbeClaimV1(value: unknown): ProbeClaimV1 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const claim = value as Partial<ProbeClaimV1>;
  if (
    claim.schemaVersion !== 1 ||
    claim.kind !== "paw.loop-v2-verification-probe-claim" ||
    typeof claim.candidateInputHash !== "string" ||
    !claim.candidateInputHash.trim() ||
    !Number.isSafeInteger(claim.mutationRevision) ||
    (claim.mutationRevision ?? -1) < 0 ||
    typeof claim.claimKey !== "string" ||
    claim.claimKey !==
      sha256Canonical({
        policy: "paw.loop-v2-verification-probe-v1",
        candidateInputHash: claim.candidateInputHash,
        mutationRevision: claim.mutationRevision,
      })
  )
    return undefined;
  return claim as ProbeClaimV1;
}

function readProbeJsonV1(
  filePath: string,
):
  | Readonly<{ state: "missing" }>
  | Readonly<{ state: "corrupt" }>
  | Readonly<{ state: "parsed"; value: unknown }> {
  try {
    return {
      state: "parsed",
      value: JSON.parse(fs.readFileSync(filePath, "utf8")),
    };
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return { state: "missing" };
    }
    return { state: "corrupt" };
  }
}

function interruptedProbeResultV2(input: {
  readonly candidateInputHash: string;
  readonly mutationRevision: number;
  readonly note: string;
}): VerificationProbeOnceResultV2 {
  return {
    candidateInputHash: input.candidateInputHash,
    mutationRevision: input.mutationRevision,
    probes: [],
    verdict: "error",
    interrupted: true,
    note: input.note,
    modelCalls: 0,
  };
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
  /** Layer 3: impacted existing tests from the code-test dependency map. */
  readonly impactedTests?: readonly string[];
  readonly candidateInputHash: string;
  readonly mutationRevision: number;
  readonly shellSandbox?: ShellSandboxConfig;
  readonly signal?: AbortSignal;
  readonly onUsage?: (modelLabel: string, usage: ModelTokenUsage) => void;
}): Promise<VerificationProbeOnceResultV2> {
  const recordPath = probeRecordPath(input.workspaceRoot, input.runId);
  const claimPath = probeClaimPath(input.workspaceRoot, input.runId);
  const recordRead = readProbeJsonV1(recordPath);
  const existing =
    recordRead.state === "parsed"
      ? parseProbeRecordV1(recordRead.value)
      : undefined;
  if (existing) {
    if (existing?.candidateInputHash === input.candidateInputHash) {
      return { ...existing.result, modelCalls: 0 };
    }
    // Candidate identity can change when new evidence is attached without a
    // product mutation. The code under test is unchanged, so reuse the settled
    // probe instead of executing a second model/shell transaction.
    if (existing?.mutationRevision === input.mutationRevision) {
      return {
        ...existing.result,
        candidateInputHash: input.candidateInputHash,
        mutationRevision: input.mutationRevision,
        modelCalls: 0,
      };
    }
  }
  const claimRead = readProbeJsonV1(claimPath);
  const existingClaim =
    claimRead.state === "parsed"
      ? parseProbeClaimV1(claimRead.value)
      : undefined;
  if (existingClaim) {
    if (
      existingClaim.candidateInputHash === input.candidateInputHash ||
      existingClaim.mutationRevision === input.mutationRevision
    ) {
      return interruptedProbeResultV2({
        candidateInputHash: input.candidateInputHash,
        mutationRevision: input.mutationRevision,
        note: "verification probe interrupted after its durable claim; execution was not repeated",
      });
    }
  }
  if (
    recordRead.state === "corrupt" ||
    (recordRead.state === "parsed" && !existing) ||
    claimRead.state === "corrupt" ||
    (claimRead.state === "parsed" && !existingClaim)
  ) {
    return interruptedProbeResultV2({
      candidateInputHash: input.candidateInputHash,
      mutationRevision: input.mutationRevision,
      note: "verification probe durable state is corrupt; execution was not repeated",
    });
  }

  const claim: ProbeClaimV1 = {
    schemaVersion: 1,
    kind: "paw.loop-v2-verification-probe-claim",
    candidateInputHash: input.candidateInputHash,
    mutationRevision: input.mutationRevision,
    claimKey: sha256Canonical({
      policy: "paw.loop-v2-verification-probe-v1",
      candidateInputHash: input.candidateInputHash,
      mutationRevision: input.mutationRevision,
    }),
  };
  atomicWrite(claimPath, JSON.stringify(claim));
  if (!parseProbeClaimV1(JSON.parse(fs.readFileSync(claimPath, "utf8")))) {
    throw new Error("Verification probe claim failed strict reread");
  }

  const completion = await input.model.complete(
    [
      {
        role: "user",
        content: buildVerificationProbePromptV1({
          goal: input.goal,
          diff: input.diff,
          changedFiles: input.changedFiles,
          ...(input.impactedTests
            ? { impactedTests: input.impactedTests }
            : {}),
          extensionPointHints: discoverRepositoryExtensionPointsV1(
            input.workspaceRoot,
            input.changedFiles,
          ),
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
  const codeFailed = probes.some((probe) => probe.status === "fail");
  const errored = probes.some((probe) => probe.status === "error");
  const result: VerificationProbeOnceResultV2 = {
    candidateInputHash: input.candidateInputHash,
    mutationRevision: input.mutationRevision,
    probes,
    verdict: codeFailed ? "fail" : errored ? "error" : "pass",
    ...(probes.length === 0
      ? {
          note: "probe model returned no executable probes; certification proceeds (fail-open is bounded by review and readiness)",
        }
      : {}),
    ...(codeFailed
      ? {}
      : errored
        ? {
            note: "probe commands could not execute (environment); not treated as a code defect and not cached as final",
          }
        : {}),
    modelCalls: 1,
    ...(completion.usage ? { usage: completion.usage } : {}),
  };
  // Once claimed, every outcome is settled atomically. Retrying an environment
  // error would repeat model/shell side effects after a crash and is therefore
  // less honest than preserving the explicit error fact for this revision.
  const record: ProbeRecordV1 = {
    schemaVersion: 1,
    kind: "paw.loop-v2-verification-probe",
    candidateInputHash: input.candidateInputHash,
    mutationRevision: input.mutationRevision,
    result,
  };
  atomicWrite(recordPath, JSON.stringify(record));
  const settled = parseProbeRecordV1(
    JSON.parse(fs.readFileSync(recordPath, "utf8")),
  );
  if (!settled) {
    throw new Error("Verification probe record failed strict reread");
  }
  return settled.result;
}
