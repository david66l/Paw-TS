export {
  createSweCompareManifest,
  findLocalTrajectoryHits,
  writeSweCompareManifest,
  SWE_COMPARE_SEEN_EXCLUSIONS,
  SWE_COMPARE_FORMAL_DEV_IDS,
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
