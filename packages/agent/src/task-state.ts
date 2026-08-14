import type {
  AgentAcceptanceUpdateAction,
  AgentToolCallAction,
} from "@paw/core";
import type { ToolRunResult } from "@paw/harness";
import { isControlPlaneToolResult } from "./lifecycle/control-plane.js";
import { isGitDiffCommand } from "./shell-command.js";
import {
  type VerificationCommandIntent,
  analyzeVerificationCommand,
  isVerificationCommand,
} from "./verification-command.js";

export { isVerificationCommand };

export interface CommandSummary {
  readonly command: string;
  readonly cwd?: string;
  readonly ok: boolean;
  readonly summary: string;
}

export interface TestResultSummary {
  readonly command: string;
  /** Parsed runner family retained as verification-scope metadata. */
  readonly family?: VerificationCommandIntent["family"];
  readonly passed: boolean;
  /** Structured result; absent on legacy snapshots and derived from passed. */
  readonly outcome?: "passed" | "code_failed" | "harness_failed";
  /** Machine-readable reason for a failed verification classification. */
  readonly failureKind?:
    | "missing_dependency"
    | "environment_setup"
    | "runner_unavailable"
    | "test_discovery"
    | "invocation_error"
    | "untrusted_exit_status"
    | "test_failure";
  /** Harness-only recovery state; absent on passes, code failures, and legacy snapshots. */
  readonly retryability?: "retryable" | "terminal";
  readonly summary: string;
  /** Short redacted diagnostic retained after the full tool payload is pruned. */
  readonly evidence?: string;
  /** Monotonic shell-command revision when this verification was recorded. */
  readonly shellCommandRevision?: number;
  /** 文件最近一次变更的版本；用于拒绝“改代码前跑过的旧绿测”。 */
  readonly mutationRevision?: number;
}

/**
 * 约束生命周期记录（Constraint Lifecycle）：
 * - active：当前有效（注入 [Constraints] 段，摘要逐字校验）
 * - superseded：被用户新指令覆盖/反转（"改用 Y" 覆盖 "不要用 X"）
 * - expired：过期（用户撤销 / 新任务转向 / 长时间无提及，由 LLM 调和判定）
 *
 * 判定由 LLM 调和（constraint-reconcile.ts）负责，harness 规则只决定
 * "什么时候该问"（新用户消息/15 轮强制/任务转向），不做语义判定。
 */
export interface ConstraintRecord {
  /** 约束原文（verbatim，不得改写） */
  readonly text: string;
  /** 首次提出的轮次（0-based） */
  readonly sourceTurn: number;
  readonly status: "active" | "superseded" | "expired";
}

export type AcceptanceCriterionStatus =
  | "pending"
  | "satisfied"
  | "blocked"
  | "superseded";

export interface AcceptanceCriterion {
  /** Stable within one task snapshot and across resume. */
  readonly id: string;
  /** Concise observable behavior or regression condition. */
  readonly text: string;
  readonly source: {
    readonly kind: "user" | "repository" | "verification";
    readonly turn: number;
    /** File, test, command, or user-message label that exposed the condition. */
    readonly ref?: string;
  };
  readonly status: AcceptanceCriterionStatus;
  /** Who is trusted to produce final verification for this condition. */
  readonly verificationAuthority?: "agent" | "external";
  /** Required for satisfied; optional diagnostic for blocked. */
  readonly evidence?: string;
  /** Source revision against which satisfied evidence was obtained. */
  readonly evidenceMutationRevision?: number;
}

export interface CandidateReviewRecord {
  readonly mutationRevision: number;
  readonly verdict: "pass" | "fail" | "partial";
  /** Independent judgment of the proposed final summary's factual grounding. */
  readonly reportGrounding?: "pass" | "fail" | "unknown";
  /** Stable digest of the exact proposed summary reviewed on this source revision. */
  readonly summaryFingerprint?: string;
  readonly summary: string;
  readonly reviewedAt: number;
}

export interface TaskState {
  readonly goal: string;
  readonly constraints: readonly ConstraintRecord[];
  /** Durable acceptance ledger; absent in legacy snapshots and restored as empty. */
  readonly acceptanceCriteria?: readonly AcceptanceCriterion[];
  readonly plan: readonly string[];
  readonly filesRead: readonly string[];
  /** Successful exact reads by normalized path; absent in legacy snapshots. */
  readonly fileReadCounts?: Readonly<Record<string, number>>;
  readonly filesChanged: readonly string[];
  readonly commandsRun: readonly CommandSummary[];
  readonly testResults: readonly TestResultSummary[];
  /** Monotonic count of recorded shell commands; unlike commandsRun it is never truncated. */
  readonly shellCommandRevision?: number;
  /** 每次成功写文件/应用 patch 单调递增；旧快照缺省为 0。 */
  readonly mutationRevision?: number;
  /** Shell-command revision at the most recent successful source mutation. */
  readonly mutationShellCommandRevision?: number;
  /** Failed exact-edit target eligible for one policy-safe recovery read. */
  readonly editRecoveryPath?: string;
  /** 最近一次成功检查最终 diff 时对应的文件变更版本。 */
  readonly diffInspectedRevision?: number;
  /** Independent semantic review, valid only for its exact mutation revision. */
  readonly candidateReview?: CandidateReviewRecord;
  readonly fileLockConflicts: readonly string[];
  readonly currentHypothesis?: string;
  readonly rejectedHypotheses: readonly string[];
  readonly pinnedFacts: readonly string[];
  readonly knownNonGoals: readonly string[];
  readonly nextStep?: string;
  readonly updatedAt: number;
}

export class TaskStateManager {
  private state: TaskState;

  constructor(goal: string, restored?: unknown) {
    if (isTaskState(restored)) {
      this.state = {
        ...restored,
        acceptanceCriteria: Array.isArray(restored.acceptanceCriteria)
          ? restored.acceptanceCriteria
          : [],
        fileLockConflicts: Array.isArray(restored.fileLockConflicts)
          ? restored.fileLockConflicts
          : [],
      };
    } else {
      this.state = {
        goal,
        constraints: extractConstraints(goal).map((text) => ({
          text,
          sourceTurn: 0,
          status: "active" as const,
        })),
        acceptanceCriteria: [],
        plan: [],
        filesRead: [],
        fileReadCounts: {},
        filesChanged: [],
        commandsRun: [],
        testResults: [],
        shellCommandRevision: 0,
        mutationRevision: 0,
        mutationShellCommandRevision: 0,
        diffInspectedRevision: 0,
        fileLockConflicts: [],
        rejectedHypotheses: [],
        pinnedFacts: [],
        knownNonGoals: [],
        updatedAt: Date.now(),
      };
    }
  }

  snapshot(): TaskState {
    return this.state;
  }

  recordFileLockConflict(path: string): void {
    const p = path.trim();
    if (!p) return;
    if (this.state.fileLockConflicts.includes(p)) return;
    this.state = {
      ...this.state,
      fileLockConflicts: [...this.state.fileLockConflicts, p].slice(-20),
      pinnedFacts: [
        ...this.state.pinnedFacts,
        `file_lock_conflict: ${p}`,
      ].slice(-20),
      updatedAt: Date.now(),
    };
  }

  /** 当前有效的约束（active）——红线区/摘要校验的唯一来源 */
  activeConstraints(): readonly ConstraintRecord[] {
    return this.state.constraints.filter((c) => c.status === "active");
  }

  acceptanceCriteria(): readonly AcceptanceCriterion[] {
    return this.state.acceptanceCriteria ?? [];
  }

  /** Apply one ledger transaction without partial writes on invalid ids. */
  applyAcceptanceUpdate(
    input: Omit<AgentAcceptanceUpdateAction, "type">,
    currentTurn: number,
  ):
    | { readonly ok: true; readonly state: unknown }
    | { readonly ok: false; readonly error: string } {
    const knownIds = new Set(
      this.acceptanceCriteria().map((criterion) => criterion.id),
    );
    const unknown = input.updates.find((update) => !knownIds.has(update.id));
    if (unknown) {
      return {
        ok: false,
        error: `Unknown criterion id ${unknown.id}. Read Acceptance criteria in Current State and retry with an existing id.`,
      };
    }
    const external = input.updates.find((update) =>
      this.acceptanceCriteria().some(
        (criterion) =>
          criterion.id === update.id &&
          criterion.verificationAuthority === "external",
      ),
    );
    if (external) {
      return {
        ok: false,
        error: `Criterion ${external.id} is owned by a trusted external verifier and cannot be resolved by the model.`,
      };
    }
    const evidenceFree = input.updates.find(
      (update) => update.status === "satisfied" && !update.evidence?.trim(),
    );
    if (evidenceFree) {
      return {
        ok: false,
        error: `Criterion ${evidenceFree.id} cannot be satisfied without concrete evidence.`,
      };
    }
    this.registerAcceptanceCriteria(input.add, currentTurn);
    for (const update of input.updates) {
      this.setAcceptanceCriterionStatus(
        update.id,
        update.status,
        update.evidence,
      );
    }
    return {
      ok: true,
      state: { criteria: acceptanceReadiness(this.snapshot()) },
    };
  }

  registerAcceptanceCriteria(
    items: readonly {
      readonly text: string;
      readonly source: AcceptanceCriterion["source"]["kind"];
      readonly ref?: string;
      readonly verificationAuthority?: "agent" | "external";
    }[],
    currentTurn: number,
  ): void {
    const criteria = [...this.acceptanceCriteria()];
    let nextId = nextAcceptanceCriterionId(criteria);
    let changed = false;
    for (const item of items) {
      const text = normalizeAcceptanceText(item.text);
      if (!text) continue;
      const duplicate = criteria.some(
        (criterion) =>
          criterion.status !== "superseded" &&
          normalizeAcceptanceText(criterion.text).toLocaleLowerCase() ===
            text.toLocaleLowerCase(),
      );
      if (duplicate) continue;
      const ref = normalizeAcceptanceEvidence(item.ref);
      criteria.push({
        id: `acceptance-${String(nextId).padStart(3, "0")}`,
        text,
        source: {
          kind: item.source,
          turn: currentTurn,
          ...(ref ? { ref } : {}),
        },
        status: "pending",
        ...(item.verificationAuthority
          ? { verificationAuthority: item.verificationAuthority }
          : {}),
      });
      nextId += 1;
      changed = true;
    }
    if (!changed) return;
    this.state = {
      ...this.state,
      acceptanceCriteria: criteria,
      updatedAt: Date.now(),
    };
  }

  setAcceptanceCriterionStatus(
    id: string,
    status: AcceptanceCriterionStatus,
    evidence?: string,
  ): void {
    const normalizedId = id.trim();
    const normalizedEvidence = normalizeAcceptanceEvidence(evidence);
    if (status === "satisfied" && !normalizedEvidence) {
      throw new Error(
        `satisfied acceptance criterion requires evidence: ${id}`,
      );
    }
    let found = false;
    const criteria = this.acceptanceCriteria().map((criterion) => {
      if (criterion.id !== normalizedId) return criterion;
      found = true;
      return {
        ...criterion,
        status,
        ...(normalizedEvidence ? { evidence: normalizedEvidence } : {}),
        ...(status === "satisfied"
          ? { evidenceMutationRevision: this.state.mutationRevision ?? 0 }
          : { evidenceMutationRevision: undefined }),
      };
    });
    if (!found) throw new Error(`unknown acceptance criterion: ${id}`);
    this.state = {
      ...this.state,
      acceptanceCriteria: criteria,
      updatedAt: Date.now(),
    };
  }

  /** 目标变更（多轮会话新请求）——更新 goal，约束由 LLM 调和另行判定 */
  updateGoal(goal: string): void {
    if (goal === this.state.goal) return;
    this.state = { ...this.state, goal, updatedAt: Date.now() };
  }

  /**
   * 应用一次 LLM 调和结果：keep 保留为 active；drop 标记 superseded；
   * add 追加为 active（带来源轮次）。
   */
  updateConstraints(
    result: {
      readonly keep: readonly number[];
      readonly drop: readonly number[];
      readonly add: readonly { readonly text: string }[];
    },
    currentTurn: number,
  ): void {
    const keepSet = new Set(result.keep);
    const constraints: ConstraintRecord[] = this.state.constraints.map(
      (c, i) => {
        if (keepSet.has(i)) return { ...c, status: "active" as const };
        if (result.drop.includes(i)) {
          return { ...c, status: "superseded" as const };
        }
        return c;
      },
    );
    for (const a of result.add) {
      const text = a.text.trim();
      if (!text) continue;
      constraints.push({ text, sourceTurn: currentTurn, status: "active" });
    }
    this.state = { ...this.state, constraints, updatedAt: Date.now() };
  }

  setPlan(items: readonly unknown[]): void {
    this.state = {
      ...this.state,
      plan: items.map((item) => summarizePlanItem(item)),
      updatedAt: Date.now(),
    };
  }

  recordCandidateReview(
    review: Omit<CandidateReviewRecord, "reviewedAt">,
  ): void {
    this.state = {
      ...this.state,
      candidateReview: { ...review, reviewedAt: Date.now() },
      updatedAt: Date.now(),
    };
  }

  recordToolResult(call: AgentToolCallAction, result: ToolRunResult): void {
    // The native acceptance tool already updates this manager atomically via
    // the injected ledger. It is control-plane state, not repository evidence.
    if (call.tool === "workspace.acceptance_update") return;
    if (isControlPlaneToolResult(result)) return;
    const args = isRecord(call.args) ? call.args : {};
    const filesRead = [...this.state.filesRead];
    const fileReadCounts = { ...(this.state.fileReadCounts ?? {}) };
    const filesChanged = [...this.state.filesChanged];
    const commandsRun = [...this.state.commandsRun];
    const testResults = [...this.state.testResults];
    const pinnedFacts = [...this.state.pinnedFacts];
    let shellCommandRevision =
      this.state.shellCommandRevision ?? this.state.commandsRun.length;
    let mutationRevision = this.state.mutationRevision ?? 0;
    let mutationShellCommandRevision =
      this.state.mutationShellCommandRevision ?? shellCommandRevision;
    let editRecoveryPath = this.state.editRecoveryPath;
    let diffInspectedRevision = this.state.diffInspectedRevision ?? 0;

    if (result.ok && call.tool === "workspace.read_file") {
      const readPath = stringArg(args.path);
      pushUnique(filesRead, readPath);
      if (readPath)
        fileReadCounts[readPath] = (fileReadCounts[readPath] ?? 0) + 1;
      if (readPath && readPath === editRecoveryPath)
        editRecoveryPath = undefined;
    }

    if (
      !result.ok &&
      call.tool === "workspace.edit_file" &&
      /old_string|not found|no match/i.test(result.summary)
    ) {
      editRecoveryPath = stringArg(args.path) || editRecoveryPath;
    }

    if (
      result.ok &&
      (call.tool === "workspace.write_file" ||
        call.tool === "workspace.edit_file" ||
        call.tool === "workspace.notebook_edit") &&
      (call.tool === "workspace.notebook_edit" || hasMaterialFileChange(result))
    ) {
      pushUnique(filesChanged, stringArg(args.path));
      mutationRevision += 1;
      mutationShellCommandRevision = shellCommandRevision;
      editRecoveryPath = undefined;
    }

    if (
      result.ok &&
      call.tool === "workspace.apply_patch" &&
      hasMaterialFileChange(result)
    ) {
      for (const path of extractPatchPaths(stringArg(args.patch))) {
        pushUnique(filesChanged, path);
      }
      mutationRevision += 1;
      mutationShellCommandRevision = shellCommandRevision;
      editRecoveryPath = undefined;
    }

    if (call.tool === "workspace.run_shell") {
      const command = stringArg(args.command);
      const cwd = stringArg(args.cwd);
      if (command) {
        shellCommandRevision += 1;
        const effect = isRecord(result.payload)
          ? result.payload.workspaceEffect
          : undefined;
        if (isRecord(effect) && effect.changed === true) {
          const paths = Array.isArray(effect.paths) ? effect.paths : [];
          for (const changedPath of paths) {
            if (typeof changedPath === "string")
              pushUnique(filesChanged, changedPath);
          }
          mutationRevision += 1;
          mutationShellCommandRevision = shellCommandRevision;
          editRecoveryPath = undefined;
        }
        commandsRun.push({
          command,
          ...(cwd ? { cwd } : {}),
          ok: result.ok,
          summary: result.summary,
        });
        const verificationIntent = analyzeVerificationCommand(command);
        if (verificationIntent) {
          const classification = classifyVerificationOutcome(
            result,
            filesChanged,
            verificationIntent,
          );
          const evidence = verificationEvidence(result);
          testResults.push({
            command,
            family: verificationIntent.family,
            passed: classification.outcome === "passed",
            outcome: classification.outcome,
            ...(classification.failureKind
              ? { failureKind: classification.failureKind }
              : {}),
            ...(classification.retryability
              ? { retryability: classification.retryability }
              : {}),
            summary: classification.summary ?? result.summary,
            ...(evidence ? { evidence } : {}),
            shellCommandRevision,
            mutationRevision,
          });
        }
        if (result.ok && isGitDiffCommand(command)) {
          diffInspectedRevision = mutationRevision;
        }
      }
    }

    if (result.ok && call.tool === "workspace.git_diff") {
      diffInspectedRevision = mutationRevision;
    }

    if (!result.ok) {
      pushUnique(pinnedFacts, `${call.tool} failed: ${result.summary}`);
    }

    this.state = {
      ...this.state,
      filesRead,
      fileReadCounts,
      filesChanged,
      commandsRun: commandsRun.slice(-20),
      testResults: testResults.slice(-20),
      shellCommandRevision,
      mutationRevision,
      mutationShellCommandRevision,
      ...(editRecoveryPath
        ? { editRecoveryPath }
        : { editRecoveryPath: undefined }),
      diffInspectedRevision,
      pinnedFacts: pinnedFacts.slice(-20),
      updatedAt: Date.now(),
    };
  }
}

function hasMaterialFileChange(result: ToolRunResult): boolean {
  if (!result.ok || !isRecord(result.payload)) return false;
  if (result.payload.changed === false) return false;
  if (result.payload.changed === true) return true;
  const directAdded = result.payload.linesAdded;
  const directRemoved = result.payload.linesRemoved;
  if (typeof directAdded === "number" || typeof directRemoved === "number") {
    return (
      (typeof directAdded === "number" ? directAdded : 0) +
        (typeof directRemoved === "number" ? directRemoved : 0) >
      0
    );
  }
  if (Array.isArray(result.payload.results)) {
    return result.payload.results.some((item) => {
      if (!isRecord(item) || item.ok === false) return false;
      if (item.changed === true) return true;
      const added = typeof item.linesAdded === "number" ? item.linesAdded : 0;
      const removed =
        typeof item.linesRemoved === "number" ? item.linesRemoved : 0;
      return added + removed > 0;
    });
  }
  return result.payload.changed === true;
}

export function formatTaskStateForContext(state: TaskState): string {
  const lines = ["[Current State]", `Goal: ${state.goal}`];
  appendList(
    lines,
    "Constraints",
    state.constraints
      .filter((c) => c.status === "active")
      .map((c) => `${c.text} (turn ${c.sourceTurn})`),
  );
  appendList(
    lines,
    "Acceptance criteria",
    acceptanceReadiness(state).map((item) => {
      const source = `${item.criterion.source.kind}${item.criterion.source.ref ? `:${item.criterion.source.ref}` : ""}`;
      return `${item.criterion.id} [${item.readiness}] ${item.criterion.text} (source ${source})${item.criterion.evidence ? ` — ${item.criterion.evidence}` : ""}`;
    }),
  );
  appendList(lines, "Files read", state.filesRead);
  appendList(lines, "Files changed", state.filesChanged);
  appendList(
    lines,
    "Commands run",
    state.commandsRun.map((c) => `${c.ok ? "ok" : "failed"}: ${c.command}`),
  );
  appendList(
    lines,
    "Tests",
    state.testResults.map(
      (t) =>
        `${verificationOutcome(t)}${t.failureKind ? ` [${t.failureKind}${t.retryability ? `/${t.retryability}` : ""}]` : ""}: ${t.command}${t.evidence ? ` — ${t.evidence}` : ""}`,
    ),
  );
  appendList(lines, "Plan", state.plan);
  if ((state.mutationRevision ?? 0) > 0) {
    lines.push(`Mutation revision: ${state.mutationRevision}`);
    lines.push(...formatCompletionReadiness(state));
    if (state.candidateReview) {
      const freshness =
        state.candidateReview.mutationRevision === state.mutationRevision
          ? "current"
          : "stale";
      lines.push(
        `Independent review: ${state.candidateReview.verdict}/${state.candidateReview.reportGrounding ?? "legacy-report-unknown"} (${freshness} for r${state.candidateReview.mutationRevision}) — ${state.candidateReview.summary}`,
      );
    }
  }
  appendList(lines, "File lock conflicts", state.fileLockConflicts ?? []);
  appendList(lines, "Pinned facts", state.pinnedFacts);
  if (state.nextStep) lines.push(`Next step: ${state.nextStep}`);
  return lines.join("\n");
}

export interface AcceptanceReadinessItem {
  readonly criterion: AcceptanceCriterion;
  readonly readiness:
    | "pending"
    | "satisfied"
    | "stale"
    | "blocked"
    | "external";
}

export function acceptanceReadiness(
  state: TaskState,
): AcceptanceReadinessItem[] {
  const revision = state.mutationRevision ?? 0;
  const items: AcceptanceReadinessItem[] = [];
  for (const criterion of state.acceptanceCriteria ?? []) {
    if (criterion.status === "superseded") continue;
    if (criterion.verificationAuthority === "external") {
      items.push({ criterion, readiness: "external" });
      continue;
    }
    if (criterion.status === "satisfied") {
      items.push({
        criterion,
        readiness:
          criterion.evidenceMutationRevision === revision
            ? "satisfied"
            : "stale",
      });
      continue;
    }
    items.push({ criterion, readiness: criterion.status });
  }
  return items;
}

export function formatCompletionReadiness(state: TaskState): string[] {
  const revision = state.mutationRevision ?? 0;
  if (revision === 0) return [];
  const latest = state.testResults.at(-1);
  const substantive = latestSubstantiveVerification(state);
  const verification = !latest
    ? "missing"
    : substantive?.mutationRevision !== revision &&
        latest.mutationRevision !== revision
      ? `stale (verified r${latest.mutationRevision ?? 0})`
      : substantive?.mutationRevision === revision &&
          verificationOutcome(substantive) === "passed"
        ? `passed for r${revision}`
        : substantive?.mutationRevision === revision &&
            verificationOutcome(substantive) === "code_failed"
          ? `code failed for r${revision}`
          : verificationOutcome(latest) === "harness_failed"
            ? `harness failed for r${revision} (${latest.failureKind === "untrusted_exit_status" ? "test pass not proven" : "verification did not execute"}${latest.failureKind ? `: ${latest.failureKind}${latest.retryability ? `/${latest.retryability}` : ""}` : ""})`
            : `code failed for r${revision}`;
  const diffRevision = state.diffInspectedRevision ?? 0;
  const diff =
    diffRevision === revision
      ? `inspected for r${revision}`
      : diffRevision > 0
        ? `stale (inspected r${diffRevision})`
        : "not inspected";
  return [
    "Completion readiness:",
    `- Verification: ${verification}`,
    `- Final diff: ${diff}`,
  ];
}

export function verificationOutcome(
  result: TestResultSummary,
): "passed" | "code_failed" | "harness_failed" {
  return result.outcome ?? (result.passed ? "passed" : "code_failed");
}

/** Latest code verdict for the current source revision; harness failures are diagnostic. */
export function latestSubstantiveVerification(
  state: TaskState,
): TestResultSummary | undefined {
  const revision = state.mutationRevision ?? 0;
  for (let index = state.testResults.length - 1; index >= 0; index -= 1) {
    const result = state.testResults[index];
    if (
      result &&
      (result.mutationRevision ?? 0) === revision &&
      verificationOutcome(result) !== "harness_failed"
    ) {
      return result;
    }
  }
  return undefined;
}

/** True only for the first retryable harness failure on the current revision. */
export function hasVerificationRetryAvailable(state: TaskState): boolean {
  const revision = state.mutationRevision ?? 0;
  const current = state.testResults.filter(
    (result) => result.mutationRevision === revision,
  );
  const latest = current.at(-1);
  return (
    latest?.retryability === "retryable" &&
    verificationOutcome(latest) === "harness_failed" &&
    current.filter(
      (result) =>
        verificationOutcome(result) === "harness_failed" &&
        result.retryability === "retryable",
    ).length === 1
  );
}

interface VerificationClassification {
  readonly outcome: "passed" | "code_failed" | "harness_failed";
  readonly failureKind?: TestResultSummary["failureKind"];
  readonly retryability?: TestResultSummary["retryability"];
  readonly summary?: string;
}

function classifyVerificationOutcome(
  result: ToolRunResult,
  filesChanged: readonly string[],
  intent: VerificationCommandIntent,
): VerificationClassification {
  if (!intent.exitStatusReliable) {
    return {
      outcome: "harness_failed",
      failureKind: "untrusted_exit_status",
      retryability: "retryable",
      summary:
        "verification ran in shell control flow whose final exit status does not prove the test runner passed",
    };
  }
  if (result.ok) return { outcome: "passed" };
  const payload = isRecord(result.payload) ? result.payload : {};
  const exitCode = payload.exit_code;
  const output = [payload.stdout, payload.stderr, result.summary]
    .filter((value): value is string => typeof value === "string")
    .join("\n");
  const missingExecutable =
    output.match(
      /['"]([^'"\r\n]+)['"] is not recognized as an internal or external command/i,
    )?.[1] ??
    output.match(
      /(?:^|\n)(?:[^:\n]+:\s*\d+:\s*)?([a-zA-Z0-9_.-]+): (?:command )?not found/i,
    )?.[1];
  const mentionsChangedFile = filesChanged.some((path) => {
    const normalized = path.replaceAll("\\", "/").toLowerCase();
    const basename = normalized.split("/").at(-1);
    const normalizedOutput = output.replaceAll("\\", "/").toLowerCase();
    return (
      normalizedOutput.includes(normalized) ||
      (!!basename && normalizedOutput.includes(basename))
    );
  });

  if (missingExecutable) {
    const runtimeMissing =
      /^(?:python(?:3(?:\.\d+)?)?|py|pytest|node|npm|pnpm|yarn|bun|npx|vitest|jest|go|cargo)$/i.test(
        missingExecutable.trim(),
      );
    return runtimeMissing
      ? {
          outcome: "harness_failed",
          failureKind: "runner_unavailable",
          retryability: "terminal",
        }
      : {
          outcome: "harness_failed",
          failureKind: "invocation_error",
          retryability: "retryable",
        };
  }
  if (
    /(?:pytest: (?:command )?not found|(?:modulenotfounderror:\s*)?no module named ['\"]?pytest['\"]?|could not find a version that satisfies)/i.test(
      output,
    )
  ) {
    return {
      outcome: "harness_failed",
      failureKind: "runner_unavailable",
      retryability: "terminal",
    };
  }
  if (
    !mentionsChangedFile &&
    /importerror while loading conftest/i.test(output) &&
    /(?:broken installation|could not determine[^\n]{0,120}(?:package )?version|package[^\n]{0,80}(?:not|never) (?:built|installed)|(?:build|install) the package)/i.test(
      output,
    )
  ) {
    return {
      outcome: "harness_failed",
      failureKind: "environment_setup",
      retryability: "terminal",
    };
  }
  if (
    !mentionsChangedFile &&
    /(?:modulenotfounderror|importerror):[^\n]*(?:no module named|cannot import)/i.test(
      output,
    )
  ) {
    return {
      outcome: "harness_failed",
      failureKind: "missing_dependency",
      retryability: "terminal",
    };
  }
  if (exitCode === 5 || /no tests (?:ran|collected)/i.test(output)) {
    return {
      outcome: "harness_failed",
      failureKind: "test_discovery",
      retryability: "terminal",
    };
  }
  if (exitCode === 3 || /error importing plugin/i.test(output)) {
    return {
      outcome: "harness_failed",
      failureKind: "invocation_error",
      retryability: "retryable",
    };
  }
  if (exitCode === 4) {
    return {
      outcome: "harness_failed",
      failureKind: "invocation_error",
      retryability: "retryable",
    };
  }
  return { outcome: "code_failed", failureKind: "test_failure" };
}

function verificationEvidence(result: ToolRunResult): string | undefined {
  const payload = isRecord(result.payload) ? result.payload : {};
  const raw = [payload.stderr, payload.stdout]
    .filter((value): value is string => typeof value === "string" && !!value)
    .join("\n")
    .trim();
  if (!raw) return result.summary.slice(0, 300);
  const redacted = raw
    .replace(/\bBearer\s+[^\s]+/gi, "Bearer [REDACTED]")
    .replace(
      /\b(api[_-]?key|token|password)\s*[:=]\s*[^\s]+/gi,
      "$1=[REDACTED]",
    )
    .replace(/\s+/g, " ");
  return redacted.slice(-600);
}

function appendList(
  lines: string[],
  label: string,
  values: readonly string[],
): void {
  if (values.length === 0) return;
  lines.push(`${label}:`);
  for (const value of values.slice(-10)) lines.push(`- ${value}`);
}

function nextAcceptanceCriterionId(
  criteria: readonly AcceptanceCriterion[],
): number {
  let max = 0;
  for (const criterion of criteria) {
    const match = criterion.id.match(/^acceptance-(\d+)$/);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

function normalizeAcceptanceText(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 500);
}

function normalizeAcceptanceEvidence(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, 500) : undefined;
}

/** 约束关键词（行级识别，仅作候选——语义判定由 LLM 调和负责） */
const CONSTRAINT_LINE_PATTERN =
  /\b(?:must|only|never|do not|don't)\b|必须|只能|不要|不能|禁止/;

/**
 * 输出格式类指令排除（e2e 实测修复）："不要多写/两行回答/简洁"这类
 * 是输出格式要求，不是行为红线——提取为约束会导致摘要门控被格式指令卡死。
 */
const OUTPUT_FORMAT_EXCLUSION =
  /不要多写|不要写(?:太|得)?多|不要啰嗦|不要长篇|用两行|只需两行|简洁|简短回答|不要展开|只回答/;

function extractConstraints(text: string): string[] {
  return text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(
      (line) =>
        CONSTRAINT_LINE_PATTERN.test(line) &&
        !OUTPUT_FORMAT_EXCLUSION.test(line),
    );
}

function extractPatchPaths(patch: string): string[] {
  const paths: string[] = [];
  for (const line of patch.split("\n")) {
    const match = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/);
    if (match?.[1]) paths.push(match[1].trim());
  }
  return paths;
}

function pushUnique(list: string[], value: string): void {
  if (value && !list.includes(value)) list.push(value);
}

function stringArg(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isTaskState(value: unknown): value is TaskState {
  if (!isRecord(value) || typeof value.goal !== "string") return false;
  if (
    !Array.isArray(value.filesRead) ||
    !Array.isArray(value.filesChanged) ||
    !Array.isArray(value.commandsRun) ||
    !Array.isArray(value.testResults)
  ) {
    return false;
  }
  // 兼容旧格式：constraints 是 string[]（resume 恢复旧快照）→ 升级为记录
  if (Array.isArray(value.constraints)) {
    const records = (value.constraints as unknown[]).map((c) =>
      typeof c === "string"
        ? ({ text: c, sourceTurn: 0, status: "active" } as const)
        : c,
    );
    (value as { constraints: unknown }).constraints = records;
  }
  return true;
}

function summarizePlanItem(item: unknown): string {
  if (typeof item === "string") return item;
  if (!isRecord(item)) return String(item);
  const text = item.text ?? item.content ?? item.title ?? item.step ?? item.id;
  if (typeof text !== "string") return JSON.stringify(item);
  const status = typeof item.status === "string" ? item.status : undefined;
  const taskId = typeof item.task_id === "string" ? item.task_id : undefined;
  return [status ? `[${status}]` : "", taskId ?? text]
    .filter(Boolean)
    .join(" ");
}
