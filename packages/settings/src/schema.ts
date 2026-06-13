import { z } from "zod";

const mcpServerConfigSchema = z.object({
  name: z.string(),
  command: z.string(),
  args: z.array(z.string()),
  env: z.record(z.string()).optional(),
});

/** Per-model configuration: self-contained for one provider. */
export const modelConfigSchema = z.object({
  model: z.string().optional(),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
});

/** `.paw/settings.local.json` — shared settings shape; unknown keys ignored. */
export const pawSettingsLocalSchema = z
  .object({
    provider: z.string().optional(),
    model: z.string().optional(),
    /** Self-contained configs per provider. Key is provider name (anthropic, openai, qwen, deepseek, ...). */
    models: z.record(z.string(), modelConfigSchema).optional(),
    approval: z.string().optional(),
    max_steps: z.number().int().positive().optional(),
    /** Cap on plan rows in orchestrator snapshots after `plan_update`; `0` = unlimited. Omit for default (64). */
    plan_snapshot_max_items: z.number().int().min(0).optional(),
    environment: z.string().optional(),
    // Legacy flat fields (kept for backward compatibility)
    openai_api_key: z.string().optional(),
    openai_base_url: z.string().optional(),
    anthropic_api_key: z.string().optional(),
    anthropic_base_url: z.string().optional(),
    qwen_api_key: z.string().optional(),
    qwen_base_url: z.string().optional(),
    deepseek_api_key: z.string().optional(),
    deepseek_base_url: z.string().optional(),
    ollama_host: z.string().optional(),
    /** Memory retrieval: keyword-only or cascade (keyword + DeepSeek Flash LLM fallback). Default cascade. */
    memory_retrieval: z.enum(["keyword", "cascade"]).optional(),
    /** Docker/Podman sandbox for workspace.run_shell. Default mode off. */
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
  })
  .passthrough();

export type PawSettingsLocal = z.infer<typeof pawSettingsLocalSchema>;
export type ModelConfig = z.infer<typeof modelConfigSchema>;
export type McpServerConfigSettings = z.infer<typeof mcpServerConfigSchema>;
