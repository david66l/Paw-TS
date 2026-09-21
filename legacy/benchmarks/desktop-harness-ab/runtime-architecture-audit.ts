// Offline characterization probes. These assertions document defects, not desired behavior.
// Historical v7 characterization only. Current acceptance: runtimeHardening.test.ts,
// request-supervision.test.ts, progress-advisor tests, and RUNTIME-V8-HARDENING.md.
// No provider requests or generated shell commands are executed.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { runDesktopNext } from "../../apps/desktop/agent-host/paw-next.js";
import { DesktopNextEvents } from "../../apps/desktop/agent-host/paw-next-events.js";
import { createAgentLoopModelAdapter } from "../../packages/models/src/agent-loop-adapter.js";
import type { LanguageModel } from "../../packages/models/src/language-model.js";
import type {
  ChatMessage,
  ModelStreamChunk,
} from "../../packages/models/src/types.js";
import type {
  InputFactV1,
  JsonValue,
} from "../../packages/protocol/src/index.js";
import {
  projectProgressAdviceV1,
  projectProgressAdviceTimelineV1,
} from "../../packages/progress-advisor/src/index.js";

const out = path.resolve(
  process.argv[2] ??
    "legacy/benchmarks/desktop-harness-ab/.runs/2026-09-07-runtime-architecture-audit",
);
if (fs.existsSync(out)) throw new Error("Fresh output required");
fs.mkdirSync(out, { recursive: true });
const cases: Record<string, unknown>[] = [];
const record = (name: string, evidence: unknown) => {
  const item = { name, evidence };
  cases.push(item);
  console.log(JSON.stringify(item));
};
const snapshot = (facts: InputFactV1[]) => ({
  entries: facts.map((fact, i) => ({ seq: i + 1, fact })),
  latestInputSeq: facts.length,
  tailSeq: facts.length,
});
function toolTurn(
  facts: InputFactV1[],
  turn: number,
  tool: string,
  args: JsonValue,
  payload?: JsonValue,
) {
  const callId = `call-${turn}`,
    modelCallId = `model-${turn}`;
  facts.push(
    {
      type: "model.settled",
      modelCallId,
      turn,
      status: "completed",
      hasToolCalls: true,
      hasVisibleOutput: false,
    },
    {
      type: "tool.call_observed",
      callId,
      modelCallId,
      turn,
      tool,
      args,
      order: 0,
    },
    {
      type: "tool.settled",
      callId,
      status: "completed",
      observation: {
        schemaVersion: "paw.tool-observation.v1",
        isError: false,
        summary: `${tool} completed`,
        ...(payload === undefined
          ? {}
          : {
              payload: { kind: "inline", value: payload, hash: "audit-inline" },
            }),
      },
    },
  );
}
const budget = { maxModelTurns: 10, maxTotalModelTurns: 10 };

// A repair reminder can preempt both exact closeout thresholds. Dedup then drops it.
{
  const facts: InputFactV1[] = [];
  toolTurn(facts, 1, "workspace_write_file", { path: "a.js" });
  for (let t = 2; t <= 8; t++)
    toolTurn(
      facts,
      t,
      "workspace_run_shell",
      { command: `npm test | tail -${t}` },
      { exit_code: 0 },
    );
  const advice = projectProgressAdviceTimelineV1(snapshot(facts), budget);
  assert.equal(
    advice.filter((x) => x.kind === "convergence_checkpoint").length,
    0,
  );
  assert.equal(
    advice.filter((x) => x.kind === "verification_repair").length,
    1,
  );
  record("closeout_shadowed_by_deduplicated_repair", {
    adviceKinds: advice.map((x) => x.kind),
    remaining: 2,
  });
}
// A successful shell write after a direct test does not invalidate the advice's revision.
{
  const facts: InputFactV1[] = [];
  toolTurn(facts, 1, "workspace_write_file", { path: "a.js" });
  toolTurn(
    facts,
    2,
    "workspace_run_shell",
    { command: "npm test" },
    { exit_code: 0 },
  );
  toolTurn(
    facts,
    3,
    "workspace_run_shell",
    { command: "node -e \"require('fs').writeFileSync('a.js','broken')\"" },
    { exit_code: 0 },
  );
  for (let t = 4; t <= 6; t++)
    toolTurn(facts, t, "workspace_read_file", { path: `file-${t}.js` });
  const advice = projectProgressAdviceV1(snapshot(facts), budget);
  assert.equal(advice?.kind, "convergence_checkpoint");
  assert.ok(advice.message.includes("latest check passed"));
  record("shell_mutation_does_not_invalidate_previous_check", {
    message: advice.message,
    actualShellExecuted: false,
  });
}
// Retry classification is absent at the current new-runtime model port.
for (const status of [429, 503]) {
  let calls = 0;
  const model: LanguageModel = {
    label: "audit-http",
    async complete() {
      calls++;
      throw Object.assign(new Error(`HTTP ${status}`), { status });
    },
  };
  const settlement = await createAgentLoopModelAdapter(
    model,
    "complete",
  ).execute(
    { messages: [{ role: "user", content: "task" }] },
    { signal: new AbortController().signal, onStreamEvent() {} },
  );
  assert.equal(settlement.status, "unknown");
  assert.equal(calls, 1);
  record("transient_error_collapses_to_unknown", { status, calls, settlement });
}
// UI/event callback is awaited in-band and its exception changes model settlement.
{
  let yielded = 0;
  const model: LanguageModel = {
    label: "audit-stream",
    async complete() {
      throw new Error("unused");
    },
    async *completeStream() {
      yielded++;
      yield { type: "thinking", delta: "x" } as ModelStreamChunk;
      yielded++;
      yield { type: "text", delta: "ready" } as ModelStreamChunk;
      yield { type: "done", finishReason: "stop" } as ModelStreamChunk;
    },
  };
  const settlement = await createAgentLoopModelAdapter(model, "stream").execute(
    { messages: [{ role: "user", content: "task" }] },
    {
      signal: new AbortController().signal,
      onStreamEvent() {
        throw new Error("presentation sink failed");
      },
    },
  );
  assert.equal(settlement.status, "unknown");
  assert.equal(yielded, 1);
  record("presentation_sink_can_interrupt_inference", { yielded, settlement });
}
// The port also waits for a sink that does not reject, until that sink is released.
{
  let release!: () => void;
  let entered!: () => void;
  const barrier = new Promise<void>((r) => (release = r)),
    seen = new Promise<void>((r) => (entered = r));
  let advanced = false,
    settled = false;
  const model: LanguageModel = {
    label: "audit-slow-sink",
    async complete() {
      throw new Error("unused");
    },
    async *completeStream() {
      yield { type: "thinking", delta: "x" } as ModelStreamChunk;
      advanced = true;
      yield { type: "done", finishReason: "stop" } as ModelStreamChunk;
    },
  };
  const running = createAgentLoopModelAdapter(model, "stream")
    .execute(
      { messages: [{ role: "user", content: "task" }] },
      {
        signal: new AbortController().signal,
        async onStreamEvent(chunk) {
          if (chunk.type === "thinking") {
            entered();
            await barrier;
          }
        },
      },
    )
    .then((r) => {
      settled = true;
      return r;
    });
  await seen;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(advanced, false);
  assert.equal(settled, false);
  release();
  assert.equal((await running).status, "success");
  record("presentation_sink_backpressure", {
    advancedBeforeRelease: false,
    settledAfterRelease: true,
  });
}

// Real desktop V3 composition, fake model, no tools: verifies project-guidance injection
// and the distinction between natural model stop and fulfilling a user action.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "paw-runtime-audit-"));
fs.mkdirSync(path.join(root, ".paw"));
fs.writeFileSync(
  path.join(root, "PAW.md"),
  "PROJECT_RULE_MARKER_ROOT: use the repository conventions.",
);
fs.writeFileSync(
  path.join(root, ".paw", "CLAUDE.md"),
  "PROJECT_RULE_MARKER_COMMITTED: use the existing test command.",
);
fs.writeFileSync(
  path.join(root, ".paw", "CLAUDE.local.md"),
  "PROJECT_RULE_MARKER_LOCAL: preserve user files.",
);
const captured: ChatMessage[][] = [];
const model: LanguageModel = {
  label: "openai:architecture-audit",
  capabilities: { contextWindow: 32000, maxOutputTokens: 4096 },
  runtimeProfile: {
    protocol: "openai-compatible",
    model: "architecture-audit",
    baseUrl: "https://audit.invalid/v1",
  },
  async complete(messages) {
    captured.push([...messages]);
    return {
      text: "I will now create the requested file.",
      nativeAssistantContent: "I will now create the requested file.",
      finishReason: "stop",
    };
  },
};
const result = await runDesktopNext(
  "Create src/main.js that exports the number 42.",
  {
    workspaceRoot: root,
    conversationId: "architecture-audit",
    model,
    taskMode: "standard",
    settings: {},
    memoryEnabled: false,
    environmentAudit: false,
    maxSteps: 8,
    resolveToolApproval: async () => false,
    onEvent() {},
  },
);
const requestText = JSON.stringify(captured);
assert.equal(captured.length, 1);
assert.equal(requestText.includes("PROJECT_RULE_MARKER_"), false);
record("desktop_project_guidance_not_injected", {
  workspaceRoot: root,
  requests: captured.length,
  markersPresent: false,
});
assert.equal(JSON.parse(result.text).status, "completed");
assert.equal(fs.existsSync(path.join(root, "src/main.js")), false);
record("promise_only_response_can_complete_action_task", {
  result,
  fileExists: false,
  environmentAudit: false,
});
const defaultAuditResult = await runDesktopNext(
  "Create src/main.js that exports the number 42.",
  {
    workspaceRoot: root,
    conversationId: "architecture-audit-default",
    model,
    taskMode: "standard",
    settings: {},
    memoryEnabled: false,
    maxSteps: 8,
    resolveToolApproval: async () => false,
    onEvent() {},
  },
);
assert.equal(JSON.parse(defaultAuditResult.text).status, "completed");
assert.equal(JSON.parse(defaultAuditResult.text).acceptance, "not_required");
assert.equal(fs.existsSync(path.join(root, "src/main.js")), false);
record("default_environment_audit_also_skips_promise_only_action", {
  result: defaultAuditResult,
  fileExists: false,
});
{
  let emittedChars = 0,
    emittedEvents = 0;
  const events = new DesktopNextEvents(
    "audit-projection",
    (envelope) => {
      const e = envelope.event;
      if (e.type === "model.thinking") {
        emittedChars += e.text.length;
        emittedEvents++;
      }
    },
    0,
    root,
  );
  for (let i = 0; i < 1000; i++)
    events.stream({ type: "thinking", delta: "abcd" });
  assert.equal(emittedChars, 2002000);
  record("thinking_ui_reemits_full_prefix", {
    inputChars: 4000,
    emittedChars,
    emittedEvents,
    amplification: emittedChars / 4000,
  });
}
fs.writeFileSync(
  path.join(out, "desktop-requests.json"),
  JSON.stringify(captured, null, 2),
);
const sources = [
  "apps/desktop/agent-host/paw-next.ts",
  "apps/desktop/agent-host/paw-next-profile.ts",
  "apps/desktop/agent-host/agent-system-prompt.ts",
  "packages/paw-next/src/composition.ts",
  "packages/agent-loop/src/agent-loop.ts",
  "packages/agent-loop/src/interactive-control.ts",
  "packages/progress-advisor/src/projector.ts",
  "packages/models/src/agent-loop-adapter.ts",
  "legacy/benchmarks/desktop-harness-ab/runtime-architecture-audit.ts",
];
fs.writeFileSync(
  path.join(out, "report.json"),
  JSON.stringify(
    {
      kind: "offline_characterization_not_success_eval",
      cases,
      sourceHashes: Object.fromEntries(
        sources.map((file) => [
          file,
          createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
        ]),
      ),
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({ event: "audit.done", cases: cases.length, output: out }),
);
