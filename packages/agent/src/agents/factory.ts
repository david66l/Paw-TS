/**
 * 从 AgentSpec 装配 Orchestrator 选项 / SharedContext
 */

import type { LanguageModel } from "@paw/models";
import {
  createDeepSeekFlashModel,
  createDefaultLanguageModel,
} from "@paw/models";
import type { SharedContext } from "../orchestrator/types.js";
import type { AgentSpec } from "./types.js";
import { resolveAllowedTools } from "./resolve-tools.js";
import { validateAgentSpec } from "./validate.js";

export interface MaterializedAgent {
  readonly spec: AgentSpec;
  readonly sharedContext: SharedContext;
  readonly childPolicy: "read_only" | "read_write";
  readonly maxSteps: number;
  readonly memoryExtraction: "off" | "background" | "await";
  readonly runMode: "full" | "child";
  /** null = 不裁工具 */
  readonly allowedTools: readonly string[] | null;
  readonly model: LanguageModel | undefined;
}

/** 按 model 偏好选模型；inherit → undefined（调用方用默认） */
export function resolveModelForSpec(
  spec: AgentSpec,
  workspaceRoot: string,
  inheritModel?: LanguageModel,
): LanguageModel | undefined {
  if (spec.model === "flash") {
    return createDeepSeekFlashModel(workspaceRoot) ?? inheritModel;
  }
  if (spec.model === "pro") {
    return createDefaultLanguageModel(workspaceRoot);
  }
  return inheritModel;
}

/**
 * 将 Spec + 本次 task 物化为运行参数。
 * goal/task 为本次派活目标；facts/artifacts 可由调用方再补。
 */
export function materializeAgent(
  spec: AgentSpec,
  task: string,
  opts?: {
    readonly workspaceRoot?: string;
    readonly inheritModel?: LanguageModel;
    readonly facts?: readonly string[];
    readonly constraints?: readonly string[];
    readonly forceChild?: boolean;
  },
): MaterializedAgent {
  const v = validateAgentSpec(spec);
  if (!v.ok) {
    throw new Error(
      `Invalid AgentSpec ${spec.id}: ${v.errors.map((e) => e.message).join("; ")}`,
    );
  }

  const allowedTools = v.resolvedTools;
  const runMode: "full" | "child" =
    opts?.forceChild || spec.kind === "worker" ? "child" : "full";

  const sharedContext: SharedContext = {
    role: spec.prompt.trim() || `You are ${spec.name} (${spec.role}).`,
    task,
    facts: opts?.facts ? [...opts.facts] : [],
    constraints: [
      ...(opts?.constraints ?? []),
      "Do not modify files outside the workspace.",
      "Do not execute destructive shell commands.",
    ],
    artifacts: [],
    state: { completed: [], pending: [task] },
    outputFormat: spec.outputFormat,
    childPolicy: spec.childPolicy,
  };

  const model =
    opts?.workspaceRoot !== undefined
      ? resolveModelForSpec(spec, opts.workspaceRoot, opts.inheritModel)
      : opts?.inheritModel;

  return {
    spec,
    sharedContext,
    childPolicy: spec.childPolicy,
    maxSteps: spec.maxSteps,
    memoryExtraction: spec.memoryExtraction,
    runMode,
    allowedTools,
    model,
  };
}

/** 仅解析 allowedTools（装配 orchestrator 时用） */
export function allowedToolsForSpec(spec: AgentSpec): readonly string[] | null {
  return resolveAllowedTools({
    tools: spec.tools,
    canSpawn: spec.canSpawn,
  });
}
