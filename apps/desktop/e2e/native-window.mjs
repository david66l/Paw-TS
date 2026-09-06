import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";
import { createServer } from "vite";

const require = createRequire(import.meta.url);
const desktop = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "paw-native-qa-"));
const output = path.resolve(
  process.env.PAW_NATIVE_QA_OUTPUT || path.join(profile, "evidence"),
);
fs.mkdirSync(output, { recursive: true });
const vite = await createServer({
  root: desktop,
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});
let app;
const errors = [];
const checks = [];
try {
  await vite.listen();
  const address = vite.httpServer.address();
  assert(address && typeof address === "object");
  const {
    BUN_PATH: _bun,
    ELECTRON_RUN_AS_NODE: _node,
    ...environment
  } = process.env;
  void _bun;
  void _node;
  app = await electron.launch({
    executablePath: require("electron"),
    args: [desktop, `--user-data-dir=${profile}`, "--paw-background-test"],
    cwd: desktop,
    env: {
      ...environment,
      VITE_DEV_SERVER_URL: `http://127.0.0.1:${address.port}`,
    },
    timeout: 30_000,
  });
  const page = await app.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForFunction(
    async () => (await window.pawDesktop?.getMeta())?.agentReady,
    undefined,
    { timeout: 20_000 },
  );
  assert.equal(
    await app.evaluate(({ app }) => app.getPath("userData")),
    profile,
  );
  checks.push(
    "Real Electron preload and Bun host ready without BUN_PATH; isolated user data",
  );
  const capture = async (name) => {
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all(
        document
          .getAnimations()
          .filter(
            (animation) =>
              animation.effect?.getComputedTiming().iterations !==
              Number.POSITIVE_INFINITY,
          )
          .map((animation) => animation.finished.catch(() => {})),
      );
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
    });
    const png = await app.evaluate(async ({ BrowserWindow }) => {
      const windows = BrowserWindow.getAllWindows();
      if (
        windows.length !== 1 ||
        windows[0].isVisible() ||
        windows[0].isFocused()
      )
        throw new Error("Expected one hidden QA window");
      const image = await windows[0].webContents.capturePage(undefined, {
        stayHidden: true,
      });
      return image.toPNG().toString("base64");
    });
    fs.writeFileSync(
      path.join(output, `${name}.png`),
      Buffer.from(png, "base64"),
    );
  };
  const assertLayout = async () => {
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
      "Page must not overflow horizontally",
    );
    for (const locator of [
      page.getByRole("checkbox", { name: "视觉验收" }),
      page.getByRole("button", { name: "发送", exact: true }),
    ]) {
      const box = await locator.boundingBox();
      const viewport = await page.evaluate(() => ({
        width: innerWidth,
        height: innerHeight,
      }));
      assert(
        box &&
          box.x >= 0 &&
          box.y >= 0 &&
          box.x + box.width <= viewport.width &&
          box.y + box.height <= viewport.height,
        "Composer control must fit window",
      );
    }
  };
  await assertLayout();
  await capture("native-default");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "设置" });
  await dialog.waitFor();
  await dialog.getByRole("button", { name: /纸间 · Louis/ }).click();
  assert.equal(
    await page.locator("html").getAttribute("data-color-theme"),
    "paper",
  );
  await capture("native-paper-settings");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  await page.getByRole("checkbox", { name: "视觉验收" }).check();
  await page.getByRole("combobox", { name: "任务模式" }).selectOption("long");
  await page.reload();
  await page.waitForFunction(
    async () => (await window.pawDesktop?.getMeta())?.agentReady,
  );
  assert.equal(
    await page.getByRole("checkbox", { name: "视觉验收" }).isChecked(),
    true,
  );
  assert.equal(
    await page.getByRole("combobox", { name: "任务模式" }).inputValue(),
    "long",
  );
  assert.equal(
    await page.locator("html").getAttribute("data-color-theme"),
    "paper",
  );
  checks.push(
    "Settings open, skin changes, Escape closes, appearance and task switches survive reload",
  );
  for (const [width, height] of [
    [960, 640],
    [1100, 800],
    [1440, 960],
  ]) {
    await app.evaluate(
      ({ BrowserWindow }, size) =>
        BrowserWindow.getAllWindows()[0].setSize(...size),
      [width, height],
    );
    await page.waitForFunction(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() => resolve(true)),
          ),
        ),
    );
    await assertLayout();
    if (width === 960) {
      const fits = await page
        .getByRole("button", { name: "/help", exact: true })
        .evaluate((element) => {
          let parent = element.parentElement;
          while (parent && getComputedStyle(parent).overflowY !== "auto")
            parent = parent.parentElement;
          const bounds = element.getBoundingClientRect();
          const panel = parent?.getBoundingClientRect();
          return (
            !!panel && bounds.top >= panel.top && bounds.bottom <= panel.bottom
          );
        });
      assert.equal(
        fits,
        true,
        "Welcome actions must fit without scrolling at the minimum native size",
      );
    }
    await capture(`native-paper-${width}`);
    checks.push(
      `Native BrowserWindow resize ${width}x${height}: composer visible, no overflow`,
    );
  }
  for (const name of ["任务", "后台", "Changes", "Context", "Plan"]) {
    const tab = page.getByRole("tab", { name, exact: true });
    await tab.click();
    assert.equal(await tab.getAttribute("aria-selected"), "true");
  }
  await page.getByRole("button", { name: "/help", exact: true }).click();
  await page.getByText("/help — 显示本帮助", { exact: false }).waitFor();
  await capture("native-help");
  checks.push(
    "Task panels switch and local /help responds without invoking a paid model",
  );
  assert.deepEqual(errors, []);
  fs.writeFileSync(
    path.join(output, "report.json"),
    JSON.stringify(
      { status: "passed", checks, errors, nativeWindow: true, osInput: false },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ status: "passed", checks, output }, null, 2));
} finally {
  if (app) await app.close();
  await vite.close();
  // Keep screenshots if the default output is inside the disposable profile.
  if (!output.startsWith(profile + path.sep))
    fs.rmSync(profile, { recursive: true, force: true });
}
