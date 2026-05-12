import { describe, expect, test } from "bun:test";
import { fetchWebPage, searchWeb } from "../src/network-tools.js";

describe("fetchWebPage", () => {
  test("returns error for missing url", async () => {
    const r = await fetchWebPage({ url: "" });
    expect(r.error).toBeDefined();
    expect(r.content).toBeUndefined();
  });

  test("returns error for non-http url", async () => {
    const r = await fetchWebPage({ url: "ftp://example.com" });
    expect(r.error).toBeDefined();
  });
});

describe("searchWeb", () => {
  test("returns error for missing query", async () => {
    const r = await searchWeb({ query: "" });
    expect(r.error).toBeDefined();
    expect(r.results).toBeUndefined();
  });
});
