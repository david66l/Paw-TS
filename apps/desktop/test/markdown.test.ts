import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "../src/components/Markdown";

function renderMarkdown(text: string): string {
  return renderToStaticMarkup(createElement(Markdown, { text }));
}

describe("Markdown (react-markdown + remark-gfm)", () => {
  test("标题不显示 #", () => {
    const html = renderMarkdown("## 项目结构");
    expect(html).toContain("<h2");
    expect(html).toContain("项目结构");
    expect(html).not.toContain("## 项目结构");
  });

  test("单换行保留为 br（路径不并成一行）", () => {
    const html = renderMarkdown("`apps/`\n`packages/`\n`docs/`");
    expect(html).toContain("<br");
    expect(html).toContain("<code>apps/</code>");
    expect(html).toContain("<code>packages/</code>");
  });

  test("无序/有序列表", () => {
    const html = renderMarkdown("- a\n- b\n\n1. x\n2. y");
    expect(html).toContain("<ul>");
    expect(html).toContain("<ol>");
    expect(html).toContain("<li>");
    expect(html).toContain("a");
    expect(html).toContain("x");
  });

  test("代码块与粗体", () => {
    const html = renderMarkdown("用 **粗体** 和\n```ts\nconst x = 1\n```");
    expect(html).toContain("<strong>粗体</strong>");
    expect(html).toContain("<pre>");
    expect(html).toContain("const x = 1");
  });

  test("不把 code 内的 * 当粗体", () => {
    const html = renderMarkdown("`a*b*c` and **ok**");
    expect(html).toContain("<code>a*b*c</code>");
    expect(html).toContain("<strong>ok</strong>");
  });

  test("GFM 表格", () => {
    const html = renderMarkdown(
      "| name | role |\n| --- | --- |\n| paw | agent |",
    );
    expect(html).toContain("<table>");
    expect(html).toContain("<th>");
    expect(html).toContain("paw");
  });

  test("GFM 删除线", () => {
    const html = renderMarkdown("~~old~~ new");
    expect(html).toContain("<del>");
    expect(html).toContain("old");
  });

  test("外链安全：javascript: 不渲染为可点链接", () => {
    const html = renderMarkdown("[x](javascript:alert(1))");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain('href="javascript');
  });

  test("http 链接可点", () => {
    const html = renderMarkdown("[site](https://example.com)");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('target="_blank"');
  });

  test("根节点带 md class", () => {
    const html = renderMarkdown("hi");
    expect(html).toContain('class="md"');
  });
});
