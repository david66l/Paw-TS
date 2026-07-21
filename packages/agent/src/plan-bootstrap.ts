/**
 * 从用户 goal 启发式抽出初始 Plan 步骤，供桌面右栏在模型未发 plan_update 时也能展示。
 * 不替代模型后续 plan_update；仅做「有结构目标 → 可见计划」兜底。
 */

import { createPlanItem, PlanItemStatus, type PlanItem } from "@paw/store";

/**
 * 从 goal 文本提取有序步骤。不足 2 步返回空（简单任务不强制出 plan）。
 */
export function extractPlanStepsFromGoal(goal: string): string[] {
  const g = goal.trim();
  if (!g || g.length < 8) return [];

  const steps: string[] = [];

  // 行首编号：1) / 1. / 1、 / (1)
  const lineRe =
    /(?:^|\n)\s*(?:\(?(\d+)\)?[.)、]|（(\d+)）)\s*([^\n]+)/g;
  let m: RegExpExecArray | null = lineRe.exec(g);
  while (m !== null) {
    const text = (m[3] ?? "").trim().replace(/[;；。]\s*$/, "");
    if (text.length >= 2) steps.push(text);
    m = lineRe.exec(g);
  }

  if (steps.length >= 2) {
    return dedupeSteps(steps).slice(0, 12);
  }

  // 同行内联编号：1) a 2) b 3) c
  const inline: string[] = [];
  const parts = g.split(/(?=\d+[.)、])/);
  for (const part of parts) {
    const im = part.match(/^\d+[.)、]\s*(.+)$/);
    if (im?.[1]) {
      const t = im[1].trim().replace(/[;；。]\s*$/, "");
      if (t.length >= 2) inline.push(t);
    }
  }
  if (inline.length >= 2) {
    return dedupeSteps(inline).slice(0, 12);
  }

  // 「先…再…最后…」弱拆分（仅当明确多步骤意图）
  if (
    /多步骤|分步|step\s*by\s*step|执行计划|先列出.*计划|分几步/i.test(g) &&
    /先.+再|然后|最后|接着/.test(g)
  ) {
    const chunks = g
      .split(/(?:然后|接着|最后|再(?!次)|；|;)/)
      .map((s) => s.replace(/^(?:请|先|再|然后|接着|最后)/, "").trim())
      .filter((s) => s.length >= 4 && s.length < 120);
    if (chunks.length >= 2) return dedupeSteps(chunks).slice(0, 8);
  }

  return [];
}

function dedupeSteps(steps: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of steps) {
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

/** 将步骤文案转为 PlanItem 列表 */
export function planItemsFromStepTexts(steps: readonly string[]): PlanItem[] {
  return steps.map((text, i) =>
    createPlanItem({
      id: `plan-${String(i).padStart(3, "0")}`,
      task_id: text.slice(0, 200),
      status: PlanItemStatus.PENDING,
    }),
  );
}

/** 将全部未完成项标为 completed（任务结束 UI 用） */
export function markPlanItemsCompleted(items: PlanItem[]): PlanItem[] {
  return items.map((item) => {
    if (
      item.status === PlanItemStatus.COMPLETED ||
      item.status === PlanItemStatus.SKIPPED
    ) {
      return item;
    }
    return { ...item, status: PlanItemStatus.COMPLETED };
  });
}

/** 序列化为 run 事件 / 右栏 items */
export function planItemsToEventSnapshot(
  items: readonly PlanItem[],
): { id: string; text: string; status: string }[] {
  return items.map((item) => ({
    id: item.id,
    text: (item.note?.trim() || item.task_id || item.id).slice(0, 500),
    status: item.status,
  }));
}
