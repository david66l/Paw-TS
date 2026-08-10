/**
 * Electron 主进程：
 * - 创建窗口
 * - spawn Bun agent-host，转发 IPC ↔ 行协议
 */
const { app, BrowserWindow, ipcMain, shell } = require("electron");
const path = require("node:path");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const readline = require("node:readline");

const isDev = !app.isPackaged;
const DEV_URL = process.env.VITE_DEV_SERVER_URL || "http://127.0.0.1:5173";

/** monorepo 根：apps/desktop/electron → ../../../ */
const REPO_ROOT = path.resolve(__dirname, "../../..");
const AGENT_HOST = path.join(__dirname, "../agent-host/run.ts");

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {import('node:child_process').ChildProcessWithoutNullStreams | null} */
let agentProc = null;
let agentReady = false;
/** 退出中标志：主动 kill 时不触发看门狗自动重启 */
let quitting = false;
/** 看门狗：最近重启时间戳（60s 滑动窗口，超 5 次放弃，防崩溃循环） */
let agentRestartTimes = [];

function findBun() {
  if (process.env.BUN_PATH && fs.existsSync(process.env.BUN_PATH)) {
    return process.env.BUN_PATH;
  }
  const home = process.env.HOME || "";
  const candidates = [
    path.join(home, ".bun/bin/bun"),
    "/usr/local/bin/bun",
    "/opt/homebrew/bin/bun",
    "bun",
  ];
  for (const c of candidates) {
    if (c === "bun") return c;
    if (fs.existsSync(c)) return c;
  }
  return "bun";
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function startAgentHost() {
  if (agentProc) return;

  const bun = findBun();
  agentProc = spawn(bun, ["run", AGENT_HOST], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      // 继承用户环境里的 DATABASE_URL 等
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  agentReady = false;

  const rl = readline.createInterface({ input: agentProc.stdout });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      sendToRenderer("agent:log", {
        level: "warn",
        text: trimmed.slice(0, 500),
      });
      return;
    }
    if (msg.type === "ready") {
      agentReady = true;
      sendToRenderer("agent:ready", {});
      return;
    }
    if (msg.type === "event") {
      sendToRenderer("agent:event", {
        requestId: msg.requestId,
        event: msg.event,
      });
      return;
    }
    if (msg.type === "run.done") {
      sendToRenderer("agent:run-done", {
        requestId: msg.requestId,
        result: msg.result,
      });
      return;
    }
    if (msg.type === "error") {
      sendToRenderer("agent:error", {
        requestId: msg.requestId,
        message: msg.message,
      });
      return;
    }
    if (msg.type === "approval.request") {
      sendToRenderer("agent:approval-request", {
        requestId: msg.requestId,
        approvalId: msg.approvalId,
        tool: msg.tool,
        summary: msg.summary,
        argsPreview: msg.argsPreview,
      });
      return;
    }
    if (msg.type === "ask.request") {
      sendToRenderer("agent:ask-request", {
        requestId: msg.requestId,
        askId: msg.askId,
        question: msg.question,
        timeoutSec: msg.timeoutSec ?? null,
      });
      return;
    }
    if (msg.type === "memory.finalize.done") {
      sendToRenderer("agent:memory-finalize-done", {
        requestId: msg.requestId,
        conversationId: msg.conversationId,
        completed: msg.completed,
        taskId: msg.taskId,
      });
    }
    if (msg.type === "memory.list.done") {
      sendToRenderer("agent:memory-list-done", {
        requestId: msg.requestId,
        ok: msg.ok,
        items: Array.isArray(msg.items) ? msg.items : [],
        error: msg.error,
      });
      return;
    }
    if (msg.type === "doctor.done") {
      sendToRenderer("agent:doctor-done", {
        requestId: msg.requestId,
        ok: msg.ok,
        text: msg.text,
      });
      return;
    }
    if (msg.type === "checkpoint.list.done") {
      sendToRenderer("agent:checkpoint-list-done", {
        requestId: msg.requestId,
        ok: msg.ok,
        runId: msg.runId,
        items: Array.isArray(msg.items) ? msg.items : [],
        error: msg.error,
      });
      return;
    }
    if (msg.type === "checkpoint.undo.done") {
      sendToRenderer("agent:checkpoint-undo-done", {
        requestId: msg.requestId,
        ok: msg.ok,
        runId: msg.runId,
        restored: msg.restored ?? null,
        error: msg.error,
      });
      return;
    }
    if (msg.type === "runs.list.done") {
      sendToRenderer("agent:runs-list-done", {
        requestId: msg.requestId,
        ok: msg.ok,
        items: Array.isArray(msg.items) ? msg.items : [],
        error: msg.error,
      });
      return;
    }
    if (msg.type === "runs.load.done") {
      sendToRenderer("agent:runs-load-done", {
        requestId: msg.requestId,
        ok: msg.ok,
        runId: msg.runId,
        events: Array.isArray(msg.events) ? msg.events : [],
        total: typeof msg.total === "number" ? msg.total : 0,
        error: msg.error,
      });
      return;
    }
    if (msg.type === "status.done") {
      sendToRenderer("agent:status-done", {
        requestId: msg.requestId,
        ok: msg.ok,
        workspaceRoot: msg.workspaceRoot,
        modelLabel: msg.modelLabel,
        skillsCount: msg.skillsCount,
        skillsDir: msg.skillsDir,
        agentsCount: msg.agentsCount,
        agents: msg.agents,
        error: msg.error,
      });
    }
    if (msg.type === "settings.done") {
      sendToRenderer("agent:settings-done", {
        requestId: msg.requestId,
        ok: msg.ok,
        provider: msg.provider,
        approvalMode: msg.approvalMode,
        presets: Array.isArray(msg.presets) ? msg.presets : [],
        error: msg.error,
      });
      return;
    }
  });

  agentProc.stderr.on("data", (buf) => {
    const text = buf.toString("utf8");
    sendToRenderer("agent:log", { level: "stderr", text: text.slice(0, 2000) });
  });

  agentProc.on("exit", (code) => {
    agentProc = null;
    agentReady = false;
    sendToRenderer("agent:host-exit", { code });
    // 看门狗：非退出场景自动重启（800ms 后），限频防崩溃循环
    if (quitting) return;
    const now = Date.now();
    agentRestartTimes = agentRestartTimes.filter((t) => now - t < 60_000);
    if (agentRestartTimes.length >= 5) {
      sendToRenderer("agent:log", {
        level: "error",
        text: "agent-host 1 分钟内重启超过 5 次，已停止自动重启，请检查 bun 与环境",
      });
      return;
    }
    agentRestartTimes.push(now);
    setTimeout(() => {
      if (!quitting && !agentProc) startAgentHost();
    }, 800);
  });
}

function writeAgent(msg) {
  if (!agentProc || !agentProc.stdin.writable) {
    throw new Error("Agent 宿主未启动");
  }
  agentProc.stdin.write(`${JSON.stringify(msg)}\n`);
}

/** 确保宿主就绪后写入；超时则回调 onTimeout */
function writeWhenReady(msg, onTimeout) {
  startAgentHost();
  if (agentReady) {
    writeAgent(msg);
    return;
  }
  const t0 = Date.now();
  const timer = setInterval(() => {
    if (agentReady) {
      clearInterval(timer);
      writeAgent(msg);
    } else if (Date.now() - t0 > 8000) {
      clearInterval(timer);
      onTimeout?.();
    }
  }, 50);
}

function newReqId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function createWindow() {
  // macOS 关窗不退出：重开窗口时复位退出标志，恢复看门狗
  quitting = false;
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    title: "Paw",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: "#eef2fb",
    vibrancy: "under-window",
    visualEffectState: "active",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (isDev) {
    void mainWindow.loadURL(DEV_URL);
  } else {
    void mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function setupIpc() {
  ipcMain.handle("agent:get-meta", () => ({
    repoRoot: REPO_ROOT,
    platform: process.platform,
    agentReady,
  }));

  ipcMain.handle("agent:start-run", (_evt, payload) => {
    startAgentHost();
    const requestId =
      typeof payload?.requestId === "string" && payload.requestId
        ? payload.requestId
        : `req-${Date.now()}`;
    const goal = typeof payload?.goal === "string" ? payload.goal : "";
    const workspaceRoot =
      typeof payload?.workspaceRoot === "string" && payload.workspaceRoot.trim()
        ? path.resolve(payload.workspaceRoot)
        : REPO_ROOT;
    const maxSteps =
      typeof payload?.maxSteps === "number" && payload.maxSteps > 0
        ? payload.maxSteps
        : 24;
    const conversationId =
      typeof payload?.conversationId === "string" &&
      payload.conversationId.trim()
        ? payload.conversationId.trim()
        : undefined;
    /** @type {{ role: string, content: string }[]} */
    let history = [];
    if (Array.isArray(payload?.history)) {
      history = payload.history
        .filter(
          (t) =>
            t &&
            (t.role === "user" || t.role === "assistant") &&
            typeof t.content === "string" &&
            t.content.trim(),
        )
        .map((t) => ({ role: t.role, content: String(t.content).trim() }));
    }

    // 宿主可能尚未 ready，短暂等待
    const tryWrite = () => {
      writeAgent({
        type: "run",
        requestId,
        goal,
        workspaceRoot,
        maxSteps,
        ...(conversationId ? { conversationId } : {}),
        ...(history.length > 0 ? { history } : {}),
      });
    };

    if (agentReady) {
      tryWrite();
    } else {
      const t0 = Date.now();
      const timer = setInterval(() => {
        if (agentReady) {
          clearInterval(timer);
          tryWrite();
        } else if (Date.now() - t0 > 8000) {
          clearInterval(timer);
          sendToRenderer("agent:error", {
            requestId,
            message: "Agent 宿主启动超时（请确认本机已安装 bun）",
          });
        }
      }, 50);
    }

    return { requestId, workspaceRoot };
  });

  ipcMain.handle("agent:abort", (_evt, payload) => {
    const requestId = payload?.requestId;
    if (typeof requestId === "string" && agentProc) {
      writeAgent({ type: "abort", requestId });
    }
    return { ok: true };
  });

  /** 渲染进程回答工具审批（允许 / 拒绝 / 本会话始终允许） */
  ipcMain.handle("agent:approval-respond", (_evt, payload) => {
    if (
      agentProc &&
      typeof payload?.requestId === "string" &&
      typeof payload?.approvalId === "string"
    ) {
      writeAgent({
        type: "approval.respond",
        requestId: payload.requestId,
        approvalId: payload.approvalId,
        approved: payload.approved === true,
        always: payload.always === true,
      });
    }
    return { ok: true };
  });

  /** 渲染进程回答模型的 ask_user 提问 */
  ipcMain.handle("agent:ask-respond", (_evt, payload) => {
    if (
      agentProc &&
      typeof payload?.requestId === "string" &&
      typeof payload?.askId === "string"
    ) {
      writeAgent({
        type: "ask.respond",
        requestId: payload.requestId,
        askId: payload.askId,
        answer: typeof payload.answer === "string" ? payload.answer : "",
      });
    }
    return { ok: true };
  });

  /** 列出工作区长期记忆（Memory 总库） */
  ipcMain.handle("agent:list-memories", (_evt, payload) => {
    startAgentHost();
    const requestId =
      typeof payload?.requestId === "string" && payload.requestId
        ? payload.requestId
        : `mlist-${Date.now()}`;
    const workspaceRoot =
      typeof payload?.workspaceRoot === "string" && payload.workspaceRoot.trim()
        ? path.resolve(payload.workspaceRoot)
        : REPO_ROOT;
    const limit =
      typeof payload?.limit === "number" && payload.limit > 0
        ? payload.limit
        : 40;
    const memoryType =
      typeof payload?.type === "string" ? payload.type : undefined;

    const tryWrite = () => {
      writeAgent({
        type: "memory.list",
        requestId,
        workspaceRoot,
        limit,
        memoryType,
      });
    };

    if (agentReady) {
      tryWrite();
    } else {
      const t0 = Date.now();
      const timer = setInterval(() => {
        if (agentReady) {
          clearInterval(timer);
          tryWrite();
        } else if (Date.now() - t0 > 8000) {
          clearInterval(timer);
          sendToRenderer("agent:memory-list-done", {
            requestId,
            ok: false,
            items: [],
            error: "Agent 宿主启动超时（list memories）",
          });
        }
      }, 100);
    }
    return { ok: true, requestId };
  });

  ipcMain.handle("agent:doctor", (_evt, payload) => {
    const requestId =
      typeof payload?.requestId === "string" && payload.requestId
        ? payload.requestId
        : newReqId("doc");
    const workspaceRoot =
      typeof payload?.workspaceRoot === "string" && payload.workspaceRoot.trim()
        ? path.resolve(payload.workspaceRoot)
        : REPO_ROOT;
    writeWhenReady({ type: "doctor", requestId, workspaceRoot }, () => {
      sendToRenderer("agent:doctor-done", {
        requestId,
        ok: false,
        text: "Agent 宿主启动超时（doctor）",
      });
    });
    return { ok: true, requestId };
  });

  ipcMain.handle("agent:checkpoint-list", (_evt, payload) => {
    const requestId =
      typeof payload?.requestId === "string" && payload.requestId
        ? payload.requestId
        : newReqId("cpl");
    const runId =
      typeof payload?.runId === "string" ? payload.runId.trim() : "";
    const workspaceRoot =
      typeof payload?.workspaceRoot === "string" && payload.workspaceRoot.trim()
        ? path.resolve(payload.workspaceRoot)
        : REPO_ROOT;
    writeWhenReady(
      { type: "checkpoint.list", requestId, workspaceRoot, runId },
      () => {
        sendToRenderer("agent:checkpoint-list-done", {
          requestId,
          ok: false,
          runId,
          items: [],
          error: "Agent 宿主启动超时",
        });
      },
    );
    return { ok: true, requestId };
  });

  ipcMain.handle("agent:checkpoint-undo", (_evt, payload) => {
    const requestId =
      typeof payload?.requestId === "string" && payload.requestId
        ? payload.requestId
        : newReqId("cpu");
    const runId =
      typeof payload?.runId === "string" ? payload.runId.trim() : "";
    const workspaceRoot =
      typeof payload?.workspaceRoot === "string" && payload.workspaceRoot.trim()
        ? path.resolve(payload.workspaceRoot)
        : REPO_ROOT;
    writeWhenReady(
      { type: "checkpoint.undo", requestId, workspaceRoot, runId },
      () => {
        sendToRenderer("agent:checkpoint-undo-done", {
          requestId,
          ok: false,
          runId,
          restored: null,
          error: "Agent 宿主启动超时",
        });
      },
    );
    return { ok: true, requestId };
  });

  ipcMain.handle("agent:runs-list", (_evt, payload) => {
    const requestId =
      typeof payload?.requestId === "string" && payload.requestId
        ? payload.requestId
        : newReqId("rnl");
    const workspaceRoot =
      typeof payload?.workspaceRoot === "string" && payload.workspaceRoot.trim()
        ? path.resolve(payload.workspaceRoot)
        : REPO_ROOT;
    writeWhenReady({ type: "runs.list", requestId, workspaceRoot }, () => {
      sendToRenderer("agent:runs-list-done", {
        requestId,
        ok: false,
        items: [],
        error: "Agent 宿主启动超时",
      });
    });
    return { ok: true, requestId };
  });

  ipcMain.handle("agent:runs-load", (_evt, payload) => {
    const requestId =
      typeof payload?.requestId === "string" && payload.requestId
        ? payload.requestId
        : newReqId("rnld");
    const runId =
      typeof payload?.runId === "string" ? payload.runId.trim() : "";
    const workspaceRoot =
      typeof payload?.workspaceRoot === "string" && payload.workspaceRoot.trim()
        ? path.resolve(payload.workspaceRoot)
        : REPO_ROOT;
    const limit =
      typeof payload?.limit === "number" && payload.limit > 0
        ? payload.limit
        : 200;
    writeWhenReady(
      { type: "runs.load", requestId, workspaceRoot, runId, limit },
      () => {
        sendToRenderer("agent:runs-load-done", {
          requestId,
          ok: false,
          runId,
          events: [],
          total: 0,
          error: "Agent 宿主启动超时",
        });
      },
    );
    return { ok: true, requestId };
  });

  ipcMain.handle("agent:status", (_evt, payload) => {
    const requestId =
      typeof payload?.requestId === "string" && payload.requestId
        ? payload.requestId
        : newReqId("st");
    const workspaceRoot =
      typeof payload?.workspaceRoot === "string" && payload.workspaceRoot.trim()
        ? path.resolve(payload.workspaceRoot)
        : REPO_ROOT;
    writeWhenReady({ type: "status", requestId, workspaceRoot }, () => {
      sendToRenderer("agent:status-done", {
        requestId,
        ok: false,
        workspaceRoot,
        modelLabel: "unknown",
        skillsCount: 0,
        skillsDir: "",
        error: "Agent 宿主启动超时",
      });
    });
    return { ok: true, requestId };
  });

  /** 读取工作区设置（模型预设 / 审批模式） */
  ipcMain.handle("agent:settings-get", (_evt, payload) => {
    const requestId =
      typeof payload?.requestId === "string" && payload.requestId
        ? payload.requestId
        : newReqId("setg");
    const workspaceRoot =
      typeof payload?.workspaceRoot === "string" && payload.workspaceRoot.trim()
        ? path.resolve(payload.workspaceRoot)
        : REPO_ROOT;
    writeWhenReady({ type: "settings.get", requestId, workspaceRoot }, () => {
      sendToRenderer("agent:settings-done", {
        requestId,
        ok: false,
        approvalMode: "ask",
        presets: [],
        error: "Agent 宿主启动超时",
      });
    });
    return { ok: true, requestId };
  });

  /** 写回设置（只改 provider / approvalMode，不碰 API key） */
  ipcMain.handle("agent:settings-set", (_evt, payload) => {
    const requestId =
      typeof payload?.requestId === "string" && payload.requestId
        ? payload.requestId
        : newReqId("sets");
    const workspaceRoot =
      typeof payload?.workspaceRoot === "string" && payload.workspaceRoot.trim()
        ? path.resolve(payload.workspaceRoot)
        : REPO_ROOT;
    writeWhenReady(
      {
        type: "settings.set",
        requestId,
        workspaceRoot,
        ...(typeof payload?.provider === "string"
          ? { provider: payload.provider }
          : {}),
        ...(payload?.approvalMode === "ask" || payload?.approvalMode === "auto"
          ? { approvalMode: payload.approvalMode }
          : {}),
      },
      () => {
        sendToRenderer("agent:settings-done", {
          requestId,
          ok: false,
          approvalMode: "ask",
          presets: [],
          error: "Agent 宿主启动超时",
        });
      },
    );
    return { ok: true, requestId };
  });

  /** 结束桌面会话：对 conversation 绑定的 memory TaskSession 做 completeTask */
  ipcMain.handle("agent:finalize-conversation", (_evt, payload) => {
    startAgentHost();
    const conversationId =
      typeof payload?.conversationId === "string"
        ? payload.conversationId.trim()
        : "";
    if (!conversationId) {
      return { ok: false, reason: "missing conversationId" };
    }
    const requestId =
      typeof payload?.requestId === "string" && payload.requestId
        ? payload.requestId
        : `fin-${Date.now()}`;
    const finalMessage =
      typeof payload?.finalMessage === "string"
        ? payload.finalMessage
        : undefined;

    const tryWrite = () => {
      writeAgent({
        type: "memory.finalize",
        requestId,
        conversationId,
        finalMessage,
        workspaceRoot: REPO_ROOT,
      });
    };

    if (agentReady) {
      tryWrite();
    } else {
      const t0 = Date.now();
      const timer = setInterval(() => {
        if (agentReady) {
          clearInterval(timer);
          tryWrite();
        } else if (Date.now() - t0 > 8000) {
          clearInterval(timer);
          sendToRenderer("agent:error", {
            requestId,
            message: "Agent 宿主启动超时（finalize）",
          });
        }
      }, 50);
    }
    return { ok: true, requestId };
  });
}

app.whenReady().then(() => {
  setupIpc();
  startAgentHost();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  quitting = true;
  if (agentProc) {
    agentProc.kill();
    agentProc = null;
  }
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  quitting = true;
  if (agentProc) {
    agentProc.kill();
    agentProc = null;
  }
});
