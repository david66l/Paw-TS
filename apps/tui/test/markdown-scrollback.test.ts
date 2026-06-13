import { describe, expect, test } from "bun:test";

import {
  createMdParserState,
  parseMarkdownLine,
} from "../src/markdown-parse.js";
import { formatToolResultSummary } from "../src/footer-state.js";

describe("parseMarkdownLine", () => {
  const colors = {
    defaultFg: "#fff",
    mutedFg: "#888",
    brandFg: "#3578e5",
    codeFg: "#6aaef2",
  };

  test("renders bold inline segments", () => {
    const state = createMdParserState();
    const segments = parseMarkdownLine(
      "**关于你：**",
      colors.defaultFg,
      colors.mutedFg,
      colors.brandFg,
      colors.codeFg,
      state,
    );
    expect(segments.some((s) => s.bold && s.text.includes("关于你"))).toBe(
      true,
    );
  });

  test("renders unordered list prefix", () => {
    const state = createMdParserState();
    const segments = parseMarkdownLine(
      "- item one",
      colors.defaultFg,
      colors.mutedFg,
      colors.brandFg,
      colors.codeFg,
      state,
    );
    expect(segments[0]?.text).toContain("•");
  });

  test("renders table header row (not first column only)", () => {
    const state = createMdParserState();
    const header = parseMarkdownLine(
      "| Name | Value |",
      colors.defaultFg,
      colors.mutedFg,
      colors.brandFg,
      colors.codeFg,
      state,
    );
    const separator = parseMarkdownLine(
      "| --- | --- |",
      colors.defaultFg,
      colors.mutedFg,
      colors.brandFg,
      colors.codeFg,
      state,
    );
    const body = parseMarkdownLine(
      "| foo | 1 |",
      colors.defaultFg,
      colors.mutedFg,
      colors.brandFg,
      colors.codeFg,
      state,
    );
    expect(header.filter((s) => s.bold).length).toBeGreaterThan(1);
    expect(separator[0]?.text).toContain("---");
    expect(body.some((s) => s.bold)).toBe(false);
  });
});

describe("formatToolResultSummary", () => {
  test("dedupes repeated tool prefix", () => {
    expect(
      formatToolResultSummary(
        "workspace.memory.list",
        "workspace.memory.list: 20 entries",
      ),
    ).toBe("20 entries");
  });
});
