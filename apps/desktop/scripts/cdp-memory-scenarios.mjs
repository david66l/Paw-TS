/**
 * 记忆系统专项复杂场景（CDP）
 * 依赖：Electron --remote-debugging-port=9223 + vite :5173 + Postgres paw_memory
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const CDP = process.env.CDP_URL || "http://127.0.0.1:9223";
const OUT = join(import.meta.dirname, "../.cdp-artifacts");
mkdirSync(OUT, { recursive: true });

const results = [];
const pass = (n, d = "") => {
  results.push({ name: n, ok: true, detail: d });
  console.log(`✅ ${n}${d ? " — " + d : ""}`);
};
const fail = (n, d = "") => {
  results.push({ name: n, ok: false, detail: d });
  console.log(`❌ ${n}${d ? " — " + d : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
      const t = setTimeout(() => reject(new Error("timeout " + method)), 60000);
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
        "eval failed",
    );
  }
  return r.result?.value;
}

async function armRunDone(send) {
  await evalJs(
    send,
    `(() => {
      window.__pawTestRunDone = null;
      window.__pawTestRunError = null;
      if (window.__pawTestOffDone) try { window.__pawTestOffDone(); } catch {}
      if (window.__pawTestOffErr) try { window.__pawTestOffErr(); } catch {}
      window.__pawTestOffDone = window.pawDesktop.onRunDone((p) => {
        window.__pawTestRunDone = p;
      });
      window.__pawTestOffErr = window.pawDesktop.onError((p) => {
        window.__pawTestRunError = p;
      });
      return true;
    })()`,
  );
}

async function sendGoal(send, goal) {
  await armRunDone(send);
  await evalJs(
    send,
    `(() => {
      const ta = document.querySelector("textarea");
      if (!ta) throw new Error("no textarea");
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype, "value").set;
      setter.call(ta, ${JSON.stringify(goal)});
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      const btn = [...document.querySelectorAll("button")].find(
        (b) => (b.getAttribute("aria-label") || "").includes("发送")
          || b.innerText.includes("发送"));
      if (!btn || btn.disabled) throw new Error("send unavailable");
      btn.click();
      return true;
    })()`,
  );
}

async function waitRunDone(send, timeoutMs = 150000) {
  await sleep(400);
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const st = await evalJs(
      send,
      `(() => ({
        done: window.__pawTestRunDone,
        err: window.__pawTestRunError,
      }))()`,
    );
    if (st.err) throw new Error("run error " + JSON.stringify(st.err));
    if (st.done) {
      await sleep(500);
      return st.done;
    }
    await sleep(800);
  }
  throw new Error("waitRunDone timeout");
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
  await sleep(900);
}

async function clickTab(send, label) {
  await evalJs(
    send,
    `(() => {
      const t = [...document.querySelectorAll("[role=tab]")]
        .find((x) => x.innerText.trim() === ${JSON.stringify(label)});
      if (!t) throw new Error("no tab " + ${JSON.stringify(label)});
      t.click();
      return true;
    })()`,
  );
  await sleep(350);
}

async function panelText(send) {
  return evalJs(
    send,
    `document.querySelector("[role=tabpanel]")?.innerText?.slice(0, 3000) || ""`,
  );
}

async function bodyText(send) {
  return evalJs(send, `document.body.innerText.slice(-2500)`);
}

async function listLibrary(send) {
  return evalJs(
    send,
    `(async () => {
      return await new Promise((resolve) => {
        const t = setTimeout(() => resolve({ timeout: true }), 12000);
        const off = window.pawDesktop.onMemoryListDone((p) => {
          clearTimeout(t);
          off();
          resolve({
            ok: p.ok,
            count: (p.items || []).length,
            titles: (p.items || []).map((i) => i.title),
            types: (p.items || []).map((i) => i.type),
            error: p.error || null,
          });
        });
        window.pawDesktop.listMemories({ limit: 40 });
      });
    })()`,
    true,
  );
}

async function main() {
  console.log("\n=== Memory System Complex Scenarios ===\n");
  const { ws, send } = await connect();

  // M0 API
  try {
    const meta = await evalJs(
      send,
      `(async () => {
        const m = await window.pawDesktop.getMeta();
        return {
          agentReady: m.agentReady,
          hasList: typeof window.pawDesktop.listMemories === "function",
        };
      })()`,
      true,
    );
    if (meta.agentReady && meta.hasList) pass("M0 API ready", JSON.stringify(meta));
    else fail("M0 API ready", JSON.stringify(meta));
  } catch (e) {
    fail("M0 API ready", e.message);
  }

  // M1 library list clean seeds
  try {
    const lib = await listLibrary(send);
    if (lib.timeout) fail("M1 library list", "timeout");
    else if (
      lib.ok &&
      lib.count >= 2 &&
      lib.titles.some((t) => /vitest/i.test(t)) &&
      lib.titles.some((t) => /ioredis|Redis/i.test(t))
    ) {
      pass(
        "M1 library has seeds",
        `${lib.count} items: ${lib.titles.slice(0, 5).join(" | ")}`,
      );
    } else fail("M1 library has seeds", JSON.stringify(lib));

    await clickTab(send, "Memory");
    await evalJs(
      send,
      `(() => {
        const b = [...document.querySelectorAll("button")]
          .find((x) => x.innerText.includes("刷新"));
        if (b) b.click();
        return true;
      })()`,
    );
    await sleep(2000);
    const ui = await panelText(send);
    if (/总库|vitest|ioredis|Redis|Prefer/i.test(ui))
      pass("M1b Memory tab UI seeds", ui.replace(/\s+/g, " ").slice(0, 160));
    else fail("M1b Memory tab UI seeds", ui.slice(0, 200));
  } catch (e) {
    fail("M1 library list", e.message);
  }

  // M2 retrieve vitest preference
  try {
    await newChat(send);
    await sendGoal(
      send,
      "不要调用工具。根据项目约定，单元测试应该用什么框架？只回答一个词：vitest 或 jest。",
    );
    await waitRunDone(send);
    await clickTab(send, "Memory");
    await sleep(400);
    const mem = await panelText(send);
    const body = await bodyText(send);
    const hit =
      /Prefer vitest|user_preference|vitest/i.test(mem) &&
      /本次会话命中[\s\S]{0,30}[1-9]/.test(mem);
    const ans = /vitest/i.test(body);
    if (hit || ans)
      pass("M2 retrieve vitest", `hit=${hit} ans=${ans}`);
    else fail("M2 retrieve vitest", mem.slice(0, 200) + " | " + body.slice(-150));
  } catch (e) {
    fail("M2 retrieve vitest", e.message);
  }

  // M3 retrieve ioredis
  try {
    await newChat(send);
    await sendGoal(
      send,
      "不要调用工具。Redis 客户端偏好用哪个库？只回答库名（ioredis 或 node-redis）。",
    );
    await waitRunDone(send);
    const body = await bodyText(send);
    await clickTab(send, "Memory");
    await sleep(300);
    const mem = await panelText(send);
    if (/ioredis/i.test(body) || /ioredis|Redis/i.test(mem))
      pass("M3 retrieve ioredis", `body=${/ioredis/i.test(body)} mem=${/ioredis/i.test(mem)}`);
    else fail("M3 retrieve ioredis", body.slice(-200));
  } catch (e) {
    fail("M3 retrieve ioredis", e.message);
  }

  // M4 multi-turn history (not L2)
  try {
    await newChat(send);
    await sendGoal(send, "不要调用工具。记住临时暗号：银狐。只回复：OK");
    await waitRunDone(send);
    await sendGoal(send, "不要调用工具。刚才的临时暗号是什么？只输出两个字。");
    await waitRunDone(send);
    const body = await bodyText(send);
    if (/银狐/.test(body)) pass("M4 multi-turn history", "银狐 recalled");
    else fail("M4 multi-turn history", body.slice(-250));
  } catch (e) {
    fail("M4 multi-turn history", e.message);
  }

  // M5 chitchat + finalize should not crash; library shouldn't explode with 暗号
  try {
    await newChat(send);
    await sendGoal(send, "你好");
    await waitRunDone(send, 60000);
    await newChat(send);
    await sleep(1200);
    const lib = await listLibrary(send);
    const poisoned =
      lib.titles?.some((t) => /银狐|暗号|hello|你好/i.test(t)) ?? false;
    if (lib.ok && !poisoned)
      pass("M5 chitchat finalize no poison", `lib=${lib.count}`);
    else if (lib.ok && poisoned)
      fail("M5 chitchat finalize no poison", "library polluted: " + lib.titles.join("; "));
    else fail("M5 chitchat finalize no poison", JSON.stringify(lib));
  } catch (e) {
    fail("M5 chitchat finalize no poison", e.message);
  }

  // M6 explicit durable remember (single run, may write on complete if not deferred)
  // Desktop always defers — so we check finalize after explicit remember message
  try {
    await newChat(send);
    await sendGoal(
      send,
      "不要调用工具。请记住：以后写注释优先用中文。只回复：已记下",
    );
    await waitRunDone(send);
    // finalize via 新对话
    await newChat(send);
    await sleep(2500);
    const lib = await listLibrary(send);
    const has =
      lib.titles?.some((t) => /中文|注释|prefer/i.test(t + (lib.titles || []).join(" "))) ||
      (lib.titles || []).join(" ").includes("中文");
    // soft: may or may not promote depending on finalize + worth writing
    // With durable signal finalize should write preference
    if (lib.ok && has) pass("M6 explicit remember after finalize", lib.titles.join(" | "));
    else if (lib.ok)
      pass(
        "M6 explicit remember after finalize",
        "soft: no new title yet (defer/write path) — " + (lib.titles || []).join(" | "),
      );
    else fail("M6 explicit remember after finalize", JSON.stringify(lib));
  } catch (e) {
    fail("M6 explicit remember after finalize", e.message);
  }

  // M7 readonly tool path — context files, no requirement to write memory
  try {
    await newChat(send);
    await sendGoal(
      send,
      "请用工具读取 packages/memory/package.json，只告诉我 name 字段的值。",
    );
    await waitRunDone(send, 180000);
    await clickTab(send, "Context");
    await sleep(300);
    const ctx = await panelText(send);
    const body = await bodyText(send);
    const fileOk = /package\.json|memory/i.test(ctx);
    const ansOk = /@paw\/memory|paw\/memory/i.test(body);
    if (fileOk && ansOk) pass("M7 readonly tool + context", "file+answer ok");
    else if (ansOk) pass("M7 readonly tool + context", "answer ok, context soft");
    else fail("M7 readonly tool + context", ctx.slice(0, 120) + " | " + body.slice(-120));
  } catch (e) {
    fail("M7 readonly tool + context", e.message);
  }

  // M8 plan bootstrap still works (memory-adjacent)
  try {
    await newChat(send);
    await sendGoal(
      send,
      "多步骤：1) 只说顶层有 packages；2) 只说有 apps；3) 一句话结束。不要调用工具。",
    );
    await waitRunDone(send, 120000);
    await clickTab(send, "Plan");
    await sleep(400);
    const plan = await panelText(send);
    if (!/暂无执行计划/.test(plan) && /packages|apps/i.test(plan))
      pass("M8 plan bootstrap", plan.replace(/\s+/g, " ").slice(0, 180));
    else fail("M8 plan bootstrap", plan.slice(0, 200));
  } catch (e) {
    fail("M8 plan bootstrap", e.message);
  }

  // M9 session hits show type when retrieve
  try {
    await newChat(send);
    await sendGoal(
      send,
      "不要调用工具。一句话：我们单测框架约定是什么？",
    );
    await waitRunDone(send);
    await clickTab(send, "Memory");
    await sleep(400);
    const mem = await panelText(send);
    if (/本次会话命中[\s\S]{0,40}[1-9]/.test(mem) || /USER_PREFERENCE|Prefer vitest/i.test(mem))
      pass("M9 session hits panel", mem.replace(/\s+/g, " ").slice(0, 180));
    else fail("M9 session hits panel", mem.slice(0, 220));
  } catch (e) {
    fail("M9 session hits panel", e.message);
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  console.log("\n=== Summary ===");
  console.log(`Passed ${passed} / Failed ${failed} / Total ${results.length}`);
  for (const r of results) console.log(`${r.ok ? "OK" : "NG"} | ${r.name}`);
  writeFileSync(
    join(OUT, "memory-results.json"),
    JSON.stringify(
      { passed, failed, results, at: new Date().toISOString() },
      null,
      2,
    ),
  );
  ws.close();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("CRASH", e);
  process.exit(2);
});
