import { describe, expect, test } from "bun:test";

import {
  createPayloadDeduper,
  simpleHash,
  truncatePayload,
  truncateString,
} from "../src/orchestrator/truncate-payload.js";

describe("truncatePayload — 分档截断", () => {
  test("read 类工具永不截断", () => {
    const big = "x".repeat(100_000);
    expect(truncatePayload(big, "workspace.read_file")).toBe(big);
    expect(truncatePayload(big, "workspace.grep")).toBe(big);
    expect(truncatePayload(big, "workspace.lsp")).toBe(big);
  });

  test("run_shell 超限截断：头尾保留 + 标记", () => {
    const big = `line0\n${"noise\n".repeat(10_000)}line_end`; // ~60KB > 40KB
    const out = truncatePayload(big, "workspace.run_shell");
    expect(typeof out).toBe("string");
    const s = out as string;
    expect(s.startsWith("line0\n")).toBe(true);
    expect(s.endsWith("line_end")).toBe(true);
    expect(s).toContain("[truncated");
    expect(s.length).toBeLessThan(big.length);
  });

  test("短输出不剪（<2,200 字符）", () => {
    const small = "ok\n".repeat(300); // ~900 chars
    expect(truncatePayload(small, "workspace.run_shell")).toBe(small);
  });

  test("错误行智能保留（含语句块上下文）", () => {
    const line = "Error: E108 list_display_item failed";
    const big = `start\n${"noise\n".repeat(3_000)}${line}\ncontext_after\n${"noise\n".repeat(3_000)}`;
    const out = truncatePayload(big, "workspace.run_shell") as string;
    expect(out).toContain(line);
    expect(out).toContain("context_after"); // 错误行后 2 行上下文
  });

  test("object payload：序列化后超限才截断", () => {
    const smallObj = { path: "a.txt", ok: true };
    expect(truncatePayload(smallObj, "workspace.run_shell")).toEqual(smallObj);
    const bigObj = { data: "x".repeat(100_000) };
    const out = truncatePayload(bigObj, "workspace.run_shell");
    expect(typeof out).toBe("string");
    expect((out as string).length).toBeLessThan(50_000);
  });

  test("中长工具收紧上限", () => {
    const big = "y".repeat(30_000);
    const out = truncatePayload(big, "workspace.search") as string;
    expect(out.length).toBeLessThan(20_000);
  });
});

describe("truncateString", () => {
  test("保留头 600 尾 400", () => {
    const s = truncateString("A".repeat(2_000) + "B".repeat(2_000), 40_000);
    expect(s.startsWith("A".repeat(600))).toBe(true);
    expect(s.endsWith("B".repeat(400))).toBe(true);
  });
});

describe("内容哈希去重", () => {
  test("同一内容第二次被识别为重复", () => {
    const deduper = createPayloadDeduper();
    const content = "log\n".repeat(3_000);
    const first = deduper.check(content);
    expect(first).toBeNull();
    deduper.record(content, 3);
    const second = deduper.check(content);
    expect(second).toEqual({ hash: simpleHash(content), turn: 3 });
  });

  test("不同内容不误判", () => {
    const deduper = createPayloadDeduper();
    deduper.record("A".repeat(3_000), 1);
    expect(deduper.check("B".repeat(3_000))).toBeNull();
  });

  test("小输出（<2,000 字符）不参与去重", () => {
    const deduper = createPayloadDeduper();
    deduper.record("small", 1);
    expect(deduper.check("small")).toBeNull();
  });
});

describe("simpleHash", () => {
  test("确定性 + 不同输入不同哈希", () => {
    const a = simpleHash("hello world");
    expect(a).toBe(simpleHash("hello world"));
    expect(a).not.toBe(simpleHash("hello worlD"));
  });
});
