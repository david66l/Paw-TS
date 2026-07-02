/**
 * 从 `.paw/settings.local.json` 读取 Shell 沙箱配置。
 * ===================================================
 *
 * Shell 沙箱用于隔离模型执行的 Shell 命令，防止对宿主系统造成损害。
 *
 * 模式（mode）：
 * - "off"（默认）：不隔离，直接在宿主机执行（开发/可信环境）
 * - "workspace"：限制在工作区目录内
 * - "strict"：完全隔离（Docker/Podman 容器）
 *
 * 网络（network）：
 * - "deny"（默认）：禁止网络访问
 * - "full"：允许网络访问
 *
 * 配置示例（.paw/settings.local.json）：
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
  // "hybrid" 是旧版配置，已废弃，按 "off" 处理
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
  // off 模式：返回预定义的关闭沙箱配置（直接在宿主机执行）
  if (mode === "off") {
    return OFF_SHELL_SANDBOX;
  }

  // 容器化沙箱配置
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
 * 从 `.paw/settings.local.json` 读取 Shell 沙箱配置。
 *
 * @returns ShellSandboxConfig（默认：mode="off" 的关闭沙箱）
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
