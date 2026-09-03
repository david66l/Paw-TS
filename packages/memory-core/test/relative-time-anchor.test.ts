import { describe, expect, test } from "bun:test";
import { extractRelativeTimeWindowV1 } from "../src/relative-time-anchor.js";

// 固定截止:2023-05-21 02:21Z(星期日)
const CUTOFF = Date.parse("2023-05-21T02:21:00Z");
const DAY = 86_400_000;

function alignedToUtcMidnight(ms: number) {
  return ms % DAY === 0;
}

describe("relative time anchor v1", () => {
  test("last Saturday resolves to the Saturday before cutoff", () => {
    const w = extractRelativeTimeWindowV1(
      "Who did I go with to the music event last Saturday?",
      CUTOFF,
    );
    expect(w).not.toBeNull();
    expect(w!.endMs - w!.startMs).toBe(DAY);
    expect(alignedToUtcMidnight(w!.startMs)).toBe(true);
    // 2023-05-21 是周日 → 上一个周六 = 05-20
    expect(Math.round((CUTOFF - w!.startMs) / DAY)).toBe(1);
    expect(w!.matchedPhrase.toLowerCase()).toContain("saturday");
  });

  test("N days ago resolves to that single day window", () => {
    const w = extractRelativeTimeWindowV1(
      "What kitchen appliance did I buy 10 days ago?",
      CUTOFF,
    );
    expect(w).not.toBeNull();
    expect(w!.endMs - w!.startMs).toBe(DAY);
    expect(Math.round((CUTOFF - w!.startMs) / DAY)).toBe(10);
  });

  test("number-word weeks ago (four weeks ago)", () => {
    const w = extractRelativeTimeWindowV1(
      "I mentioned an investment for a competition four weeks ago? What did I buy?",
      CUTOFF,
    );
    expect(w).not.toBeNull();
    expect(Math.round((CUTOFF - w!.startMs) / DAY)).toBe(28);
  });

  test("past N days resolves to a range ending at cutoff day", () => {
    const w = extractRelativeTimeWindowV1(
      "How many items did I buy in the past 14 days?",
      CUTOFF,
    );
    expect(w).not.toBeNull();
    expect(w!.endMs - w!.startMs).toBe(14 * DAY);
  });

  test("chinese N天前", () => {
    const w = extractRelativeTimeWindowV1("三天前我买了什么?", CUTOFF);
    expect(w).not.toBeNull();
    expect(Math.round((CUTOFF - w!.startMs) / DAY)).toBe(3);
  });

  test("chinese 上周六", () => {
    const w = extractRelativeTimeWindowV1("上周六我和谁去了音乐节?", CUTOFF);
    expect(w).not.toBeNull();
    expect(Math.round((CUTOFF - w!.startMs) / DAY)).toBe(1);
  });

  test("chinese 过去两个月 resolves to ~60 day range", () => {
    const w = extractRelativeTimeWindowV1(
      "过去两个月我买了多少件首饰?",
      CUTOFF,
    );
    expect(w).not.toBeNull();
    expect(w!.endMs - w!.startMs).toBeGreaterThanOrEqual(59 * DAY);
    expect(w!.endMs - w!.startMs).toBeLessThanOrEqual(61 * DAY);
  });

  test("non-temporal questions return null (zero behavior change)", () => {
    expect(
      extractRelativeTimeWindowV1("What degree did I graduate with?", CUTOFF),
    ).toBeNull();
    expect(
      extractRelativeTimeWindowV1(
        "How many weeks had passed since I recovered from the flu when I went on my 10th jog outdoors?",
        CUTOFF,
      ),
    ).toBeNull();
    expect(extractRelativeTimeWindowV1("", CUTOFF)).toBeNull();
    expect(
      extractRelativeTimeWindowV1("remind me of the deli name", Number.NaN),
    ).toBeNull();
  });
});
