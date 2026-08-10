/**
 * B 档真实场景：让桌面 Agent 在 /tmp/paw-showcase 做落地页+主题+假记忆面板
 */
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const CDP = process.env.CDP_URL || "http://127.0.0.1:9223";
const OUT_DIR = "/tmp/paw-showcase";
const ART = join(import.meta.dirname, "../.cdp-artifacts");
mkdirSync(ART, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const GOAL1 = `请在目录 ${OUT_DIR} 从零创建一个「Paw 产品展示站」（纯静态，禁止 npm install / 禁止 React/Vite 构建）。

必须包含：
1) index.html — 完整单页：顶栏导航、Hero（标题+副标题+主按钮）、三列能力卡片（多轮对话 / 长期记忆 / 桌面 Plan·Context·Memory）、FAQ 至少 2 条、页脚
2) styles.css — 浅色默认主题，干净现代；支持 data-theme="dark" 深色变量
3) theme.js — 深色/浅色切换，写入 localStorage，刷新后保持
4) memory-demo.js + 在页面中有「记忆演示」区块：展示假数据列表（至少 4 条，类型含 preference/decision），支持按类型筛选（全部/preference/decision）
5) README.md — 如何用浏览器打开、功能说明

约束：
- 只使用原生 HTML/CSS/JS
- 中文文案
- 做完后列出创建的文件路径，并确认主题切换与筛选可用
- 若目录不存在请创建`;

const GOAL2 = `继续完善 ${OUT_DIR}（不要重做整站）：
1) 浅色主题的主强调色改为更明显的蓝色（#1a6bff 系）
2) Hero 副标题改成明确强调「跨会话长期记忆」
3) 记忆演示区再增加 1 条 failure 类型假数据，筛选里加上 failure
只改必要文件，改完说明改了什么。`;

async function connect() {
  const list = await (await fetch(`${CDP}/json/list`)).json();
  const page =
    list.find((t) => t.type === "page" && t.url?.includes("5173")) ||
    list.find((t) => t.type === "page") ||
    list[0];
  if (!page?.webSocketDebuggerUrl) throw new Error("no CDP page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const send = (method, params = {}) => {
    const i = ++id;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout " + method)), 90000);
      pending.set(i, { resolve, reject, t });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(
      typeof ev.data === "string" ? ev.data : ev.data.toString(),
    );
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject, t } = pending.get(msg.id);
      clearTimeout(t);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  };
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  await send("Runtime.enable");
  return { ws, send };
}

async function evalJs(send, expression, awaitPromise = false) {
  const r = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise,
    userGesture: true,
  });
  if (r.exceptionDetails) {
    throw new Error(
      r.exceptionDetails.exception?.description ||
        r.exceptionDetails.text ||
        "eval fail",
    );
  }
  return r.result?.value;
}

async function newChat(send) {
  await evalJs(
    send,
    `(() => {
      const b = [...document.querySelectorAll("button")]
        .find((x) => x.innerText.includes("新对话"));
      if (b) b.click();
      return true;
    })()`,
  );
  await sleep(800);
}

async function sendGoal(send, goal) {
  await evalJs(
    send,
    `(() => {
      window.__pawTestRunDone = null;
      window.__pawTestRunError = null;
      if (window.__offD) try { window.__offD(); } catch {}
      if (window.__offE) try { window.__offE(); } catch {}
      window.__plans = [];
      window.__offD = window.pawDesktop.onRunDone((p) => {
        window.__pawTestRunDone = p;
      });
      window.__offE = window.pawDesktop.onError((p) => {
        window.__pawTestRunError = p;
      });
      window.pawDesktop.onEvent(({ event: env }) => {
        if (env?.event?.type === "plan.updated") {
          window.__plans = window.__plans || [];
          window.__plans.push(env.event);
        }
      });
      const ta = document.querySelector("textarea");
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype, "value").set;
      setter.call(ta, ${JSON.stringify(goal)});
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      const btn = [...document.querySelectorAll("button")].find(
        (b) => (b.getAttribute("aria-label") || "").includes("发送")
          || b.innerText.includes("发送"));
      if (!btn || btn.disabled) throw new Error("cannot send");
      btn.click();
      return true;
    })()`,
  );
}

async function waitDone(send, timeoutMs = 480000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const st = await evalJs(
      send,
      `({ done: window.__pawTestRunDone, err: window.__pawTestRunError, plans: (window.__plans||[]).length })`,
    );
    if (st.err) throw new Error("agent error " + JSON.stringify(st.err));
    if (st.done) {
      await sleep(800);
      return st;
    }
    await sleep(1500);
  }
  throw new Error("timeout waiting for run");
}

async function clickTab(send, label) {
  await evalJs(
    send,
    `(() => {
      const t = [...document.querySelectorAll("[role=tab]")]
        .find((x) => x.innerText.trim() === ${JSON.stringify(label)});
      if (t) t.click();
      return true;
    })()`,
  );
  await sleep(400);
}

async function panel(send) {
  return evalJs(
    send,
    `document.querySelector("[role=tabpanel]")?.innerText?.slice(0, 2500) || ""`,
  );
}

function inspectFiles() {
  if (!existsSync(OUT_DIR)) {
    return { ok: false, reason: "dir missing", files: [] };
  }
  const files = readdirSync(OUT_DIR);
  const need = [
    "index.html",
    "styles.css",
    "theme.js",
    "memory-demo.js",
    "README.md",
  ];
  const missing = need.filter((f) => !files.includes(f));
  let html = "";
  let css = "";
  let theme = "";
  let mem = "";
  try {
    html = readFileSync(join(OUT_DIR, "index.html"), "utf8");
    css = readFileSync(join(OUT_DIR, "styles.css"), "utf8");
    theme = readFileSync(join(OUT_DIR, "theme.js"), "utf8");
    mem = readFileSync(join(OUT_DIR, "memory-demo.js"), "utf8");
  } catch (e) {
    return { ok: false, reason: String(e), files };
  }
  const checks = {
    hasHero: /hero|Hero|主按钮|开始/i.test(html),
    hasCards: /长期记忆|多轮|Plan|Context|Memory/i.test(html),
    hasFaq: /FAQ|常见问题|问答/i.test(html),
    hasThemeToggle: /theme|深色|浅色|data-theme|localStorage/i.test(
      html + theme,
    ),
    hasMemoryDemo: /preference|decision|筛选|filter/i.test(html + mem),
    hasDarkVars: /data-theme|prefers-color|--bg|#1a6bff|accent/i.test(css),
  };
  const ok =
    missing.length === 0 &&
    checks.hasHero &&
    checks.hasCards &&
    checks.hasThemeToggle &&
    checks.hasMemoryDemo;
  return { ok, missing, files, checks, htmlLen: html.length, cssLen: css.length };
}

async function main() {
  console.log("\n=== B-tier Showcase Real Scenario ===\n");
  console.log("OUT:", OUT_DIR);
  const { ws, send } = await connect();
  const report = { steps: [], files: null, panels: {} };

  await newChat(send);
  console.log("→ Round 1: build site…");
  await sendGoal(send, GOAL1);
  const r1 = await waitDone(send, 480000);
  report.steps.push({ round: 1, done: r1.done?.result || r1.done });
  console.log("Round1 done", r1.done?.result?.status || "ok", "plans", r1.plans);

  await clickTab(send, "Plan");
  report.panels.plan1 = await panel(send);
  await clickTab(send, "Changes");
  report.panels.changes1 = await panel(send);
  await clickTab(send, "Context");
  report.panels.context1 = await panel(send);
  await clickTab(send, "Memory");
  report.panels.memory1 = await panel(send);

  const inspect1 = inspectFiles();
  report.filesAfterR1 = inspect1;
  console.log("Files R1:", JSON.stringify(inspect1, null, 2));

  console.log("→ Round 2: refine blue + failure type…");
  await sendGoal(send, GOAL2);
  const r2 = await waitDone(send, 300000);
  report.steps.push({ round: 2, done: r2.done?.result || r2.done });
  console.log("Round2 done");

  await clickTab(send, "Changes");
  report.panels.changes2 = await panel(send);
  await clickTab(send, "Plan");
  report.panels.plan2 = await panel(send);

  const inspect2 = inspectFiles();
  report.filesAfterR2 = inspect2;

  // post-check blue accent after round2
  let blueOk = false;
  let failureOk = false;
  try {
    const css = readFileSync(join(OUT_DIR, "styles.css"), "utf8");
    const mem = readFileSync(join(OUT_DIR, "memory-demo.js"), "utf8");
    const html = readFileSync(join(OUT_DIR, "index.html"), "utf8");
    blueOk = /#1a6bff|1a6bff|rgb\(26,\s*107,\s*255\)/i.test(css + html);
    failureOk = /failure/i.test(mem + html);
    const heroMem = /长期记忆|跨会话/i.test(html);
    report.round2Checks = { blueOk, failureOk, heroMem };
  } catch (e) {
    report.round2Checks = { error: String(e) };
  }

  const body = await evalJs(send, `document.body.innerText.slice(-1200)`);
  report.chatTail = body;

  // Score
  const criteria = [
    ["dir exists", existsSync(OUT_DIR)],
    ["required files", inspect2.ok || (inspect2.missing?.length === 0)],
    ["hero/cards", !!inspect2.checks?.hasHero && !!inspect2.checks?.hasCards],
    ["theme toggle", !!inspect2.checks?.hasThemeToggle],
    ["memory demo filter", !!inspect2.checks?.hasMemoryDemo],
    ["plan panel non-empty", !/暂无执行计划/.test(report.panels.plan1 || "")],
    ["changes or context activity", /html|css|js|showcase|相关文件/i.test(
      (report.panels.changes1 || "") + (report.panels.context1 || ""),
    )],
    ["round2 blue accent", blueOk],
    ["round2 failure type", failureOk],
  ];

  console.log("\n=== Acceptance ===");
  let pass = 0;
  for (const [name, ok] of criteria) {
    console.log(`${ok ? "✅" : "❌"} ${name}`);
    if (ok) pass++;
  }
  console.log(`\nScore: ${pass}/${criteria.length}`);
  report.score = { pass, total: criteria.length, criteria: criteria.map(([n, o]) => ({ n, o })) };

  writeFileSync(join(ART, "b-showcase-report.json"), JSON.stringify(report, null, 2));
  console.log("Report:", join(ART, "b-showcase-report.json"));
  console.log("Open:", join(OUT_DIR, "index.html"));

  ws.close();
  process.exit(pass >= 6 ? 0 : 1);
}

main().catch((e) => {
  console.error("CRASH", e);
  process.exit(2);
});
