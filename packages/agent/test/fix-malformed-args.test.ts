import { describe, expect, test } from "bun:test";

import type { ToolDefinition } from "@paw/models";

import { fixMalformedToolArguments } from "../src/orchestrator/fix-malformed-args.js";

function toolDef(
  name: string,
  properties: Record<string, unknown>,
): ToolDefinition {
  return {
    type: "function",
    function: {
      name,
      description: "test",
      parameters: { type: "object", properties },
    },
  };
}

const defs: ToolDefinition[] = [
  toolDef("workspace.read_file", {
    path: { type: "string" },
    offset: { type: "integer" },
    limit: { type: "integer" },
  }),
  toolDef("workspace.apply_patch", {
    patch: { type: "string" },
  }),
  toolDef("workspace.grep", {
    pattern: { type: "string" },
    line_numbers: { type: "boolean" },
  }),
  toolDef("workspace.list_dir", {
    path: { type: "string" },
    ignore: { type: "array", items: { type: "string" } },
    pattern: { type: "string" },
  }),
  toolDef("workspace.multi", {
    view_range: { type: "array", items: { type: "integer" } },
    meta: { type: "object", properties: { mode: { type: "string" } } },
    note: { type: "string" },
  }),
];

describe("fixMalformedToolArguments", () => {
  test("decodes JSON-string-encoded array by schema (GLM-style)", () => {
    const args = fixMalformedToolArguments(
      { path: ".", ignore: '["node_modules",".git"]' },
      "workspace.list_dir",
      defs,
    );
    expect(args).toEqual({
      path: ".",
      ignore: ["node_modules", ".git"],
    });
  });

  test("decodes JSON-string-encoded object by schema", () => {
    const args = fixMalformedToolArguments(
      { view_range: "[1, 5]", meta: '{"mode":"strict"}' },
      "workspace.multi",
      defs,
    );
    expect(args).toEqual({
      view_range: [1, 5],
      meta: { mode: "strict" },
    });
  });

  test("joins chunked string arrays back into a single string", () => {
    const args = fixMalformedToolArguments(
      { patch: ["line1\n", "line2\n", "line3"] },
      "workspace.apply_patch",
      defs,
    );
    expect(args).toEqual({ patch: "line1\nline2\nline3" });
  });

  test("leaves valid values untouched", () => {
    const args = fixMalformedToolArguments(
      { path: "src", ignore: ["node_modules"], pattern: "*.ts" },
      "workspace.list_dir",
      defs,
    );
    expect(args).toEqual({
      path: "src",
      ignore: ["node_modules"],
      pattern: "*.ts",
    });
  });

  test("leaves non-decodable strings as-is", () => {
    const args = fixMalformedToolArguments(
      { path: ".", ignore: "not-json" },
      "workspace.list_dir",
      defs,
    );
    expect(args).toEqual({ path: ".", ignore: "not-json" });
  });

  test("recursively fixes nested object properties", () => {
    const args = fixMalformedToolArguments(
      { meta: { mode: "strict", flags: "[1,2]" } },
      "workspace.multi",
      defs,
    );
    // flags 不在 schema 中 → 不变
    expect(args).toEqual({ meta: { mode: "strict", flags: "[1,2]" } });
  });

  test("returns args unchanged for unknown tool", () => {
    const args = fixMalformedToolArguments(
      { x: '"[1,2]"' },
      "workspace.unknown",
      defs,
    );
    expect(args).toEqual({ x: '"[1,2]"' });
  });

  test("returns args unchanged when schema has no properties", () => {
    const noSchema: ToolDefinition[] = [toolDef("workspace.noop", {})];
    const args = fixMalformedToolArguments(
      { a: "[1]" },
      "workspace.noop",
      noSchema,
    );
    expect(args).toEqual({ a: "[1]" });
  });
});
