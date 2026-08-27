import type { InputFactV1 } from "@paw/protocol";

import type { ControlDecision, LoopControlState } from "./contracts.js";
import type { ControlReducer } from "./ports.js";

export const INTERACTIVE_CONTROL_REDUCER_VERSION_V1 =
  "paw.interactive-control.v1" as const;
export const INTERACTIVE_CONTROL_REDUCER_VERSION_V2 =
  "paw.interactive-control.v2" as const;

/** 一个 run 开始时冻结的最小交互控制规则。 */
export interface InteractiveControlConfigV1 {
  readonly mode: "interactive";
  readonly maxModelTurns: number;
  /** 本轮自然停下时，是交付结果还是等待用户继续。 */
  readonly naturalStop: "complete" | "await_user";
}

/** 可完整重放并参与 state hash 的通用交互状态。 */
export interface InteractiveControlStateV1 extends LoopControlState {
  readonly reducerVersion: typeof INTERACTIVE_CONTROL_REDUCER_VERSION_V1;
  readonly modelTurns: number;
  readonly settledToolCalls: number;
  readonly decision: ControlDecision;
}

/** 多工作段运行开始时冻结的交互控制规则。 */
export interface InteractiveControlConfigV2 extends InteractiveControlConfigV1 {
  /** 包含隐式初始段（segment 0）的最大工作段数量。 */
  readonly maxSegments: number;
  /** 同一 run 内所有工作段合计的模型回合上限。 */
  readonly maxTotalModelTurns: number;
  /** Optional child-only checkpoint where progress-gated renewal begins. */
  readonly softModelTurns?: number;
  /** Size of each deterministic renewal window up to maxModelTurns. */
  readonly renewalModelTurns?: number;
  /** Maximum tolerated turn gap without meaningful progress at a checkpoint. */
  readonly softNoProgressTurns?: number;
}

/** Reducer v2 只重置段内计数；模型 turn、call 与 checkpoint 仍全 run 连续。 */
export interface InteractiveControlStateV2 extends LoopControlState {
  readonly reducerVersion: typeof INTERACTIVE_CONTROL_REDUCER_VERSION_V2;
  readonly segmentIndex: number;
  readonly segmentModelTurns: number;
  readonly totalModelTurns: number;
  readonly segmentSettledToolCalls: number;
  readonly totalSettledToolCalls: number;
  readonly decision: ControlDecision;
}

/**
 * 通用交互模式归约器。
 *
 * 它不猜 benchmark 是否通过，也不把工具业务报错误认为 Runtime 崩溃。
 * 所有结果只来自 canonical InputFact，模型的 natural stop 也必须经过这里。
 */
export function createInteractiveControlReducerV1(): ControlReducer<
  InputFactV1,
  InteractiveControlConfigV1,
  InteractiveControlStateV1
> {
  return {
    reduce(inputFacts, config) {
      assertConfig(config);
      const modelFacts = inputFacts.filter(
        (fact): fact is Extract<InputFactV1, { type: "model.settled" }> =>
          fact.type === "model.settled",
      );
      const toolFacts = inputFacts.filter(
        (fact): fact is Extract<InputFactV1, { type: "tool.settled" }> =>
          fact.type === "tool.settled",
      );
      return {
        reducerVersion: INTERACTIVE_CONTROL_REDUCER_VERSION_V1,
        modelTurns: modelFacts.length,
        settledToolCalls: toolFacts.length,
        decision: decide(inputFacts, modelFacts, toolFacts, config),
      };
    },
  };
}

/**
 * 支持同一 authoritative run 内多个用户工作段的唯一交互归约器。
 *
 * 它只把最新 work.segment_started 之后的控制事实作为当前段输入；所有
 * model turn、call ID、effect checkpoint 等持久身份仍由 Protocol 全局校验。
 */
export function createInteractiveControlReducerV2(): ControlReducer<
  InputFactV1,
  InteractiveControlConfigV2,
  InteractiveControlStateV2
> {
  return {
    reduce(inputFacts, config) {
      assertConfigV2(config);
      const markers = inputFacts.filter(
        (
          fact,
        ): fact is Extract<InputFactV1, { type: "work.segment_started" }> =>
          fact.type === "work.segment_started",
      );
      if (
        markers.some(
          (fact) =>
            fact.reducerVersion !== INTERACTIVE_CONTROL_REDUCER_VERSION_V2,
        )
      ) {
        throw new Error(
          "Work segment reducerVersion does not match interactive reducer v2",
        );
      }
      const latestMarker = markers.at(-1);
      const segmentIndex = latestMarker?.segmentIndex ?? 0;
      const markerOffset = latestMarker
        ? inputFacts.lastIndexOf(latestMarker) + 1
        : 0;
      const segmentFacts = inputFacts.slice(markerOffset);
      const segmentModelFacts = modelSettlements(segmentFacts);
      const allModelFacts = modelSettlements(inputFacts);
      const segmentToolFacts = toolSettlements(segmentFacts);
      const allToolFacts = toolSettlements(inputFacts);
      const baseDecision = decide(
        segmentFacts,
        segmentModelFacts,
        segmentToolFacts,
        config,
      );
      const budgetMayOverride =
        baseDecision.kind === "continue" || baseDecision.kind === "completed";
      const decision = freezeControlDecision(
        !budgetMayOverride
          ? baseDecision
          : segmentIndex >= config.maxSegments
            ? {
                kind: "incomplete",
                reason: "work-segment-budget-exhausted",
              }
            : segmentModelFacts.length > config.maxModelTurns
              ? {
                  kind: "incomplete",
                  reason: "model-turn-budget-exhausted",
                }
              : allModelFacts.length > config.maxTotalModelTurns ||
                  (allModelFacts.length === config.maxTotalModelTurns &&
                    baseDecision.kind === "continue")
                ? {
                    kind: "incomplete",
                    reason: "total-model-turn-budget-exhausted",
                  }
                : baseDecision,
      );
      return Object.freeze({
        reducerVersion: INTERACTIVE_CONTROL_REDUCER_VERSION_V2,
        segmentIndex,
        segmentModelTurns: segmentModelFacts.length,
        totalModelTurns: allModelFacts.length,
        segmentSettledToolCalls: segmentToolFacts.length,
        totalSettledToolCalls: allToolFacts.length,
        decision,
      });
    },
  };
}

function freezeControlDecision(decision: ControlDecision): ControlDecision {
  return Object.freeze({ ...decision });
}

function modelSettlements(
  facts: readonly InputFactV1[],
): readonly Extract<InputFactV1, { type: "model.settled" }>[] {
  return facts.filter(
    (fact): fact is Extract<InputFactV1, { type: "model.settled" }> =>
      fact.type === "model.settled",
  );
}

function toolSettlements(
  facts: readonly InputFactV1[],
): readonly Extract<InputFactV1, { type: "tool.settled" }>[] {
  return facts.filter(
    (fact): fact is Extract<InputFactV1, { type: "tool.settled" }> =>
      fact.type === "tool.settled",
  );
}

function decide(
  inputFacts: readonly InputFactV1[],
  modelFacts: readonly Extract<InputFactV1, { type: "model.settled" }>[],
  toolFacts: readonly Extract<InputFactV1, { type: "tool.settled" }>[],
  config: InteractiveControlConfigV1,
): ControlDecision {
  const abort = findLast(inputFacts, "abort.requested");
  if (abort) {
    return { kind: "aborted", reason: abort.reason ?? "abort-requested" };
  }

  const runtimeFailure = findLast(inputFacts, "runtime.failed");
  if (runtimeFailure) {
    return runtimeFailure.retryable
      ? { kind: "incomplete", reason: runtimeFailure.errorCode }
      : { kind: "failed", reason: runtimeFailure.errorCode };
  }

  const policyRequest = findLast(inputFacts, "policy.request_recorded");
  if (policyRequest) {
    switch (policyRequest.request) {
      case "continue":
        break;
      case "wait":
        return { kind: "await_user", reason: policyRequest.reasonCode };
      case "complete":
        return { kind: "completed", reason: policyRequest.reasonCode };
      case "incomplete":
        return { kind: "incomplete", reason: policyRequest.reasonCode };
    }
  }

  const latestModel = modelFacts.at(-1);
  if (!latestModel) return { kind: "continue" };
  switch (latestModel.status) {
    case "failed":
    case "rejected":
      return {
        kind: "failed",
        reason: latestModel.errorCode ?? "model-failed",
      };
    case "unknown":
      return { kind: "incomplete", reason: "model-result-unknown" };
    case "cancelled":
      return { kind: "incomplete", reason: "model-cancelled" };
    case "truncated":
      return { kind: "incomplete", reason: "model-output-truncated" };
    case "completed":
      break;
  }

  if (modelFacts.length >= config.maxModelTurns && latestModel.hasToolCalls) {
    return { kind: "incomplete", reason: "model-turn-budget-exhausted" };
  }
  if (latestModel.hasToolCalls) {
    const batch = latestToolBatch(inputFacts, latestModel, toolFacts);
    if (batch.some((fact) => fact.status === "unknown")) {
      return { kind: "incomplete", reason: "tool-result-unknown" };
    }
    if (batch.some((fact) => fact.status === "cancelled")) {
      return { kind: "incomplete", reason: "tool-cancelled" };
    }
    if (batch.some((fact) => fact.status === "rejected")) {
      return { kind: "await_user", reason: "tool-permission-rejected" };
    }
    return { kind: "continue" };
  }
  if (!latestModel.hasVisibleOutput) {
    return { kind: "incomplete", reason: "model-visible-output-missing" };
  }
  return config.naturalStop === "complete"
    ? { kind: "completed", reason: "interactive-natural-stop" }
    : { kind: "await_user", reason: "interactive-turn-finished" };
}

function latestToolBatch(
  inputFacts: readonly InputFactV1[],
  latestModel: Extract<InputFactV1, { type: "model.settled" }>,
  fallback: readonly Extract<InputFactV1, { type: "tool.settled" }>[],
): readonly Extract<InputFactV1, { type: "tool.settled" }>[] {
  const modelIndex = inputFacts.lastIndexOf(latestModel);
  if (modelIndex < 0) return fallback;
  const callIds = new Set(
    inputFacts
      .slice(modelIndex + 1)
      .filter(
        (fact): fact is Extract<InputFactV1, { type: "tool.call_observed" }> =>
          fact.type === "tool.call_observed",
      )
      .filter((fact) => fact.modelCallId === latestModel.modelCallId)
      .map((fact) => fact.callId),
  );
  return inputFacts
    .slice(modelIndex + 1)
    .filter(
      (fact): fact is Extract<InputFactV1, { type: "tool.settled" }> =>
        fact.type === "tool.settled" && callIds.has(fact.callId),
    );
}

function findLast<TType extends InputFactV1["type"]>(
  facts: readonly InputFactV1[],
  type: TType,
): Extract<InputFactV1, { type: TType }> | undefined {
  for (let index = facts.length - 1; index >= 0; index -= 1) {
    const fact = facts[index];
    if (fact?.type === type) {
      return fact as Extract<InputFactV1, { type: TType }>;
    }
  }
  return undefined;
}

function assertConfig(config: InteractiveControlConfigV1): void {
  if (
    config.mode !== "interactive" ||
    !Number.isSafeInteger(config.maxModelTurns) ||
    config.maxModelTurns <= 0 ||
    (config.naturalStop !== "complete" && config.naturalStop !== "await_user")
  ) {
    throw new Error("Interactive control config is invalid");
  }
}

function assertConfigV2(config: InteractiveControlConfigV2): void {
  assertConfig(config);
  if (
    !Number.isSafeInteger(config.maxSegments) ||
    config.maxSegments <= 0 ||
    !Number.isSafeInteger(config.maxTotalModelTurns) ||
    config.maxTotalModelTurns < config.maxModelTurns ||
    (config.softModelTurns !== undefined &&
      (!Number.isSafeInteger(config.softModelTurns) ||
        config.softModelTurns <= 0 ||
        config.softModelTurns > config.maxModelTurns)) ||
    (config.renewalModelTurns !== undefined &&
      (!Number.isSafeInteger(config.renewalModelTurns) ||
        config.renewalModelTurns <= 0)) ||
    (config.softNoProgressTurns !== undefined &&
      (!Number.isSafeInteger(config.softNoProgressTurns) ||
        config.softNoProgressTurns <= 0)) ||
    (config.softModelTurns === undefined) !==
      (config.renewalModelTurns === undefined) ||
    (config.softModelTurns === undefined) !==
      (config.softNoProgressTurns === undefined)
  ) {
    throw new Error("Interactive control v2 config is invalid");
  }
}
