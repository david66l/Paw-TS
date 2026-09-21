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
      PAW_MEMORY_WORKER_DISABLED: "1",
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
      page.getByRole("button", { name: "上下文占用详情" }),
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
  if (process.env.PAW_NATIVE_QA_MODEL) {
    await page
      .getByText(process.env.PAW_NATIVE_QA_MODEL, { exact: true })
      .waitFor();
    const preset = process.env.PAW_NATIVE_QA_PRESET;
    if (preset) {
      assert.equal(
        await dialog
          .getByRole("button", { name: preset, exact: true })
          .getAttribute("aria-pressed"),
        "true",
      );
    }
    checks.push(
      `Desktop host and selected preset: ${process.env.PAW_NATIVE_QA_MODEL}`,
    );
  }
  await dialog.getByRole("button", { name: /纸间 · Louis/ }).click();
  assert.equal(
    await page.locator("html").getAttribute("data-color-theme"),
    "paper",
  );
  await capture("native-paper-settings");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  assert.equal(
    await page.getByRole("checkbox", { name: "视觉验收" }).count(),
    0,
  );
  assert.equal(
    await page.getByRole("combobox", { name: "任务模式" }).count(),
    0,
  );
  await page.getByRole("button", { name: "上下文占用详情" }).click();
  await page.getByRole("region", { name: "上下文详情" }).waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "压缩上下文", exact: true })
      .isDisabled(),
    true,
  );
  await capture("native-context-empty");
  await page.keyboard.press("Escape");
  await page.reload();
  await page.waitForFunction(
    async () => (await window.pawDesktop?.getMeta())?.agentReady,
  );
  assert.equal(
    await page.locator("html").getAttribute("data-color-theme"),
    "paper",
  );
  checks.push(
    "Unified task input, context ring popup and saved paper appearance",
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
        .getByRole("button", { name: /解决一个问题/ })
        .evaluate((element) => {
          let parent = element.parentElement;
          while (parent && getComputedStyle(parent).overflowY !== "auto")
            parent = parent.parentElement;
          const bounds = element.getBoundingClientRect();
          const panel = parent?.getBoundingClientRect();
          if (
            !(
              !!panel &&
              bounds.top >= panel.top &&
              bounds.bottom <= panel.bottom
            )
          )
            console.log("welcome-bounds", JSON.stringify({ bounds, panel }));
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
  await page.getByRole("button", { name: "任务详情", exact: true }).click();
  for (const name of ["计划", "文件", "运行"]) {
    const tab = page.getByRole("tab", { name, exact: true });
    await tab.click();
    assert.equal(await tab.getAttribute("aria-selected"), "true");
  }
  await capture("native-run-panel");
  assert.equal(
    await page
      .getByRole("tab", { name: "运行", exact: true })
      .evaluate((tab) => {
        const panel = tab.closest("aside");
        return (
          !!panel &&
          [...panel.querySelectorAll("*")].every(
            (element) =>
              getComputedStyle(element).overflowX !== "auto" ||
              element.scrollWidth <= element.clientWidth,
          )
        );
      }),
    true,
    "Inspector scroll regions must not overflow horizontally",
  );
  await page.getByRole("button", { name: "收起任务详情" }).click();
  await page.getByRole("textbox", { name: "描述任务" }).fill("/help");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page.getByText("/help — 显示本帮助", { exact: false }).waitFor();
  await capture("native-help");
  checks.push("Plan / Files / Run inspector and local slash commands work");
  // Exercise the real component with a deterministic UI fixture. Backend
  // compaction and continuation are separately covered by pawNext.test.ts.
  await page.evaluate(async () => {
    const { default: React } = await import(
      "/node_modules/.vite/deps/react.js"
    );
    const { default: ReactDOM } = await import(
      "/node_modules/.vite/deps/react-dom_client.js"
    );
    const { ContextMeter } = await import("/src/components/ContextMeter.tsx");
    const original = document.querySelector('[aria-label="上下文占用详情"]');
    const bounds = original.getBoundingClientRect();
    const host = document.createElement("div");
    host.id = "context-qa-fixture";
    Object.assign(host.style, {
      position: "fixed",
      left: `${bounds.x}px`,
      top: `${bounds.y}px`,
      zIndex: "100",
      background: "var(--glass-bg-strong)",
    });
    document.body.append(host);
    const root = ReactDOM.createRoot(host);
    const context = {
      nextBudget: {
        selectedInputTokens: 48500,
        contextWindowTokens: 128000,
        reservedOutputTokens: 8192,
        fixedInputTokens: 9000,
        estimatedOmittedInputTokens: 0,
        level: "normal",
        categories: [
          { id: "system", label: "系统指令与规则", tokens: 5200 },
          { id: "tools", label: "工具定义", tokens: 3800 },
          { id: "memory", label: "记忆", tokens: 2500 },
          { id: "user", label: "用户消息与附件", tokens: 12000 },
          { id: "assistant", label: "回复与工具结果", tokens: 20500 },
          { id: "checkpoint", label: "任务摘要", tokens: 3000 },
          { id: "activity", label: "运行信息", tokens: 1000 },
          { id: "protocol", label: "协议开销", tokens: 500 },
        ],
      },
    };
    root.render(
      React.createElement(ContextMeter, {
        context,
        busy: false,
        onCompress: () =>
          new Promise((resolve) => {
            window.finishContextQa = () =>
              resolve({ ok: true, message: "上下文已压缩。" });
          }),
      }),
    );
  });
  const fixture = page.locator("#context-qa-fixture");
  await fixture.getByRole("button", { name: "上下文占用详情" }).click();
  const populated = fixture.getByRole("region", { name: "上下文详情" });
  await populated.getByText("37.9%", { exact: true }).waitFor();
  assert.equal(
    await populated.getByText("48,500 tokens", { exact: true }).count(),
    1,
  );
  const bounds = await populated.boundingBox();
  assert(
    bounds && bounds.x >= 0 && bounds.y >= 0,
    "Populated context popup must fit",
  );
  await capture("native-context-fixture");
  await fixture
    .getByRole("button", { name: "压缩上下文", exact: true })
    .click();
  assert.equal(
    await fixture
      .getByRole("button", { name: "正在压缩…", exact: true })
      .isDisabled(),
    true,
  );
  await page.evaluate(() => window.finishContextQa());
  await fixture
    .getByRole("status")
    .getByText("上下文已压缩。", { exact: true })
    .waitFor();
  await page.keyboard.press("Escape");
  await populated.waitFor({ state: "detached" });
  checks.push(
    "Context component fixture: category detail, pending state, compression response and Escape",
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
