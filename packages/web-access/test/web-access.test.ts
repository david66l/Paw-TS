import { describe, expect, test } from "bun:test";

import {
  WEBFETCH,
  WEBSEARCH,
  type WebAccessServiceV1,
  executeTool,
} from "@paw/harness";
import { createFrozenToolRegistryV1 } from "@paw/runtime";

import {
  type PublicWebTransportV1,
  createPinnedLookupV1,
  createPublicWebTransportV1,
  createWebAccessServiceV1,
  createWebAccessToolPluginV1,
  isPublicInternetAddressV1,
  parseBingSearchResultsV1,
  parsePublicWebUrlV1,
  resolvePublicAddressesV1,
} from "../src/index.js";

const signal = new AbortController().signal;

describe("public web transport", () => {
  test("pins one checked address for Node and Bun lookup callback shapes", () => {
    const lookup = createPinnedLookupV1({
      address: "93.184.216.34",
      family: 4,
    }) as (...args: unknown[]) => void;
    let single: readonly unknown[] = [];
    let all: readonly unknown[] = [];
    lookup("example.com", {}, (...args: unknown[]) => {
      single = args;
    });
    lookup("example.com", { all: true }, (...args: unknown[]) => {
      all = args;
    });
    expect(single).toEqual([null, "93.184.216.34", 4]);
    expect(all).toEqual([null, [{ address: "93.184.216.34", family: 4 }]]);
  });

  test("normalizes callback DNS results under the active Node-compatible runtime", async () => {
    const addresses = await resolvePublicAddressesV1("localhost");
    expect(addresses.length).toBeGreaterThan(0);
    for (const address of addresses) {
      expect([4, 6]).toContain(address.family);
      expect(typeof address.address).toBe("string");
    }
  });

  test("accepts global addresses and rejects local, private, reserved, and documentation ranges", () => {
    for (const address of [
      "93.184.216.34",
      "8.8.8.8",
      "2606:4700:4700::1111",
    ]) {
      expect(isPublicInternetAddressV1(address)).toBeTrue();
    }
    for (const address of [
      "0.0.0.0",
      "10.0.0.1",
      "100.64.0.1",
      "127.0.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "192.168.1.1",
      "192.0.2.1",
      "198.51.100.1",
      "203.0.113.1",
      "224.0.0.1",
      "::1",
      "fc00::1",
      "fe80::1",
      "2001:db8::1",
      "ff02::1",
      "::ffff:127.0.0.1",
    ]) {
      expect(isPublicInternetAddressV1(address)).toBeFalse();
    }
  });

  test("rejects unsafe URL syntax before DNS or HTTP", () => {
    for (const url of [
      "file:///etc/passwd",
      "http://localhost/",
      "http://service.internal/",
      "http://127.0.0.1/",
      "http://2130706433/",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]/",
      "https://user:secret@example.com/",
      "https://example.com:8443/",
      "http://single-label/",
    ]) {
      expect(() => parsePublicWebUrlV1(url)).toThrow();
    }
    expect(
      parsePublicWebUrlV1("https://example.com/docs#part").toString(),
    ).toBe("https://example.com/docs");
  });

  test("rejects private DNS answers before opening a socket", async () => {
    let requestCalls = 0;
    const transport = createPublicWebTransportV1({
      dependencies: {
        resolveAddresses: async () => [{ address: "10.0.0.8", family: 4 }],
        requestHop: async () => {
          requestCalls += 1;
          return { status: 200, headers: {}, body: "no", truncated: false };
        },
      },
    });

    await expect(
      transport.getText("https://example.com", signal),
    ).rejects.toThrow("non-public");
    expect(requestCalls).toBe(0);
  });

  test("pins the checked address and validates every redirect", async () => {
    const hops: string[] = [];
    const transport = createPublicWebTransportV1({
      dependencies: {
        resolveAddresses: async () => [{ address: "93.184.216.34", family: 4 }],
        requestHop: async (input) => {
          hops.push(`${input.url.toString()}@${input.address.address}`);
          return {
            status: 302,
            headers: { location: "http://127.0.0.1/private" },
            body: "",
            truncated: false,
          };
        },
      },
    });

    await expect(
      transport.getText("http://example.com/start", signal),
    ).rejects.toThrow("not public");
    expect(hops).toEqual(["http://example.com/start@93.184.216.34"]);
  });

  test("prefers a checked IPv4 address when both families are public", async () => {
    let selected = "";
    const transport = createPublicWebTransportV1({
      dependencies: {
        resolveAddresses: async () => [
          { address: "2606:4700:4700::1111", family: 6 },
          { address: "93.184.216.34", family: 4 },
        ],
        requestHop: async (input) => {
          selected = input.address.address;
          return { status: 200, headers: {}, body: "ok", truncated: false };
        },
      },
    });

    await transport.getText("https://example.com", signal);
    expect(selected).toBe("93.184.216.34");
  });

  test("rejects HTTPS downgrade redirects", async () => {
    const transport = createPublicWebTransportV1({
      dependencies: {
        resolveAddresses: async () => [{ address: "93.184.216.34", family: 4 }],
        requestHop: async () => ({
          status: 302,
          headers: { location: "http://example.com/plain" },
          body: "",
          truncated: false,
        }),
      },
    });
    await expect(
      transport.getText("https://example.com/secure", signal),
    ).rejects.toThrow("downgrade");
  });
});

describe("web access service and plugin", () => {
  test("extracts bounded page text and marks it untrusted", async () => {
    const transport: PublicWebTransportV1 = {
      async getText() {
        return {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
          body: `<html><head><title>Docs &amp; API</title><script>ignore()</script></head><body><h1>Reference</h1><p>${"x".repeat(30)}</p></body></html>`,
          truncated: false,
          finalUrl: "https://docs.example.com/reference",
          redirectCount: 1,
        };
      },
    };
    const service = createWebAccessServiceV1({ transport });
    const result = await service.fetch(
      { url: "https://example.com/start", maxLength: 20 },
      signal,
    );

    expect(result).toMatchObject({
      ok: true,
      value: {
        url: "https://example.com/start",
        finalUrl: "https://docs.example.com/reference",
        title: "Docs & API",
        contentType: "text/html",
        truncated: true,
        untrusted: true,
      },
    });
    if (result.ok) {
      expect(result.value.content.length).toBe(20);
      expect(result.value.content).not.toContain("ignore");
    }
  });

  test("parses bounded Bing results and delegates through Harness", async () => {
    const html = `
      <li class="b_algo">
        <h2><a href="https://example.com/docs">Example &amp; Docs</a></h2>
        <div class="b_caption"><p>Official&ensp;<b>documentation</b>. &#999999999999;</p></div>
      </li>`;
    expect(parseBingSearchResultsV1(html, 5)).toEqual([
      {
        title: "Example & Docs",
        url: "https://example.com/docs",
        snippet: "Official documentation. &#999999999999;",
      },
    ]);
    const webAccess: WebAccessServiceV1 = createWebAccessServiceV1({
      transport: {
        async getText() {
          return {
            status: 200,
            headers: { "content-type": "text/html" },
            body: html,
            truncated: false,
            finalUrl: "https://www.bing.com/search?q=paw",
            redirectCount: 0,
          };
        },
      },
    });
    const result = await executeTool(
      { workspaceRoot: process.cwd(), webAccess, abortSignal: signal },
      WEBSEARCH,
      { query: "paw runtime", max_results: 5 },
    );
    expect(result).toMatchObject({
      ok: true,
      payload: {
        query: "paw runtime",
        untrusted: true,
        results: [{ url: "https://example.com/docs" }],
      },
      summary: "web_search: 1 result(s)",
    });
  });

  test("installs two bounded, parallel, read-only V3 tool entries", () => {
    const registry = createFrozenToolRegistryV1({
      tools: [],
      plugins: [createWebAccessToolPluginV1()],
    });
    expect(registry.plugins).toEqual([
      {
        pluginId: "paw.web-access",
        pluginVersion:
          "paw.web-access.v1:bing-html-v1:d50000:c100000:b2097152:t15000:r5:s10:q500",
      },
    ]);
    const fetch = registry.validateAndClassify(
      {
        id: "fetch-call",
        name: "workspace_web_fetch",
        arguments: { url: "https://example.com/docs", max_length: 50_000 },
      },
      process.cwd(),
    );
    const search = registry.validateAndClassify(
      {
        id: "search-call",
        name: "workspace_web_search",
        arguments: { query: "TypeScript docs", max_results: 5 },
      },
      process.cwd(),
    );
    expect(fetch.ok).toBeTrue();
    expect(search.ok).toBeTrue();
    if (fetch.ok && search.ok) {
      expect(fetch.value.internalName).toBe(WEBFETCH);
      expect(search.value.internalName).toBe(WEBSEARCH);
      expect(fetch.value.classification).toMatchObject({
        effectClass: "read",
        permissionCategory: "read",
        concurrencyMode: "parallel",
      });
    }
    expect(
      registry.validateAndClassify(
        {
          id: "unsafe-fetch",
          name: "workspace_web_fetch",
          arguments: { url: "http://127.0.0.1/private" },
        },
        process.cwd(),
      ).ok,
    ).toBeFalse();
    expect(
      registry.validateAndClassify(
        {
          id: "wide-search",
          name: "workspace_web_search",
          arguments: { query: "docs", max_results: 11 },
        },
        process.cwd(),
      ).ok,
    ).toBeFalse();
  });

  test("Harness prefers the injected service over its legacy direct fetch", async () => {
    let calls = 0;
    const webAccess: WebAccessServiceV1 = {
      async fetch(input) {
        calls += 1;
        return {
          ok: true,
          value: {
            url: input.url,
            finalUrl: input.url,
            status: 200,
            contentType: "text/plain",
            content: "injected service",
            truncated: false,
            untrusted: true,
          },
        };
      },
      async search() {
        throw new Error("unexpected search");
      },
    };
    const result = await executeTool(
      { workspaceRoot: process.cwd(), webAccess },
      WEBFETCH,
      { url: "https://example.com" },
    );
    expect(calls).toBe(1);
    expect(result).toMatchObject({
      ok: true,
      payload: { content: "injected service", untrusted: true },
    });
  });
});
