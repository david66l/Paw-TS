/**
 * 验收 P1/P2：slash + host 能力（需 Electron --remote-debugging-port=9223）
 */
const CDP = process.env.CDP_URL || "http://127.0.0.1:9223";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  const list = await (await fetch(`${CDP}/json/list`)).json();
  const page =
    list.find((t) => t.type === "page" && t.url?.includes("5173")) ||
    list.find((t) => t.type === "page");
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

async function bodyText(send) {
  return evalJs(
    send,
    `document.body?.innerText || document.documentElement?.innerText || ""`,
  );
}

async function sendChat(send, text) {
  // Prefer React-friendly: fill textarea and click send, or dispatch via API
  const hasApi = await evalJs(send, `!!window.pawDesktop`);
  if (!hasApi) throw new Error("window.pawDesktop missing");

  // Type into composer and submit via Enter
  const ok = await evalJs(
    send,
    `(() => {
      const ta = document.querySelector("textarea");
      if (!ta) return false;
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, "value"
      )?.set;
      setter?.call(ta, ${JSON.stringify(text)});
      ta.dispatchEvent(new Event("input", { bubbles: true }));
      ta.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Enter", code: "Enter", keyCode: 13, which: 13,
        bubbles: true, cancelable: true
      }));
      return true;
    })()`,
  );
  if (!ok) throw new Error("no textarea");
}

const results = [];
const pass = (n, d = "") => {
  results.push({ name: n, ok: true, detail: d });
  console.log(`✅ ${n}${d ? " — " + d : ""}`);
};
const fail = (n, d = "") => {
  results.push({ name: n, ok: false, detail: d });
  console.log(`❌ ${n}${d ? " — " + d : ""}`);
};

async function main() {
  const { send, ws } = await connect();
  await sleep(800);

  // API surface
  try {
    const apis = await evalJs(
      send,
      `(() => {
        const d = window.pawDesktop;
        if (!d) return null;
        return {
          doctor: typeof d.doctor,
          listCheckpoints: typeof d.listCheckpoints,
          undoCheckpoint: typeof d.undoCheckpoint,
          listRuns: typeof d.listRuns,
          loadRun: typeof d.loadRun,
          fetchStatus: typeof d.fetchStatus,
          onDoctorDone: typeof d.onDoctorDone,
        };
      })()`,
    );
    if (!apis) fail("preload API", "pawDesktop missing");
    else if (Object.values(apis).some((v) => v !== "function"))
      fail("preload API", JSON.stringify(apis));
    else pass("preload API", JSON.stringify(apis));
  } catch (e) {
    fail("preload API", String(e));
  }

  // Host status via IPC
  try {
    const st = await evalJs(
      send,
      `(() => new Promise(async (resolve, reject) => {
        const d = window.pawDesktop;
        const t = setTimeout(() => reject(new Error("status timeout")), 15000);
        const off = d.onStatusDone((p) => {
          if (!p.requestId) return;
          clearTimeout(t);
          off();
          resolve(p);
        });
        await d.fetchStatus({});
      }))()`,
      true,
    );
    if (st?.ok && st.modelLabel) pass("status IPC", st.modelLabel);
    else fail("status IPC", JSON.stringify(st));
  } catch (e) {
    fail("status IPC", String(e));
  }

  // Doctor via IPC
  try {
    const doc = await evalJs(
      send,
      `(() => new Promise(async (resolve, reject) => {
        const d = window.pawDesktop;
        const t = setTimeout(() => reject(new Error("doctor timeout")), 25000);
        const off = d.onDoctorDone((p) => {
          clearTimeout(t);
          off();
          resolve(p);
        });
        await d.doctor({});
      }))()`,
      true,
    );
    if (doc?.ok && /workspace:|memory/i.test(doc.text || ""))
      pass("doctor IPC", (doc.text || "").slice(0, 80).replace(/\n/g, " "));
    else fail("doctor IPC", JSON.stringify(doc)?.slice(0, 200));
  } catch (e) {
    fail("doctor IPC", String(e));
  }

  // runs.list
  try {
    const runs = await evalJs(
      send,
      `(() => new Promise(async (resolve, reject) => {
        const d = window.pawDesktop;
        const t = setTimeout(() => reject(new Error("runs timeout")), 15000);
        const off = d.onRunsListDone((p) => {
          clearTimeout(t);
          off();
          resolve(p);
        });
        await d.listRuns({});
      }))()`,
      true,
    );
    if (runs?.ok && Array.isArray(runs.items))
      pass("runs.list IPC", `${runs.items.length} runs`);
    else fail("runs.list IPC", JSON.stringify(runs)?.slice(0, 200));
  } catch (e) {
    fail("runs.list IPC", String(e));
  }

  // slash /help in UI
  try {
    await sendChat(send, "/help");
    await sleep(1500);
    const text = await bodyText(send);
    if (/Doctor|checkpoints|\/sessions|slash/i.test(text))
      pass("slash /help UI", "help text visible");
    else fail("slash /help UI", text.slice(0, 300));
  } catch (e) {
    fail("slash /help UI", String(e));
  }

  // slash /doctor in UI
  try {
    await sendChat(send, "/doctor");
    await sleep(4000);
    const text = await bodyText(send);
    if (/Doctor|postgres|workspace:|migrations/i.test(text))
      pass("slash /doctor UI", "doctor output visible");
    else fail("slash /doctor UI", text.slice(-400));
  } catch (e) {
    fail("slash /doctor UI", String(e));
  }

  // Ops tab present
  try {
    const ops = await evalJs(
      send,
      `(() => {
        const buttons = [...document.querySelectorAll("button")];
        const opsTab = buttons.find((b) => /Ops/i.test(b.textContent || ""));
        if (!opsTab) return { found: false };
        opsTab.click();
        return { found: true, labels: buttons.map((b) => (b.textContent || "").trim()).filter(Boolean).slice(0, 30) };
      })()`,
    );
    if (ops?.found) pass("Ops tab", "clicked");
    else fail("Ops tab", JSON.stringify(ops));
    await sleep(400);
    const text = await bodyText(send);
    if (/Doctor|Checkpoint|Run/i.test(text)) pass("Ops panel content", "labels present");
    else fail("Ops panel content", text.slice(0, 300));
  } catch (e) {
    fail("Ops tab", String(e));
  }

  const failed = results.filter((r) => !r.ok);
  console.log("\n—— summary ——");
  console.log(
    `${results.length - failed.length}/${results.length} passed`,
  );
  if (failed.length) {
    for (const f of failed) console.log("FAIL:", f.name, f.detail);
    process.exitCode = 1;
  }
  ws.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
