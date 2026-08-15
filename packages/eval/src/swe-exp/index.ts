export type {
  SweInstance,
  SweExpPair,
  SweExpArmResult,
  SweExpPairResult,
  SweExpPairedStats,
  SweExpReport,
} from "./types.js";

export type {
  SweBenchLiteInstance,
  SweExpAgentPair,
  SweExpArmCheckpoint,
  SweExpArmResultExtended,
  SweExpRunManifest,
  HistorySeedInput,
} from "./agent-types.js";

export {
  statementSimilarity,
  loadSweInstancesJsonl,
  buildSameRepoPairs,
  type BuildPairsOptions,
} from "./pairs.js";

export {
  binomialSignTestP,
  armOutcome,
  summarizeSweExp,
  sweExpPassed,
  buildSweExpReport,
  renderSweExpReport,
  summarizeLifecycleGates,
  lifecycleGatesOk,
  type LifecycleGateSummary,
} from "./report.js";

export {
  SWE_EXP_BUILTIN_PAIRS,
  lessonGoalOverlap,
  type SweExpBuiltinPair,
  type SweExpHistoryLesson,
  type SweExpWorkspaceFile,
} from "./fixtures.js";

export {
  distillHistoryLesson,
  assertNoGoldLeak,
  extractMentionedPaths,
} from "./history-seed.js";

export {
  runSweExpBuiltin,
  mergeExternalResolveResults,
  type SweExpMode,
  type SweExpRunOptions,
} from "./harness.js";

export { runSweExpAgent, type SweExpAgentRunOptions } from "./agent-harness.js";
export { buildSweAgentGoal } from "./agent-arm.js";
export { buildSweAcceptanceCriteria } from "./acceptance.js";
export {
  harnessPythonArgs,
  resolveSwebenchPythonCommand,
  swebenchPythonCandidates,
  officialHarnessArgs,
  parseResolvedFromHarnessOutput,
} from "./evaluate.js";

export {
  ensureLiteJsonl,
  loadLiteInstances,
  buildAgentPairs,
  downloadSweBenchLite,
} from "./dataset.js";

export {
  isArmCompleted,
  loadArmCheckpoint,
  saveArmCheckpoint,
  writeJsonAtomic,
} from "./checkpoint.js";
