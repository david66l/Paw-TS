/**
 * MEA 审计报告：独立审计员对执行结果的三类结论。
 *
 * 设计源自 LongHorizon-Harness（arXiv 2608.01964）§2.4：
 * 执行者的完成声明（oi）只是未验证摘要；只有审计员对照验收标准、
 * 通过只读环境巡检得出的报告（vi）才能支持持久状态的 completed 转移。
 */

export type MeaAuditCompletion = "complete" | "incomplete" | "blocked";
export type MeaAuditIntegrity = "clean" | "suspect" | "violation";

export const MEA_AUDIT_REPORT_SCHEMA_VERSION = "paw.mea-audit-report.v1";

/** 一条被审计员用环境证据确认过的事实（记忆核 eventKey 的生产者）。 */
export interface MeaVerifiedFactV1 {
  readonly statement: string;
  readonly evidence: {
    readonly files?: readonly string[];
    readonly commands?: readonly string[];
    readonly notes?: string;
  };
}

export interface MeaAuditReportV1 {
  readonly schemaVersion: typeof MEA_AUDIT_REPORT_SCHEMA_VERSION;
  readonly completion: MeaAuditCompletion;
  readonly integrity: MeaAuditIntegrity;
  /** 逐条未满足的验收标准原文（complete 时为空）。 */
  readonly unmetCriteria: readonly string[];
  readonly verifiedFacts: readonly MeaVerifiedFactV1[];
  /** 一句话审计结论（注入 nudge 反馈给执行者）。 */
  readonly summary: string;
}

const COMPLETIONS: readonly MeaAuditCompletion[] = [
  "complete",
  "incomplete",
  "blocked",
];
const INTEGRITIES: readonly MeaAuditIntegrity[] = [
  "clean",
  "suspect",
  "violation",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/** 解析审计员输出的 ```json 围栏块（找不到则尝试首个 `{` 起的 JSON）。 */
export function extractMeaAuditJsonText(text: string): string | null {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1];
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return null;
}

/**
 * 解析并校验审计报告。任何字段漂移都走保守默认：
 * completion=incomplete、integrity=suspect——审计失败绝不会被当成通过。
 */
export function parseMeaAuditReportV1(raw: string | null | undefined): {
  ok: boolean;
  report: MeaAuditReportV1;
} {
  const conservative = (reason: string): MeaAuditReportV1 => ({
    schemaVersion: MEA_AUDIT_REPORT_SCHEMA_VERSION,
    completion: "incomplete",
    integrity: "suspect",
    unmetCriteria: [],
    verifiedFacts: [],
    summary: `审计报告不可解析（${reason}）；按保守处理，视为未通过审计。`,
  });
  if (!raw) return { ok: false, report: conservative("empty") };
  const jsonText = extractMeaAuditJsonText(raw);
  if (!jsonText) return { ok: false, report: conservative("no json") };
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { ok: false, report: conservative("invalid json") };
  }
  if (!isRecord(parsed)) return { ok: false, report: conservative("shape") };
  const completion = COMPLETIONS.includes(parsed.completion as never)
    ? (parsed.completion as MeaAuditCompletion)
    : null;
  const integrity = INTEGRITIES.includes(parsed.integrity as never)
    ? (parsed.integrity as MeaAuditIntegrity)
    : null;
  if (!completion || !integrity) {
    return { ok: false, report: conservative("missing enums") };
  }
  const unmetCriteria = Array.isArray(parsed.unmetCriteria)
    ? parsed.unmetCriteria
        .map((item) => boundedText(item, 300))
        .filter((item): item is string => item.length > 0)
        .slice(0, 16)
    : [];
  const verifiedFacts: MeaVerifiedFactV1[] = Array.isArray(parsed.verifiedFacts)
    ? parsed.verifiedFacts
        .filter(isRecord)
        .map((fact) => ({
          statement: boundedText(fact.statement, 400),
          evidence: {
            files: Array.isArray(fact.evidence)
              ? []
              : isRecord(fact.evidence) && Array.isArray(fact.evidence.files)
                ? fact.evidence.files
                    .map((file) => boundedText(file, 260))
                    .filter((file): file is string => file.length > 0)
                    .slice(0, 12)
                : undefined,
            commands:
              isRecord(fact.evidence) && Array.isArray(fact.evidence.commands)
                ? fact.evidence.commands
                    .map((command) => boundedText(command, 260))
                    .filter((command): command is string => command.length > 0)
                    .slice(0, 12)
                : undefined,
            notes:
              isRecord(fact.evidence) && typeof fact.evidence.notes === "string"
                ? fact.evidence.notes.slice(0, 600)
                : undefined,
          },
        }))
        .filter((fact) => fact.statement.length > 0)
        .slice(0, 16)
    : [];
  return {
    ok: true,
    report: {
      schemaVersion: MEA_AUDIT_REPORT_SCHEMA_VERSION,
      completion,
      integrity,
      unmetCriteria,
      verifiedFacts,
      summary:
        boundedText(parsed.summary, 600) ||
        `审计完成：${completion} / integrity=${integrity}。`,
    },
  };
}

/**
 * 供审计员使用的输出协议说明（注入子 Agent 目标里）。
 * 保持单一来源：schema 变化只改这里。
 */
export function renderMeaAuditProtocolV1(): string {
  return [
    "输出协议：最终回复必须且只能包含一个 ```json 代码块，结构如下：",
    '{"completion":"complete|incomplete|blocked","integrity":"clean|suspect|violation","unmetCriteria":["未满足的验收标准原文"],"verifiedFacts":[{"statement":"已被环境证据确认的事实","evidence":{"files":["文件路径"],"commands":["只读命令"],"notes":"说明"}}],"summary":"一句话审计结论"}',
    "规则：只采信你亲自用只读工具从环境取得的证据；不要采信执行者的完成声明；",
    "无法核实的验收标准列入 unmetCriteria；审计期间观察到工作区被变更时 integrity 记为 violation。",
  ].join("\n");
}
