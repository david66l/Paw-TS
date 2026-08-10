/**
 * 共享 LLM fakes — v2 记忆测试用（蒸馏/裁决/精排/改写/确认器）。
 * 所有 fake 都是纯函数对象，形状对齐 longterm 接口的 complete(prompt): Promise<string>。
 */

import type { CorrectionConfirmer } from "../src/longterm/write/correction.js";

/** 蒸馏 fake：返回固定 candidates（或垃圾输出测降级） */
export function makeDistillerLlm(opts: {
  /** 注入的候选 JSON 数组；也可传函数按调用序返回（测试间切换内容） */
  candidates?: readonly unknown[] | (() => readonly unknown[]);
  /** true：输出非 JSON（触发 schema 降级路径） */
  garbage?: boolean;
  /** 每次调用的日志（断言调用次数/次数上限用） */
  onCall?: () => void;
}): { complete: (prompt: string) => Promise<string> } {
  const { garbage = false, onCall } = opts;
  return {
    complete: async () => {
      onCall?.();
      if (garbage) return "这不是 JSON";
      const candidates =
        typeof opts.candidates === "function"
          ? opts.candidates()
          : (opts.candidates ?? []);
      return JSON.stringify({ candidates });
    },
  };
}

/** 裁决 fake：所有候选统一裁决 op（或垃圾输出） */
export function makeGovernorLlm(opts: {
  op?: "ADD" | "UPDATE" | "INVALIDATE" | "NOOP";
  /** 候选数（默认 1）；>1 时对每个候选都给出裁决 */
  count?: number;
  garbage?: boolean;
  onCall?: () => void;
}): { complete: (prompt: string) => Promise<string> } {
  const { op = "ADD", garbage = false, onCall } = opts;
  const count = opts.count ?? 1;
  return {
    complete: async () => {
      onCall?.();
      if (garbage) return "no json here";
      // 对每个候选都给出裁决（缺省会漏掉候选 2+ → 被保守 NOOP）
      const decisions = Array.from({ length: count }, (_, i) => ({
        candidate: i + 1,
        op,
        target: null,
        reason: "test",
      }));
      return JSON.stringify({ decisions });
    },
  };
}

/** 计数 fake：统计 complete 调用次数（预算熔断/零调用断言用） */
export function makeCountingLlm(): {
  complete: (prompt: string) => Promise<string>;
  callCount: number;
} {
  const state = { callCount: 0 };
  return {
    get callCount() {
      return state.callCount;
    },
    complete: async () => {
      state.callCount += 1;
      return "{}";
    },
  };
}

/** 精排 fake：固定返回（或空数组 = 无相关） */
export function makeRerankerLlm(opts: {
  items?: readonly {
    seq: number;
    why?: string;
    label?: "applicable" | "reference";
  }[];
  garbage?: boolean;
}): { complete: (prompt: string) => Promise<string> } {
  const { items = [], garbage = false } = opts;
  return {
    complete: async () => {
      if (garbage) return "corrupted";
      return JSON.stringify({ items });
    },
  };
}

/** 纠正确认器 fake：固定裁决 */
export function makeCorrectionConfirmer(result = true): CorrectionConfirmer {
  return { confirm: async () => result };
}

/** 通用语义候选（蒸馏输出契约） */
export function makeSemanticCandidate(overrides: {
  fact: string;
  keywords?: string[];
  evidence?: string[];
}): Record<string, unknown> {
  return {
    kind: "semantic",
    fact: overrides.fact,
    keywords: overrides.keywords ?? [],
    evidence: overrides.evidence ?? ["runs/test/trajectory#step-1"],
  };
}

/** 通用 episodic 候选（蒸馏输出契约，whenToUse 必填 "When …"） */
export function makeEpisodicCandidate(overrides: {
  whenToUse: string;
  perspective?: string;
  modification?: string[];
  issueType?: string;
  /** 轨迹含失败→成功转折时必填（蒸馏纪律 3） */
  failureFixPair?: { failed: string; feedback: string; fixed: string };
}): Record<string, unknown> {
  const out: Record<string, unknown> = {
    kind: "episodic",
    whenToUse: overrides.whenToUse,
    perspective: overrides.perspective ?? "一般化思维层抽象",
    modification: overrides.modification ?? ["检查配置"],
    issueType: overrides.issueType ?? "test",
    evidence: ["runs/test/trajectory#step-2"],
  };
  if (overrides.failureFixPair) out.failureFixPair = overrides.failureFixPair;
  return out;
}
