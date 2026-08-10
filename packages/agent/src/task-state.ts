import type { AgentToolCallAction } from "@paw/core";
import type { ToolRunResult } from "@paw/harness";

export interface CommandSummary {
  readonly command: string;
  readonly cwd?: string;
  readonly ok: boolean;
  readonly summary: string;
}

export interface TestResultSummary {
  readonly command: string;
  readonly passed: boolean;
  readonly summary: string;
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

export interface TaskState {
  readonly goal: string;
  readonly constraints: readonly ConstraintRecord[];
  readonly plan: readonly string[];
  readonly filesRead: readonly string[];
  readonly filesChanged: readonly string[];
  readonly commandsRun: readonly CommandSummary[];
  readonly testResults: readonly TestResultSummary[];
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
    this.state = isTaskState(restored)
      ? restored
      : {
          goal,
          constraints: extractConstraints(goal).map((text) => ({
            text,
            sourceTurn: 0,
            status: "active" as const,
          })),
          plan: [],
          filesRead: [],
          filesChanged: [],
          commandsRun: [],
          testResults: [],
          rejectedHypotheses: [],
          pinnedFacts: [],
          knownNonGoals: [],
          updatedAt: Date.now(),
        };
  }

  snapshot(): TaskState {
    return this.state;
  }

  /** 当前有效的约束（active）——红线区/摘要校验的唯一来源 */
  activeConstraints(): readonly ConstraintRecord[] {
    return this.state.constraints.filter((c) => c.status === "active");
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

  recordToolResult(call: AgentToolCallAction, result: ToolRunResult): void {
    const args = isRecord(call.args) ? call.args : {};
    const filesRead = [...this.state.filesRead];
    const filesChanged = [...this.state.filesChanged];
    const commandsRun = [...this.state.commandsRun];
    const testResults = [...this.state.testResults];
    const pinnedFacts = [...this.state.pinnedFacts];

    if (result.ok && call.tool === "workspace.read_file") {
      pushUnique(filesRead, stringArg(args.path));
    }

    if (
      result.ok &&
      (call.tool === "workspace.write_file" ||
        call.tool === "workspace.edit_file" ||
        call.tool === "workspace.notebook_edit")
    ) {
      pushUnique(filesChanged, stringArg(args.path));
    }

    if (result.ok && call.tool === "workspace.apply_patch") {
      for (const path of extractPatchPaths(stringArg(args.patch))) {
        pushUnique(filesChanged, path);
      }
    }

    if (call.tool === "workspace.run_shell") {
      const command = stringArg(args.command);
      const cwd = stringArg(args.cwd);
      if (command) {
        commandsRun.push({
          command,
          ...(cwd ? { cwd } : {}),
          ok: result.ok,
          summary: result.summary,
        });
        if (looksLikeTestCommand(command)) {
          testResults.push({
            command,
            passed: result.ok,
            summary: result.summary,
          });
        }
      }
    }

    if (!result.ok) {
      pushUnique(pinnedFacts, `${call.tool} failed: ${result.summary}`);
    }

    this.state = {
      ...this.state,
      filesRead,
      filesChanged,
      commandsRun: commandsRun.slice(-20),
      testResults: testResults.slice(-20),
      pinnedFacts: pinnedFacts.slice(-20),
      updatedAt: Date.now(),
    };
  }
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
  appendList(lines, "Files read", state.filesRead);
  appendList(lines, "Files changed", state.filesChanged);
  appendList(lines, "Commands run", state.commandsRun.map((c) => `${c.ok ? "ok" : "failed"}: ${c.command}`));
  appendList(lines, "Tests", state.testResults.map((t) => `${t.passed ? "passed" : "failed"}: ${t.command}`));
  appendList(lines, "Pinned facts", state.pinnedFacts);
  if (state.nextStep) lines.push(`Next step: ${state.nextStep}`);
  return lines.join("\n");
}

function appendList(lines: string[], label: string, values: readonly string[]): void {
  if (values.length === 0) return;
  lines.push(`${label}:`);
  for (const value of values.slice(-10)) lines.push(`- ${value}`);
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

function looksLikeTestCommand(command: string): boolean {
  return /\b(?:test|spec|vitest|jest|bun test|npm test|pnpm test|yarn test|pytest|go test|cargo test)\b/i.test(command);
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
  return typeof text === "string" ? text : JSON.stringify(item);
}
