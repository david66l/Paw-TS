import { z } from "zod";

const mcpServerConfigSchema = z.object({
  name: z.string(),
  command: z.string(),
  args: z.array(z.string()),
  env: z.record(z.string()).optional(),
});

/** `.paw/settings.local.json` — shared settings shape; unknown keys ignored. */
export const pawSettingsLocalSchema = z
  .object({
    provider: z.string().optional(),
    model: z.string().optional(),
    approval: z.string().optional(),
    max_steps: z.number().int().positive().optional(),
    /** Cap on plan rows in orchestrator snapshots after `plan_update`; `0` = unlimited. Omit for default (64). */
    plan_snapshot_max_items: z.number().int().min(0).optional(),
    environment: z.string().optional(),
    openai_api_key: z.string().optional(),
    openai_base_url: z.string().optional(),
    anthropic_api_key: z.string().optional(),
    anthropic_base_url: z.string().optional(),
    ollama_host: z.string().optional(),
    mcp_servers: z.array(mcpServerConfigSchema).optional(),
  })
  .passthrough();

export type PawSettingsLocal = z.infer<typeof pawSettingsLocalSchema>;
export type McpServerConfigSettings = z.infer<typeof mcpServerConfigSchema>;
