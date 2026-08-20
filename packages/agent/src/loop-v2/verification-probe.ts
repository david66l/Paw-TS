import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { type ModelTokenUsage, atomicWrite } from "@paw/core";
import {
  type ShellSandboxConfig,
  type ToolRunResult,
  isShellSandboxEnabled,
  runShellInWorkspace,
} from "@paw/harness";
import type { LanguageModel } from "@paw/models";

import { parseCommandChain } from "../shell-command.js";
import { classifyVerificationOutcome } from "../task-state.js";
import { analyzeVerificationInvocation } from "../verification-command.js";
import { sha256Canonical } from "./canonical.js";

/**
 * Loop v2.1 对抗式验证探针（fresh-context verification probe）。
 *
 * 认证收口前，用全新上下文（不含实施者思路）针对最终 diff 合成少量
 * 边界测试并由 host 执行；只有证据落地的 candidate_defect 才能阻止
 * certification。它只产事实，不拥有终局——状态转换最终由 reducer 负责。
 *
 * 统一不变量（与语义评审门共用）：候选绑定的对抗性发现只被候选身份变
 * 化解除；相同 revision 重交不重复模型/shell；环境、无效与证据不足不冒
 * 充代码缺陷；唯一退出边界是运行预算。
 *
 * 动机（sklearn-25102）：实施者自选测试存在确认偏差，官方契约测试又
 * 不可见；改动波及但未被修改的下游代码（如未改行消费了被改变类型的
 * 值）恰恰是自测盲区。独立视角选测试从机制上收窄该盲区。
 */
const MAX_PROBES = 1 as const;
const PROBE_TIMEOUT_MS = 180_000 as const;
const PROBE_OUTPUT_CHARS = 1_200 as const;
const DIFF_BUDGET_CHARS = 24_000 as const;
const PROBE_PLANNER_MAX_OUTPUT_TOKENS = 1_536 as const;
const PROBE_ADJUDICATOR_MAX_OUTPUT_TOKENS = 1_024 as const;
const PROBE_COMMAND_CHARS = 512 as const;
const PROBE_RATIONALE_CHARS = 160 as const;
const PROBE_ORACLE_CHARS = 160 as const;
const PROBE_MAX_GROUNDING_REFS = 2 as const;
const PROBE_RISK_EVIDENCE_CHARS = 320 as const;
const PROBE_PROMPT_MAX_CHARS = 42_000 as const;
const PROBE_POLICY_VERSION = "paw.loop-v2-verification-probe-v3" as const;

export type VerificationProbeKindV2 = "repository_test" | "inline_contract";

export interface VerificationProbePlanItemV1 {
  readonly probeId: string;
  readonly command: string;
  readonly rationale: string;
  readonly oracle: string;
  readonly kind: VerificationProbeKindV2;
  readonly groundingRefs: readonly string[];
}

/**
 * Execution status is deliberately separate from disposition. Exit status is
 * an observed fact; host/model adjudication decides whether it proves a task-
 * grounded defect, an invalid probe, an environment problem, or nothing yet.
 */
export type VerificationProbeStatusV1 =
  | "not_run"
  | "completed"
  | "environment_error";

export type VerificationProbeDispositionV2 =
  | "pass"
  | "candidate_defect"
  | "invalid_probe"
  | "environment_error"
  | "inconclusive";

export interface VerificationProbeResultV1 {
  readonly probeId: string;
  readonly plan: VerificationProbePlanItemV1;
  readonly execution: Readonly<{
    readonly status: VerificationProbeStatusV1;
    readonly exitCode?: number;
    readonly output: string;
    readonly outputHash: string;
  }>;
  readonly disposition: VerificationProbeDispositionV2;
  readonly adjudication: Readonly<{
    readonly source: "host" | "model" | "protocol" | "legacy";
    readonly summary: string;
    readonly evidenceRefs: readonly string[];
  }>;
}

export interface VerificationProbeOnceResultV2 {
  readonly candidateInputHash: string;
  readonly mutationRevision: number;
  readonly verificationAuthority?: "local" | "external" | "not_required";
  readonly probes: readonly VerificationProbeResultV1[];
  readonly verdict:
    | "clear"
    | "candidate_defect"
    | "inconclusive"
    | "interrupted";
  readonly note?: string;
  readonly modelCalls: number;
  /** A durable claim existed without a settled record; never re-execute it. */
  readonly interrupted?: true;
  readonly usage?: ModelTokenUsage;
  readonly plannerDiagnostics?: ProbePlannerDiagnosticsV3;
}

export interface ProbePlannerDiagnosticsV3 {
  readonly policyVersion: typeof PROBE_POLICY_VERSION;
  readonly finishReason: string;
  readonly promptChars: number;
  readonly promptHash: string;
  readonly visibleChars: number;
  readonly visibleHash: string;
  readonly thinkingChars: number;
  readonly thinkingHash: string;
  readonly diagnosticsHash: string;
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

function clipDiffChunkAtLineBoundariesV1(
  chunk: string,
  budget: number,
): string {
  const marker = "\n... (middle of this diff hunk omitted) ...\n";
  const maxLineChars = Math.max(120, budget - marker.length - 80);
  const lines = chunk
    .split(/\r?\n/)
    .map((line) =>
      line.length <= maxLineChars
        ? line
        : `... (oversized diff line omitted chars=${line.length} hash=${sha256Canonical({ line })}) ...`,
    );
  const normalized = lines.join("\n");
  if (normalized.length <= budget) return normalized;
  const available = Math.max(200, budget - marker.length);
  const headTarget = Math.floor(available * 0.6);
  const tailTarget = available - headTarget;
  const head: string[] = [];
  let headChars = 0;
  for (const line of lines) {
    const cost = line.length + (head.length > 0 ? 1 : 0);
    if (headChars + cost > headTarget) break;
    head.push(line);
    headChars += cost;
  }
  const tail: string[] = [];
  let tailChars = 0;
  for (let index = lines.length - 1; index >= head.length; index -= 1) {
    const line = lines[index] ?? "";
    const cost = line.length + (tail.length > 0 ? 1 : 0);
    if (tailChars + cost > tailTarget) break;
    tail.unshift(line);
    tailChars += cost;
  }
  return `${head.join("\n")}${marker}${tail.join("\n")}`;
}

/**
 * Bounded, hunk-aware terminal diff projection for the auxiliary planner.
 * Large diffs retain uniformly-spaced first/middle/last hunks instead of only
 * the leading file; oversized individual hunks preserve both boundary sides.
 */
export function sampleVerificationProbeDiffV1(
  diff: string,
  budget: number = DIFF_BUDGET_CHARS,
): string {
  if (!Number.isSafeInteger(budget) || budget < 1_000) {
    throw new Error("verification probe diff budget is invalid");
  }
  if (diff.length <= budget) return diff;

  const chunks: string[] = [];
  let fileHeader: string[] = [];
  let hunk: string[] = [];
  const flushHunk = () => {
    if (hunk.length > 0) chunks.push([...fileHeader, ...hunk].join("\n"));
    hunk = [];
  };
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      flushHunk();
      fileHeader = [line];
      continue;
    }
    if (line.startsWith("@@ ")) {
      flushHunk();
      hunk = [line];
      continue;
    }
    if (hunk.length > 0) hunk.push(line);
    else if (fileHeader.length > 0) fileHeader.push(line);
  }
  flushHunk();
  if (chunks.length === 0) {
    return clipDiffChunkAtLineBoundariesV1(diff, budget);
  }

  const targetCount = Math.min(
    chunks.length,
    Math.max(3, Math.floor(budget / 1_200)),
  );
  const indices = new Set<number>();
  if (targetCount === 1) indices.add(0);
  else {
    for (let index = 0; index < targetCount; index += 1) {
      indices.add(
        Math.round((index * (chunks.length - 1)) / (targetCount - 1)),
      );
    }
  }
  const selected = [...indices].sort((left, right) => left - right);
  const separator = "\n... (other diff hunks omitted) ...\n";
  const perChunk = Math.max(
    300,
    Math.floor(
      (budget - separator.length * (selected.length - 1)) / selected.length,
    ),
  );
  return selected
    .map((index) =>
      clipDiffChunkAtLineBoundariesV1(chunks[index] ?? "", perChunk),
    )
    .join(separator);
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
  const boundedEvidence = (value: string): string =>
    value.length <= PROBE_RISK_EVIDENCE_CHARS
      ? value
      : `${value.slice(0, PROBE_RISK_EVIDENCE_CHARS - 80)}... [chars=${value.length} hash=${sha256Canonical({ value })}]`;
  const diffText = sampleVerificationProbeDiffV1(input.diff);
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
  const riskBrief = protocolFallbackRisk
    ? [
        "## Highest-priority risk: protocol fallback ownership",
        `CATCH: ${boundedEvidence(protocolFallbackRisk.broadCatch)}`,
        `FALLBACK: ${boundedEvidence(protocolFallbackRisk.fallback)}`,
        "Probe one ownership boundary: compare a real competing protocol participant with a look-alike lacking that handler. The sentinel must appear only when another implementation can own the operation.",
        ...(protocolVariantVisible
          ? [
              "Cover the single most relevant visible out/in-place/reflected variant.",
            ]
          : []),
      ]
    : extensionPointRisk
      ? [
          "## Highest-priority risk: existing extension point",
          `Nearby mechanisms: ${boundedEvidence(
            extensionPointHints
              .slice(0, 8)
              .map((hint) => boundedEvidence(hint))
              .join(", "),
          )}`,
          "Probe the earliest public dispatch/evaluation path that distinguishes the candidate base-class change from the smallest registered handler/plugin.",
          ...(simplifyVisible
            ? [
                "Prefer direct construction/evaluation over simplify-only evidence.",
              ]
            : []),
        ]
      : narrowingRisk
        ? [
            "## Highest-priority risk: behavioral narrowing",
            `OLD: ${boundedEvidence(narrowingRisk.oldPattern)}`,
            `NEW: ${boundedEvidence(narrowingRisk.newPattern)}`,
            "Probe one input accepted by the old pattern near the changed boundary.",
          ]
        : [];
  const prompt = [
    "You are an adversarial verification planner. Return one short executable probe most likely to falsify this candidate. Do not explain your reasoning outside the JSON.",
    "",
    "## Task",
    input.goal.slice(0, 4_000),
    "",
    "## Changed files",
    input.changedFiles
      .slice(0, 20)
      .map((file) => boundedEvidence(file))
      .join(", ") || "(none)",
    ...(input.impactedTests && input.impactedTests.length > 0
      ? [
          "",
          "## Existing tests linked to the change surface (from the code-test dependency map)",
          "These tests already exist in the repository and are linked to the files you changed. They represent known behavioral contracts — probe whether the change breaks them:",
          ...input.impactedTests
            .slice(0, 8)
            .map((t) => `- repository_test:${boundedEvidence(t)}`),
          ...(input.impactedTests.length > 8
            ? [`(and ${input.impactedTests.length - 8} more)`]
            : []),
        ]
      : []),
    ...(riskBrief.length > 0 ? ["", ...riskBrief] : []),
    "",
    "## Candidate diff",
    "```diff",
    diffText,
    "```",
    "",
    "## Your mission",
    "Choose exactly one end-to-end boundary, downstream-consumer, or old-caller contract that the implementing agent did not already verify.",
    "Prefer a short inline Python/Node assertion. A repository_test command must be exactly one bare impacted selector, for example `python -m pytest tests/test_file.py::test_name`, with no options or additional targets.",
    "",
    "## Hard constraints",
    "- Offline only: no network, no package installation, no git remote operations.",
    "- Do not create or modify files in the repository; inline snippets only.",
    `- Return exactly one probe. command<=${PROBE_COMMAND_CHARS} chars; rationale<=${PROBE_RATIONALE_CHARS}; oracle<=${PROBE_ORACLE_CHARS}; groundingRefs<=${PROBE_MAX_GROUNDING_REFS}.`,
    "- The command must be one self-contained shell invocation that exits non-zero on failure.",
    "- Only probe what the diff could plausibly affect; do not restate the happy path the author already verified.",
    "- kind=repository_test is allowed only for an existing repository test named below; cite it as repository_test:<path>.",
    "- kind=inline_contract must cite task_goal and/or terminal_diff and must state a behavioral oracle. Pure delimiter counts, formatting balance, or syntax-shape checks are invalid unless the task explicitly defines that exact contract.",
    "",
    'Reply ONLY: {"probes":[{"command":"...","rationale":"...","oracle":"...","kind":"repository_test|inline_contract","groundingRefs":["task_goal","terminal_diff"]}]}',
  ].join("\n");
  if (prompt.length > PROBE_PROMPT_MAX_CHARS) {
    throw new Error(
      `verification probe prompt exceeded bounded material (${prompt.length} > ${PROBE_PROMPT_MAX_CHARS})`,
    );
  }
  return prompt;
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
    const oracle = (raw as { oracle?: unknown }).oracle;
    const kind = (raw as { kind?: unknown }).kind;
    const groundingRefs = (raw as { groundingRefs?: unknown }).groundingRefs;
    if (
      typeof command !== "string" ||
      !command.trim() ||
      typeof rationale !== "string" ||
      !rationale.trim() ||
      typeof oracle !== "string" ||
      !oracle.trim() ||
      (kind !== "repository_test" && kind !== "inline_contract") ||
      !Array.isArray(groundingRefs) ||
      groundingRefs.length === 0 ||
      !groundingRefs.every(
        (reference) =>
          typeof reference === "string" &&
          reference.trim().length > 0 &&
          reference.length <= 500,
      )
    )
      continue;
    const trimmed = command.trim();
    if (
      trimmed.length > PROBE_COMMAND_CHARS ||
      rationale.trim().length > PROBE_RATIONALE_CHARS ||
      oracle.trim().length > PROBE_ORACLE_CHARS ||
      groundingRefs.length > PROBE_MAX_GROUNDING_REFS
    )
      continue;
    if (PROBE_COMMAND_DENYLIST.test(trimmed)) continue;
    items.push({
      probeId: `probe_${items.length + 1}`,
      command: trimmed,
      rationale: rationale.trim(),
      oracle: oracle.trim(),
      kind,
      groundingRefs: [...new Set(groundingRefs.map((ref) => ref.trim()))],
    });
  }
  return items;
}

export function executeVerificationProbesV1(input: {
  readonly workspaceRoot: string;
  readonly shellSandbox?: ShellSandboxConfig;
  /** Host-owned dependency seam for deterministic tests; never model input. */
  readonly hostShellRunner?: typeof runShellInWorkspace;
  readonly probes: readonly VerificationProbePlanItemV1[];
  readonly impactedTests?: readonly string[];
  readonly changedFiles?: readonly string[];
  readonly verificationAuthority?: "local" | "external" | "not_required";
}): readonly VerificationProbeResultV1[] {
  const probeSandbox = isShellSandboxEnabled(input.shellSandbox)
    ? {
        ...input.shellSandbox,
        network: "deny" as const,
        workspaceReadOnly: true,
      }
    : undefined;
  const impactedTests = new Set(
    (input.impactedTests ?? []).map((test) => test.replace(/\\/g, "/")),
  );
  const knownRefs = new Set([
    "task_goal",
    "terminal_diff",
    ...[...impactedTests].map((test) => `repository_test:${test}`),
  ]);
  const results: VerificationProbeResultV1[] = [];
  for (const probe of input.probes) {
    const repositoryRef = probe.groundingRefs.find((reference) =>
      reference.startsWith("repository_test:"),
    );
    const repositoryPath = repositoryRef?.slice("repository_test:".length);
    const refsAreKnown = probe.groundingRefs.every((reference) =>
      knownRefs.has(reference),
    );
    const repositoryInvocation = repositoryPath
      ? trustedRepositoryTestInvocationV2(
          input.workspaceRoot,
          probe.command,
          repositoryPath,
        )
      : undefined;
    const repositoryPlanIsGrounded =
      probe.kind !== "repository_test" ||
      (repositoryPath !== undefined &&
        impactedTests.has(repositoryPath) &&
        repositoryInvocation !== undefined);
    const inlinePlanIsGrounded =
      probe.kind !== "inline_contract" ||
      probe.groundingRefs.some(
        (reference) =>
          reference === "task_goal" || reference === "terminal_diff",
      );
    if (!refsAreKnown || !repositoryPlanIsGrounded || !inlinePlanIsGrounded) {
      const summary = !refsAreKnown
        ? "probe cites evidence that was not supplied by the host"
        : probe.kind === "repository_test"
          ? "repository-test probe is not bound to a tracked impacted test"
          : "inline probe is not grounded in the visible task or terminal diff";
      results.push({
        probeId: probe.probeId,
        plan: probe,
        execution: {
          status: "not_run",
          output: "",
          outputHash: sha256Canonical({ output: "" }),
        },
        disposition: "invalid_probe",
        adjudication: {
          source: "protocol",
          summary,
          evidenceRefs: [],
        },
      });
      continue;
    }
    if (!probeSandbox) {
      const output =
        "probe could not execute: a container sandbox with a read-only workspace is required";
      results.push({
        probeId: probe.probeId,
        plan: probe,
        execution: {
          status: "environment_error",
          output,
          outputHash: sha256Canonical({ output }),
        },
        disposition: "environment_error",
        adjudication: {
          source: "host",
          summary:
            "probe runner refused to execute model-generated shell outside a read-only container",
          evidenceRefs: [],
        },
      });
      continue;
    }
    const shell = (input.hostShellRunner ?? runShellInWorkspace)(
      input.workspaceRoot,
      probe.command,
      {
        timeoutMs: PROBE_TIMEOUT_MS,
        shellSandbox: probeSandbox,
        skipApprovalGate: true,
      },
    );
    if (shell.error) {
      const output = `probe could not execute: ${shell.error}`.slice(
        0,
        PROBE_OUTPUT_CHARS,
      );
      results.push({
        probeId: probe.probeId,
        plan: probe,
        execution: {
          status: "environment_error",
          output,
          outputHash: sha256Canonical({ output }),
        },
        disposition: "environment_error",
        adjudication: {
          source: "host",
          summary: "probe runner could not launch or settle the command",
          evidenceRefs: [],
        },
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
    const clippedOutput = output.slice(-PROBE_OUTPUT_CHARS);
    const hostMayOwnDisposition =
      probe.kind === "repository_test" &&
      repositoryInvocation !== undefined &&
      input.verificationAuthority !== "external";
    const classification =
      hostMayOwnDisposition && Number.isSafeInteger(exitCode)
        ? classifyVerificationOutcome(
            {
              ok: exitCode === 0,
              payload: {
                exit_code: exitCode,
                stdout: shell.stdout,
                stderr: shell.stderr,
              },
              summary: clippedOutput || `probe exited ${exitCode ?? "unknown"}`,
            } satisfies ToolRunResult,
            input.changedFiles ?? [],
            repositoryInvocation,
          )
        : undefined;
    const disposition: VerificationProbeDispositionV2 =
      classification?.outcome === "passed"
        ? "pass"
        : classification?.outcome === "code_failed"
          ? "candidate_defect"
          : classification?.outcome === "harness_failed"
            ? "environment_error"
            : "inconclusive";
    results.push({
      probeId: probe.probeId,
      plan: probe,
      execution: {
        status: "completed",
        ...(typeof exitCode === "number" ? { exitCode } : {}),
        output: clippedOutput,
        outputHash: sha256Canonical({ output: clippedOutput }),
      },
      disposition,
      adjudication: {
        source: classification ? "host" : "protocol",
        summary: classification
          ? classification.outcome === "passed"
            ? "unchanged HEAD-owned tracked repository test passed"
            : classification.outcome === "code_failed"
              ? "unchanged HEAD-owned tracked repository test exposed a local-authority code regression"
              : `tracked repository test did not produce a code verdict (${classification.failureKind ?? "harness_failed"})`
          : "completed probe requires evidence adjudication",
        evidenceRefs:
          classification?.outcome === "code_failed" ||
          classification?.outcome === "passed"
            ? probe.groundingRefs
            : [],
      },
    });
  }
  return results;
}

function trustedRepositoryTestInvocationV2(
  workspaceRoot: string,
  command: string,
  repositoryPath: string,
): ReturnType<typeof analyzeVerificationInvocation> {
  if (
    !repositoryPath.trim() ||
    path.isAbsolute(repositoryPath) ||
    repositoryPath.split(/[\\/]/).includes("..")
  )
    return undefined;
  const chain = parseCommandChain(command);
  const invocation = analyzeVerificationInvocation(command);
  if (
    !chain ||
    chain.length !== 1 ||
    !invocation?.exitStatusReliable ||
    !invocationTargetsOnlyRepositoryPathV2(invocation, repositoryPath)
  )
    return undefined;
  const headOwned = spawnSync(
    "git",
    ["cat-file", "-e", `HEAD:${repositoryPath}`],
    {
      cwd: workspaceRoot,
      encoding: "utf8",
      windowsHide: true,
    },
  );
  if (headOwned.status !== 0) return undefined;
  const worktreeUnchanged = spawnSync(
    "git",
    ["diff", "--quiet", "HEAD", "--", repositoryPath],
    { cwd: workspaceRoot, windowsHide: true },
  );
  const indexUnchanged = spawnSync(
    "git",
    ["diff", "--cached", "--quiet", "HEAD", "--", repositoryPath],
    { cwd: workspaceRoot, windowsHide: true },
  );
  return worktreeUnchanged.status === 0 && indexUnchanged.status === 0
    ? invocation
    : undefined;
}

function invocationTargetsOnlyRepositoryPathV2(
  invocation: NonNullable<ReturnType<typeof analyzeVerificationInvocation>>,
  repositoryPath: string,
): boolean {
  const normalizeTarget = (argument: string) =>
    argument.replace(/\\/g, "/").replace(/^\.\//, "");
  const matchesTarget = (argument: string) => {
    const normalized = normalizeTarget(argument);
    return (
      normalized === repositoryPath ||
      normalized.startsWith(`${repositoryPath}::`)
    );
  };
  if (invocation.family === "node") {
    const executable = path.basename(invocation.argv[0] ?? "").toLowerCase();
    return (
      /^(?:node|node\.exe)$/.test(executable) &&
      invocation.argv.length === 2 &&
      !!invocation.argv[1] &&
      matchesTarget(invocation.argv[1])
    );
  }
  if (invocation.family !== "pytest") return false;
  const argv = invocation.argv;
  const executable = path.basename(argv[0] ?? "").toLowerCase();
  let runnerArgs: readonly string[];
  if (/^pytest(?:\.exe)?$/.test(executable)) {
    runnerArgs = argv.slice(1);
  } else {
    const moduleIndex = argv.findIndex((argument) => argument === "-m");
    if (moduleIndex < 0 || argv[moduleIndex + 1]?.toLowerCase() !== "pytest")
      return false;
    runnerArgs = argv.slice(moduleIndex + 2);
  }
  // Pytest options can change semantics (`--runxfail`, `-Werror`, plugins).
  // Rather than maintaining a fragile allowlist, host authority accepts only
  // one bare selector. Rich invocations still execute, but the adjudicator owns
  // their disposition.
  return (
    runnerArgs.length === 1 && !!runnerArgs[0] && matchesTarget(runnerArgs[0])
  );
}

function buildProbeAdjudicationPromptV2(input: {
  readonly goal: string;
  readonly diff: string;
  readonly verificationAuthority: "local" | "external" | "not_required";
  readonly probes: readonly VerificationProbeResultV1[];
  readonly knownEvidenceRefs: readonly string[];
}): string {
  return [
    "You are a read-only verification-probe adjudicator. The probe planner and implementing agent are untrusted. Classify only the supplied execution facts against the visible task, terminal diff, repository-test identities, rationale, and oracle.",
    "A non-zero exit code is not automatically a candidate defect: an invented API, wrong invocation, obsolete base-checkout expectation, environment failure, or weak delimiter/counting oracle is invalid, environmental, or inconclusive.",
    input.verificationAuthority === "external"
      ? "Verification authority is external. Local/base-checkout failures are diagnostic, not final acceptance authority. Mark candidate_defect only when the visible task or terminal diff independently grounds the failed behavior."
      : "Verification authority is local. Host-classified tracked repository tests are already settled; adjudicate only the remaining inline or ambiguous probes.",
    "candidate_defect requires a completed non-zero execution plus concrete supplied evidence. pass requires a completed zero exit and a valid behavioral oracle. Unknown evidence references, malformed output, or insufficient evidence must become inconclusive.",
    "",
    "## Task goal (task_goal)",
    input.goal.slice(0, 4_000),
    "",
    "## Terminal diff (terminal_diff)",
    input.diff.slice(0, DIFF_BUDGET_CHARS),
    "",
    "## Known evidence references",
    input.knownEvidenceRefs.join("\n") || "(none)",
    "",
    "## Probe execution facts",
    JSON.stringify(
      input.probes.map((probe) => ({
        probeId: probe.probeId,
        plan: probe.plan,
        execution: probe.execution,
      })),
    ),
    "",
    'Return ONLY JSON: {"dispositions":[{"probeId":"probe_1","disposition":"pass|candidate_defect|invalid_probe|environment_error|inconclusive","summary":"short evidence-grounded reason","evidenceRefs":["task_goal","terminal_diff","repository_test:<path>"]}]}',
  ].join("\n");
}

function applyProbeAdjudicationV2(input: {
  readonly content: string;
  readonly probes: readonly VerificationProbeResultV1[];
  readonly knownEvidenceRefs: readonly string[];
}): readonly VerificationProbeResultV1[] {
  const start = input.content.indexOf("{");
  const end = input.content.lastIndexOf("}");
  let dispositions: unknown;
  try {
    const parsed =
      start >= 0 && end > start
        ? JSON.parse(input.content.slice(start, end + 1))
        : undefined;
    dispositions = (parsed as { dispositions?: unknown } | undefined)
      ?.dispositions;
  } catch {
    dispositions = undefined;
  }
  const rows = Array.isArray(dispositions) ? dispositions : [];
  const knownRefs = new Set(input.knownEvidenceRefs);
  const byProbe = new Map<string, unknown>();
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const probeId = (row as { probeId?: unknown }).probeId;
    if (typeof probeId !== "string" || byProbe.has(probeId)) continue;
    byProbe.set(probeId, row);
  }
  return input.probes.map((probe) => {
    if (probe.disposition !== "inconclusive") return probe;
    const row = byProbe.get(probe.probeId);
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      return inconclusiveProbeV2(
        probe,
        "adjudicator omitted or malformed this probe",
      );
    }
    const disposition = (row as { disposition?: unknown }).disposition;
    const summary = (row as { summary?: unknown }).summary;
    const evidenceRefs = (row as { evidenceRefs?: unknown }).evidenceRefs;
    const validDisposition = [
      "pass",
      "candidate_defect",
      "invalid_probe",
      "environment_error",
      "inconclusive",
    ].includes(String(disposition));
    const validRefs =
      Array.isArray(evidenceRefs) &&
      evidenceRefs.every(
        (reference) =>
          typeof reference === "string" &&
          knownRefs.has(reference) &&
          probe.plan.groundingRefs.includes(reference),
      );
    const exitCode = probe.execution.exitCode;
    const dispositionMatchesExecution =
      (disposition !== "candidate_defect" ||
        (probe.execution.status === "completed" &&
          typeof exitCode === "number" &&
          exitCode !== 0 &&
          Array.isArray(evidenceRefs) &&
          evidenceRefs.some(
            (reference) =>
              reference === "task_goal" || reference === "terminal_diff",
          ))) &&
      (disposition !== "pass" ||
        (probe.execution.status === "completed" && exitCode === 0)) &&
      (disposition !== "environment_error" ||
        (probe.execution.status === "completed" &&
          typeof exitCode === "number" &&
          exitCode !== 0));
    if (
      !validDisposition ||
      typeof summary !== "string" ||
      !summary.trim() ||
      !validRefs ||
      !dispositionMatchesExecution
    ) {
      return inconclusiveProbeV2(
        probe,
        "adjudicator result was ungrounded or inconsistent with execution",
      );
    }
    return {
      ...probe,
      disposition: disposition as VerificationProbeDispositionV2,
      adjudication: {
        source: "model",
        summary: summary.trim().slice(0, 1_000),
        evidenceRefs: evidenceRefs as readonly string[],
      },
    };
  });
}

function inconclusiveProbeV2(
  probe: VerificationProbeResultV1,
  summary: string,
): VerificationProbeResultV1 {
  return {
    ...probe,
    disposition: "inconclusive",
    adjudication: {
      source: "protocol",
      summary,
      evidenceRefs: [],
    },
  };
}

function sumProbeUsageV2(
  usages: readonly (ModelTokenUsage | undefined)[],
): ModelTokenUsage | undefined {
  const present = usages.filter(
    (usage): usage is ModelTokenUsage => usage !== undefined,
  );
  if (present.length === 0) return undefined;
  const sum = (field: keyof ModelTokenUsage) =>
    present.reduce((total, usage) => total + (usage[field] ?? 0), 0);
  return {
    promptTokens: sum("promptTokens"),
    completionTokens: sum("completionTokens"),
    totalTokens: sum("totalTokens"),
    cachedPromptTokens: sum("cachedPromptTokens"),
  };
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
  if (input.result.verdict === "interrupted" || input.result.interrupted) {
    const message = [
      `[LoopV2Probe:interrupted key=${key}]`,
      "The host found a durable verification-probe claim without a settled result. The prior probe may already have executed model or shell work, so it will not be run again.",
      "Treat this candidate as not certified. Do not repeat the same probe transaction or make an unrelated code change merely to reset it; end honestly as incomplete if the result cannot be recovered.",
    ].join("\n");
    return input.noRoomForAnotherTurn
      ? { type: "incomplete", key, message, reason: "no_turn_budget" }
      : { type: "feedback", key, message };
  }
  if (input.result.verdict !== "candidate_defect") {
    // clear/inconclusive 都不冒充代码缺陷；终局权威仍由 reducer/external
    // verifier 持有，后续切片会把结构化 probe fact 纳入该 reducer。
    return {
      type: "accept",
      key,
      message: "",
    };
  }
  const failures = input.result.probes
    .filter((probe) => probe.disposition === "candidate_defect")
    .map(
      (probe, index) =>
        `${index + 1}. command: ${probe.plan.command}\n   oracle: ${probe.plan.oracle}\n   evidence: ${probe.adjudication.evidenceRefs.join(", ") || "(none)"}\n   reason: ${probe.adjudication.summary}\n   output: ${probe.execution.output.slice(0, 600) || "(no output)"}`,
    )
    .join("\n");
  const message = [
    `[LoopV2Probe:fail key=${key}]`,
    "An adversarial verification probe produced an evidence-grounded candidate defect. The candidate is not certified.",
    "Candidate-defect probe(s):",
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

interface ProbeRecordV2 {
  readonly schemaVersion: 2;
  readonly kind: "paw.loop-v2-verification-probe";
  readonly policyVersion: typeof PROBE_POLICY_VERSION;
  readonly verificationAuthority: "local" | "external" | "not_required";
  readonly candidateInputHash: string;
  readonly mutationRevision: number;
  readonly result: VerificationProbeOnceResultV2;
}

interface ProbeClaimV2 {
  readonly schemaVersion: 2;
  readonly kind: "paw.loop-v2-verification-probe-claim";
  readonly policyVersion: typeof PROBE_POLICY_VERSION;
  readonly verificationAuthority: "local" | "external" | "not_required";
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
    "verification-probe-v2.json",
  );
}

function probeClaimPath(workspaceRoot: string, runId: string): string {
  return path.join(
    path.dirname(probeRecordPath(workspaceRoot, runId)),
    "verification-probe-claim-v2.json",
  );
}

function legacyProbeRecordPath(workspaceRoot: string, runId: string): string {
  return path.join(
    path.dirname(probeRecordPath(workspaceRoot, runId)),
    "verification-probe-v1.json",
  );
}

function legacyProbeClaimPath(workspaceRoot: string, runId: string): string {
  return path.join(
    path.dirname(probeRecordPath(workspaceRoot, runId)),
    "verification-probe-claim-v1.json",
  );
}

function migrateLegacyProbeRecordV1(input: {
  readonly value: unknown;
  readonly candidateInputHash: string;
  readonly mutationRevision: number;
}): VerificationProbeOnceResultV2 | undefined {
  if (
    !input.value ||
    typeof input.value !== "object" ||
    Array.isArray(input.value)
  )
    return undefined;
  const record = input.value as {
    schemaVersion?: unknown;
    kind?: unknown;
    candidateInputHash?: unknown;
    mutationRevision?: unknown;
    result?: unknown;
  };
  const result = record.result as
    | {
        candidateInputHash?: unknown;
        mutationRevision?: unknown;
        probes?: unknown;
        verdict?: unknown;
      }
    | undefined;
  if (
    record.schemaVersion !== 1 ||
    record.kind !== "paw.loop-v2-verification-probe" ||
    typeof record.candidateInputHash !== "string" ||
    !Number.isSafeInteger(record.mutationRevision) ||
    !result ||
    result.candidateInputHash !== record.candidateInputHash ||
    result.mutationRevision !== record.mutationRevision ||
    !["pass", "fail", "error"].includes(String(result.verdict)) ||
    !Array.isArray(result.probes) ||
    !(
      record.candidateInputHash === input.candidateInputHash ||
      record.mutationRevision === input.mutationRevision
    )
  )
    return undefined;
  const migrated: VerificationProbeResultV1[] = [];
  for (const [index, raw] of result.probes.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const legacy = raw as {
      command?: unknown;
      status?: unknown;
      exitCode?: unknown;
      output?: unknown;
    };
    if (
      typeof legacy.command !== "string" ||
      !legacy.command.trim() ||
      !["pass", "fail", "error"].includes(String(legacy.status)) ||
      (legacy.exitCode !== undefined &&
        !Number.isSafeInteger(legacy.exitCode)) ||
      typeof legacy.output !== "string"
    )
      return undefined;
    const probeId = `legacy_probe_${index + 1}`;
    const disposition: VerificationProbeDispositionV2 =
      legacy.status === "pass"
        ? "pass"
        : legacy.status === "error"
          ? "environment_error"
          : "inconclusive";
    migrated.push({
      probeId,
      plan: {
        probeId,
        command: legacy.command,
        rationale: "legacy v1 probe rationale was not persisted",
        oracle: "legacy v1 probe oracle was not persisted",
        kind: "inline_contract",
        groundingRefs: [],
      },
      execution: {
        status: legacy.status === "error" ? "environment_error" : "completed",
        ...(typeof legacy.exitCode === "number"
          ? { exitCode: legacy.exitCode }
          : {}),
        output: legacy.output,
        outputHash: sha256Canonical({ output: legacy.output }),
      },
      disposition,
      adjudication: {
        source: "legacy",
        summary:
          legacy.status === "fail"
            ? "legacy v1 non-zero result has no durable oracle or grounding and cannot be upgraded to candidate_defect"
            : "legacy v1 result migrated without re-executing model or shell",
        evidenceRefs: [],
      },
    });
  }
  const verdict =
    result.verdict === "pass" &&
    migrated.every((probe) => probe.disposition === "pass")
      ? "clear"
      : "inconclusive";
  return {
    candidateInputHash: input.candidateInputHash,
    mutationRevision: input.mutationRevision,
    probes: migrated,
    verdict,
    note: "migrated legacy v1 probe record without replay; old failures are unclassified, not candidate defects",
    modelCalls: 0,
  };
}

function parseLegacyProbeClaimV1(
  value: unknown,
):
  | Readonly<{ candidateInputHash: string; mutationRevision: number }>
  | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const claim = value as {
    schemaVersion?: unknown;
    kind?: unknown;
    candidateInputHash?: unknown;
    mutationRevision?: unknown;
    claimKey?: unknown;
  };
  if (
    claim.schemaVersion !== 1 ||
    claim.kind !== "paw.loop-v2-verification-probe-claim" ||
    typeof claim.candidateInputHash !== "string" ||
    !claim.candidateInputHash.trim() ||
    !Number.isSafeInteger(claim.mutationRevision) ||
    (claim.mutationRevision as number) < 0 ||
    claim.claimKey !==
      sha256Canonical({
        policy: "paw.loop-v2-verification-probe-v1",
        candidateInputHash: claim.candidateInputHash,
        mutationRevision: claim.mutationRevision,
      })
  )
    return undefined;
  return {
    candidateInputHash: claim.candidateInputHash,
    mutationRevision: claim.mutationRevision as number,
  };
}

function parseProbeRecordV2(value: unknown): ProbeRecordV2 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const record = value as Partial<ProbeRecordV2>;
  const result = record.result;
  if (
    record.schemaVersion !== 2 ||
    record.kind !== "paw.loop-v2-verification-probe" ||
    record.policyVersion !== PROBE_POLICY_VERSION ||
    !["local", "external", "not_required"].includes(
      String(record.verificationAuthority),
    ) ||
    typeof record.candidateInputHash !== "string" ||
    !record.candidateInputHash.trim() ||
    !Number.isSafeInteger(record.mutationRevision) ||
    (record.mutationRevision ?? -1) < 0 ||
    !result ||
    result.candidateInputHash !== record.candidateInputHash ||
    result.mutationRevision !== record.mutationRevision ||
    !["clear", "candidate_defect", "inconclusive", "interrupted"].includes(
      result.verdict,
    ) ||
    !Array.isArray(result.probes) ||
    !result.probes.every(isVerificationProbeResultV2) ||
    !Number.isSafeInteger(result.modelCalls) ||
    result.modelCalls < 0 ||
    (result.interrupted !== undefined && result.interrupted !== true) ||
    (result.interrupted === true &&
      (result.verdict !== "interrupted" ||
        result.modelCalls !== 0 ||
        result.probes.length !== 0 ||
        result.plannerDiagnostics !== undefined)) ||
    (!result.interrupted &&
      !isProbePlannerDiagnosticsV3(result.plannerDiagnostics)) ||
    (!result.interrupted &&
      result.verdict !==
        (result.probes.some((probe) => probe.disposition === "candidate_defect")
          ? "candidate_defect"
          : result.probes.some((probe) =>
                ["invalid_probe", "environment_error", "inconclusive"].includes(
                  probe.disposition,
                ),
              ) || result.probes.length === 0
            ? "inconclusive"
            : "clear"))
  )
    return undefined;
  return record as ProbeRecordV2;
}

function parseProbeClaimV2(value: unknown): ProbeClaimV2 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const claim = value as Partial<ProbeClaimV2>;
  if (
    claim.schemaVersion !== 2 ||
    claim.kind !== "paw.loop-v2-verification-probe-claim" ||
    claim.policyVersion !== PROBE_POLICY_VERSION ||
    !["local", "external", "not_required"].includes(
      String(claim.verificationAuthority),
    ) ||
    typeof claim.candidateInputHash !== "string" ||
    !claim.candidateInputHash.trim() ||
    !Number.isSafeInteger(claim.mutationRevision) ||
    (claim.mutationRevision ?? -1) < 0 ||
    typeof claim.claimKey !== "string" ||
    claim.claimKey !==
      sha256Canonical({
        policy: PROBE_POLICY_VERSION,
        verificationAuthority: claim.verificationAuthority,
        candidateInputHash: claim.candidateInputHash,
        mutationRevision: claim.mutationRevision,
      })
  )
    return undefined;
  return claim as ProbeClaimV2;
}

function isVerificationProbeResultV2(
  value: unknown,
): value is VerificationProbeResultV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const probe = value as Partial<VerificationProbeResultV1>;
  const plan = probe.plan;
  const execution = probe.execution;
  const adjudication = probe.adjudication;
  if (
    typeof probe.probeId !== "string" ||
    !probe.probeId.trim() ||
    !plan ||
    plan.probeId !== probe.probeId ||
    typeof plan.command !== "string" ||
    !plan.command.trim() ||
    plan.command.length > PROBE_COMMAND_CHARS ||
    typeof plan.rationale !== "string" ||
    !plan.rationale.trim() ||
    plan.rationale.length > PROBE_RATIONALE_CHARS ||
    typeof plan.oracle !== "string" ||
    !plan.oracle.trim() ||
    plan.oracle.length > PROBE_ORACLE_CHARS ||
    !["repository_test", "inline_contract"].includes(plan.kind) ||
    !Array.isArray(plan.groundingRefs) ||
    plan.groundingRefs.length > PROBE_MAX_GROUNDING_REFS ||
    !plan.groundingRefs.every(
      (reference) => typeof reference === "string" && reference.trim(),
    ) ||
    !execution ||
    !["not_run", "completed", "environment_error"].includes(execution.status) ||
    (execution.exitCode !== undefined &&
      !Number.isSafeInteger(execution.exitCode)) ||
    typeof execution.output !== "string" ||
    execution.outputHash !== sha256Canonical({ output: execution.output }) ||
    ![
      "pass",
      "candidate_defect",
      "invalid_probe",
      "environment_error",
      "inconclusive",
    ].includes(String(probe.disposition)) ||
    !adjudication ||
    !["host", "model", "protocol", "legacy"].includes(adjudication.source) ||
    typeof adjudication.summary !== "string" ||
    !adjudication.summary.trim() ||
    !Array.isArray(adjudication.evidenceRefs) ||
    !adjudication.evidenceRefs.every(
      (reference) =>
        typeof reference === "string" &&
        reference.trim() &&
        plan.groundingRefs.includes(reference),
    )
  )
    return false;
  const exitCode = execution.exitCode;
  if (execution.status === "completed" && !Number.isSafeInteger(exitCode))
    return false;
  if (execution.status !== "completed" && exitCode !== undefined) return false;
  if (
    probe.disposition === "pass" &&
    !(execution.status === "completed" && exitCode === 0)
  )
    return false;
  if (
    probe.disposition === "candidate_defect" &&
    !(
      execution.status === "completed" &&
      typeof exitCode === "number" &&
      exitCode !== 0 &&
      adjudication.evidenceRefs.length > 0 &&
      (adjudication.source === "host"
        ? plan.kind === "repository_test" &&
          adjudication.evidenceRefs.some((reference) =>
            reference.startsWith("repository_test:"),
          )
        : adjudication.source === "model" &&
          adjudication.evidenceRefs.some(
            (reference) =>
              reference === "task_goal" || reference === "terminal_diff",
          ))
    )
  )
    return false;
  if (
    probe.disposition === "environment_error" &&
    !(
      execution.status === "environment_error" ||
      (execution.status === "completed" &&
        typeof exitCode === "number" &&
        exitCode !== 0 &&
        (adjudication.source === "host" || adjudication.source === "model"))
    )
  )
    return false;
  if (execution.status === "not_run" && probe.disposition !== "invalid_probe")
    return false;
  return true;
}

function buildProbePlannerDiagnosticsV3(input: {
  readonly prompt: string;
  readonly text: string;
  readonly thinking?: string;
  readonly finishReason?: string;
}): ProbePlannerDiagnosticsV3 {
  const thinking = input.thinking ?? "";
  const withoutHash = {
    policyVersion: PROBE_POLICY_VERSION,
    finishReason: input.finishReason?.trim() || "unknown",
    promptChars: input.prompt.length,
    promptHash: sha256Canonical({ content: input.prompt }),
    visibleChars: input.text.length,
    visibleHash: sha256Canonical({ content: input.text }),
    thinkingChars: thinking.length,
    thinkingHash: sha256Canonical({ content: thinking }),
  };
  return {
    ...withoutHash,
    diagnosticsHash: sha256Canonical(withoutHash),
  };
}

function isProbePlannerDiagnosticsV3(
  value: unknown,
): value is ProbePlannerDiagnosticsV3 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const diagnostics = value as Partial<ProbePlannerDiagnosticsV3>;
  const withoutHash = {
    policyVersion: diagnostics.policyVersion,
    finishReason: diagnostics.finishReason,
    promptChars: diagnostics.promptChars,
    promptHash: diagnostics.promptHash,
    visibleChars: diagnostics.visibleChars,
    visibleHash: diagnostics.visibleHash,
    thinkingChars: diagnostics.thinkingChars,
    thinkingHash: diagnostics.thinkingHash,
  };
  return (
    diagnostics.policyVersion === PROBE_POLICY_VERSION &&
    typeof diagnostics.finishReason === "string" &&
    diagnostics.finishReason.trim().length > 0 &&
    Number.isSafeInteger(diagnostics.promptChars) &&
    (diagnostics.promptChars ?? -1) >= 0 &&
    typeof diagnostics.promptHash === "string" &&
    diagnostics.promptHash.length === 64 &&
    Number.isSafeInteger(diagnostics.visibleChars) &&
    (diagnostics.visibleChars ?? -1) >= 0 &&
    typeof diagnostics.visibleHash === "string" &&
    diagnostics.visibleHash.length === 64 &&
    Number.isSafeInteger(diagnostics.thinkingChars) &&
    (diagnostics.thinkingChars ?? -1) >= 0 &&
    typeof diagnostics.thinkingHash === "string" &&
    diagnostics.thinkingHash.length === 64 &&
    typeof diagnostics.diagnosticsHash === "string" &&
    diagnostics.diagnosticsHash === sha256Canonical(withoutHash)
  );
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
    verdict: "interrupted",
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
  readonly verificationAuthority?: "local" | "external" | "not_required";
  readonly shellSandbox?: ShellSandboxConfig;
  /** Host-owned dependency seam for deterministic tests; never model input. */
  readonly hostShellRunner?: typeof runShellInWorkspace;
  readonly signal?: AbortSignal;
  readonly onUsage?: (modelLabel: string, usage: ModelTokenUsage) => void;
}): Promise<VerificationProbeOnceResultV2> {
  const recordPath = probeRecordPath(input.workspaceRoot, input.runId);
  const claimPath = probeClaimPath(input.workspaceRoot, input.runId);
  const verificationAuthority = input.verificationAuthority ?? "local";
  const recordRead = readProbeJsonV1(recordPath);
  const existing =
    recordRead.state === "parsed"
      ? parseProbeRecordV2(recordRead.value)
      : undefined;
  if (existing) {
    if (
      existing.verificationAuthority === verificationAuthority &&
      existing.candidateInputHash === input.candidateInputHash &&
      existing.mutationRevision === input.mutationRevision
    ) {
      return { ...existing.result, modelCalls: 0 };
    }
    if (
      existing.verificationAuthority === verificationAuthority &&
      existing.candidateInputHash === input.candidateInputHash &&
      existing.mutationRevision !== input.mutationRevision
    ) {
      return interruptedProbeResultV2({
        candidateInputHash: input.candidateInputHash,
        mutationRevision: input.mutationRevision,
        note: "verification probe candidate hash was reused with a different mutation revision",
      });
    }
    // Candidate identity can change when new evidence is attached without a
    // product mutation. The code under test is unchanged, so reuse the settled
    // probe instead of executing a second model/shell transaction.
    if (
      existing.verificationAuthority === verificationAuthority &&
      existing.mutationRevision === input.mutationRevision
    ) {
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
      ? parseProbeClaimV2(claimRead.value)
      : undefined;
  if (existingClaim) {
    if (
      existingClaim.verificationAuthority === verificationAuthority &&
      (existingClaim.candidateInputHash === input.candidateInputHash ||
        existingClaim.mutationRevision === input.mutationRevision)
    ) {
      return interruptedProbeResultV2({
        candidateInputHash: input.candidateInputHash,
        mutationRevision: input.mutationRevision,
        note: "verification probe interrupted after its durable claim; execution was not repeated",
      });
    }
  }
  if (recordRead.state === "missing" && claimRead.state === "missing") {
    const legacyRecordRead = readProbeJsonV1(
      legacyProbeRecordPath(input.workspaceRoot, input.runId),
    );
    if (legacyRecordRead.state === "parsed") {
      const migrated = migrateLegacyProbeRecordV1({
        value: legacyRecordRead.value,
        candidateInputHash: input.candidateInputHash,
        mutationRevision: input.mutationRevision,
      });
      if (migrated) return migrated;
      const legacyRevision = (
        legacyRecordRead.value as { mutationRevision?: unknown }
      ).mutationRevision;
      if (legacyRevision === input.mutationRevision) {
        return interruptedProbeResultV2({
          candidateInputHash: input.candidateInputHash,
          mutationRevision: input.mutationRevision,
          note: "legacy verification probe record is corrupt; execution was not repeated",
        });
      }
    } else if (legacyRecordRead.state === "corrupt") {
      return interruptedProbeResultV2({
        candidateInputHash: input.candidateInputHash,
        mutationRevision: input.mutationRevision,
        note: "legacy verification probe record is corrupt; execution was not repeated",
      });
    }
    const legacyClaimRead = readProbeJsonV1(
      legacyProbeClaimPath(input.workspaceRoot, input.runId),
    );
    if (legacyClaimRead.state === "parsed") {
      const legacyClaim = parseLegacyProbeClaimV1(legacyClaimRead.value);
      if (!legacyClaim) {
        return interruptedProbeResultV2({
          candidateInputHash: input.candidateInputHash,
          mutationRevision: input.mutationRevision,
          note: "legacy verification probe claim is corrupt; execution was not repeated",
        });
      }
      if (
        legacyClaim.candidateInputHash === input.candidateInputHash ||
        legacyClaim.mutationRevision === input.mutationRevision
      ) {
        return interruptedProbeResultV2({
          candidateInputHash: input.candidateInputHash,
          mutationRevision: input.mutationRevision,
          note: "legacy verification probe claim was not settled; execution was not repeated",
        });
      }
    } else if (legacyClaimRead.state === "corrupt") {
      return interruptedProbeResultV2({
        candidateInputHash: input.candidateInputHash,
        mutationRevision: input.mutationRevision,
        note: "legacy verification probe claim is corrupt; execution was not repeated",
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

  const claim: ProbeClaimV2 = {
    schemaVersion: 2,
    kind: "paw.loop-v2-verification-probe-claim",
    policyVersion: PROBE_POLICY_VERSION,
    verificationAuthority,
    candidateInputHash: input.candidateInputHash,
    mutationRevision: input.mutationRevision,
    claimKey: sha256Canonical({
      policy: PROBE_POLICY_VERSION,
      verificationAuthority,
      candidateInputHash: input.candidateInputHash,
      mutationRevision: input.mutationRevision,
    }),
  };
  atomicWrite(claimPath, JSON.stringify(claim));
  if (!parseProbeClaimV2(JSON.parse(fs.readFileSync(claimPath, "utf8")))) {
    throw new Error("Verification probe claim failed strict reread");
  }

  const plannerPrompt = buildVerificationProbePromptV1({
    goal: input.goal,
    diff: input.diff,
    changedFiles: input.changedFiles,
    ...(input.impactedTests ? { impactedTests: input.impactedTests } : {}),
    extensionPointHints: discoverRepositoryExtensionPointsV1(
      input.workspaceRoot,
      input.changedFiles,
    ),
  });
  const completion = await input.model.complete(
    [
      {
        role: "user",
        content: plannerPrompt,
      },
    ],
    {
      ...(input.signal ? { signal: input.signal } : {}),
      maxOutputTokens: PROBE_PLANNER_MAX_OUTPUT_TOKENS,
      thinkingEnabled: false,
    },
  );
  if (input.onUsage && completion.usage) {
    input.onUsage(input.model.label, completion.usage);
  }
  const plannerTruncated = ["length", "max_tokens"].includes(
    completion.finishReason?.trim().toLowerCase() ?? "",
  );
  const plan = plannerTruncated
    ? []
    : parseVerificationProbePlanV1(completion.text);
  const executed = plannerTruncated
    ? []
    : executeVerificationProbesV1({
        workspaceRoot: input.workspaceRoot,
        ...(input.shellSandbox ? { shellSandbox: input.shellSandbox } : {}),
        ...(input.hostShellRunner
          ? { hostShellRunner: input.hostShellRunner }
          : {}),
        probes: plan,
        ...(input.impactedTests ? { impactedTests: input.impactedTests } : {}),
        changedFiles: input.changedFiles,
        verificationAuthority,
      });
  const pendingAdjudication = executed.filter(
    (probe) => probe.disposition === "inconclusive",
  );
  let adjudicatorUsage: ModelTokenUsage | undefined;
  let probes = executed;
  let modelCalls = 1;
  if (pendingAdjudication.length > 0) {
    const knownEvidenceRefs = [
      "task_goal",
      "terminal_diff",
      ...(input.impactedTests ?? []).map(
        (test) => `repository_test:${test.replace(/\\/g, "/")}`,
      ),
    ];
    const adjudication = await input.model.complete(
      [
        {
          role: "user",
          content: buildProbeAdjudicationPromptV2({
            goal: input.goal,
            diff: input.diff,
            verificationAuthority,
            probes: pendingAdjudication,
            knownEvidenceRefs,
          }),
        },
      ],
      {
        ...(input.signal ? { signal: input.signal } : {}),
        maxOutputTokens: PROBE_ADJUDICATOR_MAX_OUTPUT_TOKENS,
        thinkingEnabled: false,
      },
    );
    modelCalls += 1;
    adjudicatorUsage = adjudication.usage;
    if (input.onUsage && adjudication.usage) {
      input.onUsage(input.model.label, adjudication.usage);
    }
    const adjudicatorTruncated = ["length", "max_tokens"].includes(
      adjudication.finishReason?.trim().toLowerCase() ?? "",
    );
    const adjudicatedPending = adjudicatorTruncated
      ? pendingAdjudication.map((probe) =>
          inconclusiveProbeV2(probe, "probe adjudicator output was truncated"),
        )
      : applyProbeAdjudicationV2({
          content: adjudication.text,
          probes: pendingAdjudication,
          knownEvidenceRefs,
        });
    const byId = new Map(
      adjudicatedPending.map((probe) => [probe.probeId, probe]),
    );
    probes = executed.map((probe) => byId.get(probe.probeId) ?? probe);
  }
  const candidateDefect = probes.some(
    (probe) => probe.disposition === "candidate_defect",
  );
  const inconclusive =
    probes.length === 0 ||
    probes.some((probe) =>
      ["invalid_probe", "environment_error", "inconclusive"].includes(
        probe.disposition,
      ),
    );
  const usage = sumProbeUsageV2([completion.usage, adjudicatorUsage]);
  const plannerDiagnostics = buildProbePlannerDiagnosticsV3({
    prompt: plannerPrompt,
    text: completion.text,
    ...(completion.thinking !== undefined
      ? { thinking: completion.thinking }
      : {}),
    ...(completion.finishReason !== undefined
      ? { finishReason: completion.finishReason }
      : {}),
  });
  const result: VerificationProbeOnceResultV2 = {
    candidateInputHash: input.candidateInputHash,
    mutationRevision: input.mutationRevision,
    probes,
    verdict: candidateDefect
      ? "candidate_defect"
      : inconclusive
        ? "inconclusive"
        : "clear",
    ...(probes.length === 0
      ? {
          note: plannerTruncated
            ? "probe planner output was truncated; no shell command executed"
            : "probe planner returned no valid executable probes",
        }
      : {}),
    modelCalls,
    plannerDiagnostics,
    ...(usage ? { usage } : {}),
  };
  // Once claimed, every outcome is settled atomically. Retrying an environment
  // error would repeat model/shell side effects after a crash and is therefore
  // less honest than preserving the explicit error fact for this revision.
  const record: ProbeRecordV2 = {
    schemaVersion: 2,
    kind: "paw.loop-v2-verification-probe",
    policyVersion: PROBE_POLICY_VERSION,
    verificationAuthority,
    candidateInputHash: input.candidateInputHash,
    mutationRevision: input.mutationRevision,
    result,
  };
  atomicWrite(recordPath, JSON.stringify(record));
  const settled = parseProbeRecordV2(
    JSON.parse(fs.readFileSync(recordPath, "utf8")),
  );
  if (!settled) {
    throw new Error("Verification probe record failed strict reread");
  }
  return settled.result;
}
