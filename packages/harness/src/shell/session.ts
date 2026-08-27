/**
 * 持久 Shell 会话（Claude Code / Codex 式）。
 *
 * ## 功能概述
 * 一个逻辑 run 持有一个长驻 shell 进程：命令按序"敲"进同一个 shell，
 * 工作目录、环境变量、已激活的虚拟环境与后台进程跨命令保留。任务结束
 * 时显式销毁；进程死亡时下一次调用懒重建。
 *
 * ## 两种后端
 * - local ：宿主机长驻 bash（Unix /bin/bash；Windows 依赖 Git Bash 的 bash）。
 * - docker：一个长驻容器 + 容器内长驻 bash（docker run -i，命令经 stdin 喂入）。
 *           容器沿用 workspace 沙箱的挂载/网络/资源限制策略，绝不因持久化而降级。
 *
 * ## 命令协议（后端无关）
 *   <command>
 *   printf '__PAW_DONE_<token>_<exit>__\n' "$?"
 * token 每条命令随机生成，输出里伪冒哨兵不会误判；读到哨兵即命令结束，
 * 退出码取自 "$?"。
 *
 * ## 明确的边界（v1）
 * - 命令未闭合的语法块（如悬空的 `if`）会吞掉哨兵，最终以超时收场并
 *   重建会话——诚实降级，不伪造结果。
 * - 超时/中止会终止整个会话（无法只杀当前命令的进程组），下次调用重建。
 * - 单条命令输出上限 256KiB，超限保留开头并标记 truncated（与旧
 *   spawnSync maxBuffer 语义一致）。
 * - 本模块只做"终端"：shell guard、审批、权限判定全部发生在调用方，
 *   会话不绕过任何策略。
 */

import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";

import type { ShellSandboxConfig } from "../sandbox/types.js";
import { buildDockerSessionSpawnSpecV1 } from "../sandbox/docker-runner.js";

const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
const MIN_COMMAND_TIMEOUT_MS = 1_000;
const MAX_COMMAND_TIMEOUT_MS = 300_000;
const MAX_COMMAND_OUTPUT_BYTES = 256 * 1024;

export interface ShellSessionRunOptions {
  /** 本条命令的超时（毫秒）；超时会销毁会话并在下次调用懒重建。 */
  readonly timeoutMs?: number;
  /** 中止信号：与超时同路径处理。 */
  readonly signal?: AbortSignal;
  /**
   * 本条命令的工作目录（后端语义路径：local 为宿主绝对路径，docker 为
   * 容器内绝对路径）。缺省沿用会话当前目录（持久状态的一部分）。
   */
  readonly cwd?: string;
}

export interface ShellSessionRunResult {
  readonly exitCode: number | undefined;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly truncated: boolean;
  readonly aborted: boolean;
  /** 本次调用触发了会话重建（上一会话已死亡/被超时销毁）。 */
  readonly recycled: boolean;
  readonly error?: string;
}

export interface ShellSession {
  readonly key: string;
  readonly backend: "local" | "docker";
  run(command: string, options?: ShellSessionRunOptions): Promise<ShellSessionRunResult>;
  dispose(): Promise<void>;
}

export interface ShellSessionFactoryConfig {
  /** 稳定身份（建议 `${sessionId}:${runId}`），同 key 复用同一会话。 */
  readonly key: string;
  /** 会话初始工作目录（宿主绝对路径）。 */
  readonly cwd: string;
  /** 提供即使用 docker 后端；缺省使用本地 bash。 */
  readonly sandbox?: ShellSandboxConfig;
}

interface LiveSessionInternals {
  readonly proc: import("node:child_process").ChildProcess;
  readonly stdout: string[];
  readonly stderr: string[];
}

abstract class PersistentShellSessionBase implements ShellSession {
  protected internals: LiveSessionInternals | undefined;
  protected queue: Promise<unknown> = Promise.resolve();
  protected disposed = false;

  protected constructor(
    readonly key: string,
    readonly backend: "local" | "docker",
    private readonly initialCwd: string,
  ) {}

  async run(
    command: string,
    options: ShellSessionRunOptions = {},
  ): Promise<ShellSessionRunResult> {
    const invocation = this.queue.then(
      () => this.runSerialized(command, options),
      () => this.runSerialized(command, options),
    );
    this.queue = invocation;
    return invocation;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    releaseShellSessionFromRegistry(this.key);
    const internals = this.internals;
    this.internals = undefined;
    if (internals) await this.killInternals(internals);
    await this.disposeBackendExtra();
  }

  protected abstract spawnInternals(): LiveSessionInternals;
  protected abstract killInternals(internals: LiveSessionInternals): Promise<void>;
  protected abstract disposeBackendExtra(): Promise<void>;
  /** 后端专属的 cwd 前缀（local 直接 cd 宿主路径；docker 已是容器路径）。 */
  protected abstract cwdPrefix(cwd: string): string;

  private async runSerialized(
    command: string,
    options: ShellSessionRunOptions,
  ): Promise<ShellSessionRunResult> {
    if (this.disposed) {
      return deadSessionResult("session disposed");
    }
    const recycled = this.internals === undefined;
    let internals: LiveSessionInternals;
    try {
      internals = this.internals ?? (this.internals = this.spawnInternals());
    } catch (error) {
      this.internals = undefined;
      return deadSessionResult(
        error instanceof Error ? error.message : String(error),
      );
    }

    const token = randomBytes(9).toString("hex");
    const marker = `__PAW_DONE_${token}_`;
    const cwd = options.cwd ? this.cwdPrefix(options.cwd) : "";
    const submission = `${cwd}${command}\nprintf '${marker}%s__\\n' "$?"\n`;

    const timeoutMs = clampTimeout(options.timeoutMs);
    internals.stdout.length = 0;
    internals.stderr.length = 0;

    return await new Promise<ShellSessionRunResult>((resolve) => {
      let stdoutBytes = 0;
      let truncated = false;
      let settled = false;
      const stdoutText = () => internals.stdout.join("");
      const stderrText = () => internals.stderr.join("");

      const finish = (result: ShellSessionRunResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        options.signal?.removeEventListener("abort", abortListener);
        resolve(result);
      };

      const settleFromOutput = (extra?: Partial<ShellSessionRunResult>): void => {
        const text = stdoutText();
        const match = text.match(new RegExp(`${marker}(-?\\d+)__`));
        if (!match) return;
        const stdout = text
          .slice(0, Math.max(0, match.index))
          .replace(/\r?\n$/, "");
        finish({
          exitCode: Number(match[1]),
          stdout,
          stderr: stderrText(),
          timedOut: false,
          truncated,
          aborted: false,
          recycled,
          ...extra,
        });
      };

      const onDeath = (reason: string): void => {
        this.internals = undefined;
        finish({
          exitCode: undefined,
          stdout: stdoutText(),
          stderr: stderrText(),
          timedOut: false,
          truncated,
          aborted: false,
          recycled,
          error: reason,
        });
      };

      const abortListener = (): void => {
        const internalsRef = this.internals;
        this.internals = undefined;
        if (internalsRef) {
          void this.killInternals(internalsRef);
        }
        finish({
          exitCode: undefined,
          stdout: stdoutText(),
          stderr: stderrText(),
          timedOut: false,
          truncated,
          aborted: true,
          recycled,
          error: "aborted",
        });
      };
      options.signal?.addEventListener("abort", abortListener, { once: true });
      if (options.signal?.aborted) {
        abortListener();
        return;
      }

      const timeoutId = setTimeout(() => {
        const internalsRef = this.internals;
        this.internals = undefined;
        if (internalsRef) {
          void this.killInternals(internalsRef);
        }
        finish({
          exitCode: undefined,
          stdout: stdoutText(),
          stderr: stderrText(),
          timedOut: true,
          truncated,
          aborted: false,
          recycled,
          error: `timeout after ${timeoutMs}ms (session recycled)`,
        });
      }, timeoutMs);

      const closeListener = (): void => {
        // 哨兵未出现而进程退出：会话已死。若有部分输出则如实带回。
        onDeath("session shell exited before completion");
      };
      internals.proc.once("close", closeListener);

      const onStdout = (data: Buffer): void => {
        const text = data.toString("utf8");
        stdoutBytes += text.length;
        if (stdoutBytes > MAX_COMMAND_OUTPUT_BYTES) {
          truncated = true;
          // 保留开头（与旧 maxBuffer 语义一致），丢弃后续，但仍继续扫哨兵。
        } else {
          internals.stdout.push(text);
        }
        settleFromOutput();
      };
      const onStderr = (data: Buffer): void => {
        const text = data.toString("utf8");
        internals.stderr.push(text);
      };
      internals.proc.stdout?.on("data", onStdout);
      internals.proc.stderr?.on("data", onStderr);

      internals.proc.stdin?.write(submission, (error) => {
        if (error) onDeath(`stdin write failed: ${error.message}`);
      });
      // 写入后先扫一次（极快命令可能在监听建立前完成）。
      settleFromOutput();
    });
  }
}

class LocalShellSession extends PersistentShellSessionBase {
  constructor(key: string, private readonly hostCwd: string) {
    super(key, "local", hostCwd);
  }

  protected spawnInternals(): LiveSessionInternals {
    const proc = spawn("bash", [], {
      cwd: this.hostCwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    if (!proc.stdin || !proc.stdout || !proc.stderr) {
      throw new Error("local bash session failed to open pipes");
    }
    return { proc, stdout: [], stderr: [] };
  }

  protected async killInternals(internals: LiveSessionInternals): Promise<void> {
    killLocalProcessTree(internals.proc.pid ?? 0);
  }

  protected async disposeBackendExtra(): Promise<void> {}

  protected cwdPrefix(cwd: string): string {
    return `cd ${posixSingleQuoted(cwd)} && `;
  }
}

class DockerShellSession extends PersistentShellSessionBase {
  private readonly spec: ReturnType<typeof buildDockerSessionSpawnSpecV1>;

  constructor(
    key: string,
    hostCwd: string,
    sandbox: ShellSandboxConfig,
  ) {
    super(key, "docker", hostCwd);
    this.spec = buildDockerSessionSpawnSpecV1(sandbox, {
      workspaceRoot: hostCwd,
      sessionKey: key,
    });
  }

  protected spawnInternals(): LiveSessionInternals {
    // 同名容器可能是上次崩溃的孤儿：先尽力收割，再创建。
    spawnSync(this.spec.runtime, ["rm", "-f", this.spec.containerName], {
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true,
    });
    const proc = spawn(this.spec.runtime, [...this.spec.args], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    if (!proc.stdin || !proc.stdout || !proc.stderr) {
      throw new Error("docker session failed to open pipes");
    }
    return { proc, stdout: [], stderr: [] };
  }

  protected async killInternals(internals: LiveSessionInternals): Promise<void> {
    killLocalProcessTree(internals.proc.pid ?? 0);
    spawnSync(this.spec.runtime, ["rm", "-f", this.spec.containerName], {
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true,
    });
  }

  protected async disposeBackendExtra(): Promise<void> {}

  protected cwdPrefix(cwd: string): string {
    return `cd ${posixSingleQuoted(cwd)} && `;
  }
}

const liveSessions = new Map<string, Promise<ShellSession>>();

/**
 * 按 key 获取（或创建）持久会话。同 key 并发调用只会创建一个会话。
 * 调用方负责在 run 生命周期结束时 {@link ShellSession.dispose}。
 */
export function acquireShellSession(
  config: ShellSessionFactoryConfig,
): Promise<ShellSession> {
  const existing = liveSessions.get(config.key);
  if (existing) return existing;
  const created = (async () => {
    if (config.sandbox) {
      return new DockerShellSession(
        config.key,
        path.resolve(config.cwd),
        config.sandbox,
      );
    }
    return new LocalShellSession(config.key, path.resolve(config.cwd));
  })();
  liveSessions.set(config.key, created);
  created.catch(() => liveSessions.delete(config.key));
  return created;
}

/** 进程内排障/测试用：当前活跃会话 key 列表。 */
export function activeShellSessionKeys(): readonly string[] {
  return [...liveSessions.keys()];
}

function releaseShellSessionFromRegistry(key: string): void {
  liveSessions.delete(key);
}

function clampTimeout(ms: number | undefined): number {
  if (ms === undefined || !Number.isFinite(ms)) {
    return DEFAULT_COMMAND_TIMEOUT_MS;
  }
  return Math.min(
    Math.max(Math.floor(ms), MIN_COMMAND_TIMEOUT_MS),
    MAX_COMMAND_TIMEOUT_MS,
  );
}

function deadSessionResult(error: string): ShellSessionRunResult {
  return {
    exitCode: undefined,
    stdout: "",
    stderr: "",
    timedOut: false,
    truncated: false,
    aborted: false,
    recycled: true,
    error,
  };
}

function posixSingleQuoted(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function killLocalProcessTree(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  if (process.platform === "win32") {
    spawnSync(
      process.env.ComSpec ?? "cmd.exe",
      ["/d", "/s", "/c", `taskkill /PID ${pid} /T /F`],
      { windowsHide: true, stdio: "ignore", timeout: 5_000 },
    );
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}
