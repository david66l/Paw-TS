/**
 * 容器运行时检测模块。
 *
 * ## 功能概述
 * 本模块负责在宿主机上检测可用的容器运行时（Docker 或 Podman），
 * 返回第一个可用的运行时名称。它是 Shell 沙箱功能的前提条件——如果
 * 宿主机上没有安装 Docker 或 Podman，沙箱模式将回退为报错。
 *
 * ## 核心设计决策
 *
 * 1. **支持 Docker 和 Podman 双运行时**：
 *    两种运行时都支持 OCI 镜像标准，Podman 是 Docker 的无守护进程替代品。
 *    系统按优先级依次探测，返回第一个可用的。
 *
 * 2. **探测方式**：
 *    对每个候选运行时调用 `<runtime> version` 命令（如 `docker version`），
 *    检查返回码是否为 0。设置 5 秒超时防止挂起的守护进程阻塞探测。
 *
 * 3. **优先级策略**：
 *    可以通过 `preferred` 参数指定偏好顺序，优先探测指定的运行时。
 *    如果未指定偏好，按 `["docker", "podman"]` 顺序探测（Docker 优先）。
 *
 * 4. **无侵入性**：
 *    探测使用 `spawnSync` 同步执行，结果立即可得。不修改系统状态，
 *    不拉取镜像，不做任何持久化变更。
 */

import { spawnSync } from "node:child_process";

/**
 * 检测宿主机上第一个可用的容器运行时。
 *
 * 探测策略：
 *   1. 如果指定了 `preferred`，优先探测偏好运行时
 *   2. 对每个候选运行时执行 `<runtime> version` 命令
 *   3. 返回第一个返回码为 0 的运行时名称
 *   4. 如果都不可用，返回 `undefined`
 *
 * @param preferred - 可选的偏好运行时（"docker" 或 "podman"），优先探测
 * @returns 第一个可用的运行时名称，不可用时返回 undefined
 */
export function detectContainerRuntime(
  preferred?: "docker" | "podman",
): string | undefined {
  // 构建探测顺序：偏好优先，未指定则 Docker 优先
  const order: ("docker" | "podman")[] = preferred
    ? preferred === "docker"
      ? ["docker", "podman"]   // 偏好 docker → [docker, podman]
      : ["podman", "docker"]   // 偏好 podman → [podman, docker]
    : ["docker", "podman"];    // 无偏好 → [docker, podman]

  // 依次探测每个运行时
  for (const runtime of order) {
    const probe = spawnSync(runtime, ["version"], {
      encoding: "utf8",
      timeout: 5000,  // 5 秒超时，防止守护进程挂起
    });
    // 返回码为 0 表示该运行时可用
    if (probe.status === 0) {
      return runtime;
    }
  }
  // 所有候选运行时都不可用
  return undefined;
}
