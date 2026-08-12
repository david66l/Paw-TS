/**
 * History → episodic seed（严禁 gold patch / 最终答案）
 */

import type { HistorySeedInput } from "./agent-types.js";

const GOLD_MARKERS =
  /\b(diff --git|@@ -\d+|<<<<<<<|>>>>>>>|index [0-9a-f]{7}\.\.[0-9a-f]{7})\b/i;

export interface DistilledHistoryLesson {
  readonly title: string;
  readonly summary: string;
  readonly whenToUse: string;
  readonly perspective: string;
  readonly modification: string[];
}

/** 从 problem_statement 抽文件路径线索（非 patch） */
export function extractMentionedPaths(text: string): string[] {
  const paths = new Set<string>();
  const re =
    /(?:^|[\s`'"(])([A-Za-z0-9_\-./]+?\.(?:py|js|ts|tsx|jsx|java|go|rb|c|h|cpp|rs|md))(?:$|[\s`'")\],:])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const p = m[1]!;
    if (p.includes("..")) continue;
    paths.add(p);
    if (paths.size >= 8) break;
  }
  return [...paths];
}

function scrub(text: string): string {
  // 去掉明显 patch 块，防止误把 gold 粘进 seed
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let inDiff = false;
  for (const line of lines) {
    if (/^diff --git /.test(line) || /^\+\+\+ |\-\-\- /.test(line)) {
      inDiff = true;
      continue;
    }
    if (inDiff) {
      if (/^[ @+\-\\]/.test(line) || line === "") continue;
      inDiff = false;
    }
    if (GOLD_MARKERS.test(line)) continue;
    out.push(line);
  }
  return out.join("\n").trim();
}

/**
 * 蒸馏历史经验：只用 history 题面（+可选 hints），不含任何 gold patch。
 * modification 只给调查步骤，不给具体代码改写。
 */
export function distillHistoryLesson(
  input: HistorySeedInput,
): DistilledHistoryLesson {
  const rawStatement = input.problemStatement ?? "";
  const rawHints = input.hintsText ?? "";
  if (GOLD_MARKERS.test(rawStatement) || GOLD_MARKERS.test(rawHints)) {
    throw new Error(
      `history seed rejected: gold/patch markers in ${input.historyId}`,
    );
  }
  const statement = scrub(rawStatement).slice(0, 2500);
  const hints = rawHints ? scrub(rawHints).slice(0, 800) : "";
  const files = extractMentionedPaths(`${statement}\n${hints}`);
  const fileHint =
    files.length > 0
      ? `Files mentioned in the prior issue: ${files.join(", ")}.`
      : "Prior issue did not name specific files; start from failing tests and stack traces.";

  const title = `Prior issue ${input.historyId} in ${input.repo}`;
  const summary = [
    `Related past issue in ${input.repo} (${input.historyId}).`,
    "Use as historical reference for similar symptoms — verify against current repo state.",
    fileHint,
    `Symptom excerpt: ${statement.slice(0, 600)}`,
  ].join(" ");

  return {
    title,
    summary,
    whenToUse: `When debugging ${input.repo} issues similar to: ${statement.slice(0, 180)}`,
    perspective: [
      "A previous similar bug report described these symptoms.",
      "Do not assume the old fix applies verbatim; re-read current code and tests.",
      hints ? `Optional prior hints (not a patch): ${hints.slice(0, 400)}` : "",
    ]
      .filter(Boolean)
      .join(" "),
    modification: [
      "Reproduce the failing tests first",
      "Inspect stack traces and mentioned modules before editing",
      "Prefer minimal diffs; avoid unrelated refactors",
      ...(files.length
        ? [`Check whether ${files[0]} still participates in the failure`]
        : ["Locate the failing assertion and walk callers upward"]),
    ],
  };
}

/** 静态守卫：seed 文本不得含 gold 标记或给定 gold 子串 */
export function assertNoGoldLeak(
  lesson: DistilledHistoryLesson,
  goldPatch?: string,
): void {
  const blob = [
    lesson.title,
    lesson.summary,
    lesson.whenToUse,
    lesson.perspective,
    ...lesson.modification,
  ].join("\n");
  if (GOLD_MARKERS.test(blob)) {
    throw new Error("history lesson contains patch markers");
  }
  if (goldPatch && goldPatch.trim().length >= 32) {
    const needle = goldPatch.trim().slice(0, 80);
    if (blob.includes(needle)) {
      throw new Error("history lesson leaks gold patch substring");
    }
  }
}
