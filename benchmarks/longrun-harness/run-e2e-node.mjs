/**
 * Node entry for Playwright E2E (Bun+Playwright CDP often hangs on Windows).
 * Usage: node benchmarks/longrun-harness/run-e2e-node.mjs <workspace> [headed]
 * Reads feature_list.json; prints JSON report to stdout.
 */
import { createServer } from "node:http";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const workspaceRoot = path.resolve(process.argv[2] ?? ".");
const headed = process.argv.includes("--headed");
const onlyArg = process.argv.find((a) => a.startsWith("--only="));
const baseUrlArg = process.argv.find((a) => a.startsWith("--base-url="));
const onlyIds = onlyArg
  ? onlyArg
      .slice("--only=".length)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  : undefined;
const forcedBaseUrl = baseUrlArg
  ? baseUrlArg.slice("--base-url=".length).trim()
  : undefined;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
};

function startStatic(root) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      try {
        const addr = server.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        const u = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
        let rel = decodeURIComponent(u.pathname);
        if (rel === "/") rel = "/index.html";
        const file = path.join(root, rel.replace(/^\//, ""));
        if (
          !file.startsWith(root) ||
          !existsSync(file) ||
          !statSync(file).isFile()
        ) {
          res.writeHead(404);
          res.end("not found");
          return;
        }
        const ext = path.extname(file).toLowerCase();
        res.writeHead(200, {
          "Content-Type": MIME[ext] ?? "application/octet-stream",
        });
        res.end(readFileSync(file));
      } catch (e) {
        res.writeHead(500);
        res.end(String(e));
      }
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = addr.port;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        stop: () => server.close(),
      });
    });
  });
}

async function runActions(page, baseUrl, actions) {
  for (const a of actions) {
    if (a.type === "goto") {
      await page.goto(new URL(a.path, baseUrl).toString(), {
        waitUntil: "domcontentloaded",
      });
    } else if (a.type === "click") {
      await page.locator(a.selector).first().click({ timeout: 10_000 });
    } else if (a.type === "fill") {
      await page.locator(a.selector).first().fill(a.value, { timeout: 10_000 });
    } else if (a.type === "expect_text") {
      const loc = page.locator(a.selector).first();
      const tag = await loc.evaluate((el) => el.tagName.toLowerCase());
      if (tag === "input" || tag === "textarea") {
        const v = await loc.inputValue();
        if (v !== a.text) {
          throw new Error(
            `expect_text input ${a.selector}: got ${JSON.stringify(v)} want ${JSON.stringify(a.text)}`,
          );
        }
      } else {
        const text = await loc.innerText();
        if (a.text === "") {
          if (text.trim() !== "") {
            throw new Error(`expect empty text in ${a.selector}`);
          }
        } else if (!text.includes(a.text)) {
          throw new Error(
            `expect_text ${a.selector}: missing ${JSON.stringify(a.text)} in ${JSON.stringify(text)}`,
          );
        }
      }
    } else if (a.type === "expect_visible") {
      await page.locator(a.selector).first().waitFor({
        state: "visible",
        timeout: 10_000,
      });
    } else if (a.type === "expect_count") {
      await page
        .locator(a.selector)
        .first()
        .waitFor({ timeout: 3_000 })
        .catch(() => undefined);
      const n = await page.locator(a.selector).count();
      if (n !== a.count) {
        throw new Error(`expect_count ${a.selector}: got ${n} want ${a.count}`);
      }
    } else {
      throw new Error(`unknown action ${JSON.stringify(a)}`);
    }
  }
}

async function launchBrowser() {
  const opts = {
    headless: !headed,
    timeout: 45_000,
    args: ["--disable-gpu", "--no-sandbox"],
  };
  for (const channel of ["msedge", "chrome", undefined]) {
    try {
      return await chromium.launch(
        channel ? { ...opts, channel } : opts,
      );
    } catch (e) {
      if (!channel) throw e;
    }
  }
  throw new Error("browser launch failed");
}

const listPath = path.join(workspaceRoot, "feature_list.json");
const features = JSON.parse(readFileSync(listPath, "utf8"));
const targets = features.filter((f) => {
  if (!f.e2e?.actions?.length) return false;
  if (onlyIds?.length) return onlyIds.includes(f.id);
  return true;
});

const app = forcedBaseUrl
  ? { baseUrl: forcedBaseUrl, stop: () => undefined }
  : await startStatic(workspaceRoot);
const browser = await launchBrowser();
const results = [];
try {
  for (const f of targets) {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(app.baseUrl, { waitUntil: "domcontentloaded" });
      await page.evaluate(() => localStorage.clear());
      await runActions(page, app.baseUrl, f.e2e.actions);
      results.push({ id: f.id, ok: true });
    } catch (e) {
      results.push({
        id: f.id,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
  app.stop();
}

const report = {
  ok: results.every((r) => r.ok),
  baseUrl: app.baseUrl,
  results,
};
writeFileSync(
  path.join(workspaceRoot, ".paw-e2e-last.json"),
  JSON.stringify(report, null, 2),
);
process.stdout.write(JSON.stringify(report));
process.exit(report.ok ? 0 : 1);
