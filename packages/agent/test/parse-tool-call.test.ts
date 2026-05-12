import { describe, expect, test } from "bun:test";

import { parseToolCallFromModelText } from "../src/parse-tool-call.js";

describe("parseToolCallFromModelText", () => {
  test("parses last JSON line", () => {
    const t = 'Hello\n{"tool":"workspace.list_dir","args":{"path":"."}}';
    const c = parseToolCallFromModelText(t);
    expect(c?.tool).toBe("workspace.list_dir");
  });
});
