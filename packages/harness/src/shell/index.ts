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
  startManagedShellInWorkspaceV1,
  type ManagedShellJobV1,
  type RunShellOptions,
  type RunShellStreamingOptions,
  type StartManagedShellOptions,
} from "./execute.js";
