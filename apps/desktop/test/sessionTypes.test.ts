import { describe, expect, test } from "bun:test";
import {
  createEmptySession,
  deriveSessionTitle,
} from "../src/agent/sessionTypes";

describe("deriveSessionTitle", () => {
  test("uses first user message", () => {
    expect(
      deriveSessionTitle([
        { id: "1", role: "user", content: "帮我写一个笔记应用" },
      ]),
    ).toBe("帮我写一个笔记应用");
  });

  test("truncates long title", () => {
    const long = "这是一段非常非常长的用户输入用来测试截断是否正常工作的文字内容";
    const t = deriveSessionTitle([{ id: "1", role: "user", content: long }]);
    expect(t.endsWith("…")).toBe(true);
    expect(t.length).toBeLessThanOrEqual(30);
  });

  test("fallback", () => {
    expect(deriveSessionTitle([])).toBe("新对话");
  });
});

describe("createEmptySession", () => {
  test("has id and empty messages", () => {
    const s = createEmptySession("conv-test");
    expect(s.id).toBe("conv-test");
    expect(s.messages).toEqual([]);
    expect(s.history).toEqual([]);
    expect(s.title).toBe("新对话");
  });
});
