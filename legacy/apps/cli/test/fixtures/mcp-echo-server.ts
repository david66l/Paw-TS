import fs from "node:fs";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const logPath = process.env.PAW_MCP_FIXTURE_LOG;

function log(event: string, detail: Record<string, unknown> = {}): void {
  if (!logPath) return;
  fs.appendFileSync(
    logPath,
    `${JSON.stringify({ event, ...detail })}\n`,
    "utf8",
  );
}

const server = new Server(
  { name: "paw-mcp-test-fixture", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "echo",
      description: "Echo one message from the MCP integration fixture",
      inputSchema: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
        additionalProperties: false,
      },
    },
    {
      name: "hidden",
      description: "A tool that the V3 exact allowlist must hide",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  log("call", { tool: request.params.name });
  if (request.params.name !== "echo") {
    return {
      isError: true,
      content: [{ type: "text", text: "unexpected tool" }],
    };
  }
  const message = request.params.arguments?.message;
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ echoed: message, source: "mcp-fixture" }),
      },
    ],
  };
});

process.on("exit", () => log("exit"));
log("start");
await server.connect(new StdioServerTransport());
