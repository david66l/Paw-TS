export {
  createSweCompareManifest,
  createPawSeenDevelopmentManifest,
  createPawFreshDevelopmentManifest,
  findLocalTrajectoryHits,
  selectPawFreshDevelopmentIds,
  writeSweCompareManifest,
  SWE_COMPARE_SEEN_EXCLUSIONS,
  SWE_COMPARE_FORMAL_DEV_IDS,
  PAW_SEEN_DEVELOPMENT_IDS,
  PAW_FRESH_DEVELOPMENT_RULE,
  PAW_KNOWN_EXPOSED_IDS,
} from "./manifest.js";
export { buildSweCompareGoal } from "./goal.js";
export {
  interpretPreflightSummary,
  preflightSweCompareInstance,
  PREFLIGHT_SENTINEL_PATCH,
} from "./preflight.js";
export {
  auditClaudeTraceIntegrity,
  auditPawTraceIntegrity,
  auditSweCompareResult,
  allowSweCompareToolCall,
  claudeCodeArgs,
  collectTraceMutationHints,
  createSweCompareToolEffectPolicy,
  createSweCompareToolExecutionPolicy,
  extractClaudePatchFromTrace,
  parseClaudeStream,
  recoverClaudeResultPatch,
  recoverPawResultPatch,
  sweCompareNetworkViolation,
  runSweCompareArm,
  validateCompareRun,
  verifySweCompareResult,
  type SweCompareRunnerName,
  type SweCompareRunResult,
  type SweCompareIntegrityAudit,
} from "./runner.js";
export type {
  SweCompareInstanceManifest,
  SweCompareManifest,
  SweCompareQualification,
} from "./types.js";
