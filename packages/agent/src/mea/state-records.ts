/**
 * MEA 任务状态记录：requirement / artifact / fact 的显式状态机。
 *
 * 论文不变量（arXiv 2608.01964）：执行者的声明永远不会直接把记录置为
 * completed——声明产生的记录一律 untrusted；只有带审计证据引用的事实
 * 才能进入 completed。审计本身不产生声明，只产生验证。
 */

import type { MeaAuditReportV1 } from "./audit-report.js";

export type MeaStateRecordKindV1 = "requirement" | "artifact" | "fact";
export type MeaStateRecordStatusV1 =
  | "completed"
  | "pending"
  | "blocked"
  | "untrusted";

export interface MeaStateRecordV1 {
  readonly kind: MeaStateRecordKindV1;
  readonly text: string;
  readonly status: MeaStateRecordStatusV1;
  /** 审计证据引用；completed 记录必须携带。 */
  readonly evidence?: {
    readonly auditId?: string;
    readonly files?: readonly string[];
    readonly commands?: readonly string[];
    readonly notes?: string;
  };
  readonly updatedAt: number;
}

export interface MeaExecutorClaimV1 {
  readonly kind: MeaStateRecordKindV1;
  readonly text: string;
}

/** 记录键：同 kind+text 视为同一记录（幂等合并）。 */
function recordKey(kind: MeaStateRecordKindV1, text: string): string {
  return `${kind}\0${text.trim().toLowerCase()}`;
}

/** 审计报告的稳定标识（evidence.auditId 引用它）。 */
export function meaAuditReportId(report: MeaAuditReportV1): string {
  // FNV-1a 32bit：内容寻址即可，不需要加密强度。
  let hash = 0x811c9dc5;
  const payload = JSON.stringify([
    report.completion,
    report.integrity,
    report.unmetCriteria,
    report.verifiedFacts,
  ]);
  for (let index = 0; index < payload.length; index += 1) {
    hash ^= payload.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `mea-audit-${hash.toString(16).padStart(8, "0")}`;
}

/** 审计报告 → completed fact 记录（唯一允许的 completed 来源）。 */
export function meaRecordsFromAuditReport(
  report: MeaAuditReportV1,
  now: number = Date.now(),
): MeaStateRecordV1[] {
  const auditId = meaAuditReportId(report);
  return report.verifiedFacts.map((fact) => ({
    kind: "fact" as const,
    text: fact.statement.trim().slice(0, 400),
    status: "completed" as const,
    evidence: {
      auditId,
      ...(fact.evidence.files?.length ? { files: fact.evidence.files } : {}),
      ...(fact.evidence.commands?.length
        ? { commands: fact.evidence.commands }
        : {}),
      ...(fact.evidence.notes ? { notes: fact.evidence.notes } : {}),
    },
    updatedAt: now,
  }));
}

/** 执行者声明 → untrusted 记录（未经审计，永远不能自行升级）。 */
export function meaRecordsFromExecutorClaims(
  claims: readonly MeaExecutorClaimV1[],
  now: number = Date.now(),
): MeaStateRecordV1[] {
  return claims.map((claim) => ({
    kind: claim.kind,
    text: claim.text.trim().slice(0, 400),
    status: "untrusted" as const,
    updatedAt: now,
  }));
}

/**
 * 把新记录合并进既有记录列表：
 * - audit-completed 记录覆盖同键的 untrusted/pending 记录（唯一的升级路径）；
 * - untrusted 声明不会降级已 completed 的记录；
 * - 其余按键幂等去重，保留最新。
 */
export function mergeMeaStateRecords(
  existing: readonly MeaStateRecordV1[],
  incoming: readonly MeaStateRecordV1[],
  now: number = Date.now(),
): MeaStateRecordV1[] {
  const byKey = new Map<string, MeaStateRecordV1>();
  for (const record of existing) {
    byKey.set(recordKey(record.kind, record.text), record);
  }
  for (const record of incoming) {
    const key = recordKey(record.kind, record.text);
    const current = byKey.get(key);
    if (!current) {
      byKey.set(key, record);
      continue;
    }
    const auditUpgrade =
      record.status === "completed" &&
      record.evidence?.auditId &&
      current.status !== "completed";
    if (auditUpgrade || current.status === "untrusted") {
      byKey.set(key, { ...record, updatedAt: now });
    }
  }
  return [...byKey.values()].sort((left, right) =>
    left.kind === right.kind
      ? left.text.localeCompare(right.text)
      : left.kind.localeCompare(right.kind),
  );
}
