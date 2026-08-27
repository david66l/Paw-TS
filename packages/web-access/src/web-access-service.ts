import type {
  WebAccessServiceV1,
  WebFetchPayloadV1,
  WebSearchPayloadV1,
} from "@paw/harness";

import {
  DEFAULT_WEB_ACCESS_POLICY_V1,
  type WebAccessPolicyV1,
  freezeWebAccessPolicyV1,
} from "./policy.js";
import {
  type PublicWebTransportV1,
  createPublicWebTransportV1,
  parsePublicWebUrlV1,
} from "./public-web-transport.js";

const BING_HTML_ENDPOINT = "https://www.bing.com/search";

export interface CreateWebAccessServiceOptionsV1 {
  readonly policy?: WebAccessPolicyV1;
  /** @internal Provider transport seam for deterministic tests. */
  readonly transport?: PublicWebTransportV1;
}

export function createWebAccessServiceV1(
  options: CreateWebAccessServiceOptionsV1 = {},
): WebAccessServiceV1 {
  const policy = freezeWebAccessPolicyV1(
    options.policy ?? DEFAULT_WEB_ACCESS_POLICY_V1,
  );
  const transport = options.transport ?? createPublicWebTransportV1({ policy });
  const service: WebAccessServiceV1 = {
    async fetch(input, signal) {
      try {
        const url = parsePublicWebUrlV1(input.url).toString();
        const maxLength = input.maxLength ?? policy.defaultFetchChars;
        if (
          !Number.isSafeInteger(maxLength) ||
          maxLength < 1 ||
          maxLength > policy.maxFetchChars
        ) {
          return failure(
            `web_fetch max_length must be between 1 and ${policy.maxFetchChars}`,
          );
        }
        const response = await transport.getText(url, signal);
        if (response.status < 200 || response.status >= 300) {
          return failure(`web_fetch HTTP ${response.status}`);
        }
        const contentType = normalizedContentType(
          response.headers["content-type"] ?? "text/plain",
        );
        if (!isTextContentType(contentType)) {
          return failure(`web_fetch unsupported content type: ${contentType}`);
        }
        const isMarkup =
          contentType.includes("html") || contentType.includes("xml");
        const title = isMarkup ? extractTitle(response.body) : undefined;
        const extracted = isMarkup ? stripMarkup(response.body) : response.body;
        const charTruncated = extracted.length > maxLength;
        const value: WebFetchPayloadV1 = Object.freeze({
          url,
          finalUrl: response.finalUrl,
          status: response.status,
          contentType,
          ...(title ? { title } : {}),
          content: extracted.slice(0, maxLength),
          truncated: response.truncated || charTruncated,
          untrusted: true,
        });
        return { ok: true, value };
      } catch (error) {
        if (signal?.aborted) throw error;
        return failure(describeError(error));
      }
    },
    async search(input, signal) {
      const query = input.query.trim();
      if (!query) return failure("web_search query is required");
      if (query.length > policy.maxQueryChars) {
        return failure(
          `web_search query exceeds ${policy.maxQueryChars} characters`,
        );
      }
      const maxResults = input.maxResults ?? 5;
      if (
        !Number.isSafeInteger(maxResults) ||
        maxResults < 1 ||
        maxResults > policy.maxSearchResults
      ) {
        return failure(
          `web_search max_results must be between 1 and ${policy.maxSearchResults}`,
        );
      }
      try {
        const searchUrl = new URL(BING_HTML_ENDPOINT);
        searchUrl.searchParams.set("q", query);
        const response = await transport.getText(searchUrl.toString(), signal);
        if (response.status < 200 || response.status >= 300) {
          return failure(`web_search HTTP ${response.status}`);
        }
        const results = parseBingSearchResultsV1(response.body, maxResults);
        if (results.length === 0) {
          return failure("web_search returned no parseable results");
        }
        const value: WebSearchPayloadV1 = Object.freeze({
          query,
          results: Object.freeze(results),
          untrusted: true,
        });
        return { ok: true, value };
      } catch (error) {
        if (signal?.aborted) throw error;
        return failure(describeError(error));
      }
    },
  };
  return Object.freeze(service);
}

export function parseBingSearchResultsV1(
  html: string,
  maxResults: number,
): readonly {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
}[] {
  const results: Array<{
    readonly title: string;
    readonly url: string;
    readonly snippet: string;
  }> = [];
  const blocks = [
    ...html.matchAll(
      /<li[^>]*class=["'][^"']*\bb_algo\b[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi,
    ),
  ];
  for (const match of blocks) {
    if (results.length >= maxResults) break;
    const block = match[1] ?? "";
    const anchor = block.match(
      /<h2[^>]*>\s*<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>\s*<\/h2>/i,
    );
    const rawUrl = decodeHtml(anchor?.[1] ?? "").trim();
    const title = stripMarkup(anchor?.[2] ?? "").trim();
    if (!rawUrl || !title) continue;
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = stripMarkup(snippetMatch?.[1] ?? "").trim();
    try {
      results.push(
        Object.freeze({
          title,
          url: parsePublicWebUrlV1(rawUrl).toString(),
          snippet,
        }),
      );
    } catch {
      // Search-result URLs are untrusted; omit non-public syntax.
    }
  }
  return Object.freeze(results);
}

function normalizedContentType(input: string): string {
  return input.split(";", 1)[0]?.trim().toLowerCase() || "text/plain";
}

function isTextContentType(input: string): boolean {
  return (
    input.startsWith("text/") ||
    input === "application/json" ||
    input === "application/ld+json" ||
    input === "application/xml" ||
    input === "application/xhtml+xml" ||
    input.endsWith("+json") ||
    input.endsWith("+xml")
  );
}

function extractTitle(markup: string): string | undefined {
  const match = markup.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = match ? stripMarkup(match[1] ?? "").trim() : "";
  return title || undefined;
}

function stripMarkup(markup: string): string {
  return decodeHtml(
    markup
      .replace(/<(script|style|noscript|template)[^>]*>[\s\S]*?<\/\1>/gi, "")
      .replace(
        /<(p|div|h[1-6]|li|tr|pre|blockquote|article|section|main|header|footer)[^>]*>/gi,
        "\n",
      )
      .replace(
        /<\/(p|div|h[1-6]|li|tr|pre|blockquote|article|section|main|header|footer)>/gi,
        "\n",
      )
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/\r\n?/g, "\n")
    .replace(/[\t ]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeHtml(input: string): string {
  return input
    .replace(/&#(\d+);/g, (match, digits: string) =>
      decodeCodePoint(match, digits, 10),
    )
    .replace(/&#x([0-9a-f]+);/gi, (match, digits: string) =>
      decodeCodePoint(match, digits, 16),
    )
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&(?:nbsp|ensp|emsp|thinsp);/gi, " ");
}

function decodeCodePoint(match: string, digits: string, radix: number): string {
  const value = Number.parseInt(digits, radix);
  return Number.isSafeInteger(value) && value >= 0 && value <= 0x10ffff
    ? String.fromCodePoint(value)
    : match;
}

function failure(reason: string): {
  readonly ok: false;
  readonly reason: string;
} {
  return { ok: false, reason };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
