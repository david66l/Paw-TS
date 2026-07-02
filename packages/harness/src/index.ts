/**
 * Harness 包主入口 — 编码代理（Coding Agent）的运行时执行与安全基础设施。
 *
 * ## 包定位
 *
 * Harness 是 paw-ts 项目中负责**安全地执行编码代理操作**的核心包。它提供：
 *
 *   1. **Shell 命令执行**（run-shell）：同步/流式两种模式，支持超时、输出限制、
 *      工作区路径约束、Shell 沙箱隔离。
 *   2. **Shell 安全策略**（shell-policy-config + shell-guard）：基于 glob 模式的
 *      三级策略引擎（allow/ask/deny），内置生产安全的保守默认规则。
 *   3. **Shell AST 解析**（shell-ast）：基于 unbash 的 Bash 语法解析，输出归约后
 *      的小型 AST，供策略引擎进行精确匹配。
 *   4. **审计日志**（shell-audit）：JSON Lines 格式的命令评估审计日志，支持
 *      内存缓冲 + 定时刷盘，对接 SIEM/日志聚合系统。
 *   5. **Docker/Podman 沙箱**（sandbox/）：容器化 Shell 执行，提供网络隔离、
 *      文件系统只读、资源限制等多层安全保护。
 *   6. **MCP 客户端**（mcp-client）：Model Context Protocol 客户端，管理与外部
 *      MCP 服务器的连接和工具调用。
 *   7. **工具注册表**（registry）：管理可用工具（Bash、Read、Edit 等）的注册、
 *      查找和审批判断。
 *
 * ## 架构设计
 *
 * ```
 * registry.ts          → 工具注册中心（统一管理工具定义和审批规则）
 * run-shell.ts          → Shell 执行引擎（核心运行时）
 * shell-guard.ts        → Shell 安全围栏（准入控制）
 * shell-policy-config.ts → 策略配置（规则定义与匹配）
 * shell-ast.ts          → Shell 语法解析（AST 归约）
 * shell-audit.ts        → 审计日志（安全合规）
 * sandbox/              → 容器沙箱（隔离执行）
 *   ├── index.ts        → 统一导出
 *   ├── types.ts        → 沙箱类型定义
 *   ├── detect-runtime.ts → 容器运行时检测
 *   └── docker-runner.ts  → 容器命令构建
 * mcp-client.ts         → MCP 协议客户端
 * context.ts            → 执行上下文（代理运行环境）
 * ```
 *
 * ## 安全模型（纵深防御）
 *
 * harness 采用多层防御策略，每一层独立提供保护：
 *
 *   Layer 1 — Shell Guard（策略引擎）：
 *     命令级准入控制，基于 glob 模式匹配判断 allow/ask/deny。
 *
 *   Layer 2 — 工作区路径约束：
 *     所有 cwd 必须通过 `checkWorkspacePath` 验证，确保命令执行不逃逸
 *     工作区根目录。
 *
 *   Layer 3 — 资源限制：
 *     超时时间（1s ~ 300s）、输出字节数上限（256KB）、进程被 SIGTERM
 *     终止。防止失控命令耗尽系统资源。
 *
 *   Layer 4 — 容器沙箱（可选）：
 *     网络隔离（允许/拒绝）、文件系统只读、进程数限制、内存/CPU 限制。
 *     将命令与宿主机系统隔离开来。
 *
 *   Layer 5 — 审计日志：
 *     所有命令评估和决策被记录到审计日志中，支持事后追溯和合规审查。
 */
export type {
  HarnessContext,
  SubAgentLaunchOptions,
  SubAgentLauncher,
  SubAgentResult,
} from "./context.js";
export {
  executeTool,
  listToolNames,
  toolCatalogText,
  toolDefinitions,
  toolNameReverseMap,
  toolRequiresApproval,
  type ToolName,
  type ToolRunResult,
} from "./registry/index.js";
export {
  runShellInWorkspace,
  runShellInWorkspaceStreaming,
  type RunShellOptions,
  type RunShellResult,
  type RunShellStreamingOptions,
} from "./shell/index.js";
export {
  buildDockerShellExecSpec,
  detectContainerRuntime,
  DEFAULT_SANDBOX_IMAGE,
  OFF_SHELL_SANDBOX,
  isShellSandboxEnabled,
  type DockerShellExecSpec,
  type ShellSandboxConfig,
  type ShellSandboxMode,
  type ShellSandboxNetwork,
} from "./sandbox/index.js";
export {
  McpClientManager,
  type McpCallResult,
  type McpServerConfig,
  type McpToolRef,
} from "./mcp-client.js";
