import { describe, expect, test } from "bun:test";

import {
  hasApiKey,
  redactSecrets,
  resolveApiKey,
  resolveBaseUrl,
  resolveModel,
} from "../src/credentials.js";
import type { PawSettingsLocal } from "../src/schema.js";

describe("credentials", () => {
  test("resolveApiKey reads models.<provider>.apiKey first", () => {
    const settings: PawSettingsLocal = {
      models: {
        openai: { apiKey: "sk-nested" },
      },
      openai_api_key: "sk-legacy",
    };
    expect(resolveApiKey(settings, "openai")).toBe("sk-nested");
  });

  test("resolveApiKey falls back to legacy flat field", () => {
    const settings: PawSettingsLocal = {
      openai_api_key: "sk-legacy",
    };
    expect(resolveApiKey(settings, "openai")).toBe("sk-legacy");
  });

  test("resolveApiKey falls back to env var", () => {
    process.env.OPENAI_API_KEY = "sk-from-env";
    const settings: PawSettingsLocal = {};
    expect(resolveApiKey(settings, "openai")).toBe("sk-from-env");
    delete process.env.OPENAI_API_KEY;
  });

  test("models key wins over env var", () => {
    process.env.QWEN_API_KEY = "sk-env";
    const settings: PawSettingsLocal = {
      models: { qwen: { apiKey: "sk-models" } },
    };
    expect(resolveApiKey(settings, "qwen")).toBe("sk-models");
    delete process.env.QWEN_API_KEY;
  });

  test("resolveBaseUrl reads models.<provider>.baseUrl first", () => {
    const settings: PawSettingsLocal = {
      models: {
        deepseek: { baseUrl: "https://custom.deepseek.com" },
      },
      deepseek_base_url: "https://legacy.deepseek.com",
    };
    expect(resolveBaseUrl(settings, "deepseek")).toBe("https://custom.deepseek.com");
  });

  test("resolveBaseUrl falls back to legacy flat field", () => {
    const settings: PawSettingsLocal = {
      qwen_base_url: "https://legacy.dashscope.com",
    };
    expect(resolveBaseUrl(settings, "qwen")).toBe("https://legacy.dashscope.com");
  });

  test("resolveBaseUrl falls back to env var", () => {
    process.env.DEEPSEEK_BASE_URL = "https://env.deepseek.com";
    const settings: PawSettingsLocal = {};
    expect(resolveBaseUrl(settings, "deepseek")).toBe("https://env.deepseek.com");
    delete process.env.DEEPSEEK_BASE_URL;
  });

  test("resolveModel prefers models.<provider>.model", () => {
    const settings: PawSettingsLocal = {
      provider: "deepseek",
      model: "top-level-model",
      models: {
        deepseek: { model: "deepseek-v4" },
      },
    };
    expect(resolveModel(settings, "deepseek", "fallback")).toBe("deepseek-v4");
  });

  test("resolveModel falls back to top-level model", () => {
    const settings: PawSettingsLocal = {
      provider: "deepseek",
      model: "top-level-model",
    };
    expect(resolveModel(settings, "deepseek", "fallback")).toBe("top-level-model");
  });

  test("hasApiKey returns false when missing", () => {
    const settings: PawSettingsLocal = {};
    expect(hasApiKey(settings, "openai")).toBeFalse();
  });

  test("hasApiKey returns true for models key", () => {
    const settings: PawSettingsLocal = {
      models: { anthropic: { apiKey: "sk-ant" } },
    };
    expect(hasApiKey(settings, "anthropic")).toBeTrue();
  });

  test("redactSecrets masks model configs and legacy keys", () => {
    const settings: PawSettingsLocal = {
      models: {
        deepseek: {
          apiKey: "sk-deepseek-secret",
          baseUrl: "https://api.deepseek.com",
        },
      },
      qwen_api_key: "sk-qwen-secret",
      model: "gpt-4o",
    };
    const redacted = redactSecrets(settings);
    const models = redacted.models as Record<string, { apiKey: unknown; baseUrl?: string }>;
    expect(models.deepseek?.apiKey).toContain("…");
    expect(models.deepseek?.apiKey).not.toContain("deepseek-secret");
    expect(models.deepseek?.baseUrl).toBe("https://api.deepseek.com");
    expect(redacted.qwen_api_key).toContain("…");
    expect(redacted.qwen_api_key).not.toContain("qwen-secret");
    expect(redacted.model).toBe("gpt-4o");
  });
});

test("GLM credentials resolve nested, legacy and environment values and redact secrets", () => {
  const oldKey = process.env.GLM_API_KEY;
  const oldUrl = process.env.GLM_BASE_URL;
  try {
    process.env.GLM_API_KEY = "test-env-secret";
    process.env.GLM_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
    expect(resolveApiKey({}, "glm")).toBe("test-env-secret");
    expect(resolveBaseUrl({}, "glm")).toBe(process.env.GLM_BASE_URL);
    const settings = {
      glm_api_key: "test-legacy-secret",
      models: { glm: { apiKey: "test-nested-secret" } },
    };
    expect(resolveApiKey({ glm_api_key: settings.glm_api_key }, "glm")).toBe("test-legacy-secret");
    expect(resolveApiKey(settings, "glm")).toBe("test-nested-secret");
    const redacted = JSON.stringify(redactSecrets(settings));
    expect(redacted).not.toContain("test-legacy-secret");
    expect(redacted).not.toContain("test-nested-secret");
  } finally {
    if (oldKey === undefined) delete process.env.GLM_API_KEY;
    else process.env.GLM_API_KEY = oldKey;
    if (oldUrl === undefined) delete process.env.GLM_BASE_URL;
    else process.env.GLM_BASE_URL = oldUrl;
  }
});

// `mcp_servers` 不在 pawSettingsLocalSchema 的已知字段里（靠 .passthrough()
// 透传），因此 models/flat 两条脱敏路径都覆盖不到它 —— 而 MCP server 的 env
// 恰恰是放 token 的地方。`bun run cli -- config` 与 `doctor` 都会打印这份
// settings，所以它必须被脱敏。
describe("redactSecrets MCP servers", () => {
  test("masks every MCP env value while keeping key names", () => {
    const settings = {
      provider: "glm",
      mcp_servers: [
        {
          name: "filesystem",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem"],
          env: {
            GITHUB_TOKEN: "ghp_supersecrettokenvalue",
            API_KEY: "another-secret-value-here",
            LOG_LEVEL: "debug",
          },
        },
      ],
    } as unknown as PawSettingsLocal;

    const redacted = JSON.stringify(redactSecrets(settings));
    expect(redacted).not.toContain("ghp_supersecrettokenvalue");
    expect(redacted).not.toContain("another-secret-value-here");
    // 键名保留，便于诊断「配了哪些环境变量」
    expect(redacted).toContain("GITHUB_TOKEN");
    expect(redacted).toContain("API_KEY");
    // 非密钥字段不受影响
    expect(redacted).toContain("filesystem");
  });

  test("tolerates a missing or malformed mcp_servers field", () => {
    expect(() => redactSecrets({ provider: "glm" } as PawSettingsLocal)).not.toThrow();
    expect(() =>
      redactSecrets({
        mcp_servers: "not-an-array",
      } as unknown as PawSettingsLocal),
    ).not.toThrow();
    expect(() =>
      redactSecrets({
        mcp_servers: [null, 42, { name: "x" }],
      } as unknown as PawSettingsLocal),
    ).not.toThrow();
  });
});
