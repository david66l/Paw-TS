import type { AgentAction, RunResult } from "@paw/core";
import {
  AnthropicCompatibleModel,
  type ChatMessage,
  type LanguageModel,
  OpenAICompatibleModel,
} from "@paw/models";
/**
 * Orchestrator 的模块级辅助函数：约束模式、provider 恢复文案、工具控制动作归一化、
 * 记忆 LLM 选项。
 *
 * 这些都不碰实例状态，因此不属于 class body；抽出来让 `orchestrator.ts` 专注于 run 本身。
 */
import {
  type ControlReductionV1,
  type LoopV2LegacyTerminalV1,
  type LoopV2ShadowReport,
  canonicalJson,
} from "../loop-v2/index.js";
import { isStructuredActionKind } from "../parse-agent-action.js";

export const CONSTRAINT_TASK_PIVOT_PATTERN =
  /^(?:new task|next task|now (?:do|work on|handle|fix)|新任务|接下来(?:做|处理|修复)|下一步(?:做|处理|修复)|换个任务)/i;

/** 系统注入的 user 消息（约束调和候选必须排除——不是用户意图） */
export const CONSTRAINT_SYSTEM_INJECTED_PREFIXES = [
  "[Context Package]",
  "[Status Snapshot v1]",
  "[Context Summary]",
  "[Previous session context]",
  "[You stopped",
  "[Max steps",
  "[MAX_STEPS",
  "[model produced only reasoning]",
  "[Task]",
  "[Memory refresh]",
  "[Context guard]",
  "[Loop reminder]",
  "[Convergence checkpoint]",
  "[ProviderProtocol:",
  "[LoopControl:",
  "[LoopV2Readiness:",
  "[LoopV2SemanticReview:",
  "[ProgressAdvice:",
  "[TestWarden]",
  "[ImpactedTests]",
  "[Managed jobs are unfinished:",
  "[Managed job recovery v1]",
  "[Continue from where you were cut off",
  "Plan updated:",
  "Current plan:",
  "Note:",
];

export function loopV2LegacyTerminalFromRunResult(result: RunResult): LoopV2LegacyTerminalV1 {
  if (
    result.status !== "completed" &&
    result.status !== "incomplete" &&
    result.status !== "failed" &&
    result.status !== "aborted"
  ) {
    throw new Error(`Unsupported loop v2 terminal status: ${result.status}`);
  }
  return {
    status: result.status,
    ...(result.outcome ? { outcome: result.outcome } : {}),
    ...(result.completionReason ? { reasonCode: result.completionReason } : {}),
  };
}

export function providerProtocolRecoveryMessageV2(
  issue: "empty_response" | "truncated_response" | "missing_tool_calls",
): string {
  if (issue === "truncated_response") {
    return "[ProviderProtocol:truncated_response] The previous response was discarded before any tool execution because it was truncated. Retry the complete tool call or candidate response once; do not continue partial JSON.";
  }
  if (issue === "missing_tool_calls") {
    return "[ProviderProtocol:missing_tool_calls] The provider declared tool calls but supplied none. Emit the complete structured calls once, or return a visible candidate response.";
  }
  return "[ProviderProtocol:empty_response] The provider returned no visible text or executable action. Retry once with complete tool calls, an explicit control action, or a visible candidate response.";
}

export function providerTurnBoundaryMessageV2(reduction: ControlReductionV1): string {
  if (
    reduction.effects[0]?.type === "call_model" &&
    reduction.effects[0].reason === "repair_required" &&
    reduction.state.openRepairObligation
  ) {
    const obligation = reduction.state.openRepairObligation;
    return `[LoopControl:repair_required id=${obligation.id}] The durable ${obligation.kind} obligation remains open. Execute the matching tool action now. Prose, repeated reads, unrelated successful tools, and another final_answer do not satisfy it.`;
  }
  return "[LoopControl:turn_boundary] Your previous natural-language response ended the provider turn but did not submit a completion candidate. Continue with the next required tool/action. If the task is actually ready, submit the structured final_answer action explicitly.";
}

export function isSameRevisionCandidateExtension(
  candidateReport: LoopV2ShadowReport,
  restoredReport: LoopV2ShadowReport,
): boolean {
  if (candidateReport.reportHash === restoredReport.reportHash) return true;
  if (
    candidateReport.state.currentMutationRevision !== restoredReport.state.currentMutationRevision
  )
    return false;
  const candidateEvents = candidateReport.projectedEvents;
  const restoredEvents = restoredReport.projectedEvents;
  if (restoredEvents.length < candidateEvents.length) return false;
  for (let index = 0; index < candidateEvents.length; index += 1) {
    if (canonicalJson(candidateEvents[index]) !== canonicalJson(restoredEvents[index])) {
      return false;
    }
  }
  const candidateIdentity = candidateReport.state.currentCandidate;
  return restoredEvents.slice(candidateEvents.length).every((envelope) => {
    if (envelope.event.type === "mutation.recorded") return false;
    if (envelope.event.type !== "candidate.proposed") return true;
    return (
      candidateIdentity !== undefined &&
      envelope.event.candidate.mutationRevision === candidateIdentity.mutationRevision &&
      envelope.event.candidate.candidateInputHash === candidateIdentity.candidateInputHash
    );
  });
}

/**
 * 将原生 tool-call 的控制动作名称（如 "action-final_answer"）归一化为
 * 对应的 AgentAction。覆盖 DeepSeek 等原生 tool-call 提供商可能产生的
 * 各种别名变体（连字符/下划线/前缀）。只在 native tool-call 进入
 * unknown_tool 拒绝之前调用；归一化后的动作不进入 workspace 工具
 * 执行器，走正常的 action 分发路径。
 */
export function normalizeNativeControlAction(
  name: string,
  args: Record<string, unknown> | undefined,
): AgentAction | null {
  const normalized = name.toLowerCase().replace(/[-_.]/g, "_");
  // 去掉可能的 "action_" 前缀
  const kind = normalized.replace(/^action_/, "");
  if (!isStructuredActionKind(kind)) return null;

  const payload = args ?? {};
  if (kind === "final_answer" || kind === "finalanswer") {
    const summary =
      typeof payload.summary === "string"
        ? payload.summary
        : typeof payload.text === "string"
          ? payload.text
          : typeof payload.message === "string"
            ? payload.message
            : "(completed)";
    return { type: "final_answer", summary };
  }
  if (kind === "ask_user" || kind === "askuser") {
    const question = typeof payload.question === "string" ? payload.question : "";
    if (!question) return null;
    const ctx =
      payload.context && typeof payload.context === "object"
        ? (payload.context as Record<string, unknown>)
        : {};
    let timeoutSec: number | null = null;
    if (typeof payload.timeout_sec === "number") {
      timeoutSec = payload.timeout_sec;
    } else if (typeof payload.timeoutSec === "number") {
      timeoutSec = payload.timeoutSec;
    }
    return {
      type: "ask_user",
      question,
      context: ctx,
      timeoutSec,
    };
  }
  if (kind === "abort") {
    return {
      type: "abort",
      reason: typeof payload.reason === "string" ? payload.reason : "aborted",
      canResume: false,
    };
  }
  // plan_update / acceptance_update 需要复杂嵌套参数，
  // 暂不支持原生桥接（模型可用文本 JSON 发出）
  return null;
}

// ── 记忆 LLM 接线辅助（v2）──

/**
 * v2 记忆 LLM 接线：
 * - "agent"：蒸馏/精排用主模型（label === "fake" 时跳过——FakeLanguageModel 按序消费预设
 *   响应，背景蒸馏会污染测试的预设序列）；裁决由 v2 runtime 按 settings 解析强模型
 * - "settings"：不传 llm（v2 runtime 内部解析 settings；无配置则降级）
 * - "off"：llm: null 禁用全部 LLM（含 settings 解析，蒸馏降级 append-only / 裁决直 ADD）
 */
export function buildMemoryLlmOptions(
  mode: "agent" | "settings" | "off",
  model: LanguageModel,
): {
  llm?: {
    distill: (p: string) => Promise<string>;
    rerank: (p: string) => Promise<string>;
  } | null;
} {
  if (mode === "off") return { llm: null };
  if (mode === "agent" && isRealAdapterModel(model)) {
    const complete = (prompt: string) =>
      model
        .complete([{ role: "user", content: prompt }] satisfies ChatMessage[])
        .then((r) => r.text);
    return { llm: { distill: complete, rerank: complete } };
  }
  // settings / 测试替身模型：由 v2 runtime 自行解析 settings 强模型；解析不到则降级
  return {};
}

/**
 * 是否真实适配器模型（OpenAI/Anthropic 兼容类）。
 * 测试替身（FakeLanguageModel / 内联 stub）不是实例——跳过接线：
 * 背景蒸馏/改写会吞掉测试模型的预设响应序列，且跨进程残留事件会污染后续测试。
 */
export function isRealAdapterModel(model: LanguageModel): boolean {
  return model instanceof OpenAICompatibleModel || model instanceof AnthropicCompatibleModel;
}
