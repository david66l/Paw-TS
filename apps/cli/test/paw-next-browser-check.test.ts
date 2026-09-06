import { expect, setDefaultTimeout, test } from "bun:test";
import {
  createBrowserCheckPlugin,
  parseBrowserScenario,
  runBrowserCheck,
} from "../src/paw-next/browser-check.js";

setDefaultTimeout(30_000);
const html = `<!doctype html><html><body><label>Name<input id="name"></label><button id="add" onclick="setTimeout(()=>document.querySelector('#count').textContent='Count: 1',100)">Add</button><p id="count">Count: 0</p><script>document.body.dataset.fresh=localStorage.getItem('seen')?'no':'yes';localStorage.setItem('seen','yes')</script></body></html>`;

test("real browser performs interaction assertions, waits for behavior, and isolates storage", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      new Response(html, { headers: { "content-type": "text/html" } }),
  });
  try {
    const scenario = {
      url: server.url.href,
      steps: [
        { action: "fill", selector: "#name", value: "Paw" },
        { action: "assert_value", selector: "#name", value: "Paw" },
        { action: "click", selector: "#add" },
        { action: "assert_text", selector: "#count", value: "Count: 1" },
        { action: "assert_visible", selector: 'body[data-fresh="yes"]' },
      ],
    };
    for (let i = 0; i < 2; i++) {
      const result = await runBrowserCheck(scenario);
      expect(result.ok).toBe(true);
      expect(result.payload).toMatchObject({
        evidence: { assertions: 3, passed: true },
        errors: [],
      });
      expect(JSON.stringify(result.payload)).toContain("Count: 1");
    }
    const failed = await runBrowserCheck({
      url: server.url.href,
      steps: [
        { action: "assert_text", selector: "#count", value: "Count: 99" },
      ],
    });
    expect(failed.ok).toBe(false);
    expect(failed.payload).toMatchObject({
      evidence: { assertions: 0, passed: false },
    });
    const snapshot = await runBrowserCheck({ url: server.url.href, steps: [] });
    expect(snapshot.ok).toBe(true);
    expect(snapshot.payload).toMatchObject({ evidence: { assertions: 0 } });
  } finally {
    await server.stop(true);
  }
});

test("browser blocks redirects to other origins without sending a request", async () => {
  let hits = 0;
  const other = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      hits++;
      return new Response("private");
    },
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.redirect(other.url.href),
  });
  try {
    expect(
      (await runBrowserCheck({ url: server.url.href, steps: [] })).ok,
    ).toBe(false);
    expect(hits).toBe(0);
  } finally {
    await server.stop(true);
    await other.stop(true);
  }
});

test("browser cancellation stops the active navigation", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Promise<Response>(() => {}),
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 800);
  const started = Date.now();
  try {
    expect(
      (
        await runBrowserCheck(
          { url: server.url.href, steps: [] },
          controller.signal,
        )
      ).ok,
    ).toBe(false);
    expect(Date.now() - started).toBeLessThan(6000);
  } finally {
    clearTimeout(timer);
    await server.stop(true);
  }
});

test("browser contract rejects remote access, script actions, extra fields and unbounded steps", () => {
  for (const url of [
    "https://example.com",
    "file:///C:/secret",
    "http://127.0.0.1",
    "http://user:pass@127.0.0.1:3000",
    "http://127.0.0.2:3000",
  ])
    expect(() => parseBrowserScenario({ url, steps: [] })).toThrow();
  expect(() =>
    parseBrowserScenario({
      url: "http://127.0.0.1:3000",
      steps: [
        { action: "evaluate", selector: "body", value: "fetch('/delete')" },
      ],
    }),
  ).toThrow();
  expect(() =>
    parseBrowserScenario({
      url: "http://127.0.0.1:3000",
      steps: [],
      script: "evil",
    }),
  ).toThrow();
  expect(() =>
    parseBrowserScenario({
      url: "http://127.0.0.1:3000",
      steps: Array(13).fill({ action: "assert_visible", selector: "body" }),
    }),
  ).toThrow();
  const plugin = createBrowserCheckPlugin();
  expect(plugin.entries[0]?.classify({}, "root")).toMatchObject({
    effectClass: "unknown",
    permissionCategory: "shell",
    concurrencyMode: "exclusive",
  });
});
