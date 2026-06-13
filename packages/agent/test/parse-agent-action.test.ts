import { describe, expect, test } from "bun:test";

import {
  parseAgentActionFromModelText,
  parseAgentActionsFromModelText,
} from "../src/parse-agent-action.js";

describe("parseAgentActionFromModelText", () => {
  test("parses tool_call with tool key", () => {
    const a = parseAgentActionFromModelText(
      'Hi\n{"tool":"workspace.list_dir","args":{"path":"."}}',
    );
    expect(a).toEqual({
      type: "tool_call",
      tool: "workspace.list_dir",
      args: { path: "." },
    });
  });

  test("parses tool_call with name key (Python parity)", () => {
    const a = parseAgentActionFromModelText(
      '{"name":"workspace.read_file","args":{"path":"a.txt"}}',
    );
    expect(a?.type).toBe("tool_call");
    if (a?.type === "tool_call") {
      expect(a.tool).toBe("workspace.read_file");
    }
  });

  test("parses OpenAI-style name/arguments (object)", () => {
    const a = parseAgentActionFromModelText(
      '{"name":"workspace.list_dir","arguments":{"path":"."}}',
    );
    expect(a).toEqual({
      type: "tool_call",
      tool: "workspace.list_dir",
      args: { path: "." },
    });
  });

  test("parses OpenAI-style name/arguments (JSON string)", () => {
    const a = parseAgentActionFromModelText(
      '{"name":"workspace.read_file","arguments":"{\\"path\\":\\"a.txt\\"}"}',
    );
    expect(a).toEqual({
      type: "tool_call",
      tool: "workspace.read_file",
      args: { path: "a.txt" },
    });
  });

  test("parses pretty-printed multi-line JSON", () => {
    const a = parseAgentActionFromModelText(
      'Let me check.\n{\n  "tool": "workspace.list_dir",\n  "args": {\n    "path": "."\n  }\n}',
    );
    expect(a).toEqual({
      type: "tool_call",
      tool: "workspace.list_dir",
      args: { path: "." },
    });
  });

  test("parses pretty-printed OpenAI-style multi-line JSON", () => {
    const a = parseAgentActionFromModelText(
      '{\n  "name": "workspace.list_dir",\n  "arguments": {\n    "path": "."\n  }\n}',
    );
    expect(a).toEqual({
      type: "tool_call",
      tool: "workspace.list_dir",
      args: { path: "." },
    });
  });

  test("prefers last JSON line", () => {
    const a = parseAgentActionFromModelText(
      '{"action":"noop"}\n{"tool":"t","args":{}}',
    );
    expect(a?.type).toBe("tool_call");
  });

  test("parses final_answer", () => {
    const a = parseAgentActionFromModelText(
      'Done.\n{"action":"final_answer","summary":"All good."}',
    );
    expect(a).toEqual({
      type: "final_answer",
      summary: "All good.",
    });
  });

  test("parses final_answer with type field", () => {
    const a = parseAgentActionFromModelText(
      '{"type":"final_answer","summary":"x"}',
    );
    expect(a).toEqual({ type: "final_answer", summary: "x" });
  });

  test("parses abort", () => {
    const a = parseAgentActionFromModelText(
      '{"action":"abort","reason":"bad","can_resume":true}',
    );
    expect(a).toEqual({
      type: "abort",
      reason: "bad",
      canResume: true,
    });
  });

  test("parses ask_user", () => {
    const a = parseAgentActionFromModelText(
      '{"action":"ask_user","question":"OK?","context":{"k":1},"timeout_sec":30}',
    );
    expect(a?.type).toBe("ask_user");
    if (a?.type === "ask_user") {
      expect(a.question).toBe("OK?");
      expect(a.context).toEqual({ k: 1 });
      expect(a.timeoutSec).toBe(30);
    }
  });

  test("parses plan_update", () => {
    const a = parseAgentActionFromModelText(
      '{"action":"plan_update","reason":"replan","new_items":[1],"deprecated_items":["a"]}',
    );
    expect(a?.type).toBe("plan_update");
    if (a?.type === "plan_update") {
      expect(a.reason).toBe("replan");
      expect(a.newItems).toEqual([1]);
      expect(a.deprecatedItems).toEqual(["a"]);
    }
  });

  test("returns null for unrecognized JSON", () => {
    expect(parseAgentActionFromModelText('{"foo":1}')).toBe(null);
  });

  test("returns null when final_answer missing summary", () => {
    expect(parseAgentActionFromModelText('{"action":"final_answer"}')).toBe(
      null,
    );
  });
});

describe("parseAgentActionsFromModelText", () => {
  test("collects multiple tool_call lines", () => {
    const text = `I'll read both files.
{"tool":"workspace.read_file","args":{"path":"a.txt"}}
{"tool":"workspace.read_file","args":{"path":"b.txt"}}`;
    const { actions, text: prose } = parseAgentActionsFromModelText(text);
    expect(actions.length).toBe(2);
    expect(actions[0]).toEqual({
      type: "tool_call",
      tool: "workspace.read_file",
      args: { path: "a.txt" },
    });
    expect(actions[1]).toEqual({
      type: "tool_call",
      tool: "workspace.read_file",
      args: { path: "b.txt" },
    });
    expect(prose).toBe("I'll read both files.");
  });

  test("returns empty array and full text when no tool calls", () => {
    const text = 'Just thinking.\n{"action":"final_answer","summary":"Done."}';
    const { actions, text: prose } = parseAgentActionsFromModelText(text);
    expect(actions.length).toBe(0);
    expect(prose).toBe(text.trim());
  });

  test("ignores non-tool-call JSON lines", () => {
    const text = `Plan:
{"action":"plan_update","reason":"replan","new_items":[],"deprecated_items":[]}
{"tool":"workspace.list_dir","args":{"path":"."}}`;
    const { actions, text: prose } = parseAgentActionsFromModelText(text);
    expect(actions.length).toBe(1);
    expect(actions[0]?.tool).toBe("workspace.list_dir");
    expect(prose).toContain("Plan:");
    expect(prose).toContain("plan_update");
  });

  test("handles single tool call", () => {
    const text = `Read this.
{"tool":"workspace.read_file","args":{"path":"x.txt"}}`;
    const { actions, text: prose } = parseAgentActionsFromModelText(text);
    expect(actions.length).toBe(1);
    expect(prose).toBe("Read this.");
  });

  test("handles malformed JSON gracefully", () => {
    const text = `Go.
{not json}
{"tool":"t","args":{}}
{broken}`;
    const { actions, text: prose } = parseAgentActionsFromModelText(text);
    expect(actions.length).toBe(1);
    expect(actions[0]?.tool).toBe("t");
    expect(prose).toContain("Go.");
    expect(prose).toContain("not json");
  });

  test("collects mixed Paw and OpenAI format tool calls", () => {
    const text = `I'll do both.
{"tool":"workspace.read_file","args":{"path":"a.txt"}}
{"name":"workspace.list_dir","arguments":{"path":"."}}`;
    const { actions, text: prose } = parseAgentActionsFromModelText(text);
    expect(actions.length).toBe(2);
    expect(actions[0]).toEqual({
      type: "tool_call",
      tool: "workspace.read_file",
      args: { path: "a.txt" },
    });
    expect(actions[1]).toEqual({
      type: "tool_call",
      tool: "workspace.list_dir",
      args: { path: "." },
    });
    expect(prose).toBe("I'll do both.");
  });

  test("collects OpenAI format with stringified arguments", () => {
    const text = `Checking.
{"name":"workspace.grep","arguments":"{\\"pattern\\":\\"foo\\"}"}`;
    const { actions } = parseAgentActionsFromModelText(text);
    expect(actions.length).toBe(1);
    expect(actions[0]).toEqual({
      type: "tool_call",
      tool: "workspace.grep",
      args: { pattern: "foo" },
    });
  });

  test("collects pretty-printed multi-line tool calls", () => {
    const text = `I'll read both files.
{\n  "tool": "workspace.read_file",\n  "args": {\n    "path": "a.txt"\n  }\n}
{\n  "name": "workspace.read_file",\n  "arguments": {\n    "path": "b.txt"\n  }\n}`;
    const { actions, text: prose } = parseAgentActionsFromModelText(text);
    expect(actions.length).toBe(2);
    expect(actions[0]).toEqual({
      type: "tool_call",
      tool: "workspace.read_file",
      args: { path: "a.txt" },
    });
    expect(actions[1]).toEqual({
      type: "tool_call",
      tool: "workspace.read_file",
      args: { path: "b.txt" },
    });
    expect(prose).toBe("I'll read both files.");
  });

  test("rejects tool call not in knownTools set", () => {
    const text = '{"tool":"workspace.unknown_tool","args":{"x":1}}';
    const { actions } = parseAgentActionsFromModelText(text, {
      knownTools: new Set(["workspace.read_file", "workspace.list_dir"]),
    });
    expect(actions.length).toBe(0);
  });

  test("accepts tool call in knownTools set", () => {
    const text = '{"tool":"workspace.read_file","args":{"path":"x"}}';
    const { actions } = parseAgentActionsFromModelText(text, {
      knownTools: new Set(["workspace.read_file", "workspace.list_dir"]),
    });
    expect(actions.length).toBe(1);
    expect(actions[0]?.tool).toBe("workspace.read_file");
  });

  test("knownTools filters false-positive JSON in code-like text", () => {
    // Simulate model output that embeds a code snippet containing JSON
    const text = `Here's the config:
\`\`\`json
{"tool":"some_sdk_method","args":{"mode":"strict"}}
\`\`\`
Now let me actually call the real tool.
{"tool":"workspace.read_file","args":{"path":"src/config.ts"}}`;
    const { actions } = parseAgentActionsFromModelText(text, {
      knownTools: new Set(["workspace.read_file", "workspace.list_dir"]),
    });
    expect(actions.length).toBe(1);
    expect(actions[0]?.tool).toBe("workspace.read_file");
  });

  test("without knownTools, all tool-call-like JSON is accepted", () => {
    const text = '{"tool":"any.random.tool","args":{}}';
    const { actions } = parseAgentActionsFromModelText(text);
    expect(actions.length).toBe(1);
  });
});
