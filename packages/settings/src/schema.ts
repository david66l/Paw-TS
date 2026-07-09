/**
 * 配置文件 Schema 定义 —— 使用 Zod 描述 `.paw/settings.local.json` 的数据结构。
 *
 * ## 为什么需要这个模块
 * Paw 的配置文件通过 JSON 承载用户偏好和提供商凭据。手写类型守卫容易出错且冗长，
 * Zod 提供了声明式的 schema 描述，同时自动推导 TypeScript 类型。
 * 运行时校验确保用户误配的 JSON 字段能被尽早发现。
 *
 * ## 核心设计决策
 * 1. **`.passthrough()`**：schema 显式只列出已知字段，但允许额外的未知 key 透传。
 *    这样新增配置项时不会破坏已有的 settings 文件，做到向前兼容。
 * 2. **旧版扁平字段保留**：`openai_api_key`、`anthropic_api_key` 等仍出现在 schema 中，
 *    确保从旧版本升级的用户无需立即迁移配置格式。
 * 3. **models 嵌套结构**：新的推荐配置方式，支持按 provider 键名动态扩展。
 * 4. **独立的子 schema 导出**：`modelConfigSchema` 和 `mcpServerConfigSchema` 作为独立 schema 导出，
 *    方便其他模块复用校验逻辑。
 */

import { z } from "zod";

/** MCP 服务器配置的 schema。 */
const mcpServerConfigSchema = z.object({
  name: z.string(),
  command: z.string(),
  args: z.array(z.string()),
  env: z.record(z.string()).optional(),
});

/**
 * 单模型配置 schema —— 每个 AI 提供商的自包含配置。
 *
 * 所有字段可选：未设置时回退到旧版扁平字段或环境变量。
 */
export const modelConfigSchema = z.object({
  model: z.string().optional(),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
});

/**
 * `.paw/settings.local.json` 的完整 schema。
 *
 * 描述 Paw 本地配置文件的形状，未知键会被透传。
 * 包含新推荐的 nested models 结构和旧版扁平字段，保证向后兼容。
 */
export const pawSettingsLocalSchema = z
  .object({
    provider: z.string().optional(),
    model: z.string().optional(),
    /** 按 provider 分组的自包含配置，key 为 provider 名称（anthropic, openai, qwen, deepseek 等）。 */
    models: z.record(z.string(), modelConfigSchema).optional(),
    approval: z.string().optional(),
    max_steps: z.number().int().positive().optional(),
    /**
     * orchestrator 在 `plan_update` 后对计划快照的行数上限。
     * `0` 表示无限制。省略时使用默认值（64）。
     */
    plan_snapshot_max_items: z.number().int().min(0).optional(),
    environment: z.string().optional(),
    // 以下为旧版扁平字段，保留以保证向后兼容
    openai_api_key: z.string().optional(),
    openai_base_url: z.string().optional(),
    anthropic_api_key: z.string().optional(),
    anthropic_base_url: z.string().optional(),
    qwen_api_key: z.string().optional(),
    qwen_base_url: z.string().optional(),
    deepseek_api_key: z.string().optional(),
    deepseek_base_url: z.string().optional(),
    ollama_host: z.string().optional(),
    /**
     * 记忆检索策略：
     * - `keyword`：仅关键词匹配
     * - `cascade`：关键词 + DeepSeek Flash LLM 回退（默认）
     */
    memory_retrieval: z.enum(["keyword", "cascade"]).optional(),
    /**
     * Ollama embedding 模型名，用于语义记忆增强。
     * 例如 "nomic-embed-text"、"bge-m3"。未设置 = 无语义增强。
     */
    memory_embedding_model: z.string().optional(),
    /** 记忆检索池中最多包含的历史回合数，默认 10。 */
    session_pool_size: z.number().int().positive().max(50).optional(),
    /**
     * Docker/Podman 沙箱配置，用于 `workspace.run_shell`。
     * 默认关闭沙箱。
     */
    sandbox: z
      .object({
        mode: z.enum(["off", "workspace", "strict"]).optional(),
        network: z.enum(["deny", "full"]).optional(),
        image: z.string().optional(),
        runtime: z.enum(["docker", "podman"]).optional(),
        memory_mb: z.number().int().positive().optional(),
        cpus: z.number().positive().optional(),
      })
      .optional(),
    /**
     * 付费 LLM 记忆提取总开关。false 时关闭所有付费通道（end-of-run 提取、
     * 短 Run 摘要、BackgroundReview），零成本通道不受影响。
     * 默认 true（开启）。
     */
    paid_memory_extraction: z.boolean().optional(),
    /**
     * BackgroundReview 间隔（轮）。每 N 轮用辅助模型做一次轻量会话摘要。
     * 0 = 关闭（默认）。建议值 15-20。与 compact 互斥：compact 触发后冷却期内跳过。
     */
    background_review_interval: z.number().int().min(0).optional(),
    /**
     * 单 Run 最大 LLM 提取次数（包括 end-of-run 提取、短 Run 摘要、BackgroundReview）。
     * 防止循环反复调用 LLM。默认 3。
     */
    max_extractions_per_run: z.number().int().min(1).optional(),
    /**
     * 禁用从 compact 产物中自动提取记忆亮点（决策/错误修复）。
     * 默认 false（启用）。compact 和 BackgroundReview 都会检查此开关。
     */
    disable_session_highlight_extraction: z.boolean().optional(),
    /**
     * memoryExtraction 为 "background" 时，对话低于此 token 数则跳过提取。
     * 避免对极短对话浪费 auxiliary model 调用。默认 1000。
     */
    memory_extraction_min_tokens: z.number().int().min(0).optional(),
    /**
     * 记忆后端提供者名称。默认 "file"（本地 MD 文件）。
     * 可选 "sqlite"、"mem0" 等外部后端（需对应 provider 实现）。
     * @deprecated 请改用 memory_backend；cutover 完成后将移除 file 写入路径。
     */
    memory_provider: z.string().optional(),
    /**
     * 记忆后端（历史字段）。在线路径 **仅 db**（MemoryRuntime）。
     * `file` 已从 Agent 在线路径移除；旧 MD 请用 `bun run memory:migrate-legacy`。
     * 需要 DATABASE_URL + `bun run memory:migrate`。DB 不可达时 degrade。
     */
    memory_backend: z.enum(["db", "file"]).optional(),
    /** 记忆 scope：用户 id，默认 local / PAW_USER_ID */
    user_id: z.string().optional(),
    /** 记忆 scope：仓库 id，默认 git remote hash 或 workspace hash */
    repository_id: z.string().optional(),
    /** 记忆 scope：工作区 id，默认同 repository_id */
    workspace_id: z.string().optional(),
  })
  .passthrough(); // 允许未列出的字段透传，保证向前兼容

/** 从 schema 推导出的 TypeScript 类型。 */
export type PawSettingsLocal = z.infer<typeof pawSettingsLocalSchema>;
/** 单模型配置的 TypeScript 类型。 */
export type ModelConfig = z.infer<typeof modelConfigSchema>;
/** MCP 服务器配置的 TypeScript 类型。 */
export type McpServerConfigSettings = z.infer<typeof mcpServerConfigSchema>;
