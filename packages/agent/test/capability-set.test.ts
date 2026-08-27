import { describe, expect, test } from "bun:test";

import {
  CORE_MODEL_ACTIONS,
  CORE_MODEL_EXECUTABLE_TOOLS,
  MCP_PROXY,
  toolDefinitions,
  toolNameReverseMap,
} from "@paw/harness";

import { resolveCapabilitySetV1 } from "../src/capability-set.js";
import { executeToolCalls } from "../src/orchestrator/tool-runner.js";
import { parseAgentActionFromModelText } from "../src/parse-agent-action.js";

describe("CapabilitySetV1", () => {
  const definitions = toolDefinitions();
  const toolNameMap = toolNameReverseMap();

  test("resolves the slim coding tools and the complete structured action set", () => {
    const set = resolveCapabilitySetV1({
      definitions,
      toolNameMap,
      configuredTools: CORE_MODEL_EXECUTABLE_TOOLS,
    });

    expect(new Set(set.modelToolNames)).toEqual(
      new Set(CORE_MODEL_EXECUTABLE_TOOLS),
    );
    expect(set.executableToolNames).toEqual(set.modelToolNames);
    expect(set.modelActions).toEqual(CORE_MODEL_ACTIONS);
    expect(set.modelToolDefinitions).toHaveLength(4);
    expect(set.internalToolNames).toContain("workspace.grep");
    expect(set.knownToolNames.has("workspace.grep")).toBe(false);
  });

  test("declares every structured action accepted by the model parser", () => {
    const fixtures = [
      '{"action":"final_answer","summary":"done"}',
      '{"action":"ask_user","question":"which?"}',
      '{"action":"plan_update","reason":"split","new_items":[]}',
      '{"action":"acceptance_update","reason":"track","add":[{"text":"Keep behavior","source":"repository"}],"updates":[]}',
      '{"action":"abort","reason":"blocked"}',
    ];
    const parsedActions = fixtures.map((fixture) => {
      const action = parseAgentActionFromModelText(fixture);
      if (!action || action.type === "tool_call") {
        throw new Error(`structured action did not parse: ${fixture}`);
      }
      return `action.${action.type}`;
    });

    expect(new Set(parsedActions)).toEqual(new Set(CORE_MODEL_ACTIONS));
  });

  test("accepts only selected original and sanitized names", () => {
    const set = resolveCapabilitySetV1({
      definitions,
      toolNameMap,
      configuredTools: ["workspace.read_file"],
    });
    const definition = set.modelToolDefinitions[0];
    if (!definition) throw new Error("read_file definition missing");

    expect(set.modelToolNames).toEqual(["workspace.read_file"]);
    expect(set.knownToolNames.has("workspace.read_file")).toBe(true);
    expect(set.knownToolNames.has(definition.function.name)).toBe(true);
    expect(set.knownToolNames.has("workspace.list_dir")).toBe(false);
  });

  test("keeps explicit full exposure available without weakening defaults", () => {
    const set = resolveCapabilitySetV1({
      definitions,
      toolNameMap,
      configuredTools: null,
    });

    expect(set.modelToolDefinitions).toHaveLength(definitions.length);
    expect(set.internalToolNames).toEqual([]);
    expect(set.knownToolNames.has("workspace.list_dir")).toBe(true);
  });

  test("maps legacy exact MCP grants to one proxy without widening target scope", () => {
    const set = resolveCapabilitySetV1({
      definitions,
      toolNameMap,
      configuredTools: ["workspace.read_file", "mcp:github/search_code"],
      availableMcpToolNames: [
        "mcp:github/create_issue",
        "mcp:github/search_code",
      ],
    });

    expect(set.modelToolNames).toEqual(["workspace.read_file", MCP_PROXY]);
    expect(set.mcpToolNames).toEqual(["mcp:github/search_code"]);
    expect(set.knownToolNames.has("mcp:github/search_code")).toBe(false);
    expect(set.knownToolNames.has(MCP_PROXY)).toBe(true);
    expect(
      parseAgentActionFromModelText(
        '{"tool":"mcp:github/search_code","args":{"query":"cache"}}',
        { knownTools: set.knownToolNames },
      ),
    ).toBeNull();
    expect(
      parseAgentActionFromModelText(
        '{"tool":"workspace.use_mcp","args":{"action":"search","query":"cache"}}',
        { knownTools: set.knownToolNames },
      ),
    ).toMatchObject({ type: "tool_call", tool: MCP_PROXY });
  });

  test("read-only children may discover MCP tools but cannot invoke them", async () => {
    const events: import("@paw/core").RunEvent[] = [];
    const result = await executeToolCalls(
      [
        {
          type: "tool_call",
          tool: MCP_PROXY,
          args: { action: "search", query: "code" },
        },
        {
          type: "tool_call",
          tool: MCP_PROXY,
          args: {
            action: "call",
            tool: "mcp:github/search_code",
            arguments: { query: "cache" },
          },
        },
      ],
      {
        workspaceRoot: process.cwd(),
        runId: "read-only-mcp-proxy",
        emit: (event) => events.push(event),
        checkpointSeq: { n: 0 },
        childPolicy: "read_only",
        allowedTools: [MCP_PROXY],
        mcpAllowedTools: ["mcp:github/search_code"],
      },
      {},
    );

    expect(result.results[0]?.ok).toBe(true);
    expect(result.results[1]?.ok).toBe(false);
    expect(result.results[1]?.summary).toContain("read-only child agent");
  });

  test("keeps an empty allowlist empty at the executor boundary", async () => {
    const events: import("@paw/core").RunEvent[] = [];
    const result = await executeToolCalls(
      [
        {
          type: "tool_call",
          tool: "workspace.run_shell",
          args: { command: "echo should-not-run" },
        },
      ],
      {
        workspaceRoot: process.cwd(),
        runId: "empty-capability-set",
        emit: (event) => events.push(event),
        checkpointSeq: { n: 0 },
        allowedTools: [],
      },
      {},
    );

    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.ok).toBe(false);
    expect(result.results[0]?.summary).toContain("allowlist");
    expect(events).toEqual([]);
  });
});
