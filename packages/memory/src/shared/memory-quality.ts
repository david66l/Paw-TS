/**
 * 记忆质量启发式 —— 写入过滤、查询分词、会话感知检索。
 *
 * 零 LLM：确定性规则，保证延迟可控。
 */

import { extractCleanMemoryQuery, extractFilePaths } from "./memory-query.js";

/** WorkingMemory 最小形状（避免 runtime 依赖 db 类型） */
export type MemoryWriteSignalInput = {
  readonly goal?: string;
  readonly completedSteps?: readonly { readonly summary: string }[];
  readonly executedTools?: readonly {
    readonly toolName: string;
    readonly status: string;
    readonly summary?: string;
  }[];
  readonly modifiedFiles?: readonly { readonly filePath: string }[];
  readonly readFiles?: readonly { readonly filePath: string }[];
  readonly constraints?: readonly {
    readonly source: string;
    readonly temporary?: boolean;
    readonly text?: string;
  }[];
  readonly diffSummary?: {
    readonly filesChanged: number;
  } | null;
  readonly testRunIds?: readonly string[];
};

/** 系统/宿主注入的结束语，不算有效成果 */
const SYSTEM_FINALIZE_MARKERS = [
  "desktop conversation ended",
  "desktop: new conversation",
  "conversation ended",
  "session ended",
];

/**
 * 纯寒暄 / 无信息量短句（整句匹配）。
 * 这类请求不应写入长期记忆，也不应作为检索主查询。
 */
const CHITCHAT_EXACT =
  /^(?:hi|hello|hey|yo|sup|你好|您好|嗨|哈喽|在吗|早上好|下午好|晚上好|晚安|谢谢|谢谢你|感谢|thanks|thank\s*you|ok|okay|好的|嗯|哦|额|啊|bye|再见|拜拜|嗯嗯|哈哈|哈哈哈|lol|test|测试一下|ping)[\s!！.。?？…~～]*$/i;

/**
 * 长期偏好/约定类信号（严格）。
 * 单独「记住暗号/数字」等会话玩具不算 durable。
 */
const DURABLE_PREFERENCE =
  /(?:以后|下次|总是|永远|统一|必须用|禁止用|不要用|别再用|改用|优先用|prefer|always|never|from\s+now\s+on|prefer\s+to|use\s+\w+\s+for|决策|约定|规范|coding\s+style)/i;

/** 「记住 X」且 X 像工程约定 */
const REMEMBER_RULE =
  /(?:记住|记得|remember)(?:一下|住)?[：:\s]*.{0,48}(?:用|使用|prefer|vitest|jest|ioredis|postgres|typescript|不要|禁止|always|never)/i;

/** 会话内临时信息：不应进 L2 */
const EPHEMERAL_REMEMBER =
  /(?:暗号|密码|验证码|一次性|本次会话|刚才说的|临时|只回复|只输出|只答|不要调用工具|这个数字|那个英文|单词有几个|城市名|颜色英文)/i;

/** 决策类步骤标记 */
const DECISION_STEP =
  /\b(?:decid(?:ed|e)|chose|opted|chose\s+to|decided\s+to)\b|决定|选用|采用|改为|切换为/i;

export function isSystemFinalizeMessage(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return true;
  return SYSTEM_FINALIZE_MARKERS.some((m) => t === m || t.includes(m));
}

/**
 * 当前用户请求是否为无长期记忆价值的闲聊。
 */
export function isLowValueChitchat(text: string): boolean {
  const clean = extractCleanMemoryQuery(text).trim();
  if (!clean) return true;
  if (clean.length <= 2) return true;
  if (CHITCHAT_EXACT.test(clean)) return true;
  // 极短且无文件/无 durable 信号
  if (
    clean.length < 8 &&
    !hasDurableMemorySignal(clean) &&
    extractFilePaths(clean).length === 0
  ) {
    return true;
  }
  return false;
}

/**
 * 是否值得作为长期偏好/约定写入。
 * 临时「记住暗号」返回 false。
 */
export function hasDurableMemorySignal(text: string): boolean {
  const clean = extractCleanMemoryQuery(text).trim();
  if (!clean || clean.length < 6) return false;
  if (EPHEMERAL_REMEMBER.test(clean)) return false;
  if (DURABLE_PREFERENCE.test(clean)) return true;
  if (REMEMBER_RULE.test(clean)) return true;
  return false;
}

/**
 * 从 goal 抽出「显式记住」的约定文本。
 * 无显式意图或 ephemeral → null。
 */
export function extractExplicitRememberText(goal: string): string | null {
  const clean = extractCleanMemoryQuery(goal).trim();
  if (!clean || clean.length < 4) return null;
  if (EPHEMERAL_REMEMBER.test(clean)) return null;

  // 中文：记住/记得 … 整句
  const cn = clean.match(
    /(?:请)?(?:记住|记得)(?:一下|住)?[：:\s]*(.+)$/i,
  );
  if (cn?.[1]) {
    const body = cn[1].trim().replace(/[。.!！？?]+$/, "");
    if (body.length < 4 || EPHEMERAL_REMEMBER.test(body)) return null;
    // 要求像约定（含「用/prefer/以后…」）或整句已 durable
    if (hasDurableMemorySignal(clean) || hasDurableMemorySignal(body)) {
      return body.length <= 400 ? body : body.slice(0, 400);
    }
    return null;
  }

  // 英文：remember that / remember to / please remember
  const en = clean.match(
    /(?:please\s+)?remember(?:\s+that|\s+to)?[:\s]+(.+)$/i,
  );
  if (en?.[1]) {
    const body = en[1].trim().replace(/[.!?]+$/, "");
    if (body.length < 4 || EPHEMERAL_REMEMBER.test(body)) return null;
    if (hasDurableMemorySignal(clean) || hasDurableMemorySignal(body)) {
      return body.length <= 400 ? body : body.slice(0, 400);
    }
    return null;
  }

  // 「以后都用 / 以后请用」无「记住」前缀
  const later = clean.match(
    /(?:以后|下次)(?:都|请|务必)?(?:用|使用|prefer)\s*.{2,80}/i,
  );
  if (later?.[0] && hasDurableMemorySignal(later[0])) {
    return later[0].trim().slice(0, 400);
  }

  return null;
}

/**
 * 中英混合分词，供关键词检索打分。
 * 英文按词；中文取整段 + bigram，避免 `split(/\s+/)` 把整句当成一个 token。
 */
export function tokenizeForMemoryScore(text: string): string[] {
  if (!text.trim()) return [];
  const lower = text.toLowerCase();
  const tokens: string[] = [];

  for (const m of lower.matchAll(/[a-z0-9][a-z0-9_./-]{1,}/g)) {
    tokens.push(m[0]);
  }

  for (const m of lower.matchAll(/[\u4e00-\u9fff]{1,}/g)) {
    const run = m[0];
    tokens.push(run);
    if (run.length >= 2) {
      for (let i = 0; i < run.length - 1; i++) {
        tokens.push(run.slice(i, i + 2));
      }
    }
  }

  // 去停用词噪声（极短英文）
  return [
    ...new Set(
      tokens.filter((t) => {
        if (/^[\u4e00-\u9fff]+$/.test(t)) return t.length >= 1;
        return t.length >= 2 && !STOP_EN.has(t);
      }),
    ),
  ];
}

const STOP_EN = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "this",
  "that",
  "have",
  "been",
  "will",
  "your",
  "into",
  "about",
  "please",
  "just",
  "want",
  "need",
  "can",
  "you",
  "are",
  "is",
  "to",
  "of",
  "in",
  "on",
  "at",
  "a",
  "an",
]);

/**
 * 从多轮 goal（含 history 块）构造检索查询：
 * 当前用户请求 + 历史用户轮次中的路径 / 非闲聊关键词。
 */
export function buildConversationAwareQuery(goal: string): string {
  const current = extractCleanMemoryQuery(goal).trim();
  if (!current) return "";

  const marker = "[Current user request]";
  const idx = goal.indexOf(marker);
  const historyBlock = idx >= 0 ? goal.slice(0, idx) : "";

  const paths = extractFilePaths(goal).slice(0, 6);
  const historyUserLines = [
    ...historyBlock.matchAll(/(?:^|\n)User:\s*(.+)/g),
  ]
    .map((m) => m[1]?.trim() ?? "")
    .filter(Boolean)
    .slice(-6);

  const historyTokens: string[] = [];
  for (const line of historyUserLines) {
    if (isLowValueChitchat(line)) continue;
    if (hasDurableMemorySignal(line) || extractFilePaths(line).length > 0) {
      historyTokens.push(...tokenizeForMemoryScore(line).slice(0, 8));
    }
  }

  // 当前请求若是闲聊/元查询，尽量用历史 durable 信号撑检索
  const parts: string[] = [];
  if (!isLowValueChitchat(current) || isMemoryMetaLike(current)) {
    parts.push(current);
  }
  parts.push(...paths);
  // 取有限历史 token，避免查询爆炸
  const uniqueHist = [...new Set(historyTokens)].slice(0, 12);
  if (uniqueHist.length > 0) {
    parts.push(uniqueHist.join(" "));
  }

  const q = parts.join(" ").replace(/\s+/g, " ").trim();
  return q || current;
}

function isMemoryMetaLike(text: string): boolean {
  return /(?:还记得|记不记得|之前的记忆|什么记忆|do\s+you\s+remember|what\s+memories)/i.test(
    text,
  );
}

/** 步骤摘要是否像「决策」 */
export function isDecisionStep(summary: string): boolean {
  return DECISION_STEP.test(summary);
}

/**
 * 是否应生成 task_summary 候选。
 * 纯只读会话 / 无改动无决策 → false（可仍因 preference 写 L2）。
 */
export function shouldWriteTaskSummary(wm: MemoryWriteSignalInput): boolean {
  if (wm.diffSummary && wm.diffSummary.filesChanged > 0) return true;
  if ((wm.modifiedFiles?.length ?? 0) > 0) return true;
  if ((wm.testRunIds?.length ?? 0) > 0) return true;

  const tools = wm.executedTools ?? [];
  if (tools.some((t) => t.status === "failure" || t.status === "failed")) {
    return true;
  }
  if (
    tools.some(
      (t) =>
        (t.status === "success" || t.status === "ok") &&
        !isReadOnlyTool(t.toolName),
    )
  ) {
    return true;
  }

  const steps = (wm.completedSteps ?? []).filter(
    (s) => !isSystemFinalizeMessage(s.summary),
  );
  if (steps.some((s) => isDecisionStep(s.summary))) return true;
  if (
    steps.some(
      (s) =>
        s.summary.trim().length >= 40 && hasDurableMemorySignal(s.summary),
    )
  ) {
    return true;
  }

  return false;
}

/**
 * 本任务是否值得自动写长期记忆。
 * - 有文件改动 / 失败工具 / 用户偏好约束 / 明确「记住」信号 → 写
 * - 纯闲聊、仅系统 finalize 文案、无工具无成果 → 不写
 * - 纯 read 会话无 durable → 不写
 */
export function isWorthWritingLongTermMemory(
  wm: MemoryWriteSignalInput,
): boolean {
  if (shouldWriteTaskSummary(wm)) return true;

  const prefs = (wm.constraints ?? []).filter(
    (c) =>
      (c.source === "user_followup" || c.source === "current_user_request") &&
      !c.temporary &&
      (c.text?.trim().length ?? 0) > 4,
  );
  if (prefs.length > 0) return true;

  const goal = extractCleanMemoryQuery(wm.goal ?? "").trim();
  if (hasDurableMemorySignal(goal)) return true;

  // 默认：无 durable / 无实质写入证据 → 不写
  return false;
}

function isReadOnlyTool(name: string): boolean {
  const n = name.toLowerCase();
  return (
    n.includes("read") ||
    n.includes("list") ||
    n.includes("search") ||
    n.includes("grep") ||
    n.includes("glob") ||
    n.includes("stat") ||
    n.endsWith(".get") ||
    n.includes("memory.list") ||
    n.includes("memory.read")
  );
}

/**
 * 从 goal 生成适合作为记忆标题的短句（去掉多轮 history 前缀）。
 */
export function cleanMemoryTitle(goal: string, maxLen = 120): string {
  const clean = extractCleanMemoryQuery(goal).trim() || goal.trim();
  if (clean.length <= maxLen) return clean;
  return clean.slice(0, maxLen - 1) + "…";
}
