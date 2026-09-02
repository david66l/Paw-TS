/**
 * MEA 审计门：final_answer 在 VerificationGate 之后的独立环境审计。
 *
 * 三种模式（默认 off，零行为变化）：
 * - shadow：运行审计、发 mea.audit 事件、不拦截——用于离线对照
 *   CompletionPolicy 判定与审计判定的分歧率，达标后才允许切 enforce。
 * - enforce：审计 complete 且 integrity 非 violation 才放行；否则返回
 *   nudge（预算 2 次）或强制 incomplete（诚实降级）。
 *
 * 触发条件（论文成本纪律：审计只投给变异任务）：快照 filesChanged 非空。
 */

import type { RunEvent } from "@paw/core";
import type { SubAgentLauncher } from "@paw/harness";
import {
  type CompletionDecision,
  decideIncomplete,
} from "../lifecycle/completion-policy.js";
import type { TaskStateManager } from "../task-state.js";
import type { MeaAuditReportV1 } from "./audit-report.js";
import { runMeaAuditor } from "./auditor.js";

export type MeaAuditorMode = "off" | "shadow" | "enforce";

export interface MeaAuditorConfig {
  readonly mode?: MeaAuditorMode;
  /** 审计员最大步数（默认 16）。 */
  readonly maxSteps?: number;
  /** 审计墙钟上限（默认 300s）。 */
  readonly timeoutMs?: number;
}

/** 解析生效模式：显式配置 > 环境变量 > off。 */
export function resolveMeaAuditorConfig(
  config: MeaAuditorConfig | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
): { mode: MeaAuditorMode; maxSteps?: number; timeoutMs?: number } {
  const fromEnv = env.PAW_AGENT_MEA_AUDITOR?.trim().toLowerCase();
  const mode =
    config?.mode ??
    (fromEnv === "shadow" || fromEnv === "enforce" ? fromEnv : "off");
  return {
    mode,
    ...(config?.maxSteps === undefined ? {} : { maxSteps: config.maxSteps }),
    ...(config?.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
  };
}

export type MeaAuditGateResult =
  | { readonly action: "allow" }
  | {
      readonly action: "nudge";
      readonly text: string;
      readonly nextNudges: number;
    }
  | {
      readonly action: "force_incomplete";
      readonly decision: CompletionDecision;
    };

export interface MeaAuditGateInput {
  readonly launcher: SubAgentLauncher | undefined;
  readonly config: MeaAuditorConfig | undefined;
  readonly parentRunId: string;
  readonly goal: string;
  readonly executorSummary: string;
  readonly taskState: TaskStateManager;
  readonly emit: (event: RunEvent) => void;
  readonly meaNudges: number;
  readonly noRoomForAnotherTurn: boolean;
  readonly signal?: AbortSignal;
}

function auditFindingsText(report: MeaAuditReportV1): string {
  const lines = [
    `[MEA 独立审计未通过] completion=${report.completion} integrity=${report.integrity}`,
    report.summary,
  ];
  if (report.unmetCriteria.length > 0) {
    lines.push(
      "未满足的验收标准：",
      ...report.unmetCriteria.map((item) => `- ${item}`),
    );
  }
  lines.push(
    "请用工具实际修复上述缺口后，重新给出 final_answer。注意：你的完成声明不会作为完成依据，只有环境证据才算数。",
  );
  return lines.join("\n");
}

/** 运行独立审计并给出门决策。审计通道任何故障都降级为"未通过"。 */
export async function checkMeaAuditGate(
  input: MeaAuditGateInput,
): Promise<MeaAuditGateResult> {
  const resolved = resolveMeaAuditorConfig(input.config);
  if (resolved.mode === "off") return { action: "allow" };
  if (!input.launcher) return { action: "allow" };
  // 成本纪律：审计只投给发生了工作区变异的任务。
  const snapshot = input.taskState.snapshot();
  if (snapshot.filesChanged.length === 0) return { action: "allow" };

  const acceptanceCriteria = (snapshot.acceptanceCriteria ?? []).map(
    (criterion) => ({
      text: criterion.text,
      status: criterion.status,
    }),
  );
  const outcome = await runMeaAuditor({
    launcher: input.launcher,
    parentRunId: input.parentRunId,
    goal: input.goal,
    acceptanceCriteria,
    executorSummary: input.executorSummary,
    budget: { maxSteps: resolved.maxSteps, timeoutMs: resolved.timeoutMs },
    signal: input.signal,
  });
  input.emit({
    type: "mea.audit",
    mode: resolved.mode,
    completion: outcome.report.completion,
    integrity: outcome.report.integrity,
    parseOk: outcome.parseOk,
    summary: outcome.report.summary,
    unmetCriteria: outcome.report.unmetCriteria,
  });
  if (resolved.mode === "shadow") return { action: "allow" };

  const passed =
    outcome.report.completion === "complete" &&
    outcome.report.integrity !== "violation";
  if (passed) return { action: "allow" };

  const findings = auditFindingsText(outcome.report);
  if (input.meaNudges < 2 && !input.noRoomForAnotherTurn) {
    return {
      action: "nudge",
      text: findings,
      nextNudges: input.meaNudges + 1,
    };
  }
  return {
    action: "force_incomplete",
    decision: decideIncomplete({
      reason: `mea_audit_${outcome.report.completion}`,
      message: findings,
      taskState: snapshot,
    }),
  };
}
