/**
 * Collaboration mode — daily coding vs multi-agent orchestration.
 *
 * coding (default): single long-run implementer; full TaskLifecycle loop;
 *   no roster / no spawn pressure.
 * orchestrated: 狸花 + 花名册调度（显式 /team 或 settings）。
 */

import {
  DEFAULT_LIFECYCLE_BUDGET,
  type LifecycleBudget,
} from "./lifecycle/budget.js";

export type CollaborationMode = "coding" | "orchestrated";

/** Long-run single-agent budget (loop engineering / SWE / daily coding). */
export const CODING_LIFECYCLE_BUDGET: LifecycleBudget = {
  maxSteps: 64,
  timeoutMs: 30 * 60_000,
  childMaxSteps: DEFAULT_LIFECYCLE_BUDGET.childMaxSteps,
  idleFuseHardStopTrips: 2,
};

/**
 * Identity for coding mode — reinforces edit→test→fix loop without
 * pushing run_agent. Full Paw system prompt (Doing tasks / VerificationGate)
 * remains the control plane.
 */
export const CODING_ROOT_IDENTITY = `你是 Paw 编码 Agent（日常单人长跑模式）。

职责：
1. 自己读代码、改文件、跑测试；默认亲自实现，不要调度其他 Agent
2. 长任务拆成可验证的小步，边做边验（edit → test → 失败则诊断再改）
3. 测红就继续修，直到测绿，或诚实说明卡住原因与已尝试路径
4. 用 todo 跟踪进度可以，但执行必须自己完成

约束：
- 不要只描述方案或假装改过文件；没有宿主确认的文件修改事实就不要宣称已修复
- 不要创建无必要的 helper 脚本顶替对源码的直接修改
- 破坏性操作前先确认；优先最小改动
- 用户在闲聊/问答时可以直接回答，不必强行改仓库`;

export interface ResolvedCollaboration {
  readonly mode: CollaborationMode;
  /** Agent file id for orchestrated root; coding mode usually has none. */
  readonly rootAgentId: string | undefined;
  readonly injectRoster: boolean;
  readonly forceSpawnTools: boolean;
  readonly canSpawn: boolean;
  readonly identityText: string | undefined;
  readonly defaultBudget: Partial<LifecycleBudget>;
}

function parseMode(raw: unknown): CollaborationMode | undefined {
  if (raw === "coding") return "coding";
  if (raw === "orchestrated" || raw === "team" || raw === "multi") {
    return "orchestrated";
  }
  return undefined;
}

/**
 * Resolve collaboration mode from explicit opts, settings, or rootAgentId hint.
 * Default: coding (daily single-agent long-run).
 */
export function resolveCollaborationMode(input: {
  readonly collaborationMode?: CollaborationMode;
  readonly rootAgentId?: string;
  readonly settings?: Record<string, unknown>;
}): ResolvedCollaboration {
  const fromSettings = parseMode(
    input.settings?.agent_mode ?? input.settings?.collaboration_mode,
  );
  const mode: CollaborationMode =
    input.collaborationMode ??
    fromSettings ??
    (input.rootAgentId === "lihua" ? "orchestrated" : "coding");

  if (mode === "orchestrated") {
    return {
      mode,
      rootAgentId: input.rootAgentId ?? "lihua",
      injectRoster: true,
      forceSpawnTools: true,
      canSpawn: true,
      identityText: undefined, // filled from root Spec
      defaultBudget: {},
    };
  }

  return {
    mode: "coding",
    rootAgentId: undefined,
    injectRoster: false,
    forceSpawnTools: false,
    canSpawn: false,
    identityText: CODING_ROOT_IDENTITY,
    defaultBudget: CODING_LIFECYCLE_BUDGET,
  };
}
