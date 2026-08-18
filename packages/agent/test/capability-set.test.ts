import { describe, expect, test } from "bun:test";

import {
  CORE_MODEL_ACTIONS,
  CORE_MODEL_EXECUTABLE_TOOLS,
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
    expect(set.modelToolDefinitions).toHaveLength(3);
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
