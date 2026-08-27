/**
 * AgentSpec — 可复用、可注册的 Agent 声明。
 *
 * 文件形态：`.paw/agents/<id>.md`（YAML frontmatter + 正文 system prompt）
 * 与 skills 同思路：加/改 Agent = 改文件；Registry 加载；Factory 实例化。
 */

export type ChildPolicy = "read_only" | "read_write";
export type AgentModelPref = "flash" | "pro" | "inherit";
export type AgentRunKind = "root" | "worker";
export type MemoryExtractionMode = "off" | "background" | "await";

/**
 * 工具白名单：
 * - `"inherit"`：不裁工具（仍受 childPolicy 硬拦）
 * - 字符串数组：仅允许这些工具（完整名或短名，解析后归一为 workspace.*）
 */
export type AgentToolsSpec = "inherit" | readonly string[];

export interface AgentSpec {
  readonly id: string;
  readonly name: string;
  /** 短职责标签（花名册 / 调度摘要） */
  readonly role: string;
  readonly emoji?: string;
  readonly description?: string;
  /** 正文 = system / SharedContext.role 主文案 */
  readonly prompt: string;
  readonly tools: AgentToolsSpec;
  readonly childPolicy: ChildPolicy;
  readonly model: AgentModelPref;
  readonly outputFormat: string;
  /** Stable capability tags used by schedulers; names stay independent of role labels. */
  readonly capabilities?: readonly string[];
  /** 是否允许再 spawn 子 Agent（workspace.run_agent） */
  readonly canSpawn: boolean;
  readonly maxSteps: number;
  /** root = 总控；worker = 业务执行 */
  readonly kind: AgentRunKind;
  readonly memoryExtraction: MemoryExtractionMode;
  /** 定义文件绝对路径（若从磁盘加载） */
  readonly sourcePath?: string;
}

/** 花名册 / 注入 prompt 用的轻量摘要 */
export interface AgentSummary {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly emoji?: string;
  readonly description: string;
  readonly kind: AgentRunKind;
  readonly childPolicy: ChildPolicy;
  readonly canSpawn: boolean;
  readonly tools: "inherit" | readonly string[];
  readonly capabilities?: readonly string[];
}

/** 创建/更新 Agent 时的输入（表单或狸花 create_agent） */
export interface CreateAgentInput {
  readonly id: string;
  readonly name: string;
  readonly role?: string;
  readonly emoji?: string;
  readonly description?: string;
  readonly prompt: string;
  readonly tools?: AgentToolsSpec | string;
  readonly childPolicy?: ChildPolicy;
  readonly model?: AgentModelPref;
  readonly outputFormat?: string;
  readonly capabilities?: readonly string[] | string;
  readonly canSpawn?: boolean;
  readonly maxSteps?: number;
  readonly kind?: AgentRunKind;
  readonly memoryExtraction?: MemoryExtractionMode;
}

export interface AgentValidationError {
  readonly field: string;
  readonly message: string;
}

export interface AgentValidationResult {
  readonly ok: boolean;
  readonly errors: readonly AgentValidationError[];
  readonly warnings: readonly string[];
  /** 归一化后的 tools（完整工具名）；inherit 时为 null */
  readonly resolvedTools: readonly string[] | null;
}
