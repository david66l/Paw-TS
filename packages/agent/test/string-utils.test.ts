import { describe, expect, test } from "bun:test";
import { capitalize, isBlank } from "../src/demos/string-utils.js";

describe("capitalize", () => {
  test("空串返回空串", () => {
    expect(capitalize("")).toBe("");
  });

  test("首字母大写", () => {
    expect(capitalize("hello")).toBe("Hello");
  });

  test("全大写保持不变", () => {
    expect(capitalize("HELLO")).toBe("HELLO");
  });

  test("已首字母大写保持不变", () => {
    expect(capitalize("Hello")).toBe("Hello");
  });

  test("单字符", () => {
    expect(capitalize("a")).toBe("A");
  });
});

describe("isBlank", () => {
  test("空串为 true", () => {
    expect(isBlank("")).toBe(true);
  });

  test("仅空格为 true", () => {
    expect(isBlank("   ")).toBe(true);
  });

  test("Tab/换行为 true", () => {
    expect(isBlank("\t\n ")).toBe(true);
  });

  test("非空白字符串为 false", () => {
    expect(isBlank("hello")).toBe(false);
  });

  test("包含空白但有内容为 false", () => {
    expect(isBlank(" hello ")).toBe(false);
  });
});
