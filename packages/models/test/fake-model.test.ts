import { describe, expect, test } from "bun:test";

import { FakeLanguageModel } from "../src/fake-model.js";

describe("FakeLanguageModel", () => {
  test("emits list_dir JSON when user asks to list", async () => {
    const m = new FakeLanguageModel();
    const { text } = await m.complete([
      { role: "system", content: "You are a test harness." },
      { role: "user", content: "list the directory" },
    ]);
    expect(text).toContain("workspace.list_dir");
  });

  test("emits run_shell JSON when user asks to run shell", async () => {
    const m = new FakeLanguageModel();
    const { text } = await m.complete([
      { role: "user", content: `run shell 'echo 1'` },
    ]);
    expect(text).toContain("workspace.run_shell");
    expect(text).toContain('"command":"echo 1"');
  });

  test("emits search JSON when user asks to search", async () => {
    const m = new FakeLanguageModel();
    const { text } = await m.complete([
      { role: "user", content: `search for 'needle'` },
    ]);
    expect(text).toContain("workspace.search");
    expect(text).toContain('"pattern":"needle"');
  });

  test("emits write_file JSON when user asks to write a file", async () => {
    const m = new FakeLanguageModel();
    const { text } = await m.complete([
      { role: "user", content: `write file 'out.txt' 'hello'` },
    ]);
    expect(text).toContain("workspace.write_file");
    expect(text).toContain('"path":"out.txt"');
    expect(text).toContain('"content":"hello"');
  });

  test("emits write_file JSON for Chinese website / landing goals (offline)", async () => {
    const m = new FakeLanguageModel();
    const { text } = await m.complete([
      { role: "user", content: "帮我写一个个人网站 landing 页" },
    ]);
    expect(text).toContain("workspace.write_file");
    expect(text).toContain("index.html");
  });

  test("emits multiple tool lines for parallel read requests", async () => {
    const m = new FakeLanguageModel();
    const { text } = await m.complete([
      { role: "user", content: `read both 'a.txt' and 'b.txt'` },
    ]);
    const lines = text.split("\n").filter((l) => l.trim().startsWith("{"));
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain("workspace.read_file");
    expect(lines[1]).toContain("workspace.read_file");
  });

  test("throws AbortError when signal is already aborted", async () => {
    const m = new FakeLanguageModel();
    const ac = new AbortController();
    ac.abort();
    await expect(
      m.complete([{ role: "user", content: "list" }], { signal: ac.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
