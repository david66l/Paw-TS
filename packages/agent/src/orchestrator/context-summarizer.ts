/**
 * ContextSummarizer: extracts a structured SharedContext from the parent
 * agent's conversation history.  Default budget: ~1–2 k tokens.
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

export interface ContextSummarizer {
  summarize(
    ctx: ContextManager,
    task: string,
    agentType?: AgentType,
  ): SharedContext;
  summarizeForCall(
    ctx: ContextManager,
    call: AgentToolCallAction,
  ): SharedContext;
}

const FILE_BLOCK_RE = /<file path="([^"]+)">\s*([\s\S]*?)<\/file>/g;

const NOISE_PREFIXES = [
  "[Tool ",
  "[Context from previous session]",
  "[Previous session context]",
];

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

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

function isNoiseContent(content: string): boolean {
  if (content.trim().length === 0) return true;
  if (NOISE_PREFIXES.some((p) => content.startsWith(p))) return true;
  if (content.startsWith("[Tool ") && content.includes(" completed]")) return true;
  return false;
}

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

/** Extract facts from recent messages (user + assistant only). */
function extractFacts(messages: readonly ChatMessage[]): string[] {
  const facts: string[] = [];
  const parentGoal = extractParentGoal(messages);
  if (parentGoal) {
    facts.push(`Parent goal: ${parentGoal}`);
  }

  for (const m of messages) {
    const content = messageContent(m);

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

/** Extract artifacts from inlined files and message attachments. */
function extractArtifacts(messages: readonly ChatMessage[]): ContextArtifact[] {
  const artifacts: ContextArtifact[] = [];
  const seen = new Set<string>();

  for (const m of messages) {
    const content = messageContent(m);
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

function extractParentConclusions(
  messages: readonly ChatMessage[],
): SharedContext["parentConclusions"] {
  const conclusions: NonNullable<SharedContext["parentConclusions"]> = [];

  for (const m of messages) {
    if (m.role !== "assistant") continue;
    const content = messageContent(m);

    const keyDecisions = content.match(/## Key Decisions\s*\n([\s\S]*?)(?:\n##|$)/);
    if (keyDecisions?.[1]) {
      for (const line of keyDecisions[1].split("\n")) {
        const text = line.replace(/^-\s*/, "").trim();
        if (text.length > 5) {
          conclusions.push({ conclusion: text, confidence: "high" });
        }
      }
    }

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

/** Truncate artifacts by relevance, then by size. */
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

/** Truncate SharedContext to fit within maxSharedContextTokens. */
function truncateToBudget(
  ctx: SharedContext,
  maxTokens: number,
): SharedContext {
  let tokens = estimateSharedContextTokens(ctx);
  let working: SharedContext = { ...ctx };

  while (tokens > maxTokens && working.artifacts.length > 0) {
    const withoutLast = working.artifacts.slice(0, -1);
    const candidate = { ...working, artifacts: withoutLast };
    const newTokens = estimateSharedContextTokens(candidate);
    if (newTokens >= tokens) break;
    working = candidate;
    tokens = newTokens;
  }

  while (tokens > maxTokens && working.facts.length > 1) {
    const candidate = { ...working, facts: working.facts.slice(0, -1) };
    const newTokens = estimateSharedContextTokens(candidate);
    if (newTokens >= tokens) break;
    working = candidate;
    tokens = newTokens;
  }

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

export class DefaultContextSummarizer implements ContextSummarizer {
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

    const tokens = estimateSharedContextTokens(sharedCtx);
    if (tokens > SHARED_CONTEXT_BUDGET.maxSharedContextTokens) {
      sharedCtx = truncateToBudget(
        sharedCtx,
        SHARED_CONTEXT_BUDGET.maxSharedContextTokens,
      );
    }

    return sharedCtx;
  }

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
