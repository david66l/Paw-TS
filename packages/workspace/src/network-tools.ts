/**
 * WebFetchTool and WebSearchTool for the Paw workspace harness.
 */

export interface WebFetchOptions {
  readonly url: string;
  readonly maxLength?: number;
}

export interface WebFetchResult {
  readonly content?: string;
  readonly title?: string;
  readonly error?: string;
}

export interface WebSearchOptions {
  readonly query: string;
  readonly maxResults?: number;
}

export interface WebSearchResult {
  readonly results?: Array<{
    readonly title: string;
    readonly url: string;
    readonly snippet: string;
  }>;
  readonly error?: string;
}

function stripHtml(html: string): string {
  // Remove script/style tags and their content
  let text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
  // Replace common block elements with newlines
  text = text
    .replace(/<(p|div|h[1-6]|li|tr|pre|blockquote)[^>]*>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr|pre|blockquote)>/gi, "\n");
  // Replace br with newline
  text = text.replace(/<br\s*\/?>/gi, "\n");
  // Remove remaining tags
  text = text.replace(/<[^>]+>/g, "");
  // Decode common HTML entities
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
  // Collapse whitespace
  text = text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text;
}

function extractTitle(html: string): string | undefined {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (m) {
    return stripHtml(m[1]!).trim();
  }
  return undefined;
}

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
 * Search the web using DuckDuckGo HTML interface (no API key required).
 * This scrapes the DuckDuckGo HTML results page. Fragile but works for
 * basic queries without rate limits.
 */
export async function searchWeb(
  opts: WebSearchOptions,
): Promise<WebSearchResult> {
  const query = opts.query.trim();
  if (!query) {
    return { error: "missing query" };
  }
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

function parseDuckDuckGoResults(
  html: string,
  maxResults: number,
): Array<{ title: string; url: string; snippet: string }> {
  const results: Array<{ title: string; url: string; snippet: string }> = [];
  // DuckDuckGo HTML results have .result elements
  const resultBlocks = html.split('<div class="result results_links">');
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
      // DuckDuckGo redirects through their domain
      const duckMatch = url.match(/duckduckgo\.com\/l\/\?[^&]*&uddg=([^&]+)/);
      if (duckMatch) {
        try {
          url = decodeURIComponent(duckMatch[1]!);
        } catch {
          // keep original
        }
      }
      const snippet = snippetMatch ? stripHtml(snippetMatch[1]!).trim() : "";
      results.push({ title, url, snippet });
    }
  }
  return results;
}
