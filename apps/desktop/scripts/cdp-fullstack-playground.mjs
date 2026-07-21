/**
 * 独立 workspace 全栈任务：notes-api（Bun server + 静态前端 + JSON 文件库）
 * 通过 startRun({ workspaceRoot }) 切到新工作区，不改 paw-ts monorepo。
 */
import {
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  mkdirSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const CDP = process.env.CDP_URL || "http://127.0.0.1:9223";
const WORKSPACE =
  process.env.PLAYGROUND_ROOT ||
  "/Users/Zhuanz/Documents/CS/项目/paw-playground";
const ART = join(
  import.meta.dirname,
  "../.cdp-artifacts",
);
mkdirSync(ART, { recursive: true });
mkdirSync(WORKSPACE, { recursive: true });

const GOAL = `你现在的工作区根目录是：${WORKSPACE}
这是一个**全新独立项目**（不是 monorepo）。请从零做一个全栈「本地笔记 API」应用。

## 必须交付
目录结构建议（可微调但功能要齐）：
\`\`\`
${WORKSPACE}/
  package.json          # name: paw-notes-api, type module, scripts: start
  server.ts             # Bun/Node HTTP 服务
  data/notes.json       # 初始 [] 或示例 1～2 条
  public/index.html
  public/app.js
  public/styles.css
  README.md             # 如何启动与 API 说明
\`\`\`

## 后端 API（必须实现）
- GET    /api/notes          → { notes: Note[] }
- POST   /api/notes          body: { title, body } → 创建并返回 note
- DELETE /api/notes/:id      → 删除
- GET    / 与静态资源 → 提供 public/
- 数据持久化到 data/notes.json（读写文件）
- 监听端口 **8787**（HOST 127.0.0.1）
- 启动方式：\`bun server.ts\` 或 \`bun run start\`

Note 形状：{ id: string, title: string, body: string, createdAt: string }

## 前端（public/）
- 列表展示笔记
- 表单新建（title + body，校验非空）
- 删除按钮
- 调用上述 API（fetch）
- 中文 UI，简洁可用

## 约束
- 禁止修改任何 ${WORKSPACE} 以外的路径
- 不要使用 React/Next/Vite；原生 HTML/CSS/JS + Bun server 即可
- 不要大规模 npm 依赖；可用 Bun 内置
- 做完后用文字说明如何启动；尽量自己用 shell 验证 server 能起来（若环境允许）

完成后确认：curl http://127.0.0.1:8787/api/notes 可访问。`;

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

function walk(dir, acc = [], base = dir) {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git") continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc, base);
    else acc.push(p.slice(base.length + 1));
  }
  return acc;
}

async function verifyServer() {
  const serverPath = join(WORKSPACE, "server.ts");
  const pkgPath = join(WORKSPACE, "package.json");
  if (!existsSync(serverPath) && !existsSync(join(WORKSPACE, "server.js"))) {
    return { ok: false, reason: "no server.ts/js" };
  }

  // kill anything on 8787
  try {
    const { execSync } = await import("node:child_process");
    execSync("lsof -ti :8787 | xargs kill -9 2>/dev/null || true", {
      shell: "/bin/zsh",
    });
  } catch {
    /* ignore */
  }

  const startCmd = existsSync(pkgPath)
    ? ["bun", "run", "start"]
    : ["bun", "server.ts"];
  const child = spawn(startCmd[0], startCmd.slice(1), {
    cwd: WORKSPACE,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });
  let logs = "";
  child.stdout?.on("data", (d) => {
    logs += d.toString();
  });
  child.stderr?.on("data", (d) => {
    logs += d.toString();
  });

  let apiOk = false;
  let createOk = false;
  let listCount = 0;
  let lastErr = "";
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    try {
      const r = await fetch("http://127.0.0.1:8787/api/notes");
      if (r.ok) {
        const j = await r.json();
        apiOk = true;
        listCount = Array.isArray(j.notes)
          ? j.notes.length
          : Array.isArray(j)
            ? j.length
            : 0;
        // try create
        const c = await fetch("http://127.0.0.1:8787/api/notes", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            title: "cdp-test",
            body: "hello from verify",
          }),
        });
        createOk = c.ok;
        break;
      }
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }

  child.kill("SIGTERM");
  await sleep(300);
  try {
    child.kill("SIGKILL");
  } catch {
    /* */
  }

  return {
    ok: apiOk && createOk,
    apiOk,
    createOk,
    listCount,
    lastErr,
    logs: logs.slice(-800),
  };
}

async function main() {
  console.log("\n=== Fullstack Playground ===");
  console.log("WORKSPACE:", WORKSPACE);

  const { ws, send } = await connect();

  // ensure agent ready
  const meta = await evalJs(
    send,
    `(async () => window.pawDesktop.getMeta())()`,
    true,
  );
  console.log("meta", meta);

  const started = await evalJs(
    send,
    `(async () => {
      window.__fsDone = null;
      window.__fsErr = null;
      window.__fsPlans = [];
      if (window.__fsOffD) try { window.__fsOffD(); } catch {}
      if (window.__fsOffE) try { window.__fsOffE(); } catch {}
      if (window.__fsOffEv) try { window.__fsOffEv(); } catch {}
      window.__fsOffD = window.pawDesktop.onRunDone((p) => { window.__fsDone = p; });
      window.__fsOffE = window.pawDesktop.onError((p) => { window.__fsErr = p; });
      window.__fsOffEv = window.pawDesktop.onEvent(({ event: env }) => {
        if (env?.event?.type === "plan.updated") window.__fsPlans.push(env.event);
      });
      const r = await window.pawDesktop.startRun({
        goal: ${JSON.stringify(GOAL)},
        workspaceRoot: ${JSON.stringify(WORKSPACE)},
        maxSteps: 40,
        conversationId: "playground-fullstack-" + Date.now(),
      });
      return r;
    })()`,
    true,
  );
  console.log("startRun", started);

  const t0 = Date.now();
  let done = null;
  while (Date.now() - t0 < 600000) {
    const st = await evalJs(
      send,
      `({ done: window.__fsDone, err: window.__fsErr, plans: (window.__fsPlans||[]).length })`,
    );
    if (st.err) {
      console.error("run error", st.err);
      break;
    }
    if (st.done) {
      done = st.done;
      console.log("run done in", Math.round((Date.now() - t0) / 1000), "s");
      break;
    }
    await sleep(2000);
  }
  if (!done) console.log("WARN: run timeout or no done event");

  const plans = await evalJs(send, `(window.__fsPlans||[]).length`);
  console.log("plan events", plans);

  // Panel snapshots if UI updated for this run
  await evalJs(
    send,
    `(() => {
      const t = [...document.querySelectorAll("[role=tab]")]
        .find(x => x.innerText.trim()==="Plan");
      if (t) t.click();
      return true;
    })()`,
  );
  await sleep(300);
  const planPanel = await evalJs(
    send,
    `document.querySelector("[role=tabpanel]")?.innerText?.slice(0,1500)||""`,
  );

  const files = walk(WORKSPACE);
  console.log("files:", files);

  const expected = [
    "server.ts",
    "public/index.html",
    "public/app.js",
    "public/styles.css",
    "README.md",
  ];
  // allow server.js alternative
  const hasServer =
    files.includes("server.ts") ||
    files.includes("server.js") ||
    files.some((f) => f.endsWith("server.ts"));
  const checks = {
    hasServer,
    hasIndex: files.some((f) => f.endsWith("public/index.html") || f === "index.html"),
    hasAppJs: files.some((f) => f.includes("app.js")),
    hasCss: files.some((f) => f.includes("styles.css") || f.endsWith(".css")),
    hasReadme: files.some((f) => /readme/i.test(f)),
    hasData: files.some((f) => f.includes("notes.json") || f.includes("data/")),
    planNonEmpty: !/暂无执行计划/.test(planPanel || "") || plans > 0,
  };

  console.log("\n=== File checks ===");
  for (const [k, v] of Object.entries(checks)) {
    console.log(`${v ? "✅" : "❌"} ${k}`);
  }

  console.log("\n=== Server verify ===");
  const srv = await verifyServer();
  console.log(JSON.stringify(srv, null, 2));

  const scoreParts = [
    ...Object.values(checks),
    srv.apiOk,
    srv.createOk,
  ];
  const score = scoreParts.filter(Boolean).length;
  const total = scoreParts.length;

  const report = {
    workspace: WORKSPACE,
    done,
    files,
    checks,
    server: srv,
    planPanel: planPanel?.slice(0, 500),
    score: { pass: score, total },
    at: new Date().toISOString(),
  };
  writeFileSync(
    join(ART, "fullstack-playground-report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(`\nScore: ${score}/${total}`);
  console.log("Report:", join(ART, "fullstack-playground-report.json"));
  console.log("Workspace:", WORKSPACE);

  ws.close();
  process.exit(score >= Math.ceil(total * 0.6) ? 0 : 1);
}

main().catch((e) => {
  console.error("CRASH", e);
  process.exit(2);
});
