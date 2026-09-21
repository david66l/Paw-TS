/** Shared Paw Next V3 entry point for embedded hosts. No CLI startup side effects. */
export {
  runFreshPawNextTaskV3,
  runExistingPawNextTaskV3,
  runExistingPawNextWorkSegmentV3,
  compactExistingPawNextTaskV3,
  maintainExistingPawNextMemoryV3,
  type RunFreshPawNextTaskInputV3,
  type PawNextLiveInputV1,
  type PawNextChildControlV1,
  type PawNextThinkingRecoveryPolicyV1,
  type PawNextThinkingRecoveryTelemetryV1,
  type PawNextPhaseEffortPolicyV1,
  type PawNextPhaseEffortTelemetryV1,
} from "./composition.js";
export {
  buildPawNextTaskProfileV3,
  type PawNextProductProfileV3,
  type BuiltPawNextTaskProfileV3,
} from "./product-profile-v3.js";
export { loadPawNextCollaborationRosterV1 } from "./collaboration-roster-adapter.js";
export type { StageGraphSnapshot } from "./stage-graph.js";
export { LONG_HORIZON_MANAGER_PROMPT } from "./long-horizon.js";

export { projectEnvironmentAcceptance } from "./environment-audit.js";
export {
  assertExecutionDeadlineV1,
  type ExecutionDeadlineV1,
} from "./execution-budget.js";
