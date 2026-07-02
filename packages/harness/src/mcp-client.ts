/**
 * MCP（Model Context Protocol）客户端管理器。
 * ===========================================
 *
 * 管理基于 stdio 的 MCP 服务器连接，并通过 Paw harness 注册表暴露其工具。
 *
 * MCP 是 Anthropic 提出的开放协议，允许 LLM 通过标准化接口访问外部工具和数据源。
 * 每个 MCP 服务器是一个独立的进程（通过 stdio 通信），提供一组工具。
 *
 * 工具命名空间：mcp:<server-name>/<tool-name>
 * 例如：mcp:filesystem/read_file
 *
 * 面试要点：
 * - MCP 的价值：统一的工具接口标准，任何实现了 MCP 的服务器都可以被 Paw 使用
 * - stdio transport：子进程通信，比 HTTP 更安全（不需要网络监听）
 */

import { Client as McpSdkClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export interface McpServerConfig {
  /** 服务器显示名（用于工具 ID）。必须唯一。 */
  readonly name: string;
  /** 启动 MCP 服务器的命令（如 "npx", "bunx", "uvx"）。 */
  readonly command: string;
  /** 传递给命令的参数 */
  readonly args: readonly string[];
  /** 可选的额外环境变量，合并到服务器进程环境中 */
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
 * 管理基于 stdio 的 MCP 服务器连接。
 */
export class McpClientManager {
  private servers: Map<string, ServerConnection> = new Map();

  /** 连接一个 MCP 服务器。如果同名服务器已存在，先断开。 */
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

  /** 断开指定 MCP 服务器 */
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

  /** 断开所有 MCP 服务器（在 Run 结束时调用） */
  async disconnectAll(): Promise<void> {
    for (const name of this.servers.keys()) {
      await this.disconnect(name);
    }
  }

  /** 列出所有 MCP 服务器的工具 */
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

  /** 调用 MCP 工具 */
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

      // 从 result.content 中提取文本
      let text = "";
      if (Array.isArray(result.content)) {
        for (const item of result.content) {
          if (
            item && typeof item === "object" && "type" in item &&
            item.type === "text" && "text" in item &&
            typeof item.text === "string"
          ) {
            text += item.text;
          }
        }
      }

      const payload = text || (result.content as unknown) || { result: "done" };
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

  /** 解析 MCP 工具 ID：格式为 "mcp:<server-name>/<tool-name>" */
  parseToolId(toolId: string): { serverName: string; toolName: string } | null {
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

  /** 判断是否为 MCP 工具 ID */
  isMcpTool(toolId: string): boolean {
    return toolId.startsWith("mcp:");
  }

  /** 列出所有连接的 MCP 服务器名 */
  serverNames(): readonly string[] {
    return Array.from(this.servers.keys());
  }
}
