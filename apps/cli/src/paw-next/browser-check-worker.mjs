import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
const BROWSER_AUDIT_POLICY = "paw.browser-audit.v1";
const BROWSER_PROOF_PREFIX = "Browser observation: ";
const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** One call owns one fresh browser; interrupted interactions are never auto-replayed. */
async function runBrowserCheck(scenario, signal) {
  const { chromium } = await import("playwright");
  signal?.throwIfAborted();
  const browser = await chromium.launch({ headless: true, timeout: 10_000 });
  const abort = () => {
    void browser.close().catch(() => {});
  };
  signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, 30_000);
  const errors = [];
  const recordError = (message) => {
    if (errors.length < 12) errors.push(message);
  };
  const checks = [];
  let snapshot = "";
  try {
    signal?.throwIfAborted();
    const context = await browser.newContext({
      serviceWorkers: "block",
      acceptDownloads: false,
      viewport: { width: 1280, height: 800 },
    });
    const origin = new URL(scenario.url).origin;
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== origin || url.protocol !== "http:") {
        recordError("Blocked cross-origin request");
        await route.abort();
        return;
      }
      try {
        // Browser route handlers do not intercept every redirect hop. Fetch with
        // redirects disabled and reject redirects before a second origin is reached.
        const response = await route.fetch({
          maxRedirects: 0,
          timeout: 10_000,
        });
        if (response.status() >= 300 && response.status() < 400) {
          recordError(
            "HTTP redirects are not supported; use the final local URL",
          );
          await route.abort();
        } else await route.fulfill({ response });
      } catch {
        recordError("Local request failed");
        await route.abort().catch(() => {});
      }
    });
    await context.routeWebSocket(/.*/, (socket) => {
      const url = new URL(socket.url());
      if (url.protocol === "ws:" && `http://${url.host}` === origin)
        socket.connectToServer();
      else {
        recordError("Blocked cross-origin WebSocket");
        socket.close();
      }
    });
    const page = await context.newPage();
    context.on("page", (extra) => {
      if (extra !== page) {
        recordError("Blocked popup");
        void extra.close();
      }
    });
    page.on("dialog", (dialog) => {
      recordError("Unexpected dialog");
      void dialog.dismiss();
    });
    page.on("download", (download) => {
      recordError("Blocked download");
      void download.cancel();
    });
    page.on("pageerror", (error) => recordError(error.message.slice(0, 500)));
    page.setDefaultTimeout(3000);
    const response = await page.goto(scenario.url, {
      waitUntil: "domcontentloaded",
      timeout: 10_000,
    });
    if (!response?.ok())
      throw new Error(`HTTP ${response?.status() ?? "unavailable"}`);
    for (const step of scenario.steps) {
      signal?.throwIfAborted();
      // CSS-only selectors, never Playwright's other selector engines or page code.
      const target = page.locator(`css=${step.selector}`);
      await target.waitFor({ state: "visible" });
      if ((await target.count()) !== 1)
        throw new Error("Selector must match exactly one visible element");
      if (step.action === "click") await target.click();
      else if (step.action === "fill") await target.fill(step.value ?? "");
      else {
        let actual = "";
        let passed = false;
        const deadline = Date.now() + 3000;
        do {
          actual =
            step.action === "assert_value"
              ? await target.inputValue()
              : step.action === "assert_text"
                ? await target.innerText()
                : "visible";
          passed =
            step.action === "assert_visible" ||
            (step.action === "assert_text"
              ? actual.includes(step.value ?? "")
              : actual === step.value);
          if (!passed) await new Promise((resolve) => setTimeout(resolve, 50));
        } while (!passed && Date.now() < deadline && !signal?.aborted);
        checks.push({
          action: step.action,
          selector: step.selector,
          ...(step.value === undefined ? {} : { expected: step.value }),
          actual: actual.slice(0, 2000),
          passed,
        });
        if (!passed)
          throw new Error(`Assertion failed: ${step.action} ${step.selector}`);
      }
    }
    snapshot = (
      await page.locator("body").ariaSnapshot({ timeout: 3000 })
    ).slice(0, 12_000);
  } catch (error) {
    recordError(String(error).slice(0, 500));
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    await browser.close();
  }
  const passed = errors.length === 0 && !signal?.aborted;
  const evidence = {
    schemaVersion: BROWSER_AUDIT_POLICY,
    url: scenario.url,
    scenarioHash: hash(scenario),
    observationHash: hash({ checks, snapshot, errors }),
    assertions: checks.filter((check) => check.passed).length,
    passed,
    checkedAt: Date.now(),
  };
  return {
    ok: passed,
    summary: BROWSER_PROOF_PREFIX + JSON.stringify(evidence),
    payload: {
      evidence,
      scenario,
      checks,
      snapshot,
      errors: errors.slice(0, 12),
    },
  };
}

const abort = new AbortController();
const lines = createInterface({ input: process.stdin });
lines.on("close", () => abort.abort());
let started = false;
lines.on("line", async (line) => {
  if (started) {
    abort.abort();
    return;
  }
  started = true;
  try {
    if (line.length > 40_000) throw new Error("Browser input too large");
    const result = await runBrowserCheck(JSON.parse(line), abort.signal);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({
        ok: false,
        summary: `Browser unavailable: ${String(error).slice(0, 1000)}`,
        payload: { error: "BrowserUnavailable" },
      })}\n`,
    );
  } finally {
    lines.close();
    process.stdin.destroy();
  }
});
