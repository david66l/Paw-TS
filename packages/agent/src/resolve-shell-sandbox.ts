import {
  DEFAULT_SANDBOX_IMAGE,
  OFF_SHELL_SANDBOX,
  type ShellSandboxConfig,
  type ShellSandboxMode,
  type ShellSandboxNetwork,
} from "@paw/harness";

import { readSetting } from "./settings.js";

const DEFAULT_MODE: ShellSandboxMode = "off";
const DEFAULT_NETWORK: ShellSandboxNetwork = "deny";

function parseSandboxMode(value: unknown): ShellSandboxMode {
  if (value === "workspace" || value === "strict" || value === "off") {
    return value;
  }
  // Legacy hybrid setting — no longer supported; treat as off.
  if (value === "hybrid") {
    return "off";
  }
  return DEFAULT_MODE;
}

function parseSandboxNetwork(value: unknown): ShellSandboxNetwork {
  if (value === "full" || value === "deny") {
    return value;
  }
  return DEFAULT_NETWORK;
}

function parseSandboxConfig(value: unknown): ShellSandboxConfig | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const raw = value as Record<string, unknown>;
  const mode = parseSandboxMode(raw.mode ?? DEFAULT_MODE);
  if (mode === "off") {
    return OFF_SHELL_SANDBOX;
  }

  const runtime =
    raw.runtime === "docker" || raw.runtime === "podman"
      ? raw.runtime
      : undefined;
  const image =
    typeof raw.image === "string" && raw.image.trim()
      ? raw.image.trim()
      : DEFAULT_SANDBOX_IMAGE;
  const memoryMb =
    typeof raw.memory_mb === "number" && Number.isFinite(raw.memory_mb)
      ? Math.max(256, Math.floor(raw.memory_mb))
      : undefined;
  const cpus =
    typeof raw.cpus === "number" && Number.isFinite(raw.cpus)
      ? Math.max(0.25, raw.cpus)
      : undefined;

  return {
    mode,
    network: parseSandboxNetwork(raw.network ?? DEFAULT_NETWORK),
    image,
    ...(runtime ? { runtime } : {}),
    ...(memoryMb !== undefined ? { memoryMb } : {}),
    ...(cpus !== undefined ? { cpus } : {}),
  };
}

/**
 * Reads shell sandbox settings from `.paw/settings.local.json`.
 *
 * ```json
 * {
 *   "sandbox": {
 *     "mode": "workspace",
 *     "network": "deny",
 *     "image": "paw-ts/sandbox:local"
 *   }
 * }
 * ```
 */
export function resolveShellSandboxConfig(
  workspaceRoot: string,
): ShellSandboxConfig {
  return readSetting(
    workspaceRoot,
    (s) => s.sandbox,
    OFF_SHELL_SANDBOX,
    parseSandboxConfig,
  );
}
