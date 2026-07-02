/**
 * Shell 执行沙箱类型定义。
 * =======================
 *
 * Shell 沙箱用于隔离模型执行的 Shell 命令。
 *
 * 模式：
 * - "off"：不隔离（开发/可信环境）
 * - "workspace"：限制在工作区目录内
 * - "strict"：完全容器隔离（Docker/Podman）
 *
 * 面试要点：
 * - 为什么需要沙箱？LLM 可能生成破坏性命令，沙箱是最后一道防线
 * - Docker vs Podman：Podman 不需要 daemon，更安全（rootless）
 */

/** Shell 执行沙箱模式 */
export type ShellSandboxMode = "off" | "workspace" | "strict";

/** 沙箱化 Shell 的容器网络策略 */
export type ShellSandboxNetwork = "deny" | "full";

export interface ShellSandboxConfig {
  readonly mode: ShellSandboxMode;
  readonly network: ShellSandboxNetwork;
  /** 包含 POSIX shell 和常用开发工具的容器镜像 */
  readonly image: string;
  /** 容器运行时（自动检测） */
  readonly runtime?: "docker" | "podman";
  /** 内存限制（MB） */
  readonly memoryMb?: number;
  /** CPU 限制（核心数） */
  readonly cpus?: number;
}

/** 默认沙箱镜像：Debian Bookworm Slim（体积小、工具全） */
export const DEFAULT_SANDBOX_IMAGE = "debian:bookworm-slim";

/** 关闭沙箱的预设配置 */
export const OFF_SHELL_SANDBOX: ShellSandboxConfig = {
  mode: "off",
  network: "deny",
  image: DEFAULT_SANDBOX_IMAGE,
};

/** 类型守卫：判断沙箱是否已启用（非 off 模式） */
export function isShellSandboxEnabled(
  config: ShellSandboxConfig | undefined,
): config is ShellSandboxConfig & { mode: "workspace" | "strict" } {
  return config !== undefined && config.mode !== "off";
}
