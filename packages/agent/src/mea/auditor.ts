/**
 * MEA 独立审计员：新鲜上下文、只读、不采信执行者的自我评估。
 *
 * 通过现有的只读 sub-agent 通道（DefaultSubAgentLauncher，childPolicy
 * 默认 read_only）实现论文 §2.4 的审计角色：输入不含执行轨迹，仅含
 * 原始目标、验收标准账本与执行者报告摘要；产出结构化审计报告。
 */

import type { SubAgentLauncher } from "@paw/harness";
import {
  type MeaAuditReportV1,
  parseMeaAuditReportV1,
  renderMeaAuditProtocolV1,
} from "./audit-report.js";

export interface MeaAuditorBudget {
  /** 审计员最大步数（论文同款：审计是聚焦巡检，不需要执行预算）。 */
  readonly maxSteps?: number;
  /** 审计墙钟上限；超时按保守结果处理。 */
  readonly timeoutMs?: number;
}

export const DEFAULT_MEA_AUDITOR_BUDGET: Required<MeaAuditorBudget> = {
  maxSteps: 16,
  timeoutMs: 300_000,
};

export interface MeaAuditRunInput {
  readonly launcher: SubAgentLauncher;
  readonly parentRunId: string;
  /** 原始任务目标（未经执行者转述）。 */
  readonly goal: string;
  /** 验收标准账本（TaskState.acceptanceCriteria 投影）。 */
  readonly acceptanceCriteria: readonly {
    readonly text: string;
    readonly status?: string;
  }[];
  /** 执行者的最终报告摘要——仅供定位证据，不作为完成依据。 */
  readonly executorSummary: string;
  readonly budget?: MeaAuditorBudget;
  readonly signal?: AbortSignal;
}

export interface MeaAuditRunResult {
  readonly report: MeaAuditReportV1;
  /** 报告是否由审计员成功产出并解析（false = 保守默认被采用）。 */
  readonly parseOk: boolean;
  readonly childStatus: "completed" | "failed" | "timeout";
  readonly stepsTaken?: number;
}

function renderAuditGoal(input: MeaAuditRunInput): string {
  const criteria = input.acceptanceCriteria.length
    ? input.acceptanceCriteria
        .map(
          (criterion, index) =>
            `${index + 1}. [${criterion.status ?? "pending"}] ${criterion.text}`,
        )
        .join("\n")
    : "（任务未登记结构化验收标准：请从原始目标自行推导可核对的完成条件，并在 unmetCriteria 中逐条列出无法核实的部分。）";
  return [
    "你是只读审计员（MEA Auditor）。你的职责是独立核对执行结果是否满足验收标准。",
    "你可以使用只读工具（读文件、列目录、搜索、git status/log/diff 等），不得修改任何工作区内容。",
    "忽略执行者的完成声明——那是待验证的摘要，不是事实。",
    "",
    `原始目标：${input.goal}`,
    "",
    "验收标准账本：",
    criteria,
    "",
    "执行者报告摘要（仅供参考证据定位，不作为完成依据）：",
    input.executorSummary.slice(0, 4_000),
    "",
    renderMeaAuditProtocolV1(),
  ].join("\n");
}

function conservativeTimeoutReport(): MeaAuditReportV1 {
  return {
    schemaVersion: "paw.mea-audit-report.v1",
    completion: "incomplete",
    integrity: "suspect",
    unmetCriteria: [],
    verifiedFacts: [],
    summary: "审计超时/中止；按保守处理，视为未通过审计。",
  };
}

/**
 * 运行一次独立审计。解析失败、子 Agent 失败或超时都降级为保守报告
 * （incomplete + suspect）——审计通道的任何故障都不能被解释为通过。
 */
export async function runMeaAuditor(
  input: MeaAuditRunInput,
): Promise<MeaAuditRunResult> {
  const budget = { ...DEFAULT_MEA_AUDITOR_BUDGET, ...input.budget };
  const abort = new AbortController();
  const timer = setTimeout(
    () => abort.abort(new Error("mea_audit_timeout")),
    budget.timeoutMs,
  );
  const onAbort = () => abort.abort(input.signal?.reason);
  input.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const result = await input.launcher.launch(
      renderAuditGoal(input),
      budget.maxSteps,
      {
        parentRunId: input.parentRunId,
        signal: abort.signal,
      },
    );
    const { ok, report } = parseMeaAuditReportV1(result.summary);
    return {
      report,
      parseOk: ok,
      childStatus: result.status === "completed" ? "completed" : "failed",
      stepsTaken: result.trace?.stepsTaken,
    };
  } catch (error) {
    if (input.signal?.aborted && !abort.signal.aborted) throw error;
    return {
      report: conservativeTimeoutReport(),
      parseOk: false,
      childStatus: "timeout",
    };
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onAbort);
  }
}
