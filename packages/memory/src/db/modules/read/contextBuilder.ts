/**
 * Context Builder (8.9)
 *
 * 在每轮模型调用前构建 Prompt Context。
 * Hot/Warm/Cold/Excluded 四层 + token budget 控制。
 *
 * 铁律: ContextBuilder 只读不写，不修改任何持久化状态。
 */

import type { WorkingMemory, ContextPlacement } from "../../types.js";
import type { RetrievalResult } from "./memoryRetriever.js";
import { PolicyEngine, type ContextPolicy } from "../platform/policyEngine.js";

export interface ContextItem {
  id: string;
  sourceKind: string;
  sourceId: string;
  placement: ContextPlacement;
  renderedContent: string;
  estimatedTokens: number;
  order: number;
  scores: { authority: number; relevance: number; freshness: number; confidence: number; total: number };
}

export interface ContextBuildInput {
  workingMemory: WorkingMemory;
  retrievalResult?: RetrievalResult;
  currentUserRequest: string;
  tokenBudget: number;
}

export interface ContextBuildResult {
  items: ContextItem[];
  renderedPrompt: string;
  tokenUsage: { totalBudget: number; estimatedUsed: number; byPlacement: Record<string, number> };
  warnings: string[];
}

/**
 * 估算 token 数：简化为 1 token ≈ 4 字符（英文）或 1.5 字符（中文）
 * ponytail: tiktoken 精确但依赖模型，这里用字符比例足够 MVP
 */
function estimateTokens(text: string): number {
  const asciiCount = (text.match(/[\x00-\x7F]/g) ?? []).length;
  const nonAsciiCount = text.length - asciiCount;
  return Math.ceil(asciiCount / 4 + nonAsciiCount / 1.5);
}

export class ContextBuilder {
  private policy: ContextPolicy;

  constructor(policyEngine?: PolicyEngine) {
    this.policy = policyEngine?.getDefaults().context ?? new PolicyEngine().getDefaults().context;
  }

  build(input: ContextBuildInput): ContextBuildResult {
    const items: ContextItem[] = [];
    let order = 0;
    const warnings: string[] = [];

    // ═══ Hot: 当前步骤必须看到的信息 ═══
    let hotTokens = 0;

    // Goal
    if (input.workingMemory.goal) {
      const content = `[CURRENT GOAL]\n${input.workingMemory.goal}`;
      items.push(this.makeItem("working_memory", "goal", "hot", content, ++order, { authority: 1.0, relevance: 1.0, freshness: 1.0, confidence: 1.0 }));
      hotTokens += estimateTokens(content);
    }

    // Plan (top 5 steps)
    const activeSteps = input.workingMemory.plan.filter((s) => s.status !== "completed" && s.status !== "skipped");
    if (activeSteps.length > 0) {
      const planLines = activeSteps.slice(0, 5).map((s) => `- [${s.status}] ${s.description}`);
      const content = `[CURRENT PLAN]\n${planLines.join("\n")}`;
      items.push(this.makeItem("working_memory", "plan", "hot", content, ++order, { authority: 0.9, relevance: 0.9, freshness: 0.9, confidence: 0.9 }));
      hotTokens += estimateTokens(content);
    }

    // Diff summary
    if (input.workingMemory.diffSummary) {
      const ds = input.workingMemory.diffSummary;
      const content = `[DIFF STATUS]\nFiles: ${ds.filesChanged}, +${ds.insertions} -${ds.deletions}`;
      items.push(this.makeItem("working_memory", "diff", "hot", content, ++order, { authority: 1.0, relevance: 0.9, freshness: 1.0, confidence: 1.0 }));
      hotTokens += estimateTokens(content);
    }

    // Failed tests
    const failedTests = input.workingMemory.currentTestSummary?.failures;
    if (failedTests && failedTests.length > 0) {
      const content = `[FAILED TESTS]\n${failedTests.map((f) => `- ${f.testName}: ${f.message}`).join("\n")}`;
      items.push(this.makeItem("working_memory", "test_failures", "hot", content, ++order, { authority: 1.0, relevance: 1.0, freshness: 1.0, confidence: 1.0 }));
      hotTokens += estimateTokens(content);
    }

    // Next action
    if (input.workingMemory.nextAction) {
      const content = `[NEXT ACTION]\n${input.workingMemory.nextAction.description}`;
      items.push(this.makeItem("working_memory", "next_action", "hot", content, ++order, { authority: 0.8, relevance: 0.9, freshness: 1.0, confidence: 0.8 }));
      hotTokens += estimateTokens(content);
    }

    // ═══ Warm: 检索到的长期记忆摘要 ═══
    const retrieved = input.retrievalResult?.items ?? [];
    for (const r of retrieved) {
      const content = `[MEMORY: ${r.memory.type}] ${r.memory.title}\n${r.memory.summary}\n(confidence: ${r.memory.confidence.toFixed(2)}, score: ${r.score.toFixed(2)})`;
      items.push(this.makeItem("long_term_memory", r.memory.id, "warm", content, ++order, { authority: 0.7, relevance: r.score, freshness: 0.5, confidence: r.memory.confidence }));
    }

    // ═══ Cold Pointer: 不进入 Prompt，引用外部资源 ═══
    for (const ptr of input.workingMemory.contextPointers) {
      const content = `[REFERENCE] ${ptr.pointerType}: ${ptr.uri} — ${ptr.description}`;
      items.push(this.makeItem("cold_pointer", ptr.id, "cold_pointer", content, ++order, { authority: 0.3, relevance: 0.3, freshness: 0.3, confidence: 0.5 }));
    }

    // Open questions (warm — 可能影响探索方向)
    if (input.workingMemory.openQuestions.length > 0) {
      const content = `[OPEN QUESTIONS]\n${input.workingMemory.openQuestions.map((q) => `- ${q.question}`).join("\n")}`;
      items.push(this.makeItem("working_memory", "open_questions", "warm", content, ++order, { authority: 0.5, relevance: 0.6, freshness: 0.8, confidence: 0.5 }));
    }

    // ═══ Token Budget 控制 ═══
    const userTokens = estimateTokens(input.currentUserRequest);
    const systemReserve = this.policy.tokenBudget.reservedForSystem;
    const available = input.tokenBudget - userTokens - systemReserve;
    const hotBudget = Math.floor(available * 0.5);
    const warmBudget = Math.floor(available * 0.3);
    const coldBudget = available - hotBudget - warmBudget;

    // Hot → Warm → Cold → Excluded 逐级降级
    this.applyBudget(items, "hot", hotBudget, warnings);
    this.applyBudget(items, "warm", warmBudget, warnings);
    this.applyBudget(items, "cold_pointer", coldBudget, warnings);

    // 构建渲染 Prompt
    const sections: string[] = [];
    const hotItems = items.filter((i) => i.placement === "hot");
    const warmItems = items.filter((i) => i.placement === "warm");
    const coldItems = items.filter((i) => i.placement === "cold_pointer");

    if (hotItems.length > 0) {
      sections.push(hotItems.map((i) => i.renderedContent).join("\n\n"));
    }
    if (warmItems.length > 0) {
      sections.push("---\n[BACKGROUND CONTEXT]");
      sections.push(warmItems.map((i) => i.renderedContent).join("\n\n"));
    }
    if (coldItems.length > 0) {
      sections.push("---\n[AVAILABLE REFERENCES (not in context)]");
      sections.push(coldItems.map((i) => i.renderedContent).join("\n"));
    }

    const renderedPrompt = sections.join("\n");

    // 统计
    const byPlacement: Record<string, number> = {};
    for (const item of items) {
      byPlacement[item.placement] = (byPlacement[item.placement] ?? 0) + item.estimatedTokens;
    }

    return {
      items,
      renderedPrompt,
      tokenUsage: {
        totalBudget: input.tokenBudget,
        estimatedUsed: estimateTokens(renderedPrompt) + userTokens,
        byPlacement,
      },
      warnings,
    };
  }

  // ── Private ──

  private makeItem(
    sourceKind: string, sourceId: string, placement: ContextPlacement,
    renderedContent: string, order: number,
    scores: { authority: number; relevance: number; freshness: number; confidence: number },
  ): ContextItem {
    return {
      id: `${sourceKind}_${sourceId}`,
      sourceKind,
      sourceId,
      placement,
      renderedContent,
      estimatedTokens: estimateTokens(renderedContent),
      order,
      scores: { ...scores, total: (scores.authority + scores.relevance + scores.freshness + scores.confidence) / 4 },
    };
  }

  /** 超预算时逐级降级 */
  private applyBudget(items: ContextItem[], placement: ContextPlacement, budget: number, warnings: string[]): void {
    let used = 0;
    const tierItems = items.filter((i) => i.placement === placement);
    for (const item of tierItems) {
      if (used + item.estimatedTokens > budget) {
        // 降级
        if (placement === "hot") { item.placement = "warm"; warnings.push(`Downgraded hot→warm: ${item.sourceId}`); }
        else if (placement === "warm") { item.placement = "cold_pointer"; warnings.push(`Downgraded warm→cold: ${item.sourceId}`); }
        else { item.placement = "excluded"; warnings.push(`Excluded: ${item.sourceId}`); }
      } else {
        used += item.estimatedTokens;
      }
    }
  }
}
