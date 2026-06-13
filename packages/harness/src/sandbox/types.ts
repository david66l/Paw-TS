/** Shell execution sandbox mode (Docker/Podman). */
export type ShellSandboxMode = "off" | "workspace" | "strict";

/** Container network policy for sandboxed shell. */
export type ShellSandboxNetwork = "deny" | "full";

export interface ShellSandboxConfig {
  readonly mode: ShellSandboxMode;
  readonly network: ShellSandboxNetwork;
  /** Container image with a POSIX shell and common dev utilities. */
  readonly image: string;
  readonly runtime?: "docker" | "podman";
  readonly memoryMb?: number;
  readonly cpus?: number;
}

export const DEFAULT_SANDBOX_IMAGE = "debian:bookworm-slim";

export const OFF_SHELL_SANDBOX: ShellSandboxConfig = {
  mode: "off",
  network: "deny",
  image: DEFAULT_SANDBOX_IMAGE,
};

export function isShellSandboxEnabled(
  config: ShellSandboxConfig | undefined,
): config is ShellSandboxConfig & { mode: "workspace" | "strict" } {
  return config !== undefined && config.mode !== "off";
}
