import { describe, expect, test } from "bun:test";

import { formatToolResultEventDetail } from "../src/tool-result-detail.js";

describe("formatToolResultEventDetail", () => {
  test("lists file names from list_dir payload", () => {
    const d = formatToolResultEventDetail({
      ok: true,
      summary: "list_dir: . (1 entries)",
      payload: { files: ["a.ts", "b.ts"] },
    });
    expect(d).toContain("a.ts");
    expect(d).toContain("b.ts");
  });

  test("formats run_shell stdout", () => {
    const d = formatToolResultEventDetail({
      ok: true,
      summary: "run_shell: exit 0",
      payload: { exit_code: 0, stdout: "hi\n", stderr: "" },
    });
    expect(d).toContain("exit 0");
    expect(d).toContain("hi");
  });

  test("formats search matches", () => {
    const d = formatToolResultEventDetail({
      ok: true,
      summary: "search: 1 match(es)",
      payload: {
        matches: [{ path: "a.ts", line: 3, text: "hit" }],
      },
    });
    expect(d).toContain("a.ts");
    expect(d).toContain("hit");
  });

  test("shows path and bytes for write_file payload", () => {
    const d = formatToolResultEventDetail({
      ok: true,
      summary: "write_file: x (3 bytes)",
      payload: { path: "/tmp/ws/a.txt", bytes_written: 3 },
    });
    expect(d).toContain("bytes written");
    expect(d).toContain("a.txt");
  });

  test("truncates read_file content", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `L${i}`).join("\n");
    const d = formatToolResultEventDetail({
      ok: true,
      summary: "ok",
      payload: { content: lines },
    });
    expect(d?.split("\n").length).toBeLessThanOrEqual(64);
  });
});
