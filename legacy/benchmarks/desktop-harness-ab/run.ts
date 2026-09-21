import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readDesktopMonitor,
  runDesktopNext,
} from "../../apps/desktop/agent-host/paw-next.js";
import {
  type LanguageModel,
  type ModelCompleteOptions,
  createDefaultLanguageModel,
} from "../../packages/models/src/index.js";
import { tasks } from "./tasks.js";
import { readVerification } from "./verification-result.js";

const repo = path.resolve(import.meta.dir, "../../..");
const args = process.argv.slice(2);
const budget = {
  wallMs: 720000,
  calls: 40,
  reportedTokens: 160000,
  outputPolicy: "native-default-32000-with-native-recovery",
  maxSteps: 32,
};
const write = (file: string, value: unknown) =>
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const readLines = (file: string) =>
  fs.existsSync(file)
    ? fs
        .readFileSync(file, "utf8")
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .map((x) => JSON.parse(x))
    : [];

if (args[0] === "--worker") {
  const [, caseDir, kind, mode, intent, interrupt] = args;
  const task = tasks[kind as keyof typeof tasks];
  const manifest = JSON.parse(
    fs.readFileSync(path.join(caseDir, "manifest.json"), "utf8"),
  );
  const root: string = manifest.workspaceRoot;
  const callFile = path.join(caseDir, "calls.jsonl");
  const append = (name: string, data: unknown) =>
    fs.appendFileSync(path.join(caseDir, name), `${JSON.stringify(data)}\n`);
  const base = createDefaultLanguageModel(repo);
  if (base.runtimeProfile?.model.toLowerCase() !== "glm-5.3-flash")
    throw new Error(
      "Select GLM-5.3-Flash in the Paw settings before this benchmark",
    );
  const controller = new AbortController();
  const remaining = Math.max(
    1,
    budget.wallMs - (Date.now() - manifest.startedAt),
  );
  const timer = setTimeout(
    () => controller.abort(new Error("Benchmark wall budget exhausted")),
    remaining,
  );
  let calls = readLines(callFile).filter((x) => x.type === "start").length;
  let tokens = readLines(callFile)
    .filter((x) => x.type === "usage")
    .reduce(
      (s, x) =>
        s +
        (x.usage.totalTokens ??
          (x.usage.promptTokens ?? 0) + (x.usage.completionTokens ?? 0)),
      0,
    );
  const prepare = (
    messages: readonly unknown[],
    options?: ModelCompleteOptions,
  ) => {
    controller.signal.throwIfAborted();
    if (calls >= budget.calls || tokens >= budget.reportedTokens) {
      controller.abort(new Error("Benchmark call/token threshold reached"));
      controller.signal.throwIfAborted();
    }
    const id = ++calls;
    append("calls.jsonl", {
      type: "start",
      id,
      at: Date.now(),
      messageChars: JSON.stringify(messages).length,
    });
    return {
      id,
      opts: {
        ...options,
        signal: options?.signal
          ? AbortSignal.any([options.signal, controller.signal])
          : controller.signal,
      },
    };
  };
  const usage = (id: number, value: any) => {
    if (value) {
      tokens +=
        value.totalTokens ??
        (value.promptTokens ?? 0) + (value.completionTokens ?? 0);
      append("calls.jsonl", {
        type: "usage",
        id,
        at: Date.now(),
        usage: value,
      });
    }
  };
  const model: LanguageModel = {
    label: base.label,
    capabilities: base.capabilities,
    runtimeProfile: base.runtimeProfile,
    async complete(messages, options) {
      const { id, opts } = prepare(messages, options);
      try {
        const r = await base.complete(messages, opts);
        usage(id, r.usage);
        append("calls.jsonl", {
          type: "finish",
          id,
          at: Date.now(),
          reason: r.finishReason,
        });
        return r;
      } catch (e) {
        append("calls.jsonl", {
          type: "error",
          id,
          at: Date.now(),
          error: String(e).slice(0, 400),
        });
        throw e;
      }
    },
    ...(base.completeStream
      ? {
          async *completeStream(messages: any, options: any) {
            const { id, opts } = prepare(messages, options);
            try {
              for await (const c of base.completeStream!(messages, opts)) {
                if (c.type === "done") {
                  usage(id, c.usage);
                  append("calls.jsonl", {
                    type: "finish",
                    id,
                    at: Date.now(),
                    reason: c.finishReason,
                  });
                }
                yield c;
              }
            } catch (e) {
              append("calls.jsonl", {
                type: "error",
                id,
                at: Date.now(),
                error: String(e).slice(0, 400),
              });
              throw e;
            }
          },
        }
      : {}),
  };
  write(path.join(caseDir, "model.json"), {
    label: model.label,
    runtimeProfile: model.runtimeProfile,
    budget,
    transport: model.completeStream ? "stream" : "complete",
  });
  try {
    const result = await runDesktopNext(task.goal, {
      workspaceRoot: root,
      conversationId: "benchmark",
      taskMode: mode as "standard" | "long",
      intent: intent as "continue" | "recover",
      model,
      settings: {},
      memoryEnabled: false,
      maxSteps: budget.maxSteps,
      abortSignal: controller.signal,
      resolveToolApproval: async () => true,
      onEvent(envelope) {
        const event: any = envelope.event;
        const e = event.originalEvent ?? event;
        if (
          [
            "tool.call",
            "tool.result",
            "run.completed",
            "run.failed",
            "monitor.snapshot",
          ].includes(e.type)
        )
          append("events.jsonl", {
            at: Date.now(),
            type: event.type,
            tool: e.tool,
            committedChanges: e.fileChanges ?? [],
            ok: e.ok,
            summary: e.summary,
            callId: e.callId,
            tasks: e.snapshot?.tasks?.map((t: any) => ({
              id: t.id,
              status: t.status,
              audit: t.audit?.status,
            })),
          });
        if (
          interrupt === "yes" &&
          e.type === "tool.result" &&
          e.ok &&
          (e.fileChanges?.length ||
            ["src/queue.js", "src/store.js", "src/cli.js"].some((file) =>
              fs.existsSync(path.join(root, file)),
            )) &&
          !fs.existsSync(path.join(caseDir, "interrupted.json"))
        ) {
          write(path.join(caseDir, "interrupted.json"), {
            at: Date.now(),
            tool: e.tool,
            files: ["src/queue.js", "src/store.js", "src/cli.js"]
              .filter((file) => fs.existsSync(path.join(root, file)))
              .map((file) => ({
                path: file,
                hash: hash(fs.readFileSync(path.join(root, file), "utf8")),
              })),
            trigger:
              "first successful settled tool with a product file present",
          });
          process.exit(91);
        }
      },
    });
    write(path.join(caseDir, "result.json"), {
      ...result,
      finishedAt: Date.now(),
      monitor: readDesktopMonitor(root, "benchmark"),
    });
  } catch (e) {
    write(path.join(caseDir, "result.json"), {
      ok: false,
      error: String(e),
      finishedAt: Date.now(),
      monitor: readDesktopMonitor(root, "benchmark"),
    });
  } finally {
    clearTimeout(timer);
  }
  process.exit(0);
}

const output = path.resolve(
  args[0] ??
    path.join(
      repo,
      "legacy/benchmarks/desktop-harness-ab/.runs",
      new Date().toISOString().replace(/[:.]/g, "-"),
    ),
);
fs.mkdirSync(output, { recursive: true });
const specs = [
  { kind: "queue", mode: "standard" },
  { kind: "queue", mode: "long" },
  { kind: "ledger", mode: "long" },
  { kind: "ledger", mode: "standard" },
  { kind: "queue", mode: "long", recovery: true },
  { kind: "queue", mode: "standard", recovery: true },
];
write(path.join(output, "protocol.json"), {
  version: 3,
  createdAt: new Date().toISOString(),
  budget,
  specs,
  comparison:
    "same current desktop runtime, standard versus long; not historical checkout",
  memory: false,
  autoRouting: false,
  replicates: 1,
  notes: [
    "All root/worker/auditor calls share one usage wrapper and thresholds",
    "Provider token threshold checked between calls; concurrent requests may overshoot",
    "Recovery injects process death after first committed file change, waits 95s for lease expiry; recovery shares the original case budget",
    "External deterministic verifier never supplies answers to agents",
    "No statistical significance claim from this pilot",
  ],
  sourceDiffHash: hash(
    spawnSync("git", ["diff", "--no-ext-diff"], {
      cwd: repo,
      encoding: "utf8",
      maxBuffer: 8e6,
    }).stdout ?? "",
  ),
});
const summaries: any[] = [];
for (const spec of specs) {
  const name = `${spec.kind}-${spec.mode}${spec.recovery ? "-recovery" : ""}`;
  const dir = path.join(output, name);
  if (fs.existsSync(path.join(dir, "summary.json"))) {
    summaries.push(
      JSON.parse(fs.readFileSync(path.join(dir, "summary.json"), "utf8")),
    );
    continue;
  }
  fs.mkdirSync(dir, { recursive: true });
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), `paw-desktop-ab-${name}-`),
  );
  const task = tasks[spec.kind as keyof typeof tasks];
  for (const [file, content] of Object.entries(task.seed)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
  fs.writeFileSync(path.join(root, "REQUIREMENTS.md"), task.goal);
  fs.writeFileSync(path.join(root, ".gitignore"), ".paw/\n");
  const git = (...arguments_: string[]) => {
    const result = spawnSync("git", arguments_, {
      cwd: root,
      encoding: "utf8",
    });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  git("init", "-q");
  git("add", ".");
  git(
    "-c",
    "user.name=Paw Benchmark",
    "-c",
    "user.email=benchmark@localhost",
    "commit",
    "-q",
    "-m",
    "test: seed isolated benchmark workspace",
  );
  if (
    fs.realpathSync(git("rev-parse", "--show-toplevel")) !==
    fs.realpathSync(root)
  )
    throw new Error("Benchmark Git root must equal its isolated workspace");
  const startedAt = Date.now();
  write(path.join(dir, "manifest.json"), {
    name,
    ...spec,
    startedAt,
    workspaceRoot: root,
    goalHash: hash(task.goal),
    budget,
  });
  console.log(
    JSON.stringify({ event: "case.start", name, at: new Date().toISOString() }),
  );
  const runWorker = async (intent: string, interrupt: boolean) => {
    const out = fs.openSync(path.join(dir, `${intent}.stdout.log`), "a");
    const err = fs.openSync(path.join(dir, `${intent}.stderr.log`), "a");
    const proc = Bun.spawn(
      [
        process.execPath,
        import.meta.filename,
        "--worker",
        dir,
        spec.kind,
        spec.mode,
        intent,
        interrupt ? "yes" : "no",
      ],
      { cwd: repo, stdout: out, stderr: err, env: { ...process.env } },
    );
    const timer = setTimeout(
      () => proc.kill(),
      Math.max(1000, budget.wallMs + 10000 - (Date.now() - startedAt)),
    );
    const code = await proc.exited;
    clearTimeout(timer);
    fs.closeSync(out);
    fs.closeSync(err);
    return code;
  };
  let code = await runWorker("continue", !!spec.recovery);
  if (code === 91 && spec.recovery) {
    console.log(JSON.stringify({ event: "case.interrupted", name }));
    await new Promise((r) => setTimeout(r, 95000));
    code = await runWorker("recover", false);
  }
  const endedAt = Date.now();
  const verified = spawnSync(
    "node",
    [path.join(import.meta.dir, "verify.mjs"), spec.kind, root],
    { cwd: repo, encoding: "utf8", timeout: 30000, maxBuffer: 2e6 },
  );
  const verification = readVerification(verified);
  write(path.join(dir, "verification.json"), verification);
  const result = fs.existsSync(path.join(dir, "result.json"))
    ? JSON.parse(fs.readFileSync(path.join(dir, "result.json"), "utf8"))
    : { error: `worker exit ${code}` };
  const rows = readLines(path.join(dir, "calls.jsonl"));
  const usages = rows.filter((x) => x.type === "usage");
  const sum = (key: string) =>
    usages.reduce((s, x) => s + (x.usage[key] ?? 0), 0);
  let parsed: any;
  try {
    parsed = JSON.parse(result.text);
  } catch {}
  const summary = {
    name,
    kind: spec.kind,
    mode: spec.mode,
    recovery: !!spec.recovery,
    interruptionTriggered: fs.existsSync(path.join(dir, "interrupted.json")),
    seconds: (endedAt - startedAt) / 1000,
    calls: rows.filter((x) => x.type === "start").length,
    usageReports: usages.length,
    promptTokens: sum("promptTokens"),
    completionTokens: sum("completionTokens"),
    cachedPromptTokens: sum("cachedPromptTokens"),
    totalTokens:
      sum("totalTokens") || sum("promptTokens") + sum("completionTokens"),
    passed: verification.passed,
    total: verification.total,
    allPassed:
      verification.measured && verification.passed === verification.total,
    verificationMeasured: verification.measured,
    runtimeStatus: parsed?.status,
    acceptance: parsed?.acceptance,
    error: result.error,
    goalUnchanged:
      hash(fs.readFileSync(path.join(root, "REQUIREMENTS.md"), "utf8")) ===
      hash(task.goal),
  };
  write(path.join(dir, "summary.json"), summary);
  summaries.push(summary);
  write(
    path.join(output, "summary.json"),
    summaries.map((row) =>
      JSON.parse(
        fs.readFileSync(path.join(output, row.name, "summary.json"), "utf8"),
      ),
    ),
  );
  console.log(JSON.stringify({ event: "case.done", ...summary }));
}
console.log(JSON.stringify({ event: "benchmark.done", output }));
