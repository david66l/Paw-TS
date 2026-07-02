/**
 * 记忆提取：单次模型调用分析对话并提取记忆条目。
 * ==============================================
 *
 * 这是"事后记忆提取"的核心。Run 完成后，用辅助模型分析整个对话，
 * 提取值得在将来会话中记住的事实。
 *
 * 提取内容重点：
 * - 用户偏好（编码风格、习惯、偏好的工具）
 * - 项目特定知识（架构决策、技术栈）
 * - 用户给出的反馈或纠正
 * - 当前任务的重要上下文
 *
 * 安全扫描（Sensitive-Info Scanner）：
 * 所有提取的记忆条目在返回前都会经过敏感信息扫描。
 * 检测 API key、token、密码、私钥等模式，匹配到的条目被拒绝（但保留在 rejected 列表）。
 *
 * 优先级指南：
 * - high：核心架构知识、硬性用户约束、关键 bug 修复
 * - mid（默认）：有用的项目事实、一般偏好
 * - low：临时调试笔记、一次性测试命令、已废弃的方案
 */

import type { AutoMemoryEntry } from "@paw/core";
import type { LanguageModel } from "@paw/models";

import { completeAuxiliaryTask } from "./auxiliary-complete.js";

export interface MemoryExtractionResult {
  readonly entries: readonly AutoMemoryEntry[];
  /** 被敏感信息扫描器拒绝的条目（可用于审计） */
  readonly rejected: readonly RejectedEntry[];
}

export interface RejectedEntry {
  readonly entry: AutoMemoryEntry;
  readonly reason: string;
}

// ═══ 敏感信息扫描器 ═══

/** 敏感信息检测模式列表。按特异性排序（sk-ant 在 sk 之前）。 */
const SENSITIVE_PATTERNS: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly label: string;
}> = [
  { pattern: /sk-ant-[A-Za-z0-9_\-]{20,}/, label: "Anthropic API key (sk-ant-…)" },
  { pattern: /sk-[A-Za-z0-9_\-]{20,}/, label: "OpenAI API key (sk-…)" },
  { pattern: /Bearer\s+[A-Za-z0-9_\-\.]{20,}/, label: "Bearer token" },
  { pattern: /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----/, label: "private key block" },
  { pattern: /password\s*[:=]\s*["']?\S+["']?/i, label: "password assignment" },
  { pattern: /secret_key\s*[:=]\s*["']?\S+["']?/i, label: "secret_key assignment" },
  { pattern: /api[_-]?key\s*[:=]\s*["']?\S{8,}["']?/i, label: "API key assignment" },
  { pattern: /token\s*[:=]\s*["']?ghp_[A-Za-z0-9_]{20,}["']?/, label: "GitHub personal access token" },
  { pattern: /token\s*[:=]\s*["']?gho_[A-Za-z0-9_]{20,}["']?/, label: "GitHub OAuth token" },
  { pattern: /\.npmrc\b.*_authToken\s*=/i, label: ".npmrc authToken reference" },
  { pattern: /eyJ[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}/, label: "JWT token" },
  { pattern: /xox[bpras]-[A-Za-z0-9_\-]{10,}/, label: "Slack token" },
  { pattern: /access_key\s*[:=]\s*["']?\S{8,}["']?/i, label: "access_key assignment" },
];

/**
 * 扫描记忆内容中的敏感信息。
 * 返回第一个匹配的拒绝原因，或 null（通过扫描）。
 */
export function scanForSensitiveInfo(entry: AutoMemoryEntry): string | null {
  const haystack = [entry.name, entry.description, entry.content].join("\n");
  for (const { pattern, label } of SENSITIVE_PATTERNS) {
    if (pattern.test(haystack)) {
      return `matched sensitive pattern: ${label}`;
    }
  }
  // 额外检查：内容中出现凭据关键字 + 赋值模式
  const contentLower = entry.content.toLowerCase();
  const credKeywords = ["password", "secret", "credential", "private key"];
  for (const kw of credKeywords) {
    if (contentLower.includes(kw)) {
      if (/\w+\s*[:=]\s*["']?\S{8,}["']?/.test(entry.content)) {
        return `possible credential in content: keyword "${kw}" near assignment`;
      }
    }
  }
  return null;
}

/** 对记忆条目列表执行敏感信息扫描，分为安全/拒绝两组 */
function sanitizeMemoryEntries(
  entries: readonly AutoMemoryEntry[],
): { safe: AutoMemoryEntry[]; rejected: RejectedEntry[] } {
  const safe: AutoMemoryEntry[] = [];
  const rejected: RejectedEntry[] = [];
  for (const entry of entries) {
    const reason = scanForSensitiveInfo(entry);
    if (reason) {
      rejected.push({ entry, reason });
    } else {
      safe.push(entry);
    }
  }
  return { safe, rejected };
}

// ═══ 提取 ═══

const EXTRACTION_SYSTEM = `You analyze coding-agent conversations and extract facts worth remembering across future sessions. Output markdown entry blocks only.`;

/** 构建记忆提取的用户提示词 */
function buildExtractionUser(conversationText: string): string {
  return `Analyze the following conversation and extract any facts that should be remembered for future sessions.

Focus on:
- User preferences (coding style, conventions, tools they prefer)
- Project-specific knowledge (architecture decisions, tech stack)
- Feedback or corrections the user gave
- Important context about the current task

Respond with ONLY a markdown document containing memory entries in this format:

## Entry 1
- **Name**: short_kebab_case_id
- **Type**: user | feedback | project | reference
- **Priority**: high | mid | low
- **Description**: One-line description
- **Content**: Detailed content to remember
- **RelatedFiles**: packages/core/src/foo.ts, packages/agent/src/bar.ts (comma-separated file paths mentioned or modified; omit if none)
- **ErrorSignatures**: TS2307, Cannot find module (comma-separated error codes, exception names, or key error phrases; omit if none)
- **ToolsUsed**: workspace.read_file, bash_run (comma-separated MCP tool names or harness functions used; omit if none)

## Entry 2
...

Priority guidelines:
- **high**: Core architecture knowledge, hard user constraints, critical bug fixes, essential reference docs
- **mid**: (default) Useful project facts, general preferences, non-critical fixes
- **low**: Temporary debug notes, one-off test commands, abandoned approaches

If there is nothing worth remembering, respond with "No memories to extract."

## Conversation

${conversationText}`;
}

/**
 * 通过一次便宜的辅助模型调用提取持久记忆（不需要子 Agent 循环）。
 *
 * 所有提取的条目在返回前都会经过敏感信息扫描；
 * 被拒绝的条目保留在 result.rejected 中供审计/日志使用。
 */
export async function extractMemories(
  model: LanguageModel,
  conversationText: string,
  signal?: AbortSignal,
): Promise<MemoryExtractionResult> {
  const text = await completeAuxiliaryTask({
    model,
    system: EXTRACTION_SYSTEM,
    user: buildExtractionUser(conversationText),
    signal,
  });

  const raw = parseMemoryEntries(text);
  const { safe, rejected } = sanitizeMemoryEntries(raw);
  return { entries: safe, rejected };
}

/**
 * 解析 LLM 输出的 markdown 记忆条目。
 *
 * 格式：每个 ## Entry N 段落包含 Name/Type/Priority/Description/Content 等字段。
 * 解析策略：按行匹配 `- **Field**: value` 格式，Content 之后的行全部作为内容。
 */
function parseMemoryEntries(text: string): AutoMemoryEntry[] {
  if (text.trim().toLowerCase().includes("no memories to extract")) {
    return [];
  }

  const entries: AutoMemoryEntry[] = [];
  const sections = text.split(/^##\s+/m).slice(1);

  for (const section of sections) {
    const lines = section.split("\n");
    const heading = lines[0]?.trim();
    if (!heading || heading.toLowerCase().startsWith("conversation")) continue;

    let name = "";
    let type: AutoMemoryEntry["type"] = "reference";
    let priority: AutoMemoryEntry["priority"] = "mid";
    let description = "";
    const relatedFiles: string[] = [];
    const errorSignatures: string[] = [];
    const toolsUsed: string[] = [];
    const contentLines: string[] = [];
    let inContent = false;

    for (const line of lines.slice(1)) {
      const nameMatch = line.match(/^-\s*\*\*Name\*\*:\s*([^\s:，,]+)/i);
      const typeMatch = line.match(/^-\s*\*\*Type\*\*:\s*(.+)$/i);
      const priorityMatch = line.match(/^-\s*\*\*Priority\*\*:\s*(.+)$/i);
      const descMatch = line.match(/^-\s*\*\*Description\*\*:\s*(.+)$/i);
      const relatedMatch = line.match(/^-\s*\*\*RelatedFiles\*\*:\s*(.+)$/i);
      const errorsMatch = line.match(/^-\s*\*\*ErrorSignatures\*\*:\s*(.+)$/i);
      const toolsMatch = line.match(/^-\s*\*\*ToolsUsed\*\*:\s*(.+)$/i);
      const contentStart = line.match(/^-\s*\*\*Content\*\*:\s*(.*)$/i);

      if (nameMatch) {
        name = nameMatch[1]!.trim().replace(/\s+/g, "_").replace(/[^\w._-]/g, "").toLowerCase();
      } else if (typeMatch) {
        const t = typeMatch[1]?.trim().toLowerCase();
        if (
          t === "user" ||
          t === "feedback" ||
          t === "project" ||
          t === "reference"
        ) {
          type = t;
        }
      } else if (priorityMatch) {
        const p = priorityMatch[1]?.trim().toLowerCase();
        if (p === "high" || p === "mid" || p === "low") {
          priority = p;
        }
      } else if (descMatch) {
        description = descMatch[1]!.trim();
      } else if (relatedMatch) {
        relatedMatch[1]!
          .split(/[,，]/)
          .map((s: string) => s.trim())
          .filter((s: string) => s.length > 0)
          .forEach((s: string) => relatedFiles.push(s));
      } else if (errorsMatch) {
        errorsMatch[1]!
          .split(/[,，]/)
          .map((s: string) => s.trim())
          .filter((s: string) => s.length > 0)
          .forEach((s: string) => errorSignatures.push(s));
      } else if (toolsMatch) {
        toolsMatch[1]!
          .split(/[,，]/)
          .map((s: string) => s.trim())
          .filter((s: string) => s.length > 0)
          .forEach((s: string) => toolsUsed.push(s));
      } else if (contentStart) {
        inContent = true;
        if (contentStart[1]) contentLines.push(contentStart[1]);
      } else if (inContent && line.trim()) {
        contentLines.push(line);
      }
    }

    if (name && description) {
      entries.push({
        name,
        type,
        priority,
        description,
        content: contentLines.join("\n").trim(),
        ...(relatedFiles.length > 0 ? { relatedFiles } : {}),
        ...(errorSignatures.length > 0 ? { error_signatures: errorSignatures } : {}),
        ...(toolsUsed.length > 0 ? { tools_used: toolsUsed } : {}),
      });
    }
  }

  return entries;
}
