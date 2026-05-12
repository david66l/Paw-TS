import { Client as McpSdkClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export interface McpServerConfig {
  /** Display name for this server (used in tool IDs). Must be unique. */
  readonly name: string;
  /** Command to spawn the MCP server (e.g. "npx", "bunx", "uvx"). */
  readonly command: string;
  /** Arguments passed to the command (e.g. ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"]). */
  readonly args: readonly string[];
  /** Optional extra env vars merged into the server process env. */
  readonly env?: Record<string, string>;
}

export interface McpToolRef {
  readonly serverName: string;
  readonly toolName: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface McpCallResult {
  readonly ok: boolean;
  readonly payload: unknown;
  readonly summary: string;
}

/** Minimal tool shape from MCP SDK listTools(). */
interface McpTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Record<string, unknown>;
}

interface ServerConnection {
  readonly name: string;
  readonly client: McpSdkClient;
  readonly transport: StdioClientTransport;
  readonly tools: readonly McpTool[];
}

/**
 * Manages stdio-based MCP server connections and exposes their tools
 * through the Paw harness registry.
 */
export class McpClientManager {
  private servers: Map<string, ServerConnection> = new Map();

  async connect(config: McpServerConfig): Promise<void> {
    if (this.servers.has(config.name)) {
      await this.disconnect(config.name);
    }

    const transport = new StdioClientTransport({
      command: config.command,
      args: [...config.args],
      env: config.env,
    });

    const client = new McpSdkClient({
      name: "paw-harness",
      version: "0.0.1",
    });

    await client.connect(transport);

    const toolsResult = await client.listTools();
    const tools = toolsResult.tools ?? [];

    this.servers.set(config.name, {
      name: config.name,
      client,
      transport,
      tools,
    });
  }

  async disconnect(serverName: string): Promise<void> {
    const conn = this.servers.get(serverName);
    if (!conn) return;
    try {
      await conn.client.close();
    } catch {
      // ignore
    }
    this.servers.delete(serverName);
  }

  async disconnectAll(): Promise<void> {
    for (const name of this.servers.keys()) {
      await this.disconnect(name);
    }
  }

  listTools(): readonly McpToolRef[] {
    const out: McpToolRef[] = [];
    for (const conn of this.servers.values()) {
      for (const t of conn.tools) {
        out.push({
          serverName: conn.name,
          toolName: t.name,
          description: t.description ?? "",
          inputSchema: (t.inputSchema as Record<string, unknown>) ?? {},
        });
      }
    }
    return out;
  }

  async callTool(
    serverName: string,
    toolName: string,
    args: unknown,
  ): Promise<McpCallResult> {
    const conn = this.servers.get(serverName);
    if (!conn) {
      return {
        ok: false,
        payload: { error: `MCP server not connected: ${serverName}` },
        summary: `mcp: server ${serverName} not connected`,
      };
    }

    const tool = conn.tools.find((t) => t.name === toolName);
    if (!tool) {
      return {
        ok: false,
        payload: { error: `Tool not found: ${toolName} in ${serverName}` },
        summary: `mcp: tool ${toolName} not found`,
      };
    }

    try {
      const result = await conn.client.callTool({
        name: toolName,
        arguments: args as Record<string, unknown>,
      });

      // Extract text from result.content
      let text = "";
      if (Array.isArray(result.content)) {
        for (const item of result.content) {
          if (
            item &&
            typeof item === "object" &&
            "type" in item &&
            item.type === "text" &&
            "text" in item &&
            typeof item.text === "string"
          ) {
            text += item.text;
          }
        }
      }

      const payload =
        text || (result.content as unknown) || { result: "done" };

      return {
        ok: true,
        payload,
        summary: `mcp: ${serverName}/${toolName} → ${String(text).slice(0, 80)}`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        payload: { error: msg },
        summary: `mcp: ${serverName}/${toolName} failed: ${msg.slice(0, 80)}`,
      };
    }
  }

  parseToolId(toolId: string): { serverName: string; toolName: string } | null {
    // Format: "mcp:<server-name>/<tool-name>"
    const prefix = "mcp:";
    if (!toolId.startsWith(prefix)) return null;
    const rest = toolId.slice(prefix.length);
    const slashIdx = rest.indexOf("/");
    if (slashIdx < 0) return null;
    return {
      serverName: rest.slice(0, slashIdx),
      toolName: rest.slice(slashIdx + 1),
    };
  }

  isMcpTool(toolId: string): boolean {
    return toolId.startsWith("mcp:");
  }

  serverNames(): readonly string[] {
    return Array.from(this.servers.keys());
  }
}
