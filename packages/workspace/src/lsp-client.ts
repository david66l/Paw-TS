/**
 * lsp-client.ts — 最小化 LSP（Language Server Protocol）客户端
 *
 * 【是什么】
 * 通过 JSON-RPC over stdio 与语言服务器进程通信，提供 hover（悬停提示）、
 * definition（跳转定义）、references（查找引用）和 completion（自动补全）
 * 四项核心 LSP 功能。
 *
 * 【为什么需要】
 * 在 AI 辅助编程场景中，Agent 需要对代码进行精确的语义理解（而非纯文本匹配）。
 * LSP 是编辑器生态的标准协议，通过对接 LSP 可以获得类型信息、定义位置、引用
 * 关系等结构化的代码智能数据，远比 grep/正则 精准。
 *
 * 【关键设计决策】
 * 1. stdio 通信：使用子进程的 stdin/stdout 管道与 LSP 服务端通信，无需 HTTP
 *    或 WebSocket，兼容性最好（所有 LSP 服务端都支持 stdio）。
 * 2. 基于 Header/Body 的 LSP 消息帧：LSP 使用 Content-Length 头来分割消息，
 *    processBuffer 逐帧解析，避免 JSON 解析时的粘包/断包问题。
 * 3. Promise 请求队列：pending Map 维护请求 ID 到 Promise 的映射，响应到达时
 *    通过 ID 路由到对应的 resolve/reject。
 * 4. 优雅关闭：stop() 方法先发送 shutdown 请求，再发送 exit 通知，最后 kill
 *    进程，符合 LSP 协议的关闭生命周期。
 * 5. 进程清理：killProcess() 不仅 kill 子进程，还会清理所有事件监听器并 reject
 *    所有 pending 请求，防止内存泄漏和 Promise 永久挂起。
 * 6. 初始化时序：spawn 后等待 100ms 再发送 initialize 请求，给进程一个启动缓冲
 *    时间；使用 settled 标志确保只 resolve/reject 一次。
 */

import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";

/** LSP JSON-RPC 2.0 消息结构 */
interface LspMessage {
  readonly jsonrpc: "2.0";
  readonly id?: number;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

/** LSP 客户端的启动配置 */
export interface LspClientOptions {
  /** LSP 服务端的可执行命令 */
  readonly command: string;
  /** 命令行参数 */
  readonly args?: readonly string[];
  /** 工作目录 */
  readonly cwd?: string;
}

/** hover 请求的返回结果 */
export interface LspHoverResult {
  readonly contents: string;
  readonly range?: unknown;
}

/** LSP 中的位置信息（文件 URI + 行列范围） */
export interface LspLocation {
  readonly uri: string;
  readonly range: {
    readonly start: { readonly line: number; readonly character: number };
    readonly end: { readonly line: number; readonly character: number };
  };
}

/** LSP 补全项的简化结构 */
export interface LspCompletionItem {
  readonly label: string;
  readonly kind?: number;
  readonly detail?: string;
  readonly documentation?: string;
}

/**
 * 最小化 LSP 客户端，使用 JSON-RPC over stdio。
 * 支持 hover、definition、references 和 completion。
 */
export class LspClient {
  /** LSP 服务端子进程 */
  private proc: ChildProcess | null = null;
  /** stdout 数据接收缓冲区（用于拼接不完整的消息帧） */
  private buffer = "";
  /** 下一个请求 ID（自增） */
  private nextId = 1;
  /** 等待响应的 Promise 映射表，key 为请求 ID */
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  /** 是否已完成初始化握手 */
  private initialized = false;
  /** 工作区根目录 URI */
  private _rootUri: string;
  /** 初始化超时定时器（100ms 延迟后发送 initialize） */
  private initTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(rootUri: string) {
    this._rootUri = rootUri;
  }

  /**
   * 启动 LSP 服务端并完成初始化握手。
   *
   * 流程：
   * 1. 如果已有运行的进程，先 kill 掉
   * 2. spawn 子进程
   * 3. 注册 stdout/stderr/error/exit 事件监听
   * 4. 等待 100ms 后发送 initialize 请求
   * 5. initialize 成功后发送 initialized 通知，握手完成
   */
  async start(opts: LspClientOptions): Promise<void> {
    // 先杀掉之前的进程，确保状态干净
    if (this.proc) {
      this.killProcess();
    }

    return new Promise((resolve, reject) => {
      const proc = spawn(opts.command, opts.args ?? [], {
        cwd: opts.cwd,
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.proc = proc;

      // settled 标志：确保 start 的 Promise 只被 resolve/reject 一次
      let settled = false;
      const settle = (fn: (() => void) | undefined) => {
        if (settled) return;
        settled = true;
        fn?.();
        // 清理事件监听器，防止内存泄漏
        proc.removeAllListeners("error");
        proc.removeAllListeners("exit");
        if (this.initTimer) {
          clearTimeout(this.initTimer);
          this.initTimer = null;
        }
      };

      // 收集 stdout 数据到 buffer，并逐帧解析
      proc.stdout?.on("data", (data: Buffer) => {
        this.buffer += data.toString("utf-8");
        this.processBuffer();
      });

      // stderr 通常很嘈杂，暂时忽略
      proc.stderr?.on("data", (_data: Buffer) => {
        // stderr is often noisy; ignore for now
      });

      proc.on("error", (err) => {
        settle(() => reject(err));
      });
      proc.on("exit", (code) => {
        if (code !== 0 && code !== null) {
          settle(() =>
            reject(new Error(`LSP server exited with code ${code}`)),
          );
        }
      });

      // 等待一个 tick 让进程启动，然后发送 initialize 请求
      this.initTimer = setTimeout(() => {
        this.initTimer = null;
        this.sendRequest("initialize", {
          processId: process.pid,
          rootUri: this._rootUri,
          capabilities: {},
        })
          .then(() => {
            this.initialized = true;
            // LSP 握手第三步：发送 initialized 通知
            this.sendNotification("initialized", {});
            settle(() => resolve());
          })
          .catch((err) => {
            settle(() => reject(err));
          });
      }, 100);
    });
  }

  /**
   * 获取指定位置的悬停信息（类型提示、文档等）。
   *
   * LSP 返回的 contents 可能是 string、MarkedString 数组、或 MarkupContent 对象，
   * 这里做了兼容处理，统一转为纯文本。
   */
  async hover(
    filePath: string,
    line: number,
    character: number,
  ): Promise<LspHoverResult | null> {
    const result = await this.sendRequest("textDocument/hover", {
      textDocument: { uri: this.fileToUri(filePath) },
      position: { line, character },
    });
    if (!result || typeof result !== "object") {
      return null;
    }
    const r = result as Record<string, unknown>;
    const contents = r.contents;
    let text = "";
    // 兼容三种 contents 格式
    if (typeof contents === "string") {
      text = contents;
    } else if (Array.isArray(contents)) {
      text = contents.map((c) => (typeof c === "string" ? c : "")).join("\n");
    } else if (contents !== null && typeof contents === "object") {
      text = String((contents as Record<string, unknown>).value ?? "");
    }
    return { contents: text, range: r.range };
  }

  /** 跳转到指定位置符号的定义 */
  async definition(
    filePath: string,
    line: number,
    character: number,
  ): Promise<LspLocation[]> {
    const result = await this.sendRequest("textDocument/definition", {
      textDocument: { uri: this.fileToUri(filePath) },
      position: { line, character },
    });
    return this.parseLocations(result);
  }

  /** 查找指定位置符号的所有引用（包含声明本身） */
  async references(
    filePath: string,
    line: number,
    character: number,
  ): Promise<LspLocation[]> {
    const result = await this.sendRequest("textDocument/references", {
      textDocument: { uri: this.fileToUri(filePath) },
      position: { line, character },
      context: { includeDeclaration: true },
    });
    return this.parseLocations(result);
  }

  /**
   * 获取指定位置的代码补全建议。
   *
   * LSP 的 completion 返回结构可能是 { items: [...] } 或直接是数组，
   * 这里做了兼容处理。
   */
  async completion(
    filePath: string,
    line: number,
    character: number,
  ): Promise<LspCompletionItem[]> {
    const result = await this.sendRequest("textDocument/completion", {
      textDocument: { uri: this.fileToUri(filePath) },
      position: { line, character },
    });
    if (!result || typeof result !== "object") {
      return [];
    }
    const r = result as Record<string, unknown>;
    // 兼容两种返回格式
    const items = Array.isArray(r.items)
      ? r.items
      : Array.isArray(result)
        ? result
        : [];
    return items
      .filter(
        (i): i is Record<string, unknown> =>
          i !== null && typeof i === "object",
      )
      .map((i) => ({
        label: typeof i.label === "string" ? i.label : "",
        kind: typeof i.kind === "number" ? i.kind : undefined,
        detail: typeof i.detail === "string" ? i.detail : undefined,
        documentation:
          typeof i.documentation === "string" ? i.documentation : undefined,
      }));
  }

  /**
   * 停止 LSP 客户端。
   *
   * 遵循 LSP 协议的关闭流程：
   * 1. 发送 shutdown 请求（服务端清理资源）
   * 2. 发送 exit 通知（服务端退出）
   * 3. kill 进程（兜底，确保进程一定会终止）
   */
  async stop(): Promise<void> {
    if (!this.proc || this.proc.killed) {
      this.proc = null;
      this.initialized = false;
      return;
    }
    try {
      await this.sendRequest("shutdown", {});
    } catch {
      // 即使 shutdown 失败也要继续发送 exit
    }
    this.sendNotification("exit", {});
    this.killProcess();
    this.initialized = false;
  }

  /**
   * 强制杀死进程并清理所有状态。
   * - 清除初始化定时器
   * - 移除所有事件监听器
   * - kill 子进程
   * - reject 所有 pending 请求（防止 Promise 永久挂起）
   * - 清空接收缓冲区
   */
  private killProcess(): void {
    if (this.initTimer) {
      clearTimeout(this.initTimer);
      this.initTimer = null;
    }
    if (!this.proc) return;
    // 移除 stdout/stderr 监听器，防止泄漏
    this.proc.stdout?.removeAllListeners("data");
    this.proc.stderr?.removeAllListeners("data");
    this.proc.removeAllListeners("error");
    this.proc.removeAllListeners("exit");
    this.proc.kill();
    this.proc = null;
    // Reject 所有等待中的请求，防止它们永久挂起
    for (const [id, pending] of this.pending) {
      pending.reject(new Error("LSP client stopped"));
      this.pending.delete(id);
    }
    this.buffer = "";
  }

  /** 是否已完成初始化 */
  get isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * 从接收缓冲区中逐帧解析 LSP 消息。
   *
   * LSP 的消息帧格式（基于 HTTP 头风格）：
   *   Content-Length: <字节数>\r\n
   *   \r\n
   *   <JSON 正文>
   *
   * 循环解析直到缓冲区中不足一个完整帧为止。
   */
  private processBuffer(): void {
    while (true) {
      // 查找消息头结束标记 \r\n\r\n
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        return;
      }
      const header = this.buffer.slice(0, headerEnd);
      const contentLengthMatch = /Content-Length:\s*(\d+)/i.exec(header);
      if (!contentLengthMatch) {
        // 跳过格式错误的头部
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }
      const contentLength = Number.parseInt(contentLengthMatch[1]!, 10);
      const messageStart = headerEnd + 4;
      if (this.buffer.length < messageStart + contentLength) {
        return; // 数据尚未接收完整，等待更多数据
      }
      const body = this.buffer.slice(
        messageStart,
        messageStart + contentLength,
      );
      // 从缓冲区中移除已处理的消息
      this.buffer = this.buffer.slice(messageStart + contentLength);
      this.handleMessage(body);
    }
  }

  /**
   * 处理单条 JSON-RPC 消息。
   * 如果是响应（有 id），根据 id 找到对应的 pending Promise 并 resolve/reject。
   * 如果是服务器推送的通知（无 id），目前忽略。
   */
  private handleMessage(body: string): void {
    let msg: LspMessage;
    try {
      msg = JSON.parse(body) as LspMessage;
    } catch {
      return;
    }
    // 有 id 的是响应消息，需要路由到对应的 pending Promise
    if (msg.id !== undefined) {
      const pending = this.pending.get(msg.id);
      if (pending) {
        this.pending.delete(msg.id);
        if (msg.error) {
          pending.reject(new Error(msg.error.message));
        } else {
          pending.resolve(msg.result);
        }
      }
    }
  }

  /**
   * 发送 JSON-RPC 请求并返回一个 Promise。
   * 请求 ID 自增，并将 resolve/reject 存入 pending Map。
   */
  private sendRequest(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      this.write(msg);
    });
  }

  /**
   * 发送 JSON-RPC 通知（无 id，不需要响应）。
   */
  private sendNotification(method: string, params: unknown): void {
    const msg = JSON.stringify({ jsonrpc: "2.0", method, params });
    this.write(msg);
  }

  /**
   * 向子进程 stdin 写入 LSP 帧格式的消息。
   * 帧格式：Content-Length: <字节数>\r\n\r\n<JSON>
   */
  private write(msg: string): void {
    if (!this.proc?.stdin?.writable) {
      return;
    }
    const data = `Content-Length: ${Buffer.byteLength(msg, "utf-8")}\r\n\r\n${msg}`;
    this.proc.stdin.write(data);
  }

  /**
   * 将文件路径转换为 file:// URI。
   * 支持相对路径和绝对路径，相对路径会基于 _rootUri 拼接。
   */
  private fileToUri(filePath: string): string {
    if (filePath.startsWith("file://")) {
      return filePath;
    }
    const absolute = path.isAbsolute(filePath)
      ? filePath
      : path.join(this._rootUri.replace("file://", ""), filePath);
    return `file://${absolute}`;
  }

  /**
   * 将 LSP 返回的位置结果解析为标准 LspLocation 数组。
   * 兼容单个位置对象和位置数组两种格式。
   */
  private parseLocations(result: unknown): LspLocation[] {
    if (!result) {
      return [];
    }
    const items = Array.isArray(result) ? result : [result];
    return items
      .filter(
        (i): i is Record<string, unknown> =>
          i !== null && typeof i === "object",
      )
      .map((i) => ({
        uri: typeof i.uri === "string" ? i.uri : "",
        range: i.range as LspLocation["range"],
      }))
      .filter((l) => l.uri);
  }
}

/**
 * 根据文件扩展名检测应使用哪个 LSP 服务端。
 *
 * 当前支持的扩展名和对应的 LSP 服务端：
 * - .ts/.tsx/.js/.jsx → typescript-language-server
 * - .py → pylsp
 * - .rs → rust-analyzer
 * - .go → gopls
 * - .json → vscode-json-language-server
 * - .css/.scss → vscode-css-language-server
 *
 * @returns { command, args } 或 null（不支持该文件类型时）
 */
export function detectLspCommand(
  filePath: string,
): { command: string; args: string[] } | null {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".ts":
    case ".tsx":
    case ".js":
    case ".jsx":
      return { command: "typescript-language-server", args: ["--stdio"] };
    case ".py":
      return { command: "pylsp", args: [] };
    case ".rs":
      return { command: "rust-analyzer", args: [] };
    case ".go":
      return { command: "gopls", args: [] };
    case ".json":
      return { command: "vscode-json-language-server", args: ["--stdio"] };
    case ".css":
    case ".scss":
      return { command: "vscode-css-language-server", args: ["--stdio"] };
    default:
      return null;
  }
}
