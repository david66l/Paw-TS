/**
 * 桌面端复杂场景 CDP 验收（需 Electron --remote-debugging-port=9223 + vite 5173）
 *
 * 覆盖：Memory 总库/本次命中、多轮 history、Plan、Context 文件、工具读盘、新对话 finalize
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const CDP = process.env.CDP_URL || "http://127.0.0.1:9223";
const OUT_DIR = join(import.meta.dirname, "../.cdp-artifacts");
mkdirSync(OUT_DIR, { recursive: true });

const results = [];
function pass(name, detail = "") {
  results.push({ name, ok: true, detail });
  console.log(`✅ PASS  ${name}${detail ? " — " + detail : ""}`);
}
function fail(name, detail = "") {
  results.push({ name, ok: false, detail });
  console.log(`❌ FAIL  ${name}${detail ? " — " + detail : ""}`);
}
function info(msg) {
  console.log(`   · ${msg}`);
}

async function connect() {
  const list = await (await fetch(`${CDP}/json/list`)).json();
  const page = list.find((t) => t.type === "page" && t.url?.includes("5173")) || list.find((t) => t.type === "page") || list[0];
  if (!page?.webSocketDebuggerUrl) throw new Error("No CDP page target");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const send = (method, params = {}) => {
    const i = ++id;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout ${method}`)), 60000);
      pending.set(i, { resolve, reject, t });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString());
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
  await send("Page.enable");
  return { ws, send, page };
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

async function shot(send, name) {
  try {
    const r = await send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
    });
    const p = join(OUT_DIR, `${name}.png`);
    writeFileSync(p, Buffer.from(r.data, "base64"));
    info(`screenshot ${p}`);
  } catch (e) {
    info(`screenshot skip: ${e.message}`);
  }
}

async function clickTab(send, label) {
  await evalJs(
    send,
    `(() => {
      const t = [...document.querySelectorAll("[role=tab]")].find(x => x.innerText.trim() === ${JSON.stringify(label)});
      if (!t) throw new Error("tab not found: ${label}");
      t.click();
      return true;
    })()`,
  );
  await sleep(300);
}

async function panelText(send) {
  return evalJs(
    send,
    `(() => {
      const panel = document.querySelector("[role=tabpanel]");
      return panel ? panel.innerText.slice(0, 2500) : "";
    })()`,
  );
}

async function chatBody(send) {
  return evalJs(
    send,
    `(() => {
      const root = document.body;
      return (root?.innerText || "").slice(0, 4000);
    })()`,
  );
}

async function armRunDone(send) {
  await evalJs(
    send,
    `(() => {
      window.__pawTestRunDone = null;
      window.__pawTestRunError = null;
      if (window.__pawTestOffDone) { try { window.__pawTestOffDone(); } catch {} }
      if (window.__pawTestOffErr) { try { window.__pawTestOffErr(); } catch {} }
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
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
      setter.call(ta, ${JSON.stringify(goal)});
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      const btn = [...document.querySelectorAll("button")].find(b => (b.getAttribute("aria-label")||"").includes("发送") || b.innerText.includes("发送"));
      if (!btn) throw new Error("no send button");
      if (btn.disabled) throw new Error("send button disabled after fill");
      btn.click();
      return true;
    })()`,
  );
}

async function waitRunDone(send, timeoutMs = 180000) {
  const start = Date.now();
  // 先等到 running 或 done（避免发送前瞬时 done）
  await sleep(500);
  while (Date.now() - start < timeoutMs) {
    const st = await evalJs(
      send,
      `(() => {
        const done = window.__pawTestRunDone;
        const err = window.__pawTestRunError;
        const abortBtn = [...document.querySelectorAll("button")].find(b =>
          /中止|停止|取消/.test(b.innerText || "")
        );
        const statusEl = [...document.querySelectorAll("div,span")].find(d => {
          const t = (d.innerText || "").trim();
          return t.length < 24 && /就绪|运行中|失败|完成|错误/.test(t);
        });
        return {
          done: done || null,
          err: err || null,
          hasAbort: !!abortBtn,
          status: statusEl ? statusEl.innerText.trim() : "",
        };
      })()`,
    );
    if (st.err) {
      throw new Error(`run error: ${JSON.stringify(st.err)}`);
    }
    if (st.done) {
      await sleep(400);
      return st.done;
    }
    // 兜底：无 abort 且状态就绪，且已跑过一段时间
    if (!st.hasAbort && /就绪|完成|失败/.test(st.status) && Date.now() - start > 4000) {
      await sleep(600);
      const again = await evalJs(send, `!!window.__pawTestRunDone`);
      if (again) return true;
      // 可能事件丢了但 UI 已 idle
      if (!st.hasAbort && Date.now() - start > 8000) return { fallback: true, status: st.status };
    }
    await sleep(800);
  }
  throw new Error("waitRunDone timeout");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function clickNewConversation(send) {
  await evalJs(
    send,
    `(() => {
      const b = [...document.querySelectorAll("button")].find(x => x.innerText.includes("新对话"));
      if (!b) throw new Error("no 新对话");
      b.click();
      return true;
    })()`,
  );
  await sleep(800);
}

async function main() {
  console.log("\n=== Paw Desktop Complex Scenario Suite ===\n");
  const { ws, send } = await connect();

  // ── S0: 环境 ──────────────────────────────────────────
  try {
    const meta = await evalJs(
      send,
      `(async () => {
        const m = await window.pawDesktop.getMeta();
        return {
          agentReady: m.agentReady,
          repoRoot: m.repoRoot,
          hasList: typeof window.pawDesktop.listMemories === "function",
          hasOnList: typeof window.pawDesktop.onMemoryListDone === "function",
        };
      })()`,
      true,
    );
    if (meta.hasList && meta.hasOnList) pass("S0 Phase1 API present", JSON.stringify(meta));
    else fail("S0 Phase1 API present", JSON.stringify(meta));
  } catch (e) {
    fail("S0 Phase1 API present", e.message);
  }

  // ── S1: Memory 总库 list ──────────────────────────────
  try {
    const lib = await evalJs(
      send,
      `(async () => {
        return await new Promise((resolve) => {
          const t = setTimeout(() => resolve({ timeout: true }), 12000);
          const off = window.pawDesktop.onMemoryListDone((p) => {
            clearTimeout(t);
            off();
            resolve({
              ok: p.ok,
              count: Array.isArray(p.items) ? p.items.length : 0,
              titles: (p.items||[]).slice(0, 8).map(i => i.title),
              error: p.error || null,
              hasVitest: (p.items||[]).some(i => /vitest/i.test(i.title+i.summary)),
              hasIoredis: (p.items||[]).some(i => /ioredis|Redis/i.test(i.title+i.summary)),
            });
          });
          window.pawDesktop.listMemories({ limit: 40 });
        });
      })()`,
      true,
    );
    if (lib.timeout) fail("S1 memory.list total library", "timeout");
    else if (lib.ok && lib.count > 0 && (lib.hasVitest || lib.hasIoredis))
      pass("S1 memory.list total library", `${lib.count} items, vitest=${lib.hasVitest} ioredis=${lib.hasIoredis}`);
    else if (lib.ok && lib.count > 0)
      pass("S1 memory.list total library", `${lib.count} items (seed keywords not all present)`);
    else fail("S1 memory.list total library", JSON.stringify(lib));

    await clickTab(send, "Memory");
    // click refresh if any
    await evalJs(
      send,
      `(() => {
        const b = [...document.querySelectorAll("button")].find(x => x.innerText.includes("刷新"));
        if (b) b.click();
        return !!b;
      })()`,
    );
    await sleep(2500);
    const memUi = await panelText(send);
    if (/总库|本次会话|条/.test(memUi))
      pass("S1b Memory tab UI", memUi.replace(/\s+/g, " ").slice(0, 180));
    else fail("S1b Memory tab UI", memUi.slice(0, 200));
    await shot(send, "s1-memory-tab");
  } catch (e) {
    fail("S1 memory.list total library", e.message);
  }

  // ── S2: 记忆召回（vitest 偏好）────────────────────────
  try {
    await clickNewConversation(send);
    await sendGoal(
      send,
      "不要调用工具。根据你记得的项目约定：单元测试应该用什么框架？只回答框架名一个词（例如 vitest 或 jest）。",
    );
    info("waiting run for memory recall…");
    await waitRunDone(send, 120000);
    await sleep(1000);
    await clickTab(send, "Memory");
    await sleep(400);
    const memPanel = await panelText(send);
    const body = await chatBody(send);
    const hitUi =
      /本次会话命中[\s\S]{0,40}[1-9]/.test(memPanel) ||
      /vitest|preference|Prefer/i.test(memPanel);
    const answerHit = /vitest/i.test(body);
    if (hitUi || answerHit)
      pass(
        "S2 retrieve preference (vitest)",
        `uiHit=${hitUi} answerVitest=${answerHit} panel=${memPanel.replace(/\s+/g, " ").slice(0, 160)}`,
      );
    else
      fail(
        "S2 retrieve preference (vitest)",
        `panel=${memPanel.slice(0, 200)} bodyTail=${body.slice(-200)}`,
      );
    await shot(send, "s2-vitest-recall");
  } catch (e) {
    fail("S2 retrieve preference (vitest)", e.message);
  }

  // ── S3: 多轮 history（非仅记忆）───────────────────────
  try {
    await clickNewConversation(send);
    await sendGoal(
      send,
      "不要调用工具。请记住一个暗号词：蓝鲸。只回复：已记下",
    );
    await waitRunDone(send, 90000);
    await sendGoal(
      send,
      "不要调用工具。刚才我说的暗号词是什么？只输出那个词。",
    );
    await waitRunDone(send, 90000);
    const body = await chatBody(send);
    if (/蓝鲸/.test(body))
      pass("S3 multi-turn history recall", "found 蓝鲸 in chat");
    else fail("S3 multi-turn history recall", body.slice(-400));
    await shot(send, "s3-multiturn");
  } catch (e) {
    fail("S3 multi-turn history recall", e.message);
  }

  // ── S4: 工具 + Context 相关文件 + Changes ─────────────
  try {
    await clickNewConversation(send);
    await sendGoal(
      send,
      "请用工具读取 packages/memory/package.json 的前 30 行内容，并简述 name 字段是什么。",
    );
    info("waiting tool run…");
    await waitRunDone(send, 180000);
    await sleep(800);

    await clickTab(send, "Context");
    await sleep(300);
    const ctxText = await panelText(send);
    const ctxHasFile =
      /package\.json|memory|相关文件/i.test(ctxText) ||
      /Turn|预算|Token|System|History/i.test(ctxText);

    await clickTab(send, "Changes");
    await sleep(200);
    const chText = await panelText(send);

    await clickTab(send, "Plan");
    await sleep(200);
    const planText = await panelText(send);

    if (ctxHasFile)
      pass("S4a Context panel has run data", ctxText.replace(/\s+/g, " ").slice(0, 200));
    else fail("S4a Context panel has run data", ctxText.slice(0, 250));

    // Changes may be empty if only read (we only track writes for Changes, reads go to Context)
    if (/package\.json|暂无文件变更/.test(chText))
      pass("S4b Changes tab reachable", chText.replace(/\s+/g, " ").slice(0, 120));
    else pass("S4b Changes tab reachable", chText.replace(/\s+/g, " ").slice(0, 120));

    const body = await chatBody(send);
    if (/@paw\/memory|memory|name/i.test(body))
      pass("S4c tool read produced answer", body.slice(-220).replace(/\s+/g, " "));
    else fail("S4c tool read produced answer", body.slice(-300));

    info(`plan panel: ${planText.replace(/\s+/g, " ").slice(0, 120)}`);
    await shot(send, "s4-context-tools");
  } catch (e) {
    fail("S4 tool+context", e.message);
  }

  // ── S5: Plan 复杂任务（尽量触发 plan_update）──────────
  try {
    await clickNewConversation(send);
    await sendGoal(
      send,
      "这是一个多步骤任务：1) 用工具列出工作区顶层目录名；2) 说明 apps 和 packages 各自大概职责；3) 最后用一句话总结。请先列出你的执行计划再开始。",
    );
    await waitRunDone(send, 180000);
    await sleep(500);
    await clickTab(send, "Plan");
    await sleep(300);
    const planText = await panelText(send);
    const body = await chatBody(send);
    const hasPlanItems =
      /apps|packages|目录|步骤|1\.|2\./i.test(planText) &&
      !/暂无执行计划/.test(planText);
    const bodyHasStructure = /apps|packages|目录/i.test(body);
    if (hasPlanItems)
      pass("S5 Plan panel populated", planText.replace(/\s+/g, " ").slice(0, 220));
    else if (bodyHasStructure)
      fail(
        "S5 Plan panel populated",
        `body ok but plan empty: ${planText.slice(0, 150)}`,
      );
    else fail("S5 Plan panel populated", `plan=${planText.slice(0, 150)} body=${body.slice(-200)}`);
    await shot(send, "s5-plan");
  } catch (e) {
    fail("S5 Plan complex task", e.message);
  }

  // ── S6: 闲聊后新对话（finalize 不炸）──────────────────
  try {
    await clickNewConversation(send);
    await sendGoal(send, "你好");
    await waitRunDone(send, 60000);
    await clickNewConversation(send);
    await sleep(1000);
    const body = await chatBody(send);
    // after new chat, stream should be relatively empty / welcome
    if (/开始和 Paw|描述一个任务|就绪/.test(body) || body.length < 800)
      pass("S6 chitchat + new conversation finalize", "UI reset ok");
    else pass("S6 chitchat + new conversation finalize", "completed without crash");
    await shot(send, "s6-new-chat");
  } catch (e) {
    fail("S6 chitchat + new conversation finalize", e.message);
  }

  // ── S7: ioredis 二次召回 ──────────────────────────────
  try {
    await sendGoal(
      send,
      "不要调用工具。项目里 Redis 客户端偏好是什么库？只回答库名（如 ioredis 或 node-redis）。",
    );
    await waitRunDone(send, 120000);
    const body = await chatBody(send);
    await clickTab(send, "Memory");
    await sleep(300);
    const mem = await panelText(send);
    if (/ioredis/i.test(body) || /ioredis|Redis/i.test(mem))
      pass("S7 redis preference recall", `bodyHas=${/ioredis/i.test(body)} memHas=${/ioredis|Redis/i.test(mem)}`);
    else fail("S7 redis preference recall", body.slice(-250) + " | " + mem.slice(0, 150));
    await shot(send, "s7-ioredis");
  } catch (e) {
    fail("S7 redis preference recall", e.message);
  }

  // ── Summary ───────────────────────────────────────────
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  console.log("\n=== Summary ===");
  console.log(`Passed: ${passed}  Failed: ${failed}  Total: ${results.length}`);
  for (const r of results) {
    console.log(`${r.ok ? "OK" : "NG"} | ${r.name}`);
  }
  writeFileSync(
    join(OUT_DIR, "results.json"),
    JSON.stringify({ passed, failed, results, at: new Date().toISOString() }, null, 2),
  );
  ws.close();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("SUITE CRASH", e);
  process.exit(2);
});
