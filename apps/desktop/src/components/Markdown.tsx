import { type ReactNode, memo } from "react";
/**
 * 对话 Markdown：react-markdown + remark-gfm + remark-breaks
 * - GFM：表格、删除线、任务列表等
 * - breaks：单换行 → <br>（聊天路径/短行不并段）
 * - 样式：根节点 class `md`，沿用 global.css / thinkingMd
 */
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

export type MarkdownProps = {
  readonly text: string;
  readonly className?: string;
};

const remarkPlugins = [remarkGfm, remarkBreaks];

/** 仅放行 http(s) 外链 */
function safeHref(href: string | undefined): string | undefined {
  if (!href) return undefined;
  if (/^https?:\/\//i.test(href)) return href;
  // 允许页内锚点 / 相对路径（本地预览）
  if (href.startsWith("#") || href.startsWith("/")) return href;
  return undefined;
}

const components: Components = {
  a({ href, children, ...rest }) {
    const safe = safeHref(href);
    if (!safe) {
      return <span>{children}</span>;
    }
    return (
      <a href={safe} target="_blank" rel="noreferrer noopener" {...rest}>
        {children}
      </a>
    );
  },
};

// ponytail: memo — text/className 是原语，默认浅比较即可。
// 流式时只有当前气泡 text 变，历史气泡跳过 react-markdown 重解析。
export const Markdown = memo(function Markdown({
  text,
  className,
}: MarkdownProps): ReactNode {
  const cls = ["md", className].filter(Boolean).join(" ");
  return (
    <div className={cls}>
      <ReactMarkdown remarkPlugins={remarkPlugins} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
