import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";

export const CLAUDE_CONTAINER_WORKSPACE = "/testbed";
export const CLAUDE_CONTAINER_EXECUTABLE = "/usr/local/bin/claude";
export const CLAUDE_MODEL_API_BASE_URL = "https://api.deepseek.com/anthropic";
export const CLAUDE_MODEL_API_CONNECT_TARGET = "api.deepseek.com:443";
export const CLAUDE_PROXY_AUDIT_PATH = "/tmp/paw-claude-egress-audit.jsonl";

export interface ClaudeContainerNames {
  readonly network: string;
  readonly proxy: string;
  readonly task: string;
}

export interface ClaudeProxyAudit {
  readonly ready: boolean;
  readonly allowed: number;
  readonly denied: number;
  readonly upstreamErrors: number;
  readonly malformedLines: number;
  readonly collectionError?: string;
}

export interface ClaudeContainerPlan {
  readonly names: ClaudeContainerNames;
  readonly networkCreateArgs: readonly string[];
  readonly proxyRunArgs: readonly string[];
  readonly proxyConnectArgs: readonly string[];
  readonly taskRunArgs: readonly string[];
}

export interface ClaudeContainerExecution {
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly proxyLog: string;
  readonly proxyAudit: ClaudeProxyAudit;
}

function dockerSafeIdentity(runId: string): string {
  const readable = runId
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "")
    .slice(0, 24);
  const digest = createHash("sha256").update(runId).digest("hex").slice(0, 12);
  return `${readable || "run"}-${digest}`;
}

export function claudeContainerNames(runId: string): ClaudeContainerNames {
  const identity = dockerSafeIdentity(runId);
  return {
    network: `paw-cc-${identity}-net`,
    proxy: `paw-cc-${identity}-proxy`,
    task: `paw-cc-${identity}-task`,
  };
}

export function claudeLinuxBinaryPath(
  repoRoot: string,
  claudeVersion: string,
): string {
  const explicit = process.env.PAW_CLAUDE_LINUX_BINARY?.trim();
  const binary = explicit
    ? path.resolve(explicit)
    : path.join(
        repoRoot,
        "benchmarks",
        "swe-compare",
        "runtime",
        `claude-linux-x64-${claudeVersion}`,
        "claude",
      );
  if (!existsSync(binary)) {
    throw new Error(
      `Claude Linux runtime is missing: ${binary}; run packages/eval/scripts/prepare-claude-linux-runtime.ts`,
    );
  }
  return binary;
}

export function buildClaudeContainerPlan(input: {
  readonly repoRoot: string;
  readonly workspaceRoot: string;
  readonly image: string;
  readonly runId: string;
  readonly claudeVersion: string;
  readonly claudeArgs: readonly string[];
  readonly claudeBinaryPath?: string;
  /** 超长 goal 的宿主文件：挂载为 /paw-goal.txt，容器内 sh -c 展开。 */
  readonly goalFile?: string;
}): ClaudeContainerPlan {
  const names = claudeContainerNames(input.runId);
  const binary = input.claudeBinaryPath
    ? path.resolve(input.claudeBinaryPath)
    : claudeLinuxBinaryPath(input.repoRoot, input.claudeVersion);
  if (!existsSync(binary)) {
    throw new Error(`Claude Linux runtime is missing: ${binary}`);
  }
  const proxyScript = path.join(
    input.repoRoot,
    "packages",
    "eval",
    "scripts",
    "claude-egress-proxy.py",
  );
  if (!existsSync(proxyScript)) {
    throw new Error(`Claude egress proxy is missing: ${proxyScript}`);
  }
  return {
    names,
    networkCreateArgs: ["network", "create", "--internal", names.network],
    proxyRunArgs: [
      "run",
      "-d",
      "--name",
      names.proxy,
      "--network",
      "bridge",
      "--read-only",
      "--tmpfs",
      "/tmp:nosuid,size=64m",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      "64",
      "--memory",
      "256m",
      "--cpus",
      "0.5",
      "--mount",
      `type=bind,source=${proxyScript},target=/paw/claude-egress-proxy.py,readonly`,
      "-e",
      `PAW_CLAUDE_ALLOWED_CONNECT=${CLAUDE_MODEL_API_CONNECT_TARGET}`,
      "-e",
      `PAW_CLAUDE_AUDIT_PATH=${CLAUDE_PROXY_AUDIT_PATH}`,
      input.image,
      "python",
      "/paw/claude-egress-proxy.py",
    ],
    proxyConnectArgs: ["network", "connect", names.network, names.proxy],
    taskRunArgs: [
      "run",
      "--rm",
      "--name",
      names.task,
      "--stop-timeout",
      "1",
      "--network",
      names.network,
      "--user",
      "1000:1000",
      "--read-only",
      "--tmpfs",
      "/tmp:exec,nosuid,size=2048m",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      "512",
      "--memory",
      "8192m",
      "--cpus",
      "4",
      "--mount",
      `type=bind,source=${path.resolve(input.workspaceRoot)},target=${CLAUDE_CONTAINER_WORKSPACE}`,
      "--mount",
      `type=bind,source=${binary},target=${CLAUDE_CONTAINER_EXECUTABLE},readonly`,
      "-w",
      CLAUDE_CONTAINER_WORKSPACE,
      "-e",
      "HOME=/tmp/claude-home",
      "-e",
      `ANTHROPIC_BASE_URL=${CLAUDE_MODEL_API_BASE_URL}`,
      "-e",
      "ANTHROPIC_AUTH_TOKEN",
      "-e",
      "ANTHROPIC_MODEL=deepseek-v4-flash[1m]",
      "-e",
      "ANTHROPIC_DEFAULT_OPUS_MODEL=deepseek-v4-flash[1m]",
      "-e",
      "ANTHROPIC_DEFAULT_SONNET_MODEL=deepseek-v4-flash[1m]",
      "-e",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek-v4-flash",
      "-e",
      "CLAUDE_CODE_SUBAGENT_MODEL=deepseek-v4-flash",
      "-e",
      `HTTPS_PROXY=http://${names.proxy}:3128`,
      "-e",
      `HTTP_PROXY=http://${names.proxy}:3128`,
      "-e",
      `https_proxy=http://${names.proxy}:3128`,
      "-e",
      `http_proxy=http://${names.proxy}:3128`,
      "-e",
      "NO_PROXY=localhost,127.0.0.1",
      "-e",
      "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1",
      ...(input.goalFile
        ? [
            "-v",
            `${path.resolve(input.goalFile).replaceAll("\\", "/")}:/paw-goal.txt:ro`,
          ]
        : []),
      input.image,
      ...(input.goalFile
        ? [
            "sh",
            "-c",
            `${shellQuote(CLAUDE_CONTAINER_EXECUTABLE)} ${input.claudeArgs.map(shellQuote).join(" ")} "$(cat /paw-goal.txt)"`,
          ]
        : [CLAUDE_CONTAINER_EXECUTABLE, ...input.claudeArgs]),
    ],
  };
}

function shellQuote(value: string): string {
  return /[^A-Za-z0-9_@%+=:,./-]/.test(value) ? `'${value.replaceAll("'", `'\''`)}'` : value;
}

export function parseClaudeProxyAudit(log: string): ClaudeProxyAudit {
  let ready = false;
  let allowed = 0;
  let denied = 0;
  let upstreamErrors = 0;
  let malformedLines = 0;
  for (const line of log.split(/\r?\n/).filter(Boolean)) {
    try {
      const value = JSON.parse(line) as { readonly event?: unknown };
      if (value.event === "ready") ready = true;
      else if (value.event === "allowed") allowed += 1;
      else if (value.event === "denied") denied += 1;
      else if (value.event === "upstream_error") upstreamErrors += 1;
      else malformedLines += 1;
    } catch {
      malformedLines += 1;
    }
  }
  return { ready, allowed, denied, upstreamErrors, malformedLines };
}

function dockerSync(
  args: readonly string[],
  timeoutMs = 30_000,
):
  | { readonly ok: true; readonly stdout: string }
  | {
      readonly ok: false;
      readonly error: string;
    } {
  const result = Bun.spawnSync(["docker", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: timeoutMs,
  });
  const stdout = new TextDecoder().decode(result.stdout).trim();
  const stderr = new TextDecoder().decode(result.stderr).trim();
  return result.exitCode === 0
    ? { ok: true, stdout }
    : {
        ok: false,
        error:
          stderr ||
          stdout ||
          `docker ${args[0] ?? "command"} exit ${result.exitCode}`,
      };
}

function cleanupClaudeContainerPlan(plan: ClaudeContainerPlan): void {
  dockerSync(["rm", "-f", plan.names.task], 15_000);
  dockerSync(["rm", "-f", plan.names.proxy], 15_000);
  dockerSync(["network", "rm", plan.names.network], 15_000);
}

async function readClaudeProxyAuditLog(
  plan: ClaudeContainerPlan,
  attempts = 3,
): Promise<{ readonly log: string; readonly error?: string }> {
  const errors: string[] = [];
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const auditFile = dockerSync(
      [
        "exec",
        plan.names.proxy,
        "python",
        "-c",
        `import pathlib; print(pathlib.Path(${JSON.stringify(CLAUDE_PROXY_AUDIT_PATH)}).read_text(encoding='utf-8'), end='')`,
      ],
      10_000,
    );
    if (auditFile.ok && auditFile.stdout) return { log: auditFile.stdout };
    errors.push(auditFile.ok ? "empty proxy audit file" : auditFile.error);
    if (attempt + 1 < attempts) await Bun.sleep(100);
  }
  const logs = dockerSync(["logs", plan.names.proxy], 10_000);
  if (logs.ok && logs.stdout) return { log: logs.stdout };
  errors.push(logs.ok ? "empty proxy stdout log" : logs.error);
  return { log: "", error: errors.join(" | ") };
}

async function waitForProxyReady(
  plan: ClaudeContainerPlan,
  timeoutMs = 10_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastLog = "";
  while (Date.now() < deadline) {
    const logs = await readClaudeProxyAuditLog(plan, 1);
    if (logs.log) {
      lastLog = logs.log;
      if (parseClaudeProxyAudit(lastLog).ready) return lastLog;
    }
    const running = dockerSync(
      ["inspect", "-f", "{{.State.Running}}", plan.names.proxy],
      5_000,
    );
    if (!running.ok || running.stdout !== "true") {
      throw new Error(
        `Claude egress proxy exited before ready: ${
          logs.log || logs.error || "proxy audit unavailable"
        }`,
      );
    }
    await Bun.sleep(100);
  }
  throw new Error(`Claude egress proxy did not become ready: ${lastLog}`);
}

export async function runClaudeContainer(input: {
  readonly plan: ClaudeContainerPlan;
  readonly authToken: string;
  readonly timeoutMs: number;
}): Promise<ClaudeContainerExecution> {
  if (!input.authToken.trim()) {
    throw new Error(
      "Claude container requires ANTHROPIC_AUTH_TOKEN or DEEPSEEK_API_KEY",
    );
  }
  const network = dockerSync(input.plan.networkCreateArgs);
  if (!network.ok) {
    throw new Error(`cannot create Claude internal network: ${network.error}`);
  }
  try {
    const proxy = dockerSync(input.plan.proxyRunArgs);
    if (!proxy.ok) {
      throw new Error(`cannot start Claude egress proxy: ${proxy.error}`);
    }
    const connected = dockerSync(input.plan.proxyConnectArgs);
    if (!connected.ok) {
      throw new Error(
        `cannot attach Claude egress proxy to internal network: ${connected.error}`,
      );
    }
    const readyProxyLog = await waitForProxyReady(input.plan);

    const child = Bun.spawn(["docker", ...input.plan.taskRunArgs], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        ANTHROPIC_AUTH_TOKEN: input.authToken,
      },
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      dockerSync(["rm", "-f", input.plan.names.task], 15_000);
      child.kill();
    }, input.timeoutMs);
    timer.unref?.();
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    clearTimeout(timer);
    const logs = await readClaudeProxyAuditLog(input.plan);
    const proxyLog = logs.log || readyProxyLog;
    const proxyAudit = parseClaudeProxyAudit(proxyLog);
    return {
      exitCode,
      timedOut,
      stdout,
      stderr,
      proxyLog,
      proxyAudit: logs.error
        ? { ...proxyAudit, collectionError: logs.error }
        : proxyAudit,
    };
  } finally {
    cleanupClaudeContainerPlan(input.plan);
  }
}
