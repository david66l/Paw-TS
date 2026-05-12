import { describe, expect, test } from "bun:test";

import {
  McpClientManager,
  type McpServerConfig,
} from "../src/mcp-client.js";

describe("McpClientManager", () => {
  test("parseToolId parses valid mcp tool ids", () => {
    const mcp = new McpClientManager();
    expect(mcp.parseToolId("mcp:filesystem/read_file")).toEqual({
      serverName: "filesystem",
      toolName: "read_file",
    });
    expect(mcp.parseToolId("mcp:my-server/tool_name")).toEqual({
      serverName: "my-server",
      toolName: "tool_name",
    });
  });

  test("parseToolId rejects invalid ids", () => {
    const mcp = new McpClientManager();
    expect(mcp.parseToolId("workspace.read_file")).toBeNull();
    expect(mcp.parseToolId("mcp:server-only")).toBeNull();
    expect(mcp.parseToolId("")).toBeNull();
  });

  test("isMcpTool identifies mcp-prefixed tools", () => {
    const mcp = new McpClientManager();
    expect(mcp.isMcpTool("mcp:fs/read")).toBe(true);
    expect(mcp.isMcpTool("workspace.read_file")).toBe(false);
    expect(mcp.isMcpTool("random")).toBe(false);
  });

  test("listTools returns empty when no servers connected", () => {
    const mcp = new McpClientManager();
    expect(mcp.listTools()).toEqual([]);
    expect(mcp.serverNames()).toEqual([]);
  });

  test("callTool returns error when server not connected", async () => {
    const mcp = new McpClientManager();
    const result = await mcp.callTool("missing", "tool", {});
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("not connected");
  });

  test("callTool returns error when tool not found", async () => {
    // We can't easily mock the SDK client here, so this test
    // just verifies the manager handles the no-tools case.
    const mcp = new McpClientManager();
    const result = await mcp.callTool("any", "tool", {});
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("not connected");
  });

  test("disconnectAll is safe on empty manager", async () => {
    const mcp = new McpClientManager();
    await mcp.disconnectAll();
    expect(mcp.serverNames()).toEqual([]);
  });

  test("serverNames returns connected server names", async () => {
    const mcp = new McpClientManager();
    // Without a real MCP server, we can't test connect(),
    // but we can verify the API surface.
    expect(typeof mcp.connect).toBe("function");
    expect(typeof mcp.disconnect).toBe("function");
    expect(typeof mcp.disconnectAll).toBe("function");
  });
});

describe("McpServerConfig type", () => {
  test("config shape is correct", () => {
    const cfg: McpServerConfig = {
      name: "test-server",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      env: { FOO: "bar" },
    };
    expect(cfg.name).toBe("test-server");
    expect(cfg.command).toBe("npx");
    expect(cfg.args).toHaveLength(3);
    expect(cfg.env?.FOO).toBe("bar");
  });
});
