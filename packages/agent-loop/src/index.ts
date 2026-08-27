/**
 * @paw/agent-loop — Paw Next 的简洁 Agent Loop 契约。
 *
 * 这个包提供窄接口和内存可测的最小循环。Runtime 适配器与持久事件协议由
 * 外层提供；这个包不得依赖旧 `@paw/agent` 或 benchmark 代码。
 */

export {
  type AgentLoopContinueCursorV1,
  type InspectAgentLoopContinueCursorOptionsV1,
  inspectAgentLoopContinueCursorV1,
  runAgentLoop,
} from "./agent-loop.js";
export {
  INTERACTIVE_CONTROL_REDUCER_VERSION_V1,
  INTERACTIVE_CONTROL_REDUCER_VERSION_V2,
  createInteractiveControlReducerV1,
  createInteractiveControlReducerV2,
  type InteractiveControlConfigV1,
  type InteractiveControlConfigV2,
  type InteractiveControlStateV1,
  type InteractiveControlStateV2,
} from "./interactive-control.js";
export { assertReplayEquivalentV1 } from "./replay.js";
export {
  planWorkSegmentStartV1,
  type PlanWorkSegmentStartOptionsV1,
  type WorkSegmentStartPlanV1,
  type WorkSegmentStartVerificationV1,
} from "./work-segment.js";

export type {
  AgentLoopDependencies,
  AgentLoopFactMapper,
  AgentLoopOptions,
  ControlDecision,
  LoopContextInput,
  LoopControlState,
  LoopError,
  LoopToolCall,
  ModelSettlement,
  ToolSettlement,
} from "./contracts.js";

export type { ReplayVerificationV1 } from "./replay.js";

export type {
  Context,
  ControlReducer,
  LoopInputPort,
  LoopPolicy,
  LoopSafeBoundary,
  Model,
  ModelCallOptions,
  ModelStreamSink,
  PolicyCallOptions,
  PortCallOptions,
  PromotedInputSource,
  SafeBoundaryReporter,
  SequencedInputFact,
  Session,
  SessionInputSnapshot,
  StateHasher,
  ToolBatchOptions,
  ToolExecutor,
  VerifiedModelResponseEvidenceV1,
} from "./ports.js";
