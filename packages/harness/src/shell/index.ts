export {
  classifyShellCommand,
  interpretShellExitCode,
  type ShellCommandClassification,
  type ExitCodeInterpretation,
} from "./analysis.js";

export type { RunShellResult } from "./analysis.js";

export {
  runShellInWorkspace,
  runShellInWorkspaceStreaming,
  type RunShellOptions,
  type RunShellStreamingOptions,
} from "./execute.js";
