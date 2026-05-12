import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

interface LspMessage {
  readonly jsonrpc: "2.0";
  readonly id?: number;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

export interface LspClientOptions {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
}

export interface LspHoverResult {
  readonly contents: string;
  readonly range?: unknown;
}

export interface LspLocation {
  readonly uri: string;
  readonly range: {
    readonly start: { readonly line: number; readonly character: number };
    readonly end: { readonly line: number; readonly character: number };
  };
}

export interface LspCompletionItem {
  readonly label: string;
  readonly kind?: number;
  readonly detail?: string;
  readonly documentation?: string;
}

/**
 * Minimal LSP client using JSON-RPC over stdio.
 * Supports hover, definition, references, and completion.
 */
export class LspClient {
  private proc: ChildProcess | null = null;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private initialized = false;
  private _rootUri: string;

  constructor(rootUri: string) {
    this._rootUri = rootUri;
  }

  async start(opts: LspClientOptions): Promise<void> {
    return new Promise((resolve, reject) => {
      this.proc = spawn(opts.command, opts.args ?? [], {
        cwd: opts.cwd,
        stdio: ["pipe", "pipe", "pipe"],
      });

      this.proc.stdout?.on("data", (data: Buffer) => {
        this.buffer += data.toString("utf-8");
        this.processBuffer();
      });

      this.proc.stderr?.on("data", (_data: Buffer) => {
        // stderr is often noisy; ignore for now
      });

      this.proc.on("error", reject);
      this.proc.on("exit", (code) => {
        if (code !== 0 && code !== null) {
          reject(new Error(`LSP server exited with code ${code}`));
        }
      });

      // Wait a tick for process to start, then initialize
      setTimeout(() => {
        this.sendRequest("initialize", {
          processId: process.pid,
          rootUri: this._rootUri,
          capabilities: {},
        })
          .then(() => {
            this.initialized = true;
            this.sendNotification("initialized", {});
            resolve();
          })
          .catch(reject);
      }, 100);
    });
  }

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
    if (typeof contents === "string") {
      text = contents;
    } else if (Array.isArray(contents)) {
      text = contents.map((c) => (typeof c === "string" ? c : "")).join("\n");
    } else if (contents !== null && typeof contents === "object") {
      text = String((contents as Record<string, unknown>).value ?? "");
    }
    return { contents: text, range: r.range };
  }

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
    const items = Array.isArray(r.items) ? r.items : Array.isArray(result) ? result : [];
    return items
      .filter((i): i is Record<string, unknown> => i !== null && typeof i === "object")
      .map((i) => ({
        label: typeof i.label === "string" ? i.label : "",
        kind: typeof i.kind === "number" ? i.kind : undefined,
        detail: typeof i.detail === "string" ? i.detail : undefined,
        documentation: typeof i.documentation === "string" ? i.documentation : undefined,
      }));
  }

  async stop(): Promise<void> {
    if (!this.proc || this.proc.killed) {
      return;
    }
    try {
      await this.sendRequest("shutdown", {});
    } catch {
      // ignore
    }
    this.sendNotification("exit", {});
    this.proc.kill();
    this.proc = null;
    this.initialized = false;
  }

  get isInitialized(): boolean {
    return this.initialized;
  }

  private processBuffer(): void {
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        return;
      }
      const header = this.buffer.slice(0, headerEnd);
      const contentLengthMatch = /Content-Length:\s*(\d+)/i.exec(header);
      if (!contentLengthMatch) {
        // Skip malformed header
        this.buffer = this.buffer.slice(headerEnd + 4);
        continue;
      }
      const contentLength = parseInt(contentLengthMatch[1]!, 10);
      const messageStart = headerEnd + 4;
      if (this.buffer.length < messageStart + contentLength) {
        return; // wait for more data
      }
      const body = this.buffer.slice(messageStart, messageStart + contentLength);
      this.buffer = this.buffer.slice(messageStart + contentLength);
      this.handleMessage(body);
    }
  }

  private handleMessage(body: string): void {
    let msg: LspMessage;
    try {
      msg = JSON.parse(body) as LspMessage;
    } catch {
      return;
    }
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

  private sendRequest(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      this.write(msg);
    });
  }

  private sendNotification(method: string, params: unknown): void {
    const msg = JSON.stringify({ jsonrpc: "2.0", method, params });
    this.write(msg);
  }

  private write(msg: string): void {
    if (!this.proc?.stdin?.writable) {
      return;
    }
    const data = `Content-Length: ${Buffer.byteLength(msg, "utf-8")}\r\n\r\n${msg}`;
    this.proc.stdin.write(data);
  }

  private fileToUri(filePath: string): string {
    if (filePath.startsWith("file://")) {
      return filePath;
    }
    const absolute = path.isAbsolute(filePath)
      ? filePath
      : path.join(this._rootUri.replace("file://", ""), filePath);
    return "file://" + absolute;
  }

  private parseLocations(result: unknown): LspLocation[] {
    if (!result) {
      return [];
    }
    const items = Array.isArray(result) ? result : [result];
    return items
      .filter((i): i is Record<string, unknown> => i !== null && typeof i === "object")
      .map((i) => ({
        uri: typeof i.uri === "string" ? i.uri : "",
        range: i.range as LspLocation["range"],
      }))
      .filter((l) => l.uri);
  }
}

/** Detect the LSP command for a file based on extension. */
export function detectLspCommand(filePath: string): { command: string; args: string[] } | null {
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
