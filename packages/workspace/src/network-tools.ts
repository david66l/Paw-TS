/**
 * network-tools.ts — 网页抓取与搜索工具
 *
 * 【是什么】
 * 提供 WebFetch（网页抓取）和 WebSearch（网络搜索）两个网络工具。
 * WebFetch 通过 HTTP GET 获取网页内容并提取纯文本；WebSearch 通过
 * DuckDuckGo 的 HTML 接口进行搜索（无需 API Key）。
 *
 * 【为什么需要】
 * AI Agent 在处理任务时经常需要查阅在线文档、搜索最新信息。这两个工具
 * 让 Agent 可以直接在工具调用中完成网络信息获取，无需用户手动复制粘贴。
 *
 * 【关键设计决策】
 * 1. 无需 API Key：WebSearch 使用 DuckDuckGo 的 HTML 页面（非 API），
 *    避免了 API Key 管理和付费问题。虽然解析 HTML 比较脆弱，但对于
 *    基本查询足够了。
 * 2. HTML 到纯文本转换：stripHtml() 不是简单的正则去标签，而是做了
 *    两步处理——先将块级元素替换为换行符，再去除剩余标签。这样能保留
 *    文档的段落结构，输出更可读。
 * 3. 内容长度限制：默认 maxLength=50000，防止超大页面撑爆上下文。
 * 4. User-Agent 伪装：使用合理的 UA 字符串，避免被目标网站拒绝。
 * 5. 重定向跟随：fetch 使用 redirect: "follow"，自然处理 HTTP 重定向。
 * 6. JSON 响应特殊处理：如果 Content-Type 是 application/json，不进行
 *    HTML 解析，直接返回原始 JSON 文本。
 */

export interface WebFetchOptions {
  /** 要抓取的 URL */
  readonly url: string;
  /** 返回内容的最大长度（字符数），默认 50000 */
  readonly maxLength?: number;
}

export interface WebFetchResult {
  /** 提取后的纯文本内容 */
  readonly content?: string;
  /** 页面标题（从 <title> 标签提取） */
  readonly title?: string;
  /** 错误信息（如有） */
  readonly error?: string;
}

export interface WebSearchOptions {
  /** 搜索关键词 */
  readonly query: string;
  /** 最大返回结果数，默认 5，范围 1-10 */
  readonly maxResults?: number;
}

export interface WebSearchResult {
  /** 搜索结果列表 */
  readonly results?: Array<{
    readonly title: string;
    readonly url: string;
    readonly snippet: string;
  }>;
  /** 错误信息（如有） */
  readonly error?: string;
}

/**
 * 将 HTML 转换为纯文本。
 *
 * 处理步骤：
 * 1. 移除 <script> 和 <style> 标签及其内容
 * 2. 将块级元素（p, div, h1-h6, li, tr, pre, blockquote）替换为换行符，
 *    保留文档段落结构
 * 3. <br> 替换为换行符
 * 4. 移除所有剩余 HTML 标签
 * 5. 解码常见 HTML 实体（&amp; &lt; &gt; &quot; &#39; &nbsp;）
 * 6. 合并连续空行（最多保留一个空行），去除首尾空白
 */
function stripHtml(html: string): string {
  // 移除 script/style 标签及其全部内容
  let text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
  // 将块级元素替换为换行符，保留段落结构
  text = text
    .replace(/<(p|div|h[1-6]|li|tr|pre|blockquote)[^>]*>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr|pre|blockquote)>/gi, "\n");
  // <br> 替换为换行符
  text = text.replace(/<br\s*\/?>/gi, "\n");
  // 移除剩余的 HTML 标签
  text = text.replace(/<[^>]+>/g, "");
  // 解码常见 HTML 实体
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
  // 规范化空白字符：统一换行符，合并连续空行
  text = text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text;
}

/** 从 HTML 中提取 <title> 标签内容 */
function extractTitle(html: string): string | undefined {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (m) {
    return stripHtml(m[1]!).trim();
  }
  return undefined;
}

/**
 * 抓取指定 URL 的网页内容并返回纯文本。
 *
 * 处理流程：
 * 1. 验证 URL 格式
 * 2. HTTP GET 请求（自动跟随重定向）
 * 3. 根据 Content-Type 决定处理方式：
 *    - application/json → 直接返回原始 JSON 文本
 *    - 其他 → HTML 解析，提取标题和纯文本
 * 4. 按 maxLength 截断内容
 *
 * @param opts 抓取配置（URL 和可选长度限制）
 * @returns 包含 content、title 或 error 的结果
 */
export async function fetchWebPage(
  opts: WebFetchOptions,
): Promise<WebFetchResult> {
  const url = opts.url.trim();
  if (!url) {
    return { error: "missing url" };
  }
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    return { error: "url must start with http:// or https://" };
  }
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; Paw/1.0)",
      },
      redirect: "follow",
    });
    if (!res.ok) {
      return { error: `HTTP ${res.status}: ${res.statusText}` };
    }
    const contentType = res.headers.get("content-type") || "";
    // JSON 响应不经过 HTML 解析，直接返回原始文本
    if (contentType.includes("application/json")) {
      const json = await res.text();
      const maxLen = opts.maxLength ?? 50_000;
      return {
        content: json.slice(0, maxLen),
        title: url,
      };
    }
    const html = await res.text();
    const title = extractTitle(html);
    let text = stripHtml(html);
    const maxLen = opts.maxLength ?? 50_000;
    if (text.length > maxLen) {
      text = `${text.slice(0, maxLen)}\n\n[truncated]`;
    }
    return { content: text, title };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { error: msg };
  }
}

/**
 * 通过 DuckDuckGo HTML 接口搜索网络（无需 API Key）。
 *
 * 这是一个基于 HTML 抓取的搜索方案，解析 DuckDuckGo 的 HTML 搜索结果页。
 * 维护性较差（页面结构变化会导致解析失败），但优势是不需要 API Key，
 * 且没有频率限制。
 *
 * @param opts 搜索配置（关键词和可选最大结果数）
 * @returns 包含搜索结果列表或 error 的结果
 */
export async function searchWeb(
  opts: WebSearchOptions,
): Promise<WebSearchResult> {
  const query = opts.query.trim();
  if (!query) {
    return { error: "missing query" };
  }
  // 限制结果数在 1-10 之间
  const maxResults = Math.min(Math.max(opts.maxResults ?? 5, 1), 10);
  try {
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const res = await fetch(searchUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.0",
      },
    });
    if (!res.ok) {
      return { error: `Search HTTP ${res.status}: ${res.statusText}` };
    }
    const html = await res.text();
    const results = parseDuckDuckGoResults(html, maxResults);
    if (results.length === 0) {
      return { error: "no results found" };
    }
    return { results };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { error: msg };
  }
}

/**
 * 解析 DuckDuckGo HTML 搜索结果页。
 *
 * DuckDuckGo HTML 版本的结果页使用 class="result results_links" 标记每个
 * 结果块。每个结果块内包含：
 * - class="result__a" 的 <a> 标签 → 标题和 URL
 * - class="result__snippet" 的 <a> 标签 → 摘要
 *
 * 注意：DuckDuckGo 的 URL 会经过重定向包装（duckduckgo.com/l/?uddg=...），
 * 这里会尝试提取并解码真实的原始 URL。
 *
 * @param html DuckDuckGo 搜索结果页的 HTML
 * @param maxResults 最大返回结果数
 * @returns 解析后的搜索结果列表
 */
function parseDuckDuckGoResults(
  html: string,
  maxResults: number,
): Array<{ title: string; url: string; snippet: string }> {
  const results: Array<{ title: string; url: string; snippet: string }> = [];
  // DuckDuckGo HTML 版本的结果块以这个 div 为分隔
  const resultBlocks = html.split('<div class="result results_links">');
  // 从索引 1 开始，因为 split 的第一个元素是第一个分隔符之前的内容（非结果）
  for (let i = 1; i < resultBlocks.length && results.length < maxResults; i++) {
    const block = resultBlocks[i]!;
    const titleMatch = block.match(
      /<a[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/,
    );
    const urlMatch = block.match(/<a[^>]*class="result__a"[^>]*href="([^"]*)"/);
    const snippetMatch = block.match(
      /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/,
    );
    if (titleMatch && urlMatch) {
      const title = stripHtml(titleMatch[1]!).trim();
      let url = urlMatch[1]!;
      // DuckDuckGo 的重定向链接中包含真实 URL，尝试提取
      const duckMatch = url.match(/duckduckgo\.com\/l\/\?[^&]*&uddg=([^&]+)/);
      if (duckMatch) {
        try {
          url = decodeURIComponent(duckMatch[1]!);
        } catch {
          // 解码失败时保留原始 URL
        }
      }
      const snippet = snippetMatch ? stripHtml(snippetMatch[1]!).trim() : "";
      results.push({ title, url, snippet });
    }
  }
  return results;
}
