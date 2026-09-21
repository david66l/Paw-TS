import { describe, expect, test } from "bun:test";

import type { MemoryEvidenceNotebookHitV1 } from "../src/evidence-contracts.js";
import {
  applyRelativeTimeReorderV1,
  reorderHitsByRelativeTimeWindowV1,
  resolveRelativeTimeWindowV1,
} from "../src/evidence-resolution/relative-time-window.js";

/**
 * `resolveEvidencePass` 有 1500+ 行（§M4）。它守的一条不变量是相对时间重排的
 * **软加权语义** —— 窗口内的命中优先，窗口外的仍然保留、绝不丢弃；解析不出来
 * 就完全不触发。原先这段逻辑是千行函数里的一个匿名 `try` 块，没有名字也没有
 * 用例。抽到 `evidence-resolution/relative-time-window.ts` 之后它才可被单独钉住。
 */

const CUTOFF = "2023-05-21T02:21:00Z";
const DAY_MS = 86_400_000;

function hit(
  evidenceRef: string,
  overrides: Partial<MemoryEvidenceNotebookHitV1> = {},
): MemoryEvidenceNotebookHitV1 {
  return {
    sourceId: "session-a",
    evidenceRef,
    content: `content for ${evidenceRef}`,
    authority: "user_asserted",
    ...overrides,
  };
}

/** 与 `MeaRelativeTimeWindowV1` 同形的字面窗口，让重排测试不依赖解析器。 */
const WINDOW = Object.freeze({
  startMs: 1_000_000,
  endMs: 1_000_000 + DAY_MS,
  matchedPhrase: "yesterday",
  resolvedText: "2023-05-20",
});

describe("resolveRelativeTimeWindowV1", () => {
  test("resolves a strong time phrase against the cutoff", () => {
    const w = resolveRelativeTimeWindowV1("What did I buy 10 days ago?", CUTOFF);
    expect(w).toBeDefined();
    expect(w!.endMs - w!.startMs).toBe(DAY_MS);
    expect(w!.resolvedText).not.toBe("");
  });

  test("a question with no time phrase yields nothing", () => {
    expect(resolveRelativeTimeWindowV1("What is my favourite editor?", CUTOFF)).toBeUndefined();
  });

  test("no cutoff means no window, even for a time-shaped question", () => {
    expect(resolveRelativeTimeWindowV1("What did I buy 10 days ago?", undefined)).toBeUndefined();
  });

  test("an unparseable cutoff yields nothing rather than a bogus window", () => {
    expect(
      resolveRelativeTimeWindowV1("What did I buy 10 days ago?", "not-a-date"),
    ).toBeUndefined();
  });

  test("an empty upper bound is treated as absent", () => {
    expect(resolveRelativeTimeWindowV1("What did I buy 10 days ago?", "")).toBeUndefined();
  });
});

describe("reorderHitsByRelativeTimeWindowV1", () => {
  test("without a window the input is returned by reference (zero trigger)", () => {
    const groups = [[hit("a#1")], [hit("b#1"), hit("b#2")]];
    expect(reorderHitsByRelativeTimeWindowV1(groups, undefined)).toBe(groups);
  });

  test("in-window hits come first and order is stable inside each group", () => {
    const early = hit("early", { observedAt: new Date(WINDOW.startMs).toISOString() });
    const late = hit("late", { observedAt: new Date(WINDOW.endMs + 1).toISOString() });
    const middle = hit("middle", { observedAt: new Date(WINDOW.endMs - 1).toISOString() });

    const [out] = reorderHitsByRelativeTimeWindowV1([[early, late, middle]], WINDOW);
    // early/middle 都在窗口内且保持原相对顺序；late 被推到后面
    expect(out!.map((h) => h.evidenceRef)).toEqual(["early", "middle", "late"]);
  });

  test("out-of-window hits are kept, not filtered — this is soft weighting", () => {
    const inside = hit("in", { observedAt: new Date(WINDOW.startMs + 1).toISOString() });
    const outside = hit("out", { observedAt: new Date(WINDOW.endMs + 1).toISOString() });
    const before = hit("before", { observedAt: new Date(WINDOW.startMs - 1).toISOString() });

    const [out] = reorderHitsByRelativeTimeWindowV1([[outside, inside, before]], WINDOW);
    expect(out).toHaveLength(3);
    expect(new Set(out!.map((h) => h.evidenceRef))).toEqual(new Set(["in", "out", "before"]));
    expect(out![0]!.evidenceRef).toBe("in");
  });

  test("window bounds are half-open: start inclusive, end exclusive", () => {
    const atStart = hit("at-start", { observedAt: new Date(WINDOW.startMs).toISOString() });
    const atEnd = hit("at-end", { observedAt: new Date(WINDOW.endMs).toISOString() });

    const [out] = reorderHitsByRelativeTimeWindowV1([[atEnd, atStart]], WINDOW);
    expect(out!.map((h) => h.evidenceRef)).toEqual(["at-start", "at-end"]);
  });

  test("hits without a usable observedAt fall outside rather than crashing", () => {
    const missing = hit("missing");
    const invalid = hit("invalid", { observedAt: "not-a-date" });
    const inside = hit("inside", { observedAt: new Date(WINDOW.startMs + 1).toISOString() });

    const [out] = reorderHitsByRelativeTimeWindowV1([[missing, invalid, inside]], WINDOW);
    expect(out!.map((h) => h.evidenceRef)).toEqual(["inside", "missing", "invalid"]);
  });

  test("each requirement is reordered independently", () => {
    const aIn = hit("a-in", { observedAt: new Date(WINDOW.startMs + 1).toISOString() });
    const aOut = hit("a-out", { observedAt: new Date(WINDOW.endMs + 1).toISOString() });
    const bOut = hit("b-out", { observedAt: new Date(WINDOW.endMs + 1).toISOString() });
    const bIn = hit("b-in", { observedAt: new Date(WINDOW.startMs + 1).toISOString() });

    const out = reorderHitsByRelativeTimeWindowV1(
      [
        [aOut, aIn],
        [bOut, bIn],
      ],
      WINDOW,
    );
    expect(out.map((group) => group.map((h) => h.evidenceRef))).toEqual([
      ["a-in", "a-out"],
      ["b-in", "b-out"],
    ]);
  });

  test("an empty requirement list stays empty", () => {
    expect(reorderHitsByRelativeTimeWindowV1([], WINDOW)).toEqual([]);
  });
});

describe("applyRelativeTimeReorderV1", () => {
  test("a question with no time phrase leaves the input untouched by reference", () => {
    const groups = [[hit("a#1"), hit("a#2")]];
    expect(applyRelativeTimeReorderV1(groups, "What is my favourite editor?", CUTOFF)).toBe(groups);
  });

  test("no cutoff leaves the input untouched by reference", () => {
    const groups = [[hit("a#1")]];
    expect(applyRelativeTimeReorderV1(groups, "What did I buy 10 days ago?", undefined)).toBe(
      groups,
    );
  });

  test("a real time phrase reorders against the resolved window", () => {
    const window = resolveRelativeTimeWindowV1("What did I buy 10 days ago?", CUTOFF)!;
    const inside = hit("inside", {
      observedAt: new Date(window.startMs + 60_000).toISOString(),
    });
    const outside = hit("outside", {
      observedAt: new Date(window.endMs + 30 * DAY_MS).toISOString(),
    });

    const [out] = applyRelativeTimeReorderV1(
      [[outside, inside]],
      "What did I buy 10 days ago?",
      CUTOFF,
    );
    expect(out!.map((h) => h.evidenceRef)).toEqual(["inside", "outside"]);
  });

  test("a malformed cutoff degrades to the original order instead of throwing", () => {
    const groups = [[hit("a#1"), hit("a#2")]];
    expect(applyRelativeTimeReorderV1(groups, "What did I buy 10 days ago?", "nonsense")).toBe(
      groups,
    );
  });
});
