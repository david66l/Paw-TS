/**
 * Shell command gate — semantic analysis via configurable policy engine.
 *
 * Thin wrapper that:
 *   1. Parses the command into an AST using `unbash`.
 *   2. Runs the policy engine over the AST.
 *   3. Records an audit log entry for every decision.
 *   4. Falls back to a conservative regex scan if parsing fails.
 */

import { parse } from "./shell-ast.js";
import {
  analyzeCommandLine,
  type ShellGuardResult,
} from "./shell-policy.js";
import { logShellAudit } from "./shell-audit.js";

export type { ShellGuardResult };

// ---------------------------------------------------------------------------
// Session context (optional — enables audit logging and per-session policy)
// ---------------------------------------------------------------------------

export interface ShellGuardContext {
  readonly sessionId?: string;
  readonly workspace?: string;
  readonly userId?: string;
}

// ---------------------------------------------------------------------------
// Fallback regex scan (used when AST parsing fails)
// ---------------------------------------------------------------------------

const DANGEROUS_LITERALS = [
  "rm -rf /",
  "rm -rf /*",
  "> /dev/sda",
  "mkfs.",
  "dd if=",
  ":(){ :|:& };:",
];

const INJECTION_MARKERS = ["$(", "`", "<<<"];

function fallbackRegexScan(raw: string): ShellGuardResult | null {
  const low = raw.toLowerCase();
  for (const lit of DANGEROUS_LITERALS) {
    if (low.includes(lit)) {
      return { allowed: false, reason: `blocked literal: ${lit}` };
    }
  }
  for (const m of INJECTION_MARKERS) {
    if (raw.includes(m)) {
      return {
        allowed: false,
        reason: `disallowed pattern (injection): ${m}`,
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Returns whether the command may be executed under the harness shell tool. */
export function validateShellCommand(
  command: string,
  ctx?: ShellGuardContext,
): ShellGuardResult {
  const raw = command.trim();
  if (!raw) {
    return { allowed: false, reason: "empty command" };
  }

  // Fast literal scan — catches obvious attacks before parsing.
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
      decision: result.allowed
        ? "allow"
        : result.requiresApproval
          ? "ask"
          : "block",
      reason: result.reason || "unknown",
      matchedRule: result.matchedRule,
      userId: ctx?.userId,
    });
  } catch {
    // Audit logging is best-effort; never let it break the guard.
  }
}
