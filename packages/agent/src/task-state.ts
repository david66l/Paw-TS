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

export interface TaskState {
  readonly goal: string;
  readonly constraints: readonly string[];
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
          constraints: extractConstraints(goal),
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
  appendList(lines, "Constraints", state.constraints);
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

function extractConstraints(text: string): string[] {
  return text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => /\b(?:must|only|never|do not|don't)\b|必须|只能|不要|不能/.test(line));
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
  return (
    isRecord(value) &&
    typeof value.goal === "string" &&
    Array.isArray(value.filesRead) &&
    Array.isArray(value.filesChanged) &&
    Array.isArray(value.commandsRun) &&
    Array.isArray(value.testResults)
  );
}

function summarizePlanItem(item: unknown): string {
  if (typeof item === "string") return item;
  if (!isRecord(item)) return String(item);
  const text = item.text ?? item.content ?? item.title ?? item.step ?? item.id;
  return typeof text === "string" ? text : JSON.stringify(item);
}
