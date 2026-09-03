/**
 * 相对时间翻译官:把问题里的相对时间短语换算成绝对日期窗口。
 *
 * 设计对齐 Hindsight 的 query analyzer(时间约束抽取),但零依赖、
 * 确定性、双语(英/中)。规则:
 * - 所有换算以可信截止时间(cutoff,即问题时间)为锚,绝不使用当前时钟;
 * - 没有匹配到强信号短语时返回 null——调用方对 null 必须零处理,
 *   这保证非时间问题的行为与过去完全一致;
 * - 单日表达("上周六"/"10 days ago")给 [当日 00:00, 当日 24:00) 窗口;
 *   跨度表达("过去两周")给 [cutoff-跨度, cutoff] 窗口;
 * - 会话时间戳是 UTC ISO,因此窗口按 UTC 日对齐。
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
}

const DAY_MS = 86_400_000;

function startOfDayUtc(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

function addUtcCalendarMonths(dayMs: number, delta: number): number {
  const source = new Date(dayMs);
  const targetMonthStart = new Date(
    Date.UTC(source.getUTCFullYear(), source.getUTCMonth() + delta, 1),
  );
  const targetMonthEnd = new Date(
    Date.UTC(
      targetMonthStart.getUTCFullYear(),
      targetMonthStart.getUTCMonth() + 1,
      0,
    ),
  ).getUTCDate();
  return Date.UTC(
    targetMonthStart.getUTCFullYear(),
    targetMonthStart.getUTCMonth(),
    Math.min(source.getUTCDate(), targetMonthEnd),
  );
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
function lastWeekdayBefore(cutoffMs: number, weekday: number): number {
  const cutoffDayStart = startOfDayUtc(cutoffMs);
  const cutoffDow = new Date(cutoffDayStart).getUTCDay();
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
  const chinese = /^([一二两三四五六七八九])?十([一二三四五六七八九])?$/.exec(
    trimmed,
  );
  if (chinese) {
    const tens = chinese[1] ? NUMBER_WORDS_ZH[chinese[1]] : 1;
    const ones = chinese[2] ? NUMBER_WORDS_ZH[chinese[2]] : 0;
    return (tens ?? 0) * 10 + (ones ?? 0);
  }
  return null;
}

interface PatternRule {
  readonly regex: RegExp;
  readonly build: (
    match: RegExpMatchArray,
    cutoffMs: number,
  ) => Omit<MeaRelativeTimeWindowV1, "never"> | null;
}

/** 规则表:强信号短语;弱匹配(裸 "recently")一律不识别。 */
const RULES: readonly PatternRule[] = [
  {
    regex: /\blast\s+weekend\b/i,
    build: (match, cutoffMs) => {
      const cutoffDay = startOfDayUtc(cutoffMs);
      const day = new Date(cutoffDay).getUTCDay();
      const currentMonday = cutoffDay - ((day + 6) % 7) * DAY_MS;
      const start = currentMonday - 2 * DAY_MS;
      return {
        startMs: start,
        endMs: currentMonday,
        matchedPhrase: match[0],
        resolvedText: "上个周末",
      };
    },
  },
  {
    regex: /(?:上个周末|上周末)/,
    build: (match, cutoffMs) => {
      const cutoffDay = startOfDayUtc(cutoffMs);
      const day = new Date(cutoffDay).getUTCDay();
      const currentMonday = cutoffDay - ((day + 6) % 7) * DAY_MS;
      const start = currentMonday - 2 * DAY_MS;
      return {
        startMs: start,
        endMs: currentMonday,
        matchedPhrase: match[0],
        resolvedText: "上个周末",
      };
    },
  },
  {
    regex: /\blast\s+month\b/i,
    build: (match, cutoffMs) => {
      const cutoff = new Date(startOfDayUtc(cutoffMs));
      const end = Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth(), 1);
      const start = addUtcCalendarMonths(end, -1);
      return {
        startMs: start,
        endMs: end,
        matchedPhrase: match[0],
        resolvedText: "上个月",
      };
    },
  },
  {
    regex: /上个月/,
    build: (match, cutoffMs) => {
      const cutoff = new Date(startOfDayUtc(cutoffMs));
      const end = Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth(), 1);
      const start = addUtcCalendarMonths(end, -1);
      return {
        startMs: start,
        endMs: end,
        matchedPhrase: match[0],
        resolvedText: "上个月",
      };
    },
  },
  {
    regex: /\blast\s+week\b/i,
    build: (match, cutoffMs) => {
      const cutoffDay = startOfDayUtc(cutoffMs);
      return {
        startMs: cutoffDay - 7 * DAY_MS,
        endMs: cutoffDay,
        matchedPhrase: match[0],
        resolvedText: "上周",
      };
    },
  },
  {
    regex: /上周(?![一二三四五六日天])|上个星期(?![一二三四五六日天])/,
    build: (match, cutoffMs) => {
      const cutoffDay = startOfDayUtc(cutoffMs);
      return {
        startMs: cutoffDay - 7 * DAY_MS,
        endMs: cutoffDay,
        matchedPhrase: match[0],
        resolvedText: "上周",
      };
    },
  },
  {
    regex:
      /\b(?:this\s+past\s+|last\s+)(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|tues|wed|thu|thurs|fri|sat)\b/i,
    build: (match, cutoffMs) => {
      const weekday = weekdayIndexEn(match[1] ?? "");
      if (weekday === null) return null;
      const start = lastWeekdayBefore(cutoffMs, weekday);
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
    build: (match, cutoffMs) => {
      const weekday = WEEKDAYS_ZH.indexOf((match[1] ?? "").replace("天", "日"));
      if (weekday < 0) return null;
      const start = lastWeekdayBefore(cutoffMs, weekday);
      return {
        startMs: start,
        endMs: start + DAY_MS,
        matchedPhrase: match[0],
        resolvedText: `上周${match[1]}(当日)`,
      };
    },
  },
  {
    regex:
      /\b(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(day|week|month)s?\s+ago\b/i,
    build: (match, cutoffMs) => {
      const count = parseCount(match[1] ?? "");
      if (count === null) return null;
      const unit = (match[2] ?? "").toLowerCase();
      const cutoffDay = startOfDayUtc(cutoffMs);
      const day =
        unit === "month"
          ? addUtcCalendarMonths(cutoffDay, -count)
          : cutoffDay - count * (unit === "week" ? 7 : 1) * DAY_MS;
      return {
        startMs: day,
        endMs: day + DAY_MS,
        matchedPhrase: match[0],
        resolvedText: `${count} ${unit}(s)前(当日)`,
      };
    },
  },
  {
    regex: /(\d{1,3}|[一二两三四五六七八九十]+)\s*(天|周|个?星期|个月)前/,
    build: (match, cutoffMs) => {
      const count = parseCount(match[1] ?? "");
      if (count === null) return null;
      const unit = match[2] ?? "";
      const cutoffDay = startOfDayUtc(cutoffMs);
      const day = unit.includes("月")
        ? addUtcCalendarMonths(cutoffDay, -count)
        : cutoffDay - count * (unit.startsWith("天") ? 1 : 7) * DAY_MS;
      return {
        startMs: day,
        endMs: day + DAY_MS,
        matchedPhrase: match[0],
        resolvedText: `${count}${unit}前(当日)`,
      };
    },
  },
  {
    regex: /\b(?:past|last)\s+(\d{1,3})\s+(day|week|month)s?\b/i,
    build: (match, cutoffMs) => {
      const count = Number(match[1]);
      const unit = (match[2] ?? "").toLowerCase();
      const end = startOfDayUtc(cutoffMs) + DAY_MS;
      return {
        startMs:
          unit === "month"
            ? addUtcCalendarMonths(end, -count)
            : end - count * (unit === "week" ? 7 : 1) * DAY_MS,
        endMs: end,
        matchedPhrase: match[0],
        resolvedText: `过去${count} ${unit}(s)`,
      };
    },
  },
  {
    regex:
      /(?:过去|最近)(\d{1,3}|[一二两三四五六七八九十]+)\s*(天|周|个?星期|个?月)/,
    build: (match, cutoffMs) => {
      const count = parseCount(match[1] ?? "");
      if (count === null) return null;
      const unit = match[2] ?? "";
      const end = startOfDayUtc(cutoffMs) + DAY_MS;
      return {
        startMs: unit.includes("月")
          ? addUtcCalendarMonths(end, -count)
          : end - count * (unit.startsWith("天") ? 1 : 7) * DAY_MS,
        endMs: end,
        matchedPhrase: match[0],
        resolvedText: `过去${count}${unit}`,
      };
    },
  },
  {
    regex: /\byesterday\b/i,
    build: (match, cutoffMs) => {
      const start = startOfDayUtc(cutoffMs) - DAY_MS;
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
    build: (match, cutoffMs) => {
      const start = startOfDayUtc(cutoffMs) - DAY_MS;
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
 * 多个短语命中时取最先出现的(问题主旨通常由首个时间表达主导)。
 */
export function extractRelativeTimeWindowV1(
  query: string,
  cutoffMs: number,
): MeaRelativeTimeWindowV1 | null {
  if (!query.trim() || !Number.isFinite(cutoffMs)) return null;
  const candidates: Array<MeaRelativeTimeWindowV1 & { index: number }> = [];
  for (const rule of RULES) {
    const flags = `${rule.regex.flags.replace("g", "")}g`;
    for (const match of query.matchAll(new RegExp(rule.regex.source, flags))) {
      if (match.index === undefined) continue;
      const built = rule.build(match, cutoffMs);
      if (built) candidates.push({ ...built, index: match.index });
    }
  }
  if (candidates.length === 0) return null;
  const distinctIntervals = new Set(
    candidates.map((candidate) => `${candidate.startMs}\0${candidate.endMs}`),
  );
  // A display-oriented "first match wins" policy is unsafe once the interval
  // enters typed execution. Incompatible relative clauses stay unbound until
  // a future clause-to-leaf binder can prove their ownership.
  if (distinctIntervals.size !== 1) return null;
  const best = candidates.sort((left, right) => left.index - right.index)[0];
  if (!best) return null;
  const { index: _index, ...window } = best;
  return window;
}
