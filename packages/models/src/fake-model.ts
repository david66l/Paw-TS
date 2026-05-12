import type { ModelTokenUsage } from "@paw/core";

import type { LanguageModel } from "./language-model.js";
import type { ModelCompleteOptions } from "./model-options.js";
import type {
  ChatMessage,
  ModelCompletionResult,
  ModelStreamChunk,
} from "./types.js";

/**
 * Deterministic model for tests and offline runs.
 * If the last user message looks like a write/read/list intent, returns a JSON tool line
 * the orchestrator can parse; otherwise returns plain assistant text.
 */
export class FakeLanguageModel implements LanguageModel {
  readonly label = "fake";

  async complete(
    messages: readonly ChatMessage[],
    options?: ModelCompleteOptions,
  ): Promise<ModelCompletionResult> {
    if (options?.signal?.aborted) {
      throw abortError();
    }
    const text = await this.computeText(messages);
    return {
      text,
      usage: estimateUsage(messages, text),
    };
  }

  async *completeStream(
    messages: readonly ChatMessage[],
    options?: ModelCompleteOptions,
  ): AsyncIterable<ModelStreamChunk> {
    const res = await this.complete(messages, options);
    const step = 14;
    for (let i = 0; i < res.text.length; i += step) {
      yield {
        type: "text",
        delta: res.text.slice(i, i + step),
      };
    }
    yield { type: "done", usage: res.usage };
  }

  private async computeText(messages: readonly ChatMessage[]): Promise<string> {
    const last = [...messages].reverse().find((m) => m.role === "user");
    const raw = last?.content ?? "";
    // Strip inline context blocks so heuristics see only the user sentence.
    const text = raw
      .replace(/<auto-context>[\s\S]*?<\/auto-context>/g, "")
      .replace(/<files>[\s\S]*?<\/files>/g, "")
      .trim();
    if (text.includes("Tool result")) {
      return "Fake model: reviewed tool output; no further tools.";
    }
    const lower = text.toLowerCase();
    if (wantsWebsiteOrPortfolio(text)) {
      const args = {
        path: "index.html",
        content: `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"/><title>Site</title></head>
<body><p>Starter page — replace with your content.</p></body>
</html>
`,
        create_directories: true,
      };
      return `Scaffold starter page.\n{"tool":"workspace.write_file","args":${JSON.stringify(args)}}`;
    }
    if (wantsWriteFile(text)) {
      const quotes = [...text.matchAll(/["']([^"']*)["']/g)].map((m) => m[1]);
      const relPath = quotes[0] ?? "written.txt";
      const content = quotes[1] ?? "";
      const args = { path: relPath, content };
      return `I'll write that file.\n{"tool":"workspace.write_file","args":${JSON.stringify(args)}}`;
    }
    if (wantsRunShell(text)) {
      const quotes = [...text.matchAll(/["']([^"']*)["']/g)].map((m) => m[1]);
      const command = quotes[0] ?? "pwd";
      const args = { command };
      return `Running shell.\n{"tool":"workspace.run_shell","args":${JSON.stringify(args)}}`;
    }
    if (wantsSearch(text)) {
      const quotes = [...text.matchAll(/["']([^"']*)["']/g)].map((m) => m[1]);
      const pattern = quotes[0] ?? "needle";
      const inPath = quotes[1] ?? ".";
      const args = { pattern, path: inPath };
      return `Searching the workspace.\n{"tool":"workspace.search","args":${JSON.stringify(args)}}`;
    }
    if (/\bread\s+(?:both|two)\b/.test(lower) || /\bread\s+files?\b/.test(lower)) {
      const quotes = [...text.matchAll(/["']([^"']*)["']/g)].map((m) => m[1]);
      const lines: string[] = [];
      for (const p of quotes.slice(0, 2)) {
        lines.push(`{"tool":"workspace.read_file","args":{"path":${JSON.stringify(p)}}}`);
      }
      return `Reading files in parallel.\n${lines.join("\n")}`;
    }
    if (/\bread\b/.test(lower)) {
      const m = text.match(/["']([^"']+)["']/);
      const path = m?.[1] ?? "README.md";
      return `I'll read that file.\n{"tool":"workspace.read_file","args":{"path":${JSON.stringify(path)}}}`;
    }
    if (/\blist\b|ls|dir/.test(lower)) {
      return `Listing the directory.\n{"tool":"workspace.list_dir","args":{"path":".","recursive":false}}`;
    }
    return `Fake model: received goal (${text.slice(0, 120)}${text.length > 120 ? "…" : ""}). No tool call.`;
  }
}

function estimateUsage(
  messages: readonly ChatMessage[],
  text: string,
): ModelTokenUsage {
  let promptChars = 0;
  for (const m of messages) {
    promptChars += m.content.length;
  }
  const promptTokens = Math.max(1, Math.ceil(promptChars / 4));
  const completionTokens = Math.max(1, Math.ceil(text.length / 4));
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
  };
}

function abortError(): Error {
  const e = new Error("The operation was aborted");
  e.name = "AbortError";
  return e;
}

/** Heuristic: user wants to create/overwrite a workspace file (offline demo / tests). */
/** Offline heuristic: personal site / landing requests → write_file scaffold. */
function wantsWebsiteOrPortfolio(text: string): boolean {
  const t = text.toLowerCase();
  return (
    /网站|网页|着陆页|落地页|个人网站|主页|建站/.test(text) ||
    /\b(landing\s*page|personal\s+site|portfolio\s+site)\b/i.test(t)
  );
}

function wantsWriteFile(text: string): boolean {
  const t = text.toLowerCase();
  return (
    /\bwrite\s+(?:a\s+)?file\b/.test(t) ||
    /\bcreate\s+(?:a\s+)?file\b/.test(t) ||
    /\bwrite\s+to\s+file\b/.test(t) ||
    /\bsave\s+to\s+['"]/.test(text)
  );
}

function wantsSearch(text: string): boolean {
  const t = text.toLowerCase();
  return /\b(search|grep)\b/.test(t);
}

function wantsRunShell(text: string): boolean {
  const t = text.toLowerCase();
  return /\brun\s+shell\b/.test(t);
}
