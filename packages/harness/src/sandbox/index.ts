/**
 * Shell 沙箱模块统一导出入口。
 *
 * ## 模块定位
 * 沙箱子模块（sandbox/）是 harness 的安全隔离层，负责将用户 Shell 命令
 * 包装在 Docker/Podman 容器中执行，提供网络隔离、文件系统只读、资源限制等
 * 安全保护。
 *
 * ## 导出内容
 *
 * 从各子模块重新导出以下公共 API：
 *
 * ### docker-runner.ts — 容器命令构建
 *   - `buildDockerShellExecSpec`: 组装完整的 `docker run` 命令参数
 *   - `hostPathToContainerPath`: 宿主机路径 → 容器内路径映射
 *   - `DockerShellExecSpec`: 容器执行规范类型
 *
 * ### detect-runtime.ts — 运行时检测
 *   - `detectContainerRuntime`: 自动发现 Docker/Podman 可用性
 *
 * ### types.ts — 类型定义与常量
 *   - `DEFAULT_SANDBOX_IMAGE`: 默认沙箱镜像名
 *   - `OFF_SHELL_SANDBOX`: 预定义的"关闭沙箱"配置常量
 *   - `isShellSandboxEnabled`: 判断沙箱是否启用的类型守卫
 *   - `ShellSandboxConfig`: 沙箱配置类型
 *   - `ShellSandboxMode`: 沙箱模式类型（off / workspace / strict）
 *   - `ShellSandboxNetwork`: 网络策略类型（deny / full）
 *
 * ## 使用方式
 *
 * 外部使用者只需从 `./sandbox/index.js` 导入，无需关心内部文件组织：
 *
 * ```typescript
 * import { buildDockerShellExecSpec, isShellSandboxEnabled } from "./sandbox/index.js";
 * ```
 */

export {
  buildDockerShellExecSpec,
  hostPathToContainerPath,
  type DockerShellExecSpec,
} from "./docker-runner.js";
export { detectContainerRuntime } from "./detect-runtime.js";
export {
  DEFAULT_SANDBOX_IMAGE,
  OFF_SHELL_SANDBOX,
  isShellSandboxEnabled,
  type ShellSandboxConfig,
  type ShellSandboxMode,
  type ShellSandboxNetwork,
} from "./types.js";
