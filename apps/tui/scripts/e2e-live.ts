#!/usr/bin/env bun
/**
 * Live E2E for TUI (same path as App.tsx) + UI formatting checks.
 * Usage: cd apps/tui && bun run e2e:live
 */

import fs from "node:fs";
import path from "node:path";
import type { RunEventEnvelope } from "@paw/core";
import { defaultSettingsPath, loadPawSettingsLocal } from "@paw/settings";
import { submitUserLine } from "../src/commands.js";
import {
  formatBottomBar,
  formatContextBar,
  formatEventForScrollback,
  formatHudText,
} from "../src/footer-state.js";
import {
  createPersistentSession,
  createRunSessionController,
} from "../src/run-session-controller.js";

const WORKSPACE = path.resolve(import.meta.dir, "../../..");
const GLOBAL_TIMEOUT_MS = 900_000;
const E2E_TMP = path.join(WORKSPACE, "e2e-tmp");

interface ScenarioResult {
  readonly name: string;
  readonly ok: boolean;
  readonly ms: number;
  readonly detail: string;
  readonly errors: readonly string[];
}

function loadSettings() {
  return loadPawSettingsLocal(defaultSettingsPath(WORKSPACE));
}

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

function collectEvents(on: (e: RunEventEnvelope) => void) {
  const events: RunEventEnvelope[] = [];
  const handler = (e: RunEventEnvelope) => {
    events.push(e);
    on(e);
  };
  return { events, handler };
}

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
      const actualPct = Number.parseInt(bar.split(" ").pop()?.replace("%", "") ?? "", 10);
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
      if (!bottom.includes("ctx")) issues.push("bottom bar missing ctx estimate");
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
    if (ev.type === "tool.call" && scroll && !scroll.match(/[📖✏️🔍⚙️🔧🤖🛠️🌐📋🔀💡📓📊]/)) {
      issues.push(`tool.call missing icon: ${scroll}`);
    }
  }
  return issues;
}

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

  const ready = await providerReady();
  if (!ready.ok) {
    console.error(`FAIL: ${ready.reason}`);
    process.exit(1);
  }
  console.log(`Provider: ${ready.reason}\n`);

  const sessionProbe = createPersistentSession({
    workspaceRoot: WORKSPACE,
    onEvent: () => {},
  });
  const ctxWindow = sessionProbe.contextWindow;
  sessionProbe.dispose();
  console.log(`Context window: ${ctxWindow}\n`);

  const results: ScenarioResult[] = [];

  results.push(
    await runScenario("boundary: empty input", async ({ sessionCtrl, session }) => {
      const pushLog: string[] = [];
      const { handler } = collectEvents(() => {});
      await submitLine("   ", session, sessionCtrl, handler, pushLog);
      if (pushLog.length > 0) throw new Error("empty input should be no-op");
    }),
  );

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

  results.push(
    await runScenario("UI: /fs-read", async ({ sessionCtrl, session }) => {
      const pushLog: string[] = [];
      const { handler } = collectEvents(() => {});
      await submitLine("/fs-read package.json", session, sessionCtrl, handler, pushLog);
      if (!pushLog.join("\n").includes("package.json")) {
        throw new Error("fs-read missing content");
      }
    }),
  );

  results.push(
    await runScenario("UI: /fs-list", async ({ sessionCtrl, session }) => {
      const pushLog: string[] = [];
      const { handler } = collectEvents(() => {});
      await submitLine("/fs-list packages", session, sessionCtrl, handler, pushLog);
      if (!pushLog.join("\n").includes("packages")) {
        throw new Error("fs-list missing packages dir");
      }
    }),
  );

  results.push(
    await runScenario("agent: chat + stream", async ({ sessionCtrl, session, events, logs }) => {
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
    }),
  );

  results.push(
    await runScenario("agent: list_dir", async ({ sessionCtrl, session, events }) => {
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
    }),
  );

  results.push(
    await runScenario("agent: read_file", async ({ sessionCtrl, session, events }) => {
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
    }),
  );

  const writeRel = path.join("e2e-tmp", `write-${Date.now()}.txt`);
  const writeAbs = path.join(WORKSPACE, writeRel);
  const marker = `e2e-marker-${Date.now()}`;

  results.push(
    await runScenario("agent: write + read", async ({ sessionCtrl, session, events, logs }) => {
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
        throw new Error(`file content missing marker: ${content.slice(0, 80)}`);
      }
      if (!events.some((e) => e.event.type === "run.completed")) {
        throw new Error("run did not complete");
      }
    }),
  );

  results.push(
    await runScenario("agent: read failure boundary", async ({ sessionCtrl, session, events }) => {
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
    }),
  );

  results.push(
    await runScenario("agent: multi-turn context + cost", async ({ sessionCtrl, session, events, logs }) => {
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
    }),
  );

  console.log("--- Results ---\n");
  let pass = 0;
  let fail = 0;
  for (const r of results) {
    console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}  (${(r.ms / 1000).toFixed(1)}s)`);
    if (r.ok) pass++;
    else fail++;
    for (const err of r.errors) console.log(`       error: ${err}`);
    if (r.detail.trim()) console.log(r.detail);
    console.log();
  }
  console.log(`=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail > 0 ? 1 : 0);
}

const timer = setTimeout(() => process.exit(2), GLOBAL_TIMEOUT_MS);
main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => clearTimeout(timer));
