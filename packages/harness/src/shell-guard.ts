/**
 * Shell 命令安全门控 — 通过可配置策略引擎进行语义分析。
 * =======================================================
 *
 * 这是 paw-ts 安全架构的核心组件。所有模型执行的 shell 命令在运行前
 * 都必须经过此门控检查。
 *
 * 三层防护：
 * 1. **快速字面量扫描**（无引号时）：检测明显的攻击模式
 *    （rm -rf /、mkfs.、fork bomb 等），在任何解析之前拦截
 * 2. **AST 解析 + 策略引擎**：使用 unbash 将命令解析为 AST，
 *    由 shell-policy.ts 的策略引擎逐节点分析
 * 3. **保守回退**：如果 AST 解析失败，用正则扫描作为最后防线
 *
 * 所有决策都会记录审计日志。
 *
 * 面试要点：
 * - 为什么需要 Shell 沙箱？LLM 可能生成危险的 shell 命令
 * - AST vs 正则：正则容易被绕过（如 `rm --recursive --force /`），
 *   AST 解析真正理解命令结构
 */

import { parse } from "./shell-ast.js";
import { analyzeCommandLine, type ShellGuardResult } from "./shell-policy.js";
import { logShellAudit } from "./shell-audit.js";

export type { ShellGuardResult };

/** 会话上下文（可选 — 启用审计日志和逐会话策略） */
export interface ShellGuardContext {
  readonly sessionId?: string;
  readonly workspace?: string;
  readonly userId?: string;
}

/** 危险字面量列表：在任何解析前直接匹配 */
const DANGEROUS_LITERALS = [
  "rm -rf /",
  "rm -rf /*",
  "> /dev/sda",
  "mkfs.",
  "dd if=",
  ":(){ :|:& };:",
];

/** 命令注入标记：这些模式在 shell 中可能导致代码执行 */
const INJECTION_MARKERS = ["$(", "`", "<<<"];

/**
 * 回退正则扫描（AST 解析失败时使用）。
 * 保守策略：宁可误杀，不可放过。
 */
function fallbackRegexScan(raw: string): ShellGuardResult | null {
  const low = raw.toLowerCase();
  for (const lit of DANGEROUS_LITERALS) {
    if (low.includes(lit)) {
      return { allowed: false, reason: `blocked literal: ${lit}` };
    }
  }
  for (const m of INJECTION_MARKERS) {
    if (raw.includes(m)) {
      return { allowed: false, reason: `disallowed pattern (injection): ${m}` };
    }
  }
  return null;
}

/**
 * 验证 shell 命令是否可以执行。
 *
 * 流程：
 * 1. 空命令 → 拒绝
 * 2. 无引号时快速扫描 → 发现危险模式直接拒绝
 * 3. AST 解析 + 策略引擎分析
 * 4. 解析失败 → 保守回退
 */
export function validateShellCommand(
  command: string,
  ctx?: ShellGuardContext,
): ShellGuardResult {
  const raw = command.trim();
  if (!raw) {
    return { allowed: false, reason: "empty command" };
  }

  // 快速字面量扫描 — 在解析前拦截明显的攻击
  // 注意：如果命令包含引号，跳过快速扫描（引号可能改变语义）
  const hasQuotes = raw.includes('"') || raw.includes("'");
  if (!hasQuotes) {
    const fast = fallbackRegexScan(raw);
    if (fast) {
      logAudit(ctx, raw, fast);
      return fast;
    }
  }

  try {
    const ast = parse(raw);
    const result = analyzeCommandLine(ast, raw);
    logAudit(ctx, raw, result);
    return result;
  } catch {
    // AST 解析失败 → 保守回退
    const conservative = fallbackRegexScan(raw);
    if (conservative) {
      logAudit(ctx, raw, conservative);
      return conservative;
    }
    const fallback: ShellGuardResult = {
      allowed: false,
      reason: "unable to parse command",
    };
    logAudit(ctx, raw, fallback);
    return fallback;
  }
}

/** 记录审计日志（best-effort，失败不阻断门控） */
function logAudit(
  ctx: ShellGuardContext | undefined,
  command: string,
  result: ShellGuardResult,
): void {
  try {
    logShellAudit({
      sessionId: ctx?.sessionId || "default",
      workspace: ctx?.workspace || process.cwd(),
      command,
      decision: result.allowed ? "allow" : result.requiresApproval ? "ask" : "block",
      reason: result.reason || "unknown",
      matchedRule: result.matchedRule,
      userId: ctx?.userId,
    });
  } catch {
    // 审计日志是 best-effort，绝不让它阻断门控
  }
}
