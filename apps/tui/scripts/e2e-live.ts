#!/usr/bin/env bun
/**
 * TUI 实时端到端测试脚本。
 *
 * 覆盖与 App.tsx 相同的执行路径，并额外检查 UI 格式化输出：
 * HUD、上下文条、底部状态栏、工具图标、流式单调性、成本单调性等。
 *
 * 用法：cd apps/tui && bun run e2e:live
 */

import fs from "node:fs";
import path from "node:path";
import {
  createPersistentSession,
  createRunSessionController,
} from "@paw/agent";
import type { RunEventEnvelope } from "@paw/core";
import { defaultSettingsPath, loadPawSettingsLocal } from "@paw/settings";
import { submitUserLine } from "../src/commands.js";
import {
  formatBottomBar,
  formatContextBar,
  formatHudText,
} from "../src/footer-chips.js";
import { formatEventForScrollback } from "../src/scrollback-format.js";

// 工作区根目录（paw-ts 项目根）
const WORKSPACE = path.resolve(import.meta.dir, "../../..");
// 全局超时：15 分钟
const GLOBAL_TIMEOUT_MS = 900_000;
// E2E 临时文件目录
const E2E_TMP = path.join(WORKSPACE, "e2e-tmp");

/** 单个测试场景结果。 */
interface ScenarioResult {
  readonly name: string;
  readonly ok: boolean;
  readonly ms: number;
  readonly detail: string;
  readonly errors: readonly string[];
}

/**
 * 加载当前工作区设置。
 */
function loadSettings() {
  return loadPawSettingsLocal(defaultSettingsPath(WORKSPACE));
}

/**
 * 检查模型服务提供商是否就绪。
 *
 * - ollama：探测本地 /api/tags
 * - 其他：要求 settings.local.json 中配置了 API key
 */
async function providerReady(): Promise<{ ok: boolean; reason: string }> {
  try {
    const s = loadSettings();
    const provider = s.provider?.trim().toLowerCase() ?? "";
    if (provider === "ollama") {
      const host = s.ollama_host?.trim() || "http://localhost:11434";
      const res = await fetch(`${host}/api/tags`, {
        signal: AbortSignal.timeout(3000),
      });
      return res.ok
        ? { ok: true, reason: `ollama @ ${host}` }
        : { ok: false, reason: `ollama unreachable: ${host}` };
    }
    const key = s.openai_api_key?.trim() || s.anthropic_api_key?.trim();
    if (!key) {
      return { ok: false, reason: "no API key in settings.local.json" };
    }
    const model = s.model?.trim() || "unknown";
    const base = s.openai_base_url?.trim() ?? "";
    const label = base.includes("deepseek")
      ? `deepseek:${model}`
      : `${provider || "openai"}:${model}`;
    return { ok: true, reason: label };
  } catch (e) {
    return {
      ok: false,
      reason: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * 创建事件收集器。
 *
 * @param on 每个事件的回调
 * @returns 事件数组与处理器
 */
function collectEvents(on: (e: RunEventEnvelope) => void) {
  const events: RunEventEnvelope[] = [];
  const handler = (e: RunEventEnvelope) => {
    events.push(e);
    on(e);
  };
  return { events, handler };
}

/**
 * 运行一个 E2E 场景。
 *
 * @param name 场景名称
 * @param fn 场景执行函数
 */
async function runScenario(
  name: string,
  fn: (ctx: {
    session: ReturnType<typeof createPersistentSession>;
    sessionCtrl: ReturnType<typeof createRunSessionController>;
    logs: string[];
    events: RunEventEnvelope[];
  }) => Promise<void>,
): Promise<ScenarioResult> {
  const logs: string[] = [];
  const { events, handler } = collectEvents((e) => {
    const t = e.event.type;
    // 只记录关键事件，避免日志过大
    if (
      t === "run.failed" ||
      t === "tool.call" ||
      t === "tool.result" ||
      t === "memory.retrieve.done" ||
      t === "cost.update" ||
      t === "loop.tick" ||
      t === "compression.auto_compact.done"
    ) {
      logs.push(`  [${e.seq}] ${t}: ${JSON.stringify(e.event).slice(0, 160)}`);
    }
  });

  const sessionCtrl = createRunSessionController();
  const session = createPersistentSession({
    workspaceRoot: WORKSPACE,
    skillsDir: path.join(WORKSPACE, ".paw", "skills"),
    onEvent: handler,
    resolveToolApproval: async () => true,
  });

  const start = Date.now();
  const errors: string[] = [];
  try {
    await fn({ session, sessionCtrl, logs, events });
    for (const f of events) {
      if (f.event.type === "run.failed") errors.push(f.event.message);
    }
    return {
      name,
      ok: errors.length === 0,
      ms: Date.now() - start,
      detail: logs.join("\n") || "(no notable events)",
      errors,
    };
  } catch (e) {
    return {
      name,
      ok: false,
      ms: Date.now() - start,
      detail: logs.join("\n"),
      errors: [e instanceof Error ? e.message : String(e)],
    };
  } finally {
    session.dispose();
  }
}

/**
 * 向会话提交一行用户输入。
 */
async function submitLine(
  text: string,
  session: ReturnType<typeof createPersistentSession>,
  sessionCtrl: ReturnType<typeof createRunSessionController>,
  handler: (e: RunEventEnvelope) => void,
  pushLog: string[],
): Promise<void> {
  await submitUserLine(text, {
    cwd: WORKSPACE,
    pushText: (msg) => pushLog.push(msg),
    onRunEvent: handler,
    exit: () => {},
    clear: () => {},
    runSession: sessionCtrl.runSession,
    session,
    orchestratorHooks: { resolveToolApproval: async () => true },
  });
}

/**
 * 断言 UI 格式化输出是否符合预期。
 *
 * 检查 HUD 前缀、上下文条、底部状态栏、完成状态与工具图标。
 *
 * @param events 运行事件列表
 * @param ctxWindow 上下文窗口大小
 */
function assertUiFormatting(
  events: RunEventEnvelope[],
  ctxWindow: number,
): string[] {
  const issues: string[] = [];
  const hud = formatHudText({
    modelLabel: null,
    turn: null,
    maxSteps: null,
    phase: null,
    tokens: null,
    costDetail: null,
    elapsedMs: null,
  });
  if (!hud.includes("paw │")) issues.push("HUD missing paw prefix");

  for (const e of events) {
    const ev = e.event;
    if (ev.type === "loop.tick") {
      const bar = formatContextBar(ev.estimatedTokens, ctxWindow);
      if (!bar.includes("█") && !bar.includes("░")) {
        issues.push("context bar empty at loop.tick");
      }
      const expectedPct = Math.round(
        Math.min(ev.estimatedTokens / ctxWindow, 1) * 100,
      );
      const actualPct = Number.parseInt(
        bar.split(" ").pop()?.replace("%", "") ?? "",
        10,
      );
      if (actualPct !== expectedPct) {
        issues.push(
          `context bar pct mismatch: ${actualPct}% vs expected ${expectedPct}%`,
        );
      }
    }
    if (ev.type === "cost.update") {
      if (ev.totalTokens !== ev.promptTokens + ev.completionTokens) {
        issues.push(
          `cost.update total mismatch: ${ev.totalTokens} != ${ev.promptTokens}+${ev.completionTokens}`,
        );
      }
      const bottom = formatBottomBar(
        {
          modelLabel: "x",
          turn: 1,
          maxSteps: 40,
          phase: "idle",
          tokens: 6500,
          elapsedMs: 5000,
          costDetail: {
            promptTokens: ev.promptTokens,
            completionTokens: ev.completionTokens,
            totalTokens: ev.totalTokens,
            estimatedCostUsd: ev.estimatedCostUsd,
            cachedPromptTokens: ev.cachedPromptTokens,
          },
        },
        ctxWindow,
      );
      if (!bottom.includes("api")) issues.push("bottom bar missing api tokens");
      if (!bottom.includes("ctx"))
        issues.push("bottom bar missing ctx estimate");
      if (ev.estimatedCostUsd > 0) {
        const sym = ev.costCurrency === "CNY" ? "¥" : "$";
        if (!bottom.includes(sym)) {
          issues.push(`bottom bar missing cost symbol ${sym}`);
        }
      }
    }
    const scroll = formatEventForScrollback(e);
    if (
      ev.type === "run.completed" &&
      ev.status === "completed" &&
      scroll !== "✅ completed"
    ) {
      issues.push(`run.completed scroll text wrong: ${scroll}`);
    }
    if (
      ev.type === "tool.call" &&
      scroll &&
      !scroll.match(/[📖✏️🔍⚙️🔧🤖🛠️🌐📋🔀💡📓📊]/u)
    ) {
      issues.push(`tool.call missing icon: ${scroll}`);
    }
  }
  return issues;
}

/**
 * 断言模型流式输出单调递增。
 */
function assertStreamingMonotonic(events: RunEventEnvelope[]): string[] {
  const issues: string[] = [];
  let lastChunk = "";
  let lastThinking = "";
  for (const e of events) {
    const ev = e.event;
    if (ev.type === "model.chunk") {
      if (!ev.text.startsWith(lastChunk)) {
        issues.push(
          `model.chunk not monotonic: len ${lastChunk.length} -> ${ev.text.length}`,
        );
      }
      lastChunk = ev.text;
    }
    if (ev.type === "model.thinking") {
      if (!ev.text.startsWith(lastThinking)) {
        issues.push("model.thinking not monotonic");
      }
      lastThinking = ev.text;
    }
    if (ev.type === "model.done" && ev.text !== lastChunk) {
      issues.push("model.done text != last model.chunk");
    }
  }
  return issues;
}

/**
 * 断言上下文在多轮对话中增长。
 */
function assertContextGrowth(events: RunEventEnvelope[]): string[] {
  const ticks = events
    .filter((e) => e.event.type === "loop.tick")
    .map((e) => (e.event as { estimatedTokens: number }).estimatedTokens);
  if (ticks.length < 2) return ["need >= 2 loop.tick for context growth"];
  const first = ticks[0]!;
  const last = ticks[ticks.length - 1]!;
  if (last <= first) {
    return [`context did not grow: ${first} -> ${last}`];
  }
  return [];
}

/**
 * 断言成本单调不减。
 */
function assertCostMonotonic(events: RunEventEnvelope[]): string[] {
  const costs = events
    .filter((e) => e.event.type === "cost.update")
    .map((e) => e.event.estimatedCostUsd);
  for (let i = 1; i < costs.length; i++) {
    if (costs[i]! < costs[i - 1]!) {
      return [`cost decreased: ${costs[i - 1]} -> ${costs[i]}`];
    }
  }
  return [];
}

async function main() {
  console.log("=== Paw TUI live E2E ===\n");
  fs.mkdirSync(path.join(WORKSPACE, "e2e-tmp"), { recursive: true });

  // 检查 provider 是否就绪
  const ready = await providerReady();
  if (!ready.ok) {
    console.error(`FAIL: ${ready.reason}`);
    process.exit(1);
  }
  console.log(`Provider: ${ready.reason}\n`);

  // 探测上下文窗口大小
  const sessionProbe = createPersistentSession({
    workspaceRoot: WORKSPACE,
    onEvent: () => {},
  });
  const ctxWindow = sessionProbe.contextWindow;
  sessionProbe.dispose();
  console.log(`Context window: ${ctxWindow}\n`);

  const results: ScenarioResult[] = [];

  // 场景 1：空输入边界
  results.push(
    await runScenario(
      "boundary: empty input",
      async ({ sessionCtrl, session }) => {
        const pushLog: string[] = [];
        const { handler } = collectEvents(() => {});
        await submitLine("   ", session, sessionCtrl, handler, pushLog);
        if (pushLog.length > 0) throw new Error("empty input should be no-op");
      },
    ),
  );

  // 场景 2：/doctor 命令
  results.push(
    await runScenario("UI: /doctor", async ({ sessionCtrl, session, logs }) => {
      const pushLog: string[] = [];
      const { handler } = collectEvents(() => {});
      await submitLine("/doctor", session, sessionCtrl, handler, pushLog);
      const out = pushLog.join("\n");
      if (!out.includes("provider")) throw new Error("doctor missing provider");
      logs.push(`  ${pushLog[0]?.slice(0, 80)}`);
    }),
  );

  // 场景 3：/help 命令
  results.push(
    await runScenario("UI: /help", async ({ sessionCtrl, session }) => {
      const pushLog: string[] = [];
      const { handler } = collectEvents(() => {});
      await submitLine("/help", session, sessionCtrl, handler, pushLog);
      if (!pushLog.join("\n").includes("stub-run")) {
        throw new Error("/help missing commands");
      }
    }),
  );

  // 场景 4：/fs-read 命令
  results.push(
    await runScenario("UI: /fs-read", async ({ sessionCtrl, session }) => {
      const pushLog: string[] = [];
      const { handler } = collectEvents(() => {});
      await submitLine(
        "/fs-read package.json",
        session,
        sessionCtrl,
        handler,
        pushLog,
      );
      if (!pushLog.join("\n").includes("package.json")) {
        throw new Error("fs-read missing content");
      }
    }),
  );

  // 场景 5：/fs-list 命令
  results.push(
    await runScenario("UI: /fs-list", async ({ sessionCtrl, session }) => {
      const pushLog: string[] = [];
      const { handler } = collectEvents(() => {});
      await submitLine(
        "/fs-list packages",
        session,
        sessionCtrl,
        handler,
        pushLog,
      );
      if (!pushLog.join("\n").includes("packages")) {
        throw new Error("fs-list missing packages dir");
      }
    }),
  );

  // 场景 6：自然语言对话 + 流式检查
  results.push(
    await runScenario(
      "agent: chat + stream",
      async ({ sessionCtrl, session, events, logs }) => {
        const pushLog: string[] = [];
        const { handler } = collectEvents(() => {});
        await submitLine(
          "用一句话介绍 Paw-TS，不要调用任何工具",
          session,
          sessionCtrl,
          handler,
          pushLog,
        );
        if (!events.some((e) => e.event.type === "model.done")) {
          throw new Error("no model.done");
        }
        const streamIssues = assertStreamingMonotonic(events);
        const uiIssues = assertUiFormatting(events, ctxWindow);
        const all = [...streamIssues, ...uiIssues];
        if (all.length) {
          logs.push(...all.map((i) => `  UI: ${i}`));
          throw new Error(all.join("; "));
        }
      },
    ),
  );

  // 场景 7：list_dir 工具调用
  results.push(
    await runScenario(
      "agent: list_dir",
      async ({ sessionCtrl, session, events }) => {
        const pushLog: string[] = [];
        const { handler } = collectEvents(() => {});
        await submitLine(
          "Use list_dir on packages/ (non-recursive). Reply with file count only.",
          session,
          sessionCtrl,
          handler,
          pushLog,
        );
        if (!events.some((e) => e.event.type === "tool.call")) {
          throw new Error("expected tool.call");
        }
        if (!events.some((e) => e.event.type === "run.completed")) {
          throw new Error("run did not complete");
        }
      },
    ),
  );

  // 场景 8：read_file 工具调用
  results.push(
    await runScenario(
      "agent: read_file",
      async ({ sessionCtrl, session, events }) => {
        const pushLog: string[] = [];
        const { handler } = collectEvents(() => {});
        await submitLine(
          'Use read_file on package.json and reply with the "name" field only.',
          session,
          sessionCtrl,
          handler,
          pushLog,
        );
        if (!events.some((e) => e.event.type === "run.completed")) {
          throw new Error("run did not complete");
        }
      },
    ),
  );

  // 场景 9：写入 + 读取文件
  const writeRel = path.join("e2e-tmp", `write-${Date.now()}.txt`);
  const writeAbs = path.join(WORKSPACE, writeRel);
  const marker = `e2e-marker-${Date.now()}`;

  results.push(
    await runScenario(
      "agent: write + read",
      async ({ sessionCtrl, session, events, logs }) => {
        const pushLog: string[] = [];
        const { handler } = collectEvents(() => {});
        await submitLine(
          `Use write_file to create ${writeRel} with exactly this one line: ${marker}. Then use read_file on the same path and reply OK if content matches.`,
          session,
          sessionCtrl,
          handler,
          pushLog,
        );
        const wrote = events.some(
          (e) =>
            e.event.type === "tool.call" &&
            (e.event.tool.includes("write") || e.event.tool.includes("edit")),
        );
        if (!wrote) logs.push("  warn: no write tool.call");
        if (!fs.existsSync(writeAbs)) {
          throw new Error(`file not created: ${writeRel}`);
        }
        const content = fs.readFileSync(writeAbs, "utf8");
        if (!content.includes(marker)) {
          throw new Error(
            `file content missing marker: ${content.slice(0, 80)}`,
          );
        }
        if (!events.some((e) => e.event.type === "run.completed")) {
          throw new Error("run did not complete");
        }
      },
    ),
  );

  // 场景 10：读取不存在的文件边界
  results.push(
    await runScenario(
      "agent: read failure boundary",
      async ({ sessionCtrl, session, events }) => {
        const pushLog: string[] = [];
        const { handler } = collectEvents(() => {});
        await submitLine(
          "Use read_file on .paw/e2e-tmp/does-not-exist-xyz.txt. Reply FAIL if tool errors.",
          session,
          sessionCtrl,
          handler,
          pushLog,
        );
        const failedTool = events.some(
          (e) => e.event.type === "tool.result" && !e.event.ok,
        );
        if (!failedTool) {
          throw new Error("expected failed tool.result for missing file");
        }
      },
    ),
  );

  // 场景 11：多轮上下文 + 成本检查
  results.push(
    await runScenario(
      "agent: multi-turn context + cost",
      async ({ sessionCtrl, session, events, logs }) => {
        const pushLog: string[] = [];
        const { handler } = collectEvents(() => {});
        await submitLine(
          "Remember the number 42. Do not use tools. Reply: OK",
          session,
          sessionCtrl,
          handler,
          pushLog,
        );
        await submitLine(
          "What number did I ask you to remember? One digit or number only, no tools.",
          session,
          sessionCtrl,
          handler,
          pushLog,
        );
        const growthIssues = assertContextGrowth(events);
        const costIssues = assertCostMonotonic(events);
        const uiIssues = assertUiFormatting(events, ctxWindow);
        const all = [...growthIssues, ...costIssues, ...uiIssues];
        if (all.length) {
          logs.push(...all.map((i) => `  check: ${i}`));
          throw new Error(all.join("; "));
        }
        if (!events.some((e) => e.event.type === "cost.update")) {
          throw new Error("expected cost.update events");
        }
        if (!events.some((e) => e.event.type === "loop.tick")) {
          throw new Error("expected loop.tick events");
        }
      },
    ),
  );

  // 汇总结果
  console.log("--- Results ---\n");
  let pass = 0;
  let fail = 0;
  for (const r of results) {
    console.log(
      `${r.ok ? "PASS" : "FAIL"}  ${r.name}  (${(r.ms / 1000).toFixed(1)}s)`,
    );
    if (r.ok) pass++;
    else fail++;
    for (const err of r.errors) console.log(`       error: ${err}`);
    if (r.detail.trim()) console.log(r.detail);
    console.log();
  }
  console.log(`=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail > 0 ? 1 : 0);
}

// 全局超时保险
const timer = setTimeout(() => process.exit(2), GLOBAL_TIMEOUT_MS);
main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => clearTimeout(timer));
