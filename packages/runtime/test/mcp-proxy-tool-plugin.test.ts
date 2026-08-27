import os from "node:os";

import { describe, expect, test } from "bun:test";
import { MCP_PROXY } from "@paw/harness";

import {
  type RuntimeToolCallV1,
  createFrozenToolRegistryV1,
  createMcpProxyToolPluginV1,
} from "../src/index.js";

describe("Paw Next frozen MCP proxy plugin", () => {
  test("keeps the provider schema stable while scope changes registry identity", () => {
    const firstPlugin = createMcpProxyToolPluginV1("1".repeat(64));
    const secondPlugin = createMcpProxyToolPluginV1("2".repeat(64));
    const first = createFrozenToolRegistryV1({ plugins: [firstPlugin] });
    const second = createFrozenToolRegistryV1({ plugins: [secondPlugin] });

    expect(firstPlugin.entries[0]?.definition).toEqual(
      secondPlugin.entries[0]?.definition,
    );
    expect(first.definitions).toEqual(second.definitions);
    expect(first.registryHash).not.toBe(second.registryHash);
    expect(first.plugins).toEqual([
      {
        pluginId: "paw.mcp-proxy",
        pluginVersion: `paw.mcp-proxy.v1.${"1".repeat(64)}`,
      },
    ]);
    expect(first.resolveProviderName("workspace_use_mcp")?.internalName).toBe(
      MCP_PROXY,
    );
  });

  test("classifies discovery as read and invocation as unknown external effect", () => {
    const root = os.tmpdir();
    const registry = createFrozenToolRegistryV1({
      plugins: [createMcpProxyToolPluginV1("a".repeat(64))],
    });
    const search = registry.validateAndClassify(
      call("search", { action: "search", query: "issues" }),
      root,
    );
    const invoke = registry.validateAndClassify(
      call("call", {
        action: "call",
        tool: "mcp:github/create_issue",
        arguments: { title: "example" },
      }),
      root,
    );

    expect(search.ok).toBe(true);
    if (search.ok) {
      expect(search.value.classification).toMatchObject({
        effectClass: "read",
        permissionCategory: "read",
        concurrencyMode: "parallel",
        resources: [expect.objectContaining({ access: "read" })],
      });
    }
    expect(invoke.ok).toBe(true);
    if (invoke.ok) {
      expect(invoke.value.classification).toMatchObject({
        effectClass: "unknown",
        permissionCategory: "shell",
        concurrencyMode: "exclusive",
        resources: [expect.objectContaining({ access: "write" })],
      });
    }
  });

  test("rejects malformed scope identity and invalid proxy arguments", () => {
    expect(() => createMcpProxyToolPluginV1("short")).toThrow(/SHA-256/);
    const registry = createFrozenToolRegistryV1({
      plugins: [createMcpProxyToolPluginV1("b".repeat(64))],
    });
    const invalid = registry.validateAndClassify(
      call("invalid", { action: "other" }),
      os.tmpdir(),
    );
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.result.payload).toMatchObject({
        code: "E_TOOL_CLASSIFICATION",
        executed: false,
      });
    }
  });
});

function call(
  id: string,
  args: Readonly<Record<string, unknown>>,
): RuntimeToolCallV1 {
  return {
    id,
    name: "workspace_use_mcp",
    arguments: args,
    argumentsValid: true,
  };
}
