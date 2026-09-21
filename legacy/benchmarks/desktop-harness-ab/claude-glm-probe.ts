// Run Claude Code with the exact frozen Paw task. Credentials remain on the host.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  defaultSettingsPath,
  loadPawSettingsLocal,
  resolveApiKey,
} from "../../packages/settings/src/index.js";
const [pawDir, outArg, mode = "queue"] = process.argv.slice(2);
if (!pawDir || !outArg || !["queue", "smoke", "workflow"].includes(mode))
  throw new Error("Usage: <paw-run> <fresh-output> [queue|smoke|workflow]");
const out = path.resolve(outArg);
if (fs.existsSync(out)) throw new Error("Fresh output required");
const protocol = JSON.parse(
  fs.readFileSync(path.join(pawDir, "protocol.json"), "utf8"),
);
if (protocol.runtimeProfile.model !== "glm-5.3-flash" || !protocol.isolation.ok)
  throw new Error("Expected isolated GLM run");
const settings = loadPawSettingsLocal(defaultSettingsPath(process.cwd()));
const preset = settings.models?.[settings.provider ?? "glm"];
const key = preset?.apiKey || resolveApiKey(settings, "glm");
if (!key) throw new Error("Missing local GLM credential");
if (new URL(protocol.runtimeProfile.baseUrl).hostname !== "open.bigmodel.cn")
  throw new Error("Review endpoint mapping for this provider");
const endpoint = "https://open.bigmodel.cn/api/anthropic";
const image = spawnSync(
  "docker",
  ["image", "inspect", "paw-claude-bench:2.1.224", "--format", "{{.Id}}"],
  { encoding: "utf8" },
);
if (image.status !== 0) throw new Error("Build benchmark image first");
fs.mkdirSync(out, { recursive: true });
const root = fs.mkdtempSync(path.join(os.tmpdir(), "paw-claude-glm-"));
const spool = path.join(out, "relay");
fs.mkdirSync(spool);
fs.mkdirSync(path.join(root, ".paw"));
fs.writeFileSync(
  path.join(root, ".paw/settings.local.json"),
  JSON.stringify({
    sandbox: {
      mode: "strict",
      network: "deny",
      runtime: "docker",
      image: protocol.isolation.imageId,
      memory_mb: 1024,
      cpus: 2,
      container_workspace_root: "/workspace",
      command_shell: "sh",
      pull_policy: "never",
    },
  }),
);
const goal =
  mode !== "smoke"
    ? protocol.goal
    : "Create probe.txt containing exactly GLM_OK followed by a newline, read it back, then finish. Work only in /workspace.";
fs.writeFileSync(path.join(root, "REQUIREMENTS.md"), goal);
fs.writeFileSync(path.join(root, ".gitignore"), ".paw/\n");
for (const args of [
  ["init", "-q"],
  ["add", "."],
  [
    "-c",
    "user.name=Paw Benchmark",
    "-c",
    "user.email=benchmark@localhost",
    "commit",
    "-q",
    "-m",
    "test: seed isolated tool probe",
  ],
]) {
  if (spawnSync("git", args, { cwd: root }).status !== 0)
    throw new Error("Git seed failed");
}
const append = (file: string, value: unknown) =>
  fs.appendFileSync(path.join(out, file), JSON.stringify(value) + "\n");
const write = (file: string, value: unknown) =>
  fs.writeFileSync(path.join(out, file), JSON.stringify(value, null, 2));
const startedAt = Date.now();
const workflow = mode === "workflow";
if (workflow && (protocol.taskVariant !== "workflow" || protocol.runtimeProfile.reasoningEffort !== "high")) throw new Error("Expected frozen workflow high protocol");
const wallMs = workflow ? protocol.budget.wallMs : mode === "queue" ? 720000 : 90000;
const maxRequests = workflow ? protocol.budget.calls : 40;
const maxTurns = workflow ? protocol.budget.maxSteps : 32;
const effort = workflow ? "high" : "max";
const runController = new AbortController();
const handled = new Set<string>();
let requests = 0;
const active = new Set<Promise<void>>();
async function forward(id: string) {
  const prefix = path.join(spool, id);
  const controller = new AbortController();
  const cancel = setInterval(() => {
    if (fs.existsSync(prefix + ".cancel")) controller.abort();
  }, 50);
  try {
    const req = JSON.parse(fs.readFileSync(prefix + ".request", "utf8"));
    const route = String(req.url).split("?")[0];
    if (
      req.method !== "POST" ||
      !["/v1/messages", "/v1/messages/count_tokens"].includes(route)
    ) {
      fs.writeFileSync(
        prefix + ".body",
        JSON.stringify({
          error: {
            type: "not_found_error",
            message: "Only model requests are available",
          },
        }),
      );
      fs.writeFileSync(
        prefix + ".meta",
        JSON.stringify({ status: 404, contentType: "application/json" }),
      );
      return;
    }
    const body = JSON.parse(req.body);
    if (body.model !== "glm-5.3-flash") throw new Error("Unexpected model");
    if (workflow && route === "/v1/messages" && body.tools?.length && (body.output_config?.effort !== effort || body.max_tokens !== 128000)) throw new Error("Claude reasoning configuration mismatch");
    if (route === "/v1/messages") {
      if (requests >= maxRequests) throw new Error("Request budget exhausted");
      requests++;
    }
    append("wire.jsonl", {
      type: "request",
      id,
      at: Date.now(),
      route,
      model: body.model,
      max_tokens: body.max_tokens,
      thinking: body.thinking,
      output_config: body.output_config,
    });
    write(`request-${id}.json`, body);
    const response =
      process.env.PAW_CLAUDE_RELAY_CHECK === "1"
        ? new Response(
            [
              {
                type: "message_start",
                message: {
                  id: "msg_transport_check",
                  type: "message",
                  role: "assistant",
                  model: "glm-5.3-flash",
                  content: [],
                  stop_reason: null,
                  usage: { input_tokens: 1, output_tokens: 0 },
                },
              },
              {
                type: "content_block_start",
                index: 0,
                content_block: { type: "text", text: "" },
              },
              {
                type: "content_block_delta",
                index: 0,
                delta: { type: "text_delta", text: "TRANSPORT_CHECK_ONLY" },
              },
              { type: "content_block_stop", index: 0 },
              {
                type: "message_delta",
                delta: { stop_reason: "end_turn", stop_sequence: null },
                usage: { output_tokens: 1 },
              },
              { type: "message_stop" },
            ]
              .map(
                (event) =>
                  `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
              )
              .join(""),
            { headers: { "content-type": "text/event-stream" } },
          )
        : await fetch(endpoint + req.url, {
            method: "POST",
            headers: {
              ...req.headers,
              "x-api-key": key,
              Authorization: `Bearer ${key}`,
            },
            body: req.body,
            signal: AbortSignal.any([runController.signal, controller.signal]),
          });
    append("wire.jsonl", {
      type: "headers",
      id,
      at: Date.now(),
      status: response.status,
    });
    fs.writeFileSync(prefix + ".body", "");
    fs.writeFileSync(
      prefix + ".meta",
      JSON.stringify({
        status: response.status,
        contentType: response.headers.get("content-type") ?? "application/json",
      }),
    );
    if (response.body)
      for await (const chunk of response.body) {
        fs.appendFileSync(prefix + ".body", chunk);
        append("wire.jsonl", {
          type: "chunk",
          id,
          at: Date.now(),
          bytes: chunk.byteLength,
        });
      }
    append("wire.jsonl", { type: "end", id, at: Date.now() });
  } catch (error) {
    append("wire.jsonl", {
      type: "error",
      id,
      at: Date.now(),
      name: error instanceof Error ? error.name : "Error",
    });
    if (!fs.existsSync(prefix + ".meta")) {
      fs.writeFileSync(
        prefix + ".body",
        JSON.stringify({
          error: {
            type: "api_error",
            message: "Benchmark request failed or budget ended",
          },
        }),
      );
      fs.writeFileSync(
        prefix + ".meta",
        JSON.stringify({ status: 502, contentType: "application/json" }),
      );
    }
  } finally {
    clearInterval(cancel);
    fs.writeFileSync(prefix + ".done", "");
  }
}
const poll = setInterval(() => {
  for (const file of fs.readdirSync(spool)) {
    if (!file.endsWith(".request") || handled.has(file)) continue;
    handled.add(file);
    const task = forward(file.slice(0, -8));
    active.add(task);
    void task.finally(() => active.delete(task));
  }
}, 25);
const name = "paw-claude-bench-" + randomUUID().slice(0, 8);
const cliArgs = [
  "-p",
  goal,
  "--model",
  "glm-5.3-flash",
  "--effort",
  effort,
  "--output-format",
  "stream-json",
  "--verbose",
  "--include-partial-messages",
  "--no-session-persistence",
  "--setting-sources",
  "",
  "--strict-mcp-config",
  "--mcp-config",
  '{"mcpServers":{}}',
  "--disable-slash-commands",
  "--tools",
  workflow ? "Bash,Read,Write,Edit,Glob,Grep,TodoWrite,TaskCreate,TaskGet,TaskList,TaskUpdate" : "Bash,Read,Write,Edit,Glob,Grep",
  "--dangerously-skip-permissions",
  "--max-turns",
  String(maxTurns),
];
const args = [
  "run",
  "--rm",
  "--name",
  name,
  "--pull",
  "never",
  "--network",
  "none",
  "--read-only",
  "--cap-drop",
  "ALL",
  "--security-opt",
  "no-new-privileges",
  "--memory",
  "1024m",
  "--cpus",
  "2",
  "--pids-limit",
  "128",
  "--user",
  "1000:1000",
  "--tmpfs",
  "/tmp:exec,nosuid,size=256m,mode=1777",
  "-w",
  "/workspace",
  "--mount",
  `type=bind,source=${root},target=/workspace`,
  "--mount",
  `type=bind,source=${spool},target=/relay`,
  "--mount",
  `type=bind,source=${path.resolve(import.meta.dir, "claude-file-relay.mjs")},target=/runner.mjs,readonly`,
  "-e",
  "HOME=/tmp/claude-home",
  "-e",
  "CLAUDE_CONFIG_DIR=/tmp/claude-home",
  "-e",
  "DISABLE_AUTOUPDATER=1",
  "-e",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1",
  "-e",
  "CLAUDE_CODE_MAX_OUTPUT_TOKENS=128000",
  "-e",
  "ANTHROPIC_DEFAULT_SONNET_MODEL=glm-5.3-flash",
  "-e",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL=glm-5.3-flash",
  "-e",
  "ANTHROPIC_DEFAULT_OPUS_MODEL=glm-5.3-flash",
  image.stdout.trim(),
  "node",
  "/runner.mjs",
  ...cliArgs,
];
write("protocol.json", {
  transportCheckOnly: process.env.PAW_CLAUDE_RELAY_CHECK === "1",
  startedAt,
  workspaceRoot: root,
  goal,
  model: "glm-5.3-flash",
  endpoint,
  mode,
  reasoningEffort: effort,
  wallMs,
  maxRequests,
  maxTurns,
  imageId: image.stdout.trim(),
  claudeVersion: "2.1.224",
  cliArgs,
  isolation: protocol.isolation,
  sourceHashes: Object.fromEntries(
    ["claude-glm-probe.ts", "claude-file-relay.mjs", "verify.mjs", "workflow-task.ts", "verify-workflow.mjs"].map(
      (file) => [
        file,
        createHash("sha256")
          .update(fs.readFileSync(path.join(import.meta.dir, file)))
          .digest("hex"),
      ],
    ),
  ),
});
console.log(
  JSON.stringify({ event: "claude.start", output: out, workspaceRoot: root }),
);
fs.mkdirSync(path.join(out, "source-snapshot"));
for (const file of [
  "claude-glm-probe.ts",
  "claude-file-relay.mjs",
  "verify.mjs",
  "workflow-task.ts",
  "verify-workflow.mjs",
  "claude-comparison-report.py",
  "Claude.Dockerfile",
]) {
  fs.copyFileSync(
    path.join(import.meta.dir, file),
    path.join(out, "source-snapshot", file),
  );
}
const child = spawn("docker", args, {
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
let pending = "";
child.stdout.on("data", (chunk) => {
  fs.appendFileSync(path.join(out, "stdout.jsonl"), chunk);
  pending += chunk.toString();
  for (;;) {
    const n = pending.indexOf("\n");
    if (n < 0) break;
    const line = pending.slice(0, n);
    pending = pending.slice(n + 1);
    try {
      append("events.jsonl", { at: Date.now(), event: JSON.parse(line) });
    } catch {}
  }
});
child.stderr.on("data", (chunk) =>
  fs.appendFileSync(path.join(out, "stderr.txt"), chunk),
);
let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  runController.abort();
  spawnSync("docker", ["rm", "-f", name], { windowsHide: true });
}, wallMs);
const exitCode = await new Promise<number | null>((resolve, reject) => {
  child.on("exit", resolve);
  child.on("error", reject);
});
clearTimeout(timer);
clearInterval(poll);
runController.abort();
await Promise.allSettled(active);
spawnSync("docker", ["rm", "-f", name], { windowsHide: true });
write("result.json", {
  exitCode,
  timedOut,
  seconds: (Date.now() - startedAt) / 1000,
  physicalRequests: requests,
});
console.log(
  JSON.stringify({ event: "claude.settled", exitCode, timedOut, requests }),
);
