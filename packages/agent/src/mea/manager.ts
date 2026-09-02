/**
 * MEA Manager：持有任务状态视角、决定下一步的纯决策角色。
 *
 * 论文 §2.2 的关键约束：Manager 没有任何环境工具权限——它只能读
 * 任务状态与审计历史，产出有界子任务契约或路由决策
 * （execute/done/blocked/ask）。模型通过显式端口注入（与 memory-core
 * 的 model-port 模式一致），本模块不耦合任何 LLM SDK。
 *
 * 保守性：解析失败升级为 ask（把失败显式交给用户），绝不猜一个
 * execute/done——错误的 done 会伪装完成，错误的 execute 会浪费一轮。
 */

export type MeaManagerActionV1 = "execute" | "done" | "blocked" | "ask";

export interface MeaSubtaskContractV1 {
  /** 本轮唯一目标（有界：一个可验收的环境转移）。 */
  readonly objective: string;
  /** 可核对的验收标准（进入 TaskState 验收账本）。 */
  readonly acceptanceCriteria: readonly string[];
  /** 边界约束：本轮不允许触碰的范围。 */
  readonly boundaryConstraints: readonly string[];
}

export interface MeaManagerDecisionV1 {
  readonly action: MeaManagerActionV1;
  readonly contract?: MeaSubtaskContractV1;
  /** blocked/ask 的原因或向用户提出的问题。 */
  readonly question?: string;
  readonly reason?: string;
}

/** 与 memory-core model-port 同型的最小模型端口。 */
export interface MeaManagerModelV1 {
  complete(
    prompt: string,
    signal?: AbortSignal,
  ): Promise<{ status: "completed" | "cancelled" | "error"; text: string }>;
}

export interface MeaManagerContextInput {
  /** 原始任务目标。 */
  readonly goal: string;
  /** 当前轮次（1 起）。 */
  readonly round: number;
  /** 最大轮数；达到后 manager 不得再 execute。 */
  readonly maxRounds: number;
  /** 未完成/未信任的记录与验收标准（状态投影）。 */
  readonly openRecords: readonly {
    readonly kind: string;
    readonly text: string;
    readonly status: string;
  }[];
  /** 最近一条审计报告摘要（首轮为空）。 */
  readonly lastAuditSummary?: string;
  readonly signal?: AbortSignal;
}

const ACTIONS: readonly MeaManagerActionV1[] = [
  "execute",
  "done",
  "blocked",
  "ask",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function renderMeaManagerPrompt(input: MeaManagerContextInput): string {
  const open =
    input.openRecords.length > 0
      ? input.openRecords
          .map(
            (record) =>
              `- [${record.kind}/${record.status}] ${record.text.slice(0, 300)}`,
          )
          .join("\n")
      : "（无未决记录）";
  return [
    "你是 MEA Manager：只做规划与路由，没有任何环境访问能力。",
    "根据原始目标、未决记录与最近审计结论，决定下一步。",
    "规则：",
    "- 每轮只构造一个有界子任务契约（一个可验收的环境转移）。",
    "- 全部验收标准已被审计确认时才输出 done。",
    "- 没有允许的行动能推进剩余需求时输出 blocked。",
    "- 需要用户提供信息/授权时输出 ask 并写明问题。",
    `- 轮次 ${input.round}/${input.maxRounds}；达到上限后禁止 execute。`,
    "",
    `原始目标：${input.goal}`,
    "",
    "未决记录：",
    open,
    "",
    input.lastAuditSummary
      ? `最近审计结论：${input.lastAuditSummary.slice(0, 600)}`
      : "最近审计结论：（首轮，无）",
    "",
    '输出协议：只输出一个 JSON 对象 {"action":"execute|done|blocked|ask","contract":{"objective":"...","acceptanceCriteria":["..."],"boundaryConstraints":["..."]},"question":"ask/blocked 时的原因或问题","reason":"简要理由"}。action=execute 时必须给出 contract。',
  ].join("\n");
}

function parseDecision(
  text: string,
  input: MeaManagerContextInput,
): MeaManagerDecisionV1 {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  const jsonText =
    fenced?.[1] ??
    (start >= 0 && end > start ? text.slice(start, end + 1) : null);
  const fail = (question: string): MeaManagerDecisionV1 => ({
    action: "ask",
    question,
    reason: "manager_output_unparseable",
  });
  if (!jsonText) return fail("Manager 输出缺少 JSON 决策。");
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return fail("Manager 输出不是合法 JSON。");
  }
  if (!isRecord(parsed) || !ACTIONS.includes(parsed.action as never)) {
    return fail("Manager 决策缺少合法的 action。");
  }
  const action = parsed.action as MeaManagerActionV1;
  if (action === "execute") {
    if (input.round > input.maxRounds) {
      return {
        action: "blocked",
        reason: "round_budget_exhausted",
        question: "轮数预算已耗尽，仍有未决需求。",
      };
    }
    const contractRaw = isRecord(parsed.contract) ? parsed.contract : null;
    const objective = contractRaw
      ? typeof contractRaw.objective === "string"
        ? contractRaw.objective.trim()
        : ""
      : "";
    if (!objective) return fail("execute 决策缺少 contract.objective。");
    const stringList = (value: unknown): string[] =>
      Array.isArray(value)
        ? value
            .filter((item): item is string => typeof item === "string")
            .map((item) => item.trim())
            .filter(Boolean)
            .slice(0, 12)
        : [];
    return {
      action: "execute",
      contract: {
        objective: objective.slice(0, 500),
        acceptanceCriteria: stringList(contractRaw?.acceptanceCriteria),
        boundaryConstraints: stringList(contractRaw?.boundaryConstraints),
      },
      reason:
        typeof parsed.reason === "string"
          ? parsed.reason.slice(0, 300)
          : undefined,
    };
  }
  return {
    action,
    question:
      typeof parsed.question === "string"
        ? parsed.question.slice(0, 600)
        : undefined,
    reason:
      typeof parsed.reason === "string"
        ? parsed.reason.slice(0, 300)
        : undefined,
  };
}

/** 运行一次 Manager 决策。任何失败都保守升级为 ask。 */
export async function runMeaManager(
  model: MeaManagerModelV1,
  input: MeaManagerContextInput,
): Promise<MeaManagerDecisionV1> {
  try {
    const result = await model.complete(
      renderMeaManagerPrompt(input),
      input.signal,
    );
    if (result.status !== "completed") {
      return {
        action: "ask",
        question: "Manager 模型调用未完成，需要用户介入。",
        reason: `manager_status_${result.status}`,
      };
    }
    return parseDecision(result.text, input);
  } catch (error) {
    return {
      action: "ask",
      question: `Manager 决策失败：${error instanceof Error ? error.message : String(error)}`,
      reason: "manager_error",
    };
  }
}
