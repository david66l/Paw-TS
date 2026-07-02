/**
 * Docker/Podman 沙箱命令构建器。
 *
 * ## 功能概述
 * 本模块负责将用户请求的 Shell 命令包装为容器执行命令（`docker run` 或
 * `podman run`），并配置容器的安全隔离策略（文件系统挂载、网络、资源限制）。
 *
 * ## 两种沙箱模式
 *
 * ### workspace（工作区模式）— 较宽松
 * - 宿主机工作区以读写模式挂载到容器 `/workspace`
 * - 命令可以正常读写项目文件
 * - 适用于大多数开发场景（如 `npm test`, `tsc --noEmit`）
 *
 * ### strict（严格模式）— 更严格
 * - 工作区以**只读**模式挂载
 * - `/tmp` 作为独立的 tmpfs 挂载（可执行、nosuid、512MB）
 * - 适用于高风险的命令，确保不会修改项目文件
 *
 * ## 容器安全策略
 *
 * 无论哪种模式，容器都配置了以下安全措施：
 *   - `--rm`：执行完成后自动删除容器（不留残留状态）
 *   - `-i`：保持 stdin 打开（支持管道输入）
 *   - `--pids-limit 256`：限制容器内最大进程数（防止 fork bomb）
 *   - `--memory`：限制容器内存使用（默认 2048MB，可配置）
 *   - `--cpus`：限制 CPU 核心数（默认 2，可配置）
 *   - 网络策略：
 *     - `deny` → `--network none`（完全断网）
 *     - `full` → 保持默认网络（允许访问外部网络）
 *
 * ## 路径映射（hostPathToContainerPath）
 *
 * 宿主机文件路径需要映射到容器内的路径。映射规则：
 *   - 工作区根目录 `/path/to/project` → `/workspace`
 *   - 工作区内的文件 `/path/to/project/src/main.ts` → `/workspace/src/main.ts`
 *   - 工作区外的路径 → 安全回退到 `/workspace`
 *
 * 这是纵深防御的一部分：即使上游传入了越界的 cwd，映射也会将其
 * 安全地限制在 `/workspace` 内。
 */

import path from "node:path";

import { detectContainerRuntime } from "./detect-runtime.js";
import {
  DEFAULT_SANDBOX_IMAGE,
  type ShellSandboxConfig,
  type ShellSandboxNetwork,
} from "./types.js";

/**
 * 容器执行规范。
 * 包含最终要执行的运行时程序、参数列表和沙箱元信息。
 */
export interface DockerShellExecSpec {
  /** 运行时程序路径（"docker" 或 "podman"） */
  readonly runtime: string;
  /** 运行时参数列表（如 ["run", "--rm", "-i", ...]） */
  readonly args: readonly string[];
  /** 容器内的工作目录（已映射的路径） */
  readonly containerCwd: string;
  /** 使用的容器镜像名称 */
  readonly image: string;
  /** 网络策略 */
  readonly network: ShellSandboxNetwork;
  /** 沙箱模式 */
  readonly mode: "workspace" | "strict";
}

/**
 * 将宿主机路径映射为容器内路径。
 *
 * 映射逻辑：
 *   1. 解析工作区根目录和宿主机路径为绝对路径
 *   2. 计算宿主机路径相对于工作区的相对路径
 *   3. 在容器内重建为 `/workspace/<相对路径>`
 *
 * 安全检查：
 *   - 如果路径在工作区外（`rel` 以 `..` 开头），回退到 `/workspace`
 *   - 如果路径就是工作区根目录，返回 `/workspace`
 *   - 跨平台路径分隔符映射（Windows `\` → POSIX `/`）
 *
 * @param workspaceRoot - 宿主机工作区根目录绝对路径
 * @param hostPath - 宿主机上要映射的路径
 * @returns 容器内对应的路径
 */
export function hostPathToContainerPath(
  workspaceRoot: string,
  hostPath: string,
): string {
  const root = path.resolve(workspaceRoot);
  const target = path.resolve(hostPath);
  const rel = path.relative(root, target);

  // 就是工作区根目录本身
  if (!rel || rel === ".") {
    return "/workspace";
  }

  // 路径在工作区外 → 安全回退到 /workspace（纵深防御）
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return "/workspace";
  }

  // 将相对路径映射到容器内的 /workspace 目录下
  return `/workspace/${rel.split(path.sep).join("/")}`;
}

/**
 * 构建 Docker/Podman 容器执行规范。
 *
 * 这是沙箱的核心函数：接收用户命令和沙箱配置，输出一组完整的
 * `docker run` / `podman run` 参数。
 *
 * 执行流程：
 *   1. 检测可用的容器运行时（docker/podman）
 *   2. 将 cwd 路径映射到容器内路径
 *   3. 组装 `docker run` 参数列表（安全限制、文件挂载、网络等）
 *   4. 末尾追加容器镜像名和要执行的 Shell 命令
 *
 * @param config - 沙箱配置（包含模式、内存、CPU、网络、镜像等）
 * @param input - 输入参数（工作区根、cwd 路径、命令字符串）
 * @returns 容器执行规范，或错误信息
 */
export function buildDockerShellExecSpec(
  config: ShellSandboxConfig & { mode: "workspace" | "strict" },
  input: {
    readonly workspaceRoot: string;
    readonly cwdPath: string;
    readonly command: string;
  },
): DockerShellExecSpec | { readonly error: string } {
  // 1. 检测可用的容器运行时
  const runtime = detectContainerRuntime(config.runtime);
  if (!runtime) {
    return {
      error:
        "shell sandbox is enabled but neither docker nor podman is available",
    };
  }

  // 2. 路径映射
  const workspaceRoot = path.resolve(input.workspaceRoot);
  const containerCwd = hostPathToContainerPath(workspaceRoot, input.cwdPath);
  const image = config.image.trim() || DEFAULT_SANDBOX_IMAGE;
  const memoryMb = config.memoryMb ?? 2048;  // 默认 2GB 内存限制
  const cpus = config.cpus ?? 2;              // 默认 2 核 CPU 限制

  // 3. 组装 docker run 基础参数
  const args: string[] = [
    "run",
    "--rm",        // 执行完成后自动删除容器
    "-i",          // 保持 stdin 打开（允许管道输入）
    "-w",          // 设置容器内工作目录
    containerCwd,
    "-v",          // 挂载宿主机工作区到容器
    `${workspaceRoot}:/workspace:rw`,
    "--pids-limit", "256",    // 限制最大进程数（防 fork bomb）
    "--memory",    `${memoryMb}m`,  // 内存限制
    "--cpus",      String(cpus),    // CPU 核心数限制
  ];

  // 4. 网络策略
  if (config.network === "deny") {
    args.push("--network", "none");  // 完全断网
  }
  // "full" 时保持默认网络，不添加额外限制

  // 5. 严格模式：只读根文件系统 + 独立的临时目录
  if (config.mode === "strict") {
    args.push(
      "--read-only",              // 根文件系统只读
      "--tmpfs",                  // /tmp 作为内存文件系统
      "/tmp:exec,nosuid,size=512m",  // 可执行、禁止 setuid、512MB 上限
    );
  }

  // 6. 末尾追加镜像名和要执行的命令（通过 sh -lc 执行，支持别名和环境）
  args.push(image, "sh", "-lc", input.command);

  return {
    runtime,
    args,
    containerCwd,
    image,
    network: config.network,
    mode: config.mode,
  };
}
