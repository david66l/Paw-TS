import { describe, expect, test } from "bun:test";
import {
  extractEmbeddedThinking,
  formatModelOutputForUi,
  formatModelTextForUi,
  mergeStreamText,
  mergeThinking,
} from "../src/agent/formatModelText";

describe("mergeStreamText", () => {
  test("累积快照：用新全文替换", () => {
    expect(mergeStreamText("联", "联调")).toBe("联调");
    expect(mergeStreamText("联调", "联调OK")).toBe("联调OK");
  });

  test("增量：拼接", () => {
    expect(mergeStreamText("hello ", "world")).toBe("hello world");
  });
});

describe("extractEmbeddedThinking", () => {
  test("闭合 think 标签", () => {
    const r = extractEmbeddedThinking(
      "<think>先想一下</think>\n最终答案是 42",
    );
    expect(r.thinking).toBe("先想一下");
    expect(r.text).toBe("最终答案是 42");
  });

  test("流式未闭合标签归入 thinking", () => {
    const r = extractEmbeddedThinking("<thinking>还在想", {
      streaming: true,
    });
    expect(r.thinking).toBe("还在想");
    expect(r.text).toBe("");
  });
});

describe("formatModelOutputForUi", () => {
  test("final_answer 只取 summary", () => {
    const raw =
      '分析完毕。\n{"action":"final_answer","summary":"顶层有 apps 和 packages"}';
    const r = formatModelOutputForUi(raw);
    expect(r.content).toContain("顶层有 apps");
    expect(r.content).not.toContain("final_answer");
  });

  test("纯 tool JSON 返回 content null", () => {
    const raw = '{"tool":"workspace.list_dir","args":{"path":"."}}';
    expect(formatModelOutputForUi(raw).content).toBeNull();
  });

  test("流式未闭合 JSON 不上屏", () => {
    const raw = '{"action":"final_answer","summary":"还没';
    const r = formatModelOutputForUi(raw, { streaming: true });
    expect(r.content).toBeNull();
  });

  test("流式未闭合 JSON 保留前缀自然语言", () => {
    const raw = '先说一句。\n{"action":"final_answer","summary":"半';
    const r = formatModelOutputForUi(raw, { streaming: true });
    expect(r.content).toBe("先说一句。");
  });

  test("普通文本原样", () => {
    expect(formatModelTextForUi("联调OK")).toBe("联调OK");
  });

  test("write_file 整文件 content 泄漏不上屏", () => {
    const raw = JSON.stringify({
      tool: "workspace.write_file",
      args: {
        path: "public/styles.css",
        content: "* {\nmargin: 0;\nbox-sizing: border-box;\n}\nbody { color: red; }\n",
      },
    });
    expect(formatModelOutputForUi(raw).content).toBeNull();
  });

  test("final_answer summary 内裸换行（非法 JSON）仍只展示正文", () => {
    const raw = `{"action":"final_answer","summary":"由于 workspace 权限限制，无法读取。

有两种替代方案：
请选一种方式继续。"}`;
    const r = formatModelOutputForUi(raw);
    expect(r.content).toContain("由于 workspace 权限限制");
    expect(r.content).toContain("有两种替代方案");
    expect(r.content).not.toContain("final_answer");
    expect(r.content).not.toContain('{"action"');
  });

  test("final_answer 前缀 + 非法 JSON 多行 summary", () => {
    const raw = `分析完成。
{"action":"final_answer","summary":"第一行

第二行"}`;
    const r = formatModelOutputForUi(raw);
    expect(r.content).toContain("分析完成");
    expect(r.content).toContain("第一行");
    expect(r.content).toContain("第二行");
    expect(r.content).not.toContain("final_answer");
  });
});

describe("mergeThinking", () => {
  test("去重包含关系", () => {
    expect(mergeThinking("abc", "ab")).toBe("abc");
    expect(mergeThinking("ab", "abc")).toBe("abc");
  });

  test("不同内容拼接", () => {
    expect(mergeThinking("a", "b")).toBe("a\n\nb");
  });
});
