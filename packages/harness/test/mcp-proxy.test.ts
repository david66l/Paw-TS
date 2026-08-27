import { describe, expect, test } from "bun:test";

import type { McpClientManager, McpToolRef } from "../src/mcp-client.js";
import {
  MCP_PROXY,
  executeTool,
  listToolNames,
  toolCatalogText,
  toolDefinitions,
  toolRequiresApproval,
} from "../src/registry/index.js";

function fakeMcp(
  tools: readonly McpToolRef[],
  calls: Array<{ serverName: string; toolName: string; args: unknown }> = [],
  signals: AbortSignal[] = [],
): McpClientManager {
  return {
    listTools: () => tools,
    parseToolId: (id: string) => {
      const match = /^mcp:([^/]+)\/([^/]+)$/.exec(id);
      return match?.[1] && match[2]
        ? { serverName: match[1], toolName: match[2] }
        : null;
    },
    isMcpTool: (id: string) => id.startsWith("mcp:"),
    callTool: async (
      serverName: string,
      toolName: string,
      args: unknown,
      options?: { readonly signal?: AbortSignal },
    ) => {
      calls.push({ serverName, toolName, args });
      if (options?.signal) signals.push(options.signal);
      return {
        ok: true,
        payload: { serverName, toolName, args },
        summary: `called ${serverName}/${toolName}`,
      };
    },
  } as unknown as McpClientManager;
}

const githubSearch: McpToolRef = {
  serverName: "github",
  toolName: "search_code",
  description: "Search source code in GitHub repositories",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
};

const issueCreate: McpToolRef = {
  serverName: "github",
  toolName: "create_issue",
  description: "Create a GitHub issue",
  inputSchema: {
    type: "object",
    properties: { title: { type: "string" } },
    required: ["title"],
  },
};

describe("stable MCP proxy", () => {
  test("provider definitions and text catalog ignore dynamic MCP inventory", () => {
    const one = fakeMcp([githubSearch]);
    const two = fakeMcp([issueCreate, githubSearch]);

    expect(toolDefinitions(one)).toEqual(toolDefinitions(two));
    expect(toolCatalogText(one)).toBe(toolCatalogText(two));
    expect(listToolNames(one)).toEqual(listToolNames(two));
    expect(
      toolDefinitions(one).filter(
        (definition) => definition.function.name === "workspace_use_mcp",
      ),
    ).toHaveLength(1);
    expect(
      toolDefinitions(one).some((definition) =>
        definition.function.name.startsWith("mcp:"),
      ),
    ).toBe(false);
    expect(toolCatalogText(one)).not.toContain("search_code");
  });

  test("search returns only exact host-authorized targets with schemas", async () => {
    const result = await executeTool(
      {
        workspaceRoot: process.cwd(),
        mcp: fakeMcp([issueCreate, githubSearch]),
        mcpAllowedTools: ["mcp:github/search_code"],
      },
      MCP_PROXY,
      { action: "search", query: "source code", limit: 8 },
    );

    expect(result.ok).toBe(true);
    expect(result.payload).toMatchObject({
      schemaVersion: "paw.mcp-capability-search.v1",
      provenance: {
        source: "mcp",
        trust: "external_untrusted_data",
        taint: "external_content",
        instructionAuthority: "none",
        permissionAuthority: "none",
      },
      totalMatches: 1,
      returned: 1,
      tools: [
        {
          id: "mcp:github/search_code",
          inputSchema: githubSearch.inputSchema,
        },
      ],
    });
  });

  test("call routes exact ids and rejects targets outside the run scope", async () => {
    const calls: Array<{
      serverName: string;
      toolName: string;
      args: unknown;
    }> = [];
    const mcp = fakeMcp([issueCreate, githubSearch], calls);
    const context = {
      workspaceRoot: process.cwd(),
      mcp,
      mcpAllowedTools: ["mcp:github/search_code"],
    };

    const allowed = await executeTool(context, MCP_PROXY, {
      action: "call",
      tool: "mcp:github/search_code",
      arguments: { query: "cache" },
    });
    const denied = await executeTool(context, MCP_PROXY, {
      action: "call",
      tool: "mcp:github/create_issue",
      arguments: { title: "must not run" },
    });

    expect(allowed.ok).toBe(true);
    expect(allowed.payload).toMatchObject({
      schemaVersion: "paw.mcp-capability-result.v1",
      provenance: {
        source: "mcp",
        trust: "external_untrusted_data",
        instructionAuthority: "none",
        permissionAuthority: "none",
      },
      tool: "mcp:github/search_code",
    });
    expect(denied.ok).toBe(false);
    expect(denied.summary).toContain("allowlist");
    expect(calls).toEqual([
      {
        serverName: "github",
        toolName: "search_code",
        args: { query: "cache" },
      },
    ]);
  });

  test("search is approval-free while invocation remains approval-gated", () => {
    expect(
      toolRequiresApproval(MCP_PROXY, undefined, { action: "search" }),
    ).toBe(false);
    expect(toolRequiresApproval(MCP_PROXY, undefined, { action: "call" })).toBe(
      true,
    );
  });

  test("an omitted allowlist fails closed even when a manager is connected", async () => {
    const calls: Array<{
      serverName: string;
      toolName: string;
      args: unknown;
    }> = [];
    const context = {
      workspaceRoot: process.cwd(),
      mcp: fakeMcp([githubSearch], calls),
    };

    const search = await executeTool(context, MCP_PROXY, {
      action: "search",
      query: "source code",
    });
    const call = await executeTool(context, MCP_PROXY, {
      action: "call",
      tool: "mcp:github/search_code",
      arguments: { query: "cache" },
    });

    expect(search.payload).toMatchObject({ totalMatches: 0, tools: [] });
    expect(call.ok).toBe(false);
    expect(call.summary).toContain("allowlist");
    expect(calls).toEqual([]);
  });

  test("forwards the run abort signal to the exact MCP request", async () => {
    const signals: AbortSignal[] = [];
    const controller = new AbortController();
    const result = await executeTool(
      {
        workspaceRoot: process.cwd(),
        mcp: fakeMcp([githubSearch], [], signals),
        mcpAllowedTools: ["mcp:github/search_code"],
        abortSignal: controller.signal,
      },
      MCP_PROXY,
      {
        action: "call",
        tool: "mcp:github/search_code",
        arguments: { query: "cache" },
      },
    );

    expect(result.ok).toBe(true);
    expect(signals).toEqual([controller.signal]);
  });
});
