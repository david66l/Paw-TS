/**
 * 假语言模型（Fake Language Model）
 *
 * ## 是什么
 * 一个确定性的、无需网络的语言模型模拟实现，用于测试和离线运行。
 *
 * ## 为什么需要
 * 1. **测试**：单元测试和集成测试中需要一个行为可预测的模型，而不是调用真实 API。
 *    可以预设响应序列（responses），精准控制每轮对话的返回值。
 * 2. **离线/无配置场景**：当用户没有配置任何 LLM API key 时，程序不应崩溃。
 *    FakeLanguageModel 作为安全的兜底方案，让程序在离线模式下仍可交互。
 * 3. **CI/CD**：持续集成环境通常没有 API key，使用假模型可以验证核心逻辑流程。
 *
 * ## 关键设计决策
 * 1. **意图启发式匹配**：根据最后一条用户消息的关键词，自动返回对应的工具调用 JSON。
 *    支持 write_file、run_shell、search、read_file、list_dir 等常见操作。
 *    这使得在没有真实模型的情况下，仍能对工作区文件进行基本操作。
 * 2. **上下文块剥离**：处理用户消息前，先移除 `<auto-context>` 和 `<files>` 块，
 *    确保启发式匹配只针对用户的实际指令，不被自动注入的上下文干扰。
 * 3. **预设响应序列**：通过 `responses` 参数可以预设每轮对话的返回值，按顺序消费。
 *    支持模拟错误（error 字段）、指定 token 用量（usage）和终止原因（finishReason）。
 *    用完预设响应后自动回退到启发式匹配。
 * 4. **流式模拟**：completeStream 方法将完整响应的 text 按每 14 字符分块输出，
 *    模拟 SSE 流式传输效果。
 * 5. **调用计数**：`callCount` 属性记录模型被调用的总次数，方便测试中断言调用行为。
 * 6. **中文优先**：网站/落地页检测同时支持中文（"网站"、"建站"）和英文关键词。
 */

import type { ModelTokenUsage } from "@paw/core";

import type { LanguageModel } from "./language-model.js";
import type { ModelCompleteOptions } from "./model-options.js";
import type {
  ChatMessage,
  ModelCompletionResult,
  ModelStreamChunk,
} from "./types.js";

/** 预设的单次响应配置 */
export interface FakeModelResponse {
  readonly text?: string;
  readonly usage?: ModelTokenUsage;
  readonly finishReason?: "stop" | "length" | "max_tokens";
  /** 如果设置了 error，调用 complete 时会抛出该错误而非返回正常结果 */
  readonly error?: Error | string;
}

/** FakeLanguageModel 构造选项 */
export interface FakeLanguageModelOptions {
  /**
   * 预设响应数组，按顺序每次调用 consume 一个。
   * 耗尽后自动回退到启发式匹配。
   */
  readonly responses?: readonly FakeModelResponse[];
}

/**
 * 确定性假模型，用于测试和离线运行。
 *
 * 行为逻辑：
 * - 如果最后一条用户消息符合特定意图（写文件、搜索、读文件等），返回对应的工具调用 JSON
 * - 否则返回纯文本的 assistant 回复
 * - 当提供了 `responses` 预设时，每次调用按顺序消费一个预设响应
 * - 如果预设响应包含 `error`，会抛出错误而非返回结果
 */
export class FakeLanguageModel implements LanguageModel {
  readonly label = "fake";
  private readonly responses?: readonly FakeModelResponse[];
  /** 内部调用计数器 */
  private _callCount = 0;

  /** 获取当前模型已被调用的次数 */
  get callCount(): number {
    return this._callCount;
  }

  constructor(opts?: FakeLanguageModelOptions) {
    this.responses = opts?.responses;
  }

  /**
   * 执行一次完整的模型调用（非流式）。
   *
   * @param messages - 对话消息历史
   * @param options - 调用选项（支持 AbortSignal 用于取消）
   * @returns 模型返回结果，包含文本、token 用量和终止原因
   */
  async complete(
    messages: readonly ChatMessage[],
    options?: ModelCompleteOptions,
  ): Promise<ModelCompletionResult> {
    // 支持 AbortController 取消
    if (options?.signal?.aborted) {
      throw abortError();
    }
    this._callCount++;
    // 优先使用预设响应
    const response = this.responses?.[this._callCount - 1];
    if (response) {
      if (response.error) {
        throw response.error instanceof Error
          ? response.error
          : new Error(response.error);
      }
      const text = response.text ?? "";
      return {
        text,
        usage: response.usage ?? estimateUsage(messages, text),
        finishReason: response.finishReason,
      };
    }
    // 无预设响应时使用启发式匹配
    const text = await this.computeText(messages);
    return {
      text,
      usage: estimateUsage(messages, text),
    };
  }

  /**
   * 模拟流式输出：将完整文本按每 14 字符一块逐步 yield。
   * 最后 yield 一个 type="done" 的结束 chunk。
   */
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
    yield { type: "done", usage: res.usage, finishReason: res.finishReason };
  }

  /**
   * 核心启发式匹配逻辑：根据用户意图返回对应的工具调用或文本响应。
   *
   * 匹配顺序（从上到下，命中即停止）：
   * 1. 是 Tool 结果消息 → 返回 final_answer
   * 2. 要求建站/落地页 → 返回 write_file（生成 index.html）
   * 3. 要求写文件 → 返回 write_file
   * 4. 要求运行 shell → 返回 run_shell
   * 5. 要求搜索 → 返回 search
   * 6. 要求读两个文件 → 返回两次 read_file
   * 7. 要求读文件 → 返回 read_file
   * 8. 要求列目录 → 返回 list_dir
   * 9. 以上都不匹配 → 返回纯文本（不做任何工具调用）
   */
  private async computeText(messages: readonly ChatMessage[]): Promise<string> {
    // 取最后一条用户消息
    const last = [...messages].reverse().find((m) => m.role === "user");
    const raw = last?.content ?? "";
    // 剥离自动注入的上下文块，确保启发式只看到用户的真实指令
    const text = raw
      .replace(/<auto-context>[\s\S]*?<\/auto-context>/g, "")
      .replace(/<files>[\s\S]*?<\/files>/g, "")
      .trim();
    // 如果消息是工具调用结果，直接返回 final_answer
    if (text.startsWith("[Tool ") || text.includes("Tool result")) {
      return `Fake model: reviewed tool output; no further tools.\n{"action":"final_answer","summary":"Fake model completed after reviewing tool results."}`;
    }
    const lower = text.toLowerCase();
    // ── 建站/落地页意图 ──
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
    // ── 写文件意图 ──
    if (wantsWriteFile(text)) {
      // 从用户消息中提取引号内的文件路径和内容
      const quotes = [...text.matchAll(/["']([^"']*)["']/g)].map((m) => m[1]);
      const relPath = quotes[0] ?? "written.txt";
      const content = quotes[1] ?? "";
      const args = { path: relPath, content };
      return `I'll write that file.\n{"tool":"workspace.write_file","args":${JSON.stringify(args)}}`;
    }
    // ── 运行 shell 意图 ──
    if (wantsRunShell(text)) {
      const quotes = [...text.matchAll(/["']([^"']*)["']/g)].map((m) => m[1]);
      const command = quotes[0] ?? "pwd";
      const args = { command };
      return `Running shell.\n{"tool":"workspace.run_shell","args":${JSON.stringify(args)}}`;
    }
    // ── 搜索意图 ──
    if (wantsSearch(text)) {
      const quotes = [...text.matchAll(/["']([^"']*)["']/g)].map((m) => m[1]);
      const pattern = quotes[0] ?? "needle";
      // 第二段引号仅当像路径时才作为 path，避免 "search for 'needle'" 把 needle 误当 path
      const maybePath = quotes[1];
      const inPath =
        maybePath &&
        (maybePath === "." ||
          maybePath.includes("/") ||
          maybePath.includes("\\") ||
          /\.\w+$/.test(maybePath))
          ? maybePath
          : ".";
      const args = { pattern, path: inPath };
      return `Searching the workspace.\n{"tool":"workspace.search","args":${JSON.stringify(args)}}`;
    }
    // ── 读两个文件意图（"read both files" 等） ──
    if (
      /\bread\s+(?:both|two)\b/.test(lower) ||
      /\bread\s+files?\b/.test(lower)
    ) {
      const quotes = [...text.matchAll(/["']([^"']*)["']/g)].map((m) => m[1]);
      const lines: string[] = [];
      for (const p of quotes.slice(0, 2)) {
        lines.push(
          `{"tool":"workspace.read_file","args":{"path":${JSON.stringify(p)}}}`,
        );
      }
      return `Reading files in parallel.\n${lines.join("\n")}`;
    }
    // ── 读文件意图 ──
    if (/\bread\b/.test(lower)) {
      const m = text.match(/["']([^"']+)["']/);
      const path = m?.[1] ?? "README.md";
      return `I'll read that file.\n{"tool":"workspace.read_file","args":{"path":${JSON.stringify(path)}}}`;
    }
    // ── 列目录意图（list / ls / dir） ──
    if (/\blist\b|ls|dir/.test(lower)) {
      return `Listing the directory.\n{"tool":"workspace.list_dir","args":{"path":".","recursive":false}}`;
    }
    // ── 无匹配：返回纯文本，不做工具调用 ──
    return `Fake model: received goal (${text.slice(0, 120)}${text.length > 120 ? "…" : ""}). No tool call.`;
  }
}

/**
 * 根据消息和生成文本估算 token 用量。
 * 使用简单的字符数/4 估算，非精确计算但足够测试使用。
 */
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

/** 创建一个符合规范的 AbortError，用于模拟请求取消 */
function abortError(): Error {
  const e = new Error("The operation was aborted");
  e.name = "AbortError";
  return e;
}

/**
 * 检测用户是否想创建网站/落地页/个人主页。
 * 支持中英文关键词匹配。
 */
function wantsWebsiteOrPortfolio(text: string): boolean {
  const t = text.toLowerCase();
  return (
    /网站|网页|着陆页|落地页|个人网站|主页|建站/.test(text) ||
    /\b(landing\s*page|personal\s+site|portfolio\s+site)\b/i.test(t)
  );
}

/** 检测用户是否想写入/创建文件 */
function wantsWriteFile(text: string): boolean {
  const t = text.toLowerCase();
  return (
    /\bwrite\s+(?:a\s+)?file\b/.test(t) ||
    /\bcreate\s+(?:a\s+)?file\b/.test(t) ||
    /\bwrite\s+to\s+file\b/.test(t) ||
    /\bsave\s+to\s+['"]/.test(text)
  );
}

/** 检测用户是否想搜索/grep */
function wantsSearch(text: string): boolean {
  const t = text.toLowerCase();
  return /\b(search|grep)\b/.test(t);
}

/** 检测用户是否想运行 shell 命令 */
function wantsRunShell(text: string): boolean {
  const t = text.toLowerCase();
  return /\brun\s+shell\b/.test(t);
}
