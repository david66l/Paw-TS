// Shared implementation migrated from the legacy runtime.
export {
  isGitDiffCommand,
  containsExecutedGitDiffCommand,
  splitCommandSegments,
  parseCommandChain,
  tokenizeCommandSegment,
  tokenizeCommandSegments,
  type ShellCommandConnector,
  type ShellCommandSegment,
} from "@paw/core";
