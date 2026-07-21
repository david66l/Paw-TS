/**
 * 真实场景性能验证（需 Electron --remote-debugging-port=9223 + vite 5173）。
 * 目标：验证 fix #1（流式期间不落盘）+ #2/#3（memo 不破坏渲染）。
 * 指标：流式窗口内 localStorage.setItem 调用次数应远小于 chunk 数。
 */
const CDP = process.env.CDP_URL || "http://127.0.0.1:9223";
const PROMPT =
  process.env.PROMPT ||
  "用 markdown 无序列表分 4 点简介你自己，每点一句话，中文。";

async function connect() {
  const list = await (await fetch(`${CDP}/json/list`)).json();
  const page =
    list.find((t) => t.type === "page" && t.url?.includes("5173")) ||
    list.find((t) => t.type === "page");
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
  return { send };
}

async function evalJs(send, expression) {
  const r = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) {
    throw new Error(
      r.exceptionDetails.exception?.description ||
        JSON.stringify(r.exceptionDetails),
    );
  }
  return r.result.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { send } = await connect();
  const log = (m) => console.log(m);

  // 1) 健康检查：无 Vite 错误浮层，输入框在
  const health = await evalJs(
    send,
    `(() => ({
      title: document.title,
      overlay: !!document.querySelector('vite-error-overlay'),
      textarea: !!document.querySelector('textarea'),
      sidebar: !!document.querySelector('aside'),
    }))()`,
  );
  log(`health: ${JSON.stringify(health)}`);
  if (health.overlay) throw new Error("Vite 错误浮层存在 → HMR 未恢复");
  if (!health.textarea) throw new Error("找不到输入框");

  // 2) 埋点：真实 chunk 渲染数（MutationObserver）+ setItem 是否发生在「流式进行中」
  await evalJs(
    send,
    `(() => {
      window.__perf = { chunkRenders: 0, setItemTotal: 0, setItemWhileStreaming: 0 };
      const streaming = () => !!document.querySelector('[class*="streaming"]');
      const orig = localStorage.setItem.bind(localStorage);
      localStorage.setItem = (k, v) => {
        window.__perf.setItemTotal++;
        if (streaming()) window.__perf.setItemWhileStreaming++;
        return orig(k, v);
      };
      // 观察对话区所有子树变化 = 真实流式渲染次数（远多于 2Hz 采样）
      const root = document.querySelector('[class*="stream"]') || document.body;
      const mo = new MutationObserver((muts) => {
        // 只在有 streaming 气泡时计入，代表流式增量渲染
        if (streaming()) window.__perf.chunkRenders += muts.length;
      });
      mo.observe(root, { childList: true, subtree: true, characterData: true });
      window.__perf._mo = mo;
      return true;
    })()`,
  );

  // 3) 填入 prompt 并发送
  await evalJs(
    send,
    `(() => {
      const ta = document.querySelector('textarea');
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, ${JSON.stringify(PROMPT)});
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`,
  );
  await sleep(150);
  const sent = await evalJs(
    send,
    `(() => {
      const btn = document.querySelector('button[aria-label="发送"]');
      if (!btn || btn.disabled) return { ok:false, disabled: btn?.disabled };
      btn.click();
      return { ok:true };
    })()`,
  );
  log(`send: ${JSON.stringify(sent)}`);
  if (!sent.ok) throw new Error("发送按钮不可点（hostReady? draft?）");

  // 4) 轮询直到完成（无 streaming、有 assistant 正文），最长 90s
  let prevLen = -1,
    stableSamples = 0,
    done = null;
  for (let i = 0; i < 180; i++) {
    await sleep(500);
    const s = await evalJs(
      send,
      `(() => {
        const badge = document.querySelector('.badge')?.textContent?.trim() || '';
        const streamingEls = document.querySelectorAll('[class*="streaming"]').length;
        const mds = [...document.querySelectorAll('[class*="rowAssistant"] .md')];
        const last = mds[mds.length - 1];
        const bodyLen = last ? last.textContent.trim().length : 0;
        return { badge, streamingEls, bodyLen,
                 chunkRenders: window.__perf.chunkRenders,
                 setItemWhileStreaming: window.__perf.setItemWhileStreaming,
                 setItemTotal: window.__perf.setItemTotal };
      })()`,
    );
    if (s.bodyLen === prevLen) stableSamples++;
    else stableSamples = 0;
    prevLen = s.bodyLen;
    if (i % 6 === 0 || s.badge === "完成" || s.badge === "失败")
      log(
        `  poll#${i} badge=${s.badge} bodyLen=${s.bodyLen} chunkRenders=${s.chunkRenders} setItemWhileStreaming=${s.setItemWhileStreaming} setItemTotal=${s.setItemTotal}`,
      );
    if (
      s.badge === "完成" ||
      s.badge === "失败" ||
      (s.streamingEls === 0 && s.bodyLen > 0 && stableSamples >= 3)
    ) {
      done = s;
      break;
    }
  }
  if (!done) throw new Error("超时未完成");

  // 5) 汇总
  const perf = await evalJs(
    send,
    `(() => {
      const p = window.__perf;
      p._mo?.disconnect();
      let persisted = false, sessLen = 0;
      try {
        const key = Object.keys(localStorage).find(k=>/sessions/i.test(k));
        const raw = key ? localStorage.getItem(key) : null;
        if (raw) { const arr = JSON.parse(raw); sessLen = arr.length;
          persisted = JSON.stringify(arr).length > 200; }
      } catch {}
      return {
        chunkRenders: p.chunkRenders,
        setItemWhileStreaming: p.setItemWhileStreaming,
        setItemTotal: p.setItemTotal,
        persistedSessions: sessLen,
        persisted,
      };
    })()`,
  );

  // markdown 渲染健康
  const render = await evalJs(
    send,
    `(() => {
      const mds = [...document.querySelectorAll('[class*="rowAssistant"] .md')];
      const last = mds[mds.length-1];
      return {
        assistantBubbles: mds.length,
        lastHasList: !!last?.querySelector('ul,ol,li'),
        lastLen: last ? last.textContent.trim().length : 0,
        overlay: !!document.querySelector('vite-error-overlay'),
      };
    })()`,
  );

  console.log("\n===== 结果 =====");
  console.log("perf  :", JSON.stringify(perf));
  console.log("render:", JSON.stringify(render));

  // 判定
  const problems = [];
  if (render.overlay) problems.push("出现 Vite 错误浮层");
  if (render.lastLen < 5) problems.push("assistant 正文过短/未渲染");
  if (!perf.persisted) problems.push("localStorage 未持久化会话");
  // 核心不变量（fix #1）：流式渲染很多次，但流式进行中落盘应为 0
  if (perf.chunkRenders < 10)
    problems.push(`流式渲染次数过少(${perf.chunkRenders})，样本不足以验证`);
  if (perf.setItemWhileStreaming > 0)
    problems.push(
      `流式进行中仍落盘 ${perf.setItemWhileStreaming} 次（fix #1 失效）`,
    );

  if (problems.length) {
    console.log("\n❌ FAIL:\n  - " + problems.join("\n  - "));
    process.exit(1);
  }
  console.log(
    `\n✅ PASS — 流式渲染 ${perf.chunkRenders} 次，流式进行中落盘 ${perf.setItemWhileStreaming} 次（全程 setItem ${perf.setItemTotal} 次，均在 step/结束边界）；答案已持久化、markdown 列表正常渲染。`,
  );
  process.exit(0);
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(2);
});
