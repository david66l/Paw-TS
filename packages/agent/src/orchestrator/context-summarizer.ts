/**
 * ContextSummarizer：从父 Agent 的对话历史中提取结构化的 SharedContext。
 * ====================================================================
 *
 * 当父 Agent 启动子 Agent 时，不能直接把完整的对话历史传过去——
 * 父 Agent 的上下文可能已经很大（数万 token），子 Agent 的上下文窗口有限。
 *
 * ContextSummarizer 负责将父 Agent 的对话历史压缩为 ~1-2k token 的
 * 结构化摘要（SharedContext），包含：
 * - role：子 Agent 的角色描述
 * - task：具体的任务
 * - facts：关键事实（父 Agent 的目标、最近的对话摘要、用户和助手的消息）
 * - constraints：约束条件（安全规则 + 用户消息中的 must/never 指令）
 * - artifacts：相关文件内容（来自 <file> 标签和附件）
 * - parentConclusions：父 Agent 已有的结论
 *
 * 预算控制（truncateToBudget）：
 * 当估算 token 数超过 maxSharedContextTokens 时，按优先级逐步缩减：
 * artifacts → facts → parentConclusions(保留 high 置信度) → constraints
 */

import type { AgentToolCallAction, ChatMessage, ContextManager } from "@paw/core";
import { CONTEXT_SUMMARY_PREFIX } from "@paw/core";
import { SHARED_CONTEXT_BUDGET } from "./constants.js";
import {
  type AgentType,
  buildOutputFormat,
  buildRole,
  parseAgentType,
  parseChildPolicy,
} from "./agent-args.js";
import type { ContextArtifact, SharedContext } from "./types.js";

/** ContextSummarizer 接口：支持两种调用方式 */
export interface ContextSummarizer {
  /** 按 task 文本 + agentType 生成摘要 */
  summarize(
    ctx: ContextManager,
    task: string,
    agentType?: AgentType,
  ): SharedContext;
  /** 从工具调用中提取参数再生成摘要 */
  summarizeForCall(
    ctx: ContextManager,
    call: AgentToolCallAction,
  ): SharedContext;
}

/** 正则：匹配 <file path="...">...</file> 标签 */
const FILE_BLOCK_RE = /<file path="([^"]+)">\s*([\s\S]*?)<\/file>/g;

/** 噪音消息前缀：这些消息不包含有价值的上下文信息 */
const NOISE_PREFIXES = [
  "[Tool ",                    // 工具结果
  "[Context from previous session]",  // 断点恢复的上下文前缀
  "[Previous session context]",       // 上一会话的上下文
];

/** 粗糙的 token 估算：英文约 4 字符/token */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** 估算 SharedContext 的总 token 数 */
function estimateSharedContextTokens(ctx: SharedContext): number {
  let tokens = 0;
  tokens += estimateTokens(ctx.role);
  tokens += estimateTokens(ctx.task);
  for (const f of ctx.facts) tokens += estimateTokens(f);
  for (const c of ctx.constraints) tokens += estimateTokens(c);
  for (const a of ctx.artifacts) tokens += estimateTokens(a.content);
  tokens += estimateTokens(JSON.stringify(ctx.state));
  tokens += estimateTokens(ctx.outputFormat);
  if (ctx.parentConclusions) {
    for (const c of ctx.parentConclusions) tokens += estimateTokens(c.conclusion);
  }
  return tokens;
}

function messageContent(m: ChatMessage): string {
  return typeof m.content === "string" ? m.content : JSON.stringify(m.content);
}

/** 判断消息内容是否为噪音（工具结果、上下文注入等） */
function isNoiseContent(content: string): boolean {
  if (content.trim().length === 0) return true;
  if (NOISE_PREFIXES.some((p) => content.startsWith(p))) return true;
  if (content.startsWith("[Tool ") && content.includes(" completed]")) return true;
  return false;
}

/**
 * 从消息列表中提取父 Agent 的原始目标。
 * 跳过噪音消息和 <files> 块，返回第一条有意义的 user 消息的前 300 字符。
 */
function extractParentGoal(messages: readonly ChatMessage[]): string | undefined {
  for (const m of messages) {
    if (m.role !== "user") continue;
    const content = messageContent(m);
    if (isNoiseContent(content)) continue;
    if (content.startsWith("<files>")) continue;
    const cleaned = content
      .replace(
        /^\[Context from previous session\][\s\S]*?\[Current user request\]\n/s,
        "",
      )
      .trim();
    if (cleaned.length > 0) return cleaned.slice(0, 300);
  }
  return undefined;
}

/**
 * 从最近的消息中提取事实。
 * 包括：父 Agent 的目标、会话摘要、用户和助手的消息片段。
 * 保留最近 maxFacts 条。
 */
function extractFacts(messages: readonly ChatMessage[]): string[] {
  const facts: string[] = [];
  const parentGoal = extractParentGoal(messages);
  if (parentGoal) {
    facts.push(`Parent goal: ${parentGoal}`);
  }

  for (const m of messages) {
    const content = messageContent(m);

    // 已有的上下文摘要 → 作为事实保留
    if (content.startsWith(`${CONTEXT_SUMMARY_PREFIX}\n`)) {
      facts.push(
        `Session summary: ${content.slice(CONTEXT_SUMMARY_PREFIX.length + 1, 900)}`,
      );
      continue;
    }
    if (isNoiseContent(content)) continue;
    if (m.role !== "user" && m.role !== "assistant") continue;

    const label = m.role === "user" ? "User" : "Assistant";
    facts.push(`${label}: ${content.slice(0, 450)}`);
  }

  return facts.slice(-SHARED_CONTEXT_BUDGET.maxFacts);
}

/**
 * 从用户消息中提取约束条件。
 * 识别包含 must/never/always/don't/禁止/必须 等关键词的行。
 * 始终包含基本的安全约束（不修改工作区外文件、不执行破坏性命令）。
 */
function extractUserConstraints(messages: readonly ChatMessage[]): string[] {
  const base = [
    "Do not modify files outside the workspace.",
    "Do not execute destructive shell commands.",
  ];
  const extra: string[] = [];
  const seen = new Set<string>();

  for (const m of messages) {
    if (m.role !== "user") continue;
    const content = messageContent(m);
    const lines = content.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length < 8 || trimmed.length > 120) continue;
      if (!/(must|never|always|don't|do not|avoid|禁止|必须|不要|不能)/i.test(trimmed)) {
        continue;
      }
      const key = trimmed.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      extra.push(trimmed);
    }
  }

  return [...base, ...extra].slice(0, SHARED_CONTEXT_BUDGET.maxConstraints);
}

/** 从内联文件块和消息附件中提取制品 */
function extractArtifacts(messages: readonly ChatMessage[]): ContextArtifact[] {
  const artifacts: ContextArtifact[] = [];
  const seen = new Set<string>();

  for (const m of messages) {
    const content = messageContent(m);
    // 匹配 <file path="...">...</file> 标签
    for (const match of content.matchAll(FILE_BLOCK_RE)) {
      const filePath = match[1];
      const body = match[2]?.trim() ?? "";
      if (!filePath || seen.has(filePath)) continue;
      seen.add(filePath);
      artifacts.push({
        type: "file",
        path: filePath,
        content: body.slice(0, SHARED_CONTEXT_BUDGET.maxArtifactBytes),
        relevance: "critical",
      });
    }

    // 消息附件中的文件
    if (m.attachments) {
      for (const att of m.attachments) {
        if (att.type !== "file" || seen.has(att.name)) continue;
        seen.add(att.name);
        artifacts.push({
          type: "file",
          path: att.name,
          content: att.content.slice(0, SHARED_CONTEXT_BUDGET.maxArtifactBytes),
          relevance: "relevant",
        });
      }
    }
  }

  return artifacts.slice(0, SHARED_CONTEXT_BUDGET.maxArtifacts);
}

/**
 * 从助手的回复中提取已有结论。
 * 识别 ## Key Decisions 和 ## Progress 段落。
 */
function extractParentConclusions(
  messages: readonly ChatMessage[],
): SharedContext["parentConclusions"] {
  const conclusions: Array<{
    conclusion: string;
    confidence: "high" | "medium" | "low";
  }> = [];

  for (const m of messages) {
    if (m.role !== "assistant") continue;
    const content = messageContent(m);

    // 匹配 ## Key Decisions 段落
    const keyDecisions = content.match(/## Key Decisions\s*\n([\s\S]*?)(?:\n##|$)/);
    if (keyDecisions?.[1]) {
      for (const line of keyDecisions[1].split("\n")) {
        const text = line.replace(/^-\s*/, "").trim();
        if (text.length > 5) {
          conclusions.push({ conclusion: text, confidence: "high" });
        }
      }
    }

    // 匹配 ## Progress 段落
    const progress = content.match(/## Progress\s*\n([\s\S]*?)(?:\n##|$)/);
    if (progress?.[1]) {
      for (const line of progress[1].split("\n")) {
        const text = line.replace(/^-\s*/, "").trim();
        if (text.length > 8 && text.length < 200) {
          conclusions.push({ conclusion: text, confidence: "medium" });
        }
      }
    }
  }

  if (conclusions.length === 0) return undefined;
  return conclusions.slice(-8);
}

/** 按相关性排序并截断制品：critical > relevant > reference */
function truncateArtifacts(artifacts: ContextArtifact[]): ContextArtifact[] {
  const order = { critical: 0, relevant: 1, reference: 2 } as const;
  const sorted = [...artifacts].sort(
    (a, b) => order[a.relevance] - order[b.relevance],
  );
  return sorted.slice(0, SHARED_CONTEXT_BUDGET.maxArtifacts).map((a) => ({
    ...a,
    content: a.content.slice(0, SHARED_CONTEXT_BUDGET.maxArtifactBytes),
  }));
}

/**
 * 将 SharedContext 裁剪到 token 预算内。
 *
 * 裁剪优先级（从低到高）：
 * 1. artifacts（先丢弃相关性最低的）
 * 2. facts（先丢弃最早的）
 * 3. parentConclusions（只保留 high 置信度的）
 * 4. constraints（先丢弃最后的）
 */
function truncateToBudget(
  ctx: SharedContext,
  maxTokens: number,
): SharedContext {
  let tokens = estimateSharedContextTokens(ctx);
  let working: SharedContext = { ...ctx };

  // 逐步丢弃 artifacts（从末尾开始）
  while (tokens > maxTokens && working.artifacts.length > 0) {
    const withoutLast = working.artifacts.slice(0, -1);
    const candidate = { ...working, artifacts: withoutLast };
    const newTokens = estimateSharedContextTokens(candidate);
    if (newTokens >= tokens) break; // 没有减少 → 停止
    working = candidate;
    tokens = newTokens;
  }

  // 逐步丢弃 facts（从末尾开始）
  while (tokens > maxTokens && working.facts.length > 1) {
    const candidate = { ...working, facts: working.facts.slice(0, -1) };
    const newTokens = estimateSharedContextTokens(candidate);
    if (newTokens >= tokens) break;
    working = candidate;
    tokens = newTokens;
  }

  // 只保留高置信度的父 Agent 结论
  if (tokens > maxTokens && working.parentConclusions) {
    const high = working.parentConclusions.filter(
      (c) => c.confidence === "high",
    );
    const candidate = { ...working, parentConclusions: high };
    const newTokens = estimateSharedContextTokens(candidate);
    if (newTokens < tokens) {
      working = candidate;
      tokens = newTokens;
    }
  }

  // 逐步丢弃 constraints（从末尾开始）
  while (tokens > maxTokens && working.constraints.length > 1) {
    const candidate = {
      ...working,
      constraints: working.constraints.slice(0, -1),
    };
    const newTokens = estimateSharedContextTokens(candidate);
    if (newTokens >= tokens) break;
    working = candidate;
    tokens = newTokens;
  }

  return working;
}

/** 默认的 ContextSummarizer 实现 */
export class DefaultContextSummarizer implements ContextSummarizer {
  /**
   * 从父 Agent 的 ContextManager 中提取结构化的 SharedContext。
   *
   * 流程：
   * 1. 从所有消息中提取 facts/constraints/artifacts/conclusions
   * 2. 构建 SharedContext 结构
   * 3. 如果超过 token 预算，调用 truncateToBudget 裁剪
   */
  summarize(
    ctx: ContextManager,
    task: string,
    agentType: AgentType = "simple",
    overrides?: Partial<
      Pick<SharedContext, "childPolicy" | "parentConclusions">
    >,
  ): SharedContext {
    const messages = ctx.buildMessages();

    const facts = extractFacts(messages).slice(0, SHARED_CONTEXT_BUDGET.maxFacts);
    const constraints = extractUserConstraints(messages);
    const artifacts = truncateArtifacts(extractArtifacts(messages));
    const parentConclusions =
      overrides?.parentConclusions ?? extractParentConclusions(messages);

    const state: SharedContext["state"] = {
      completed: [],
      pending: [task],
    };

    let sharedCtx: SharedContext = {
      role: buildRole(agentType),
      task,
      facts,
      constraints,
      artifacts,
      state,
      outputFormat: buildOutputFormat(agentType),
      childPolicy: overrides?.childPolicy ?? "read_only",
      ...(parentConclusions ? { parentConclusions } : {}),
    };

    // 预算控制
    const tokens = estimateSharedContextTokens(sharedCtx);
    if (tokens > SHARED_CONTEXT_BUDGET.maxSharedContextTokens) {
      sharedCtx = truncateToBudget(
        sharedCtx,
        SHARED_CONTEXT_BUDGET.maxSharedContextTokens,
      );
    }

    return sharedCtx;
  }

  /**
   * 从 AgentToolCallAction 中提取参数后调用 summarize。
   * 这是 action-handlers 中 handleRunAgent 的主要调用方式。
   */
  summarizeForCall(ctx: ContextManager, call: AgentToolCallAction): SharedContext {
    const args =
      call.args && typeof call.args === "object"
        ? (call.args as Record<string, unknown>)
        : undefined;
    const goal =
      typeof args?.goal === "string"
        ? args.goal
        : String(args?.goal ?? "").trim();
    const agentType = parseAgentType(args);
    const childPolicy = parseChildPolicy(args);
    return this.summarize(ctx, goal, agentType, {
      ...(childPolicy ? { childPolicy } : {}),
    });
  }
}
