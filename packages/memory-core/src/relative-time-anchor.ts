/**
 * 相对时间翻译官:把问题里的相对时间短语换算成绝对日期窗口。
 *
 * 设计对齐 Hindsight 的 query analyzer(时间约束抽取),但零依赖、
 * 确定性、双语(英/中)。规则:
 * - 所有换算以可信截止时间(cutoff,即问题时间)为锚,绝不使用当前时钟;
 * - 没有匹配到强信号短语时返回 null——调用方对 null 必须零处理,
 *   这保证非时间问题的行为与过去完全一致;
 * - 单日表达("上周六"/"10 days ago")给 [当日 00:00, 当日 24:00) 窗口;
 *   跨度表达("过去两周")给 [cutoff-跨度, cutoff] 窗口。
 */

export interface MeaRelativeTimeWindowV1 {
  /** 窗口起点(Unix ms,含)。 */
  readonly startMs: number;
  /** 窗口终点(Unix ms,不含)。 */
  readonly endMs: number;
  /** 命中的原文短语。 */
  readonly matchedPhrase: string;
  /** 人类可读的换算结果(注入证据包标签)。 */
  readonly resolvedText: string;
  /** 换算所用时区偏移(分钟),来自截止时间本身。 */
  readonly cutoffOffsetMinutes: number;
}

const DAY_MS = 86_400_000;

function startOfDayLocal(ms: number, offsetMinutes: number): number {
  const shifted = ms + offsetMinutes * 60_000;
  const dayStartShifted = Math.floor(shifted / DAY_MS) * DAY_MS;
  return dayStartShifted - offsetMinutes * 60_000;
}

/** cutoff 当天的本地时区偏移(以 UTC 午夜采样,避免 DST 边界)。 */
function cutoffOffsetMs(cutoffMs: number): number {
  const utcMidnight = Math.floor(cutoffMs / DAY_MS) * DAY_MS;
  const date = new Date(utcMidnight);
  return -date.getTimezoneOffset() * 60_000;
}

const WEEKDAYS_EN: readonly (readonly string[])[] = [
  ["sunday", "sun"],
  ["monday", "mon"],
  ["tuesday", "tue", "tues"],
  ["wednesday", "wed"],
  ["thursday", "thu", "thurs"],
  ["friday", "fri"],
  ["saturday", "sat"],
];

const WEEKDAYS_ZH: readonly string[] = [
  "日",
  "一",
  "二",
  "三",
  "四",
  "五",
  "六",
];

function weekdayIndexEn(word: string): number | null {
  const normalized = word.toLowerCase().replace(/\.$/, "");
  for (let index = 0; index < WEEKDAYS_EN.length; index += 1) {
    if (WEEKDAYS_EN[index]?.includes(normalized)) return index;
  }
  return null;
}

/** 最近一个“小于 cutoff 日”的指定星期几(不含 cutoff 当天)。 */
function lastWeekdayBefore(
  cutoffMs: number,
  weekday: number,
  offsetMinutes: number,
): number {
  const cutoffDayStart = startOfDayLocal(cutoffMs, offsetMinutes);
  const cutoffDow = new Date(
    cutoffDayStart + offsetMinutes * 60_000,
  ).getUTCDay();
  let delta = (cutoffDow - weekday + 7) % 7;
  if (delta === 0) delta = 7;
  return cutoffDayStart - delta * DAY_MS;
}

const NUMBER_WORDS_EN: Readonly<Record<string, number>> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};

const NUMBER_WORDS_ZH: Readonly<Record<string, number>> = {
  一: 1,
  两: 2,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
};

function parseCount(raw: string): number | null {
  const trimmed = raw.trim().toLowerCase();
  if (/^\d{1,3}$/.test(trimmed)) return Number(trimmed);
  if (NUMBER_WORDS_EN[trimmed] !== undefined) return NUMBER_WORDS_EN[trimmed];
  if (NUMBER_WORDS_ZH[trimmed] !== undefined) return NUMBER_WORDS_ZH[trimmed];
  return null;
}

interface PatternRule {
  readonly regex: RegExp;
  readonly build: (
    match: RegExpMatchArray,
    cutoffMs: number,
    offsetMinutes: number,
  ) => Omit<MeaRelativeTimeWindowV1, "cutoffOffsetMinutes"> | null;
}

/**
 * 规则表:按优先级排列(具体weekday > N-unit-ago > last/past N-unit > yesterday)。
 * 全部为强信号短语;弱匹配(如裸 "recently")一律不识别,保持保守。
 */
const RULES: readonly PatternRule[] = [
  // last <weekday> / this past <weekday> / 上周<X> / 上<X>
  {
    regex:
      /\b(?:this\s+past\s+|last\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|tues|wed|thu|thurs|fri|sat)\b/i,
    build: (match, cutoffMs, offset) => {
      const weekday = weekdayIndexEn(match[1] ?? "");
      if (weekday === null) return null;
      const start = lastWeekdayBefore(cutoffMs, weekday, offset);
      return {
        startMs: start,
        endMs: start + DAY_MS,
        matchedPhrase: match[0],
        resolvedText: `最近一个${match[0]}(当日)`,
      };
    },
  },
  {
    regex: /上(?:周|个星期)([一二三四五六日天])/,
    build: (match, cutoffMs, offset) => {
      const weekday = WEEKDAYS_ZH.indexOf((match[1] ?? "").replace("天", "日"));
      if (weekday < 0) return null;
      const start = lastWeekdayBefore(cutoffMs, weekday, offset);
      return {
        startMs: start,
        endMs: start + DAY_MS,
        matchedPhrase: match[0],
        resolvedText: `上周${match[1]}(当日)`,
      };
    },
  },
  // N day(s)/week(s)/month(s) ago / N天前、N周(星期)前、N个月前
  {
    regex:
      /\b(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(day|week|month)s?\s+ago\b/i,
    build: (match, cutoffMs, offset) => {
      const count = parseCount(match[1] ?? "");
      if (count === null) return null;
      const unit = (match[2] ?? "").toLowerCase();
      const multiplier = unit === "day" ? 1 : unit === "week" ? 7 : 30;
      const day =
        startOfDayLocal(cutoffMs, offset) - count * multiplier * DAY_MS;
      return {
        startMs: day,
        endMs: day + DAY_MS,
        matchedPhrase: match[0],
        resolvedText: `${count} ${unit}(s)前(当日)`,
      };
    },
  },
  {
    regex: /(\d{1,3}|[一二两三四五六七八九十]+)\s*(天|周|个?星期|个月|月)前/,
    build: (match, cutoffMs, offset) => {
      const count = parseCount(match[1] ?? "");
      if (count === null) return null;
      const unit = match[2] ?? "";
      const multiplier = unit.startsWith("天")
        ? 1
        : unit.includes("月")
          ? 30
          : 7;
      const day =
        startOfDayLocal(cutoffMs, offset) - count * multiplier * DAY_MS;
      return {
        startMs: day,
        endMs: day + DAY_MS,
        matchedPhrase: match[0],
        resolvedText: `${count}${unit}前(当日)`,
      };
    },
  },
  // past/last N day(s)/week(s)/month(s) / 过去/最近 N 天/周/个月
  {
    regex: /\b(?:past|last)\s+(\d{1,3})\s+(day|week|month)s?\b/i,
    build: (match, cutoffMs, offset) => {
      const count = Number(match[1]);
      const unit = (match[2] ?? "").toLowerCase();
      const multiplier = unit === "day" ? 1 : unit === "week" ? 7 : 30;
      const end = startOfDayLocal(cutoffMs, offset) + DAY_MS;
      return {
        startMs: end - count * multiplier * DAY_MS,
        endMs: end,
        matchedPhrase: match[0],
        resolvedText: `过去${count} ${unit}(s)`,
      };
    },
  },
  {
    regex:
      /(?:过去|最近)(\d{1,3}|[一二两三四五六七八九十]+)\s*(天|周|个?星期|个?月)/,
    build: (match, cutoffMs, offset) => {
      const count = parseCount(match[1] ?? "");
      if (count === null) return null;
      const unit = match[2] ?? "";
      const multiplier = unit.startsWith("天")
        ? 1
        : unit.includes("月")
          ? 30
          : 7;
      const end = startOfDayLocal(cutoffMs, offset) + DAY_MS;
      return {
        startMs: end - count * multiplier * DAY_MS,
        endMs: end,
        matchedPhrase: match[0],
        resolvedText: `过去${count}${unit}`,
      };
    },
  },
  // yesterday / 昨天
  {
    regex: /\byesterday\b/i,
    build: (match, cutoffMs, offset) => {
      const start = startOfDayLocal(cutoffMs, offset) - DAY_MS;
      return {
        startMs: start,
        endMs: start + DAY_MS,
        matchedPhrase: match[0],
        resolvedText: "昨天(当日)",
      };
    },
  },
  {
    regex: /昨天/,
    build: (match, cutoffMs, offset) => {
      const start = startOfDayLocal(cutoffMs, offset) - DAY_MS;
      return {
        startMs: start,
        endMs: start + DAY_MS,
        matchedPhrase: match[0],
        resolvedText: "昨天(当日)",
      };
    },
  },
];

/**
 * 从问题文本抽取相对时间窗口。无强信号短语 → null(调用方零处理)。
 * 多个短语命中时取**最先出现**的(问题主旨通常由首个时间表达主导)。
 */
export function extractRelativeTimeWindowV1(
  query: string,
  cutoffMs: number,
): MeaRelativeTimeWindowV1 | null {
  if (!query.trim() || !Number.isFinite(cutoffMs)) return null;
  const offsetMinutes = cutoffOffsetMs(cutoffMs);
  const offset = offsetMinutes / 60_000;
  let best: (MeaRelativeTimeWindowV1 & { index: number }) | null = null;
  for (const rule of RULES) {
    const regex = new RegExp(rule.regex.source, "i");
    const match = query.match(regex);
    if (!match || match.index === undefined) continue;
    const built = rule.build(match, cutoffMs, offset);
    if (!built) continue;
    if (best === null || match.index < best.index) {
      best = {
        ...built,
        cutoffOffsetMinutes: offsetMinutes,
        index: match.index,
      };
    }
  }
  if (best === null) return null;
  const { index: _index, ...window } = best;
  return window;
}
