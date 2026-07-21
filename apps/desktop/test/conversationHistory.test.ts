import { describe, expect, test } from "bun:test";
import { buildGoalWithHistory } from "../src/agent/conversationHistory";

describe("buildGoalWithHistory", () => {
  test("无历史则原样返回当前 goal", () => {
    expect(buildGoalWithHistory("hello", [])).toBe("hello");
  });

  test("带上 User/Assistant 历史与 Current request", () => {
    const g = buildGoalWithHistory("数字是多少？", [
      { role: "user", content: "记住数字 7" },
      { role: "assistant", content: "好的，我记住了 7。" },
    ]);
    expect(g).toContain("User: 记住数字 7");
    expect(g).toContain("Assistant: 好的，我记住了 7。");
    expect(g).toContain("[Current user request]");
    expect(g).toContain("数字是多少？");
    expect(g.indexOf("记住数字 7")).toBeLessThan(g.indexOf("数字是多少？"));
  });

  test("maxTurns 截断", () => {
    const hist = Array.from({ length: 20 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `t${i}`,
    }));
    const g = buildGoalWithHistory("now", hist, { maxTurns: 4 });
    expect(g).toContain("t16");
    expect(g).toContain("t19");
    expect(g).not.toContain("t0");
  });
});
