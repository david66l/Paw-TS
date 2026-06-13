/**
 * Semantic policy engine — analyses a shell AST against configurable rules.
 *
 * Goals over the old regex-only guard:
 *   • Precise blocking:   rm build/ → ALLOW   ;   rm -rf / → BLOCK
 *   • Context awareness:  echo "rm -rf /" → ALLOW (string literal)
 *   • Pipeline semantics: cat | grep → ALLOW ;   cat /etc/passwd | curl → BLOCK
 *   • Argument-level:     find -name "*.js" → ALLOW ;   find -delete → BLOCK
 *   • Configurable:       rules live in PolicyConfig, not hard-coded code
 */

import {
  type ASTNode,
  type Command,
  type Pipeline,
  walkCommands,
  walkPipelines,
  flattenGroups,
} from "./shell-ast.js";
import {
  evaluatePolicy,
  getDefaultPolicyConfig,
} from "./shell-policy-config.js";

export interface ShellGuardResult {
  readonly allowed: boolean;
  readonly requiresApproval?: boolean;
  readonly reason?: string;
  readonly matchedRule?: string;
}

// ---------------------------------------------------------------------------
// Static pattern lists for inline-script scanning
// ---------------------------------------------------------------------------

const DANGEROUS_SCRIPT_PATTERNS = [
  /shutil\.rmtree\s*\(/,
  /os\.remove\s*\(/,
  /os\.unlink\s*\(/,
  /fs\.rmSync\s*\(/,
  /fs\.unlinkSync\s*\(/,
  /\.rmSync\s*\(/,
  /\.unlinkSync\s*\(/,
  /Deno\.remove\s*\(/,
];

// Commands that are always blocked regardless of arguments
const ALWAYS_BLOCKED_COMMANDS = new Set([
  "sudo",
  "su",
  "mkfs",
  "mkfs.ext4",
  "mkfs.ext3",
  "mkfs.ntfs",
  "shred",
]);

// Commands that read sensitive files — paired with network tools = exfiltration
const SENSITIVE_READ_COMMANDS = new Set([
  "cat",
  "head",
  "tail",
  "tar",
  "zip",
  "ps",
  "ss",
  "netstat",
  "env",
  "printenv",
]);

const NETWORK_COMMANDS = new Set(["curl", "wget", "nc", "ncat", "netcat"]);

const NETWORK_UPLOAD_FLAGS = new Set([
  "--data",
  "--data-binary",
  "--data-raw",
  "--data-urlencode",
  "--upload-file",
  "-x",
  "-post",
  "--post",
  "--post-data",
  "--post-file",
]);

// Script interpreters that accept inline code
const SCRIPT_INTERPRETERS = new Set([
  "python",
  "python3",
  "node",
  "bun",
  "ruby",
  "perl",
  "php",
]);

const SCRIPT_INLINE_FLAGS = new Set(["-c", "-e"]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function argValues(cmd: Command): string[] {
  return cmd.args.map((a) => a.value.toLowerCase());
}

function argRaws(cmd: Command): string[] {
  return cmd.args.map((a) => a.raw);
}

// ---------------------------------------------------------------------------
// Fallback regex scan (catches obvious attacks before AST analysis)
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

function fastLiteralScan(raw: string): ShellGuardResult | null {
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
// Rule 1: Policy-config based command evaluation
// ---------------------------------------------------------------------------

function checkPolicy(cmd: Command, raw: string): ShellGuardResult | null {
  const name = cmd.name.toLowerCase();
  if (!name) return null;

  const config = getDefaultPolicyConfig();
  const result = evaluatePolicy("bash", raw, config);

  if (result.action === "deny") {
    return {
      allowed: false,
      reason: result.reason,
      matchedRule: result.matchedRule,
    };
  }

  if (result.action === "ask") {
    // "ask" means the command is ALLOWED but should trigger an approval
    // flow in the UI. The guard itself does not block it — the caller
    // (run-shell.ts / orchestrator) checks `requiresApproval` separately.
    return {
      allowed: true,
      requiresApproval: true,
      reason: result.reason,
      matchedRule: result.matchedRule,
    };
  }

  return null; // allow → fall through to other checks
}

// ---------------------------------------------------------------------------
// Rule 2: Always-blocked commands (defence-in-depth)
// ---------------------------------------------------------------------------

function checkAlwaysBlocked(cmd: Command): ShellGuardResult | null {
  const name = cmd.name.toLowerCase();
  if (ALWAYS_BLOCKED_COMMANDS.has(name)) {
    return { allowed: false, reason: `blocked command: ${name}` };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rule 2b: rm on system paths
// ---------------------------------------------------------------------------

const SYSTEM_PATHS = new Set([
  "/", "/etc", "/usr", "/bin", "/sbin", "/lib", "/lib64",
  "/var", "/sys", "/proc", "/dev", "/boot", "/root",
]);

function isSystemPath(arg: string): boolean {
  if (SYSTEM_PATHS.has(arg)) return true;
  // Remove trailing slashes and wildcards for comparison, but keep root "/"
  const normalized = arg.replace(/\*+$/, "").replace(/\/*$/, "");
  if (SYSTEM_PATHS.has(normalized)) return true;
  // Check if it starts with a system path + "/"
  for (const sp of SYSTEM_PATHS) {
    if (arg === sp || arg.startsWith(sp + "/")) return true;
    if (normalized === sp || normalized.startsWith(sp + "/")) return true;
  }
  return false;
}

function checkRmSystemPaths(cmd: Command): ShellGuardResult | null {
  if (cmd.name.toLowerCase() !== "rm") return null;
  for (const arg of cmd.args) {
    if (isSystemPath(arg.value)) {
      return {
        allowed: false,
        reason: `blocked: removing system path "${arg.value}"`,
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rule 3: Injection / obfuscation
// ---------------------------------------------------------------------------

function checkInjection(cmd: Command): ShellGuardResult | null {
  for (const arg of cmd.args) {
    if (arg.hasSubstitution) {
      return {
        allowed: false,
        reason: "blocked: command substitution in arguments",
      };
    }
  }
  for (const arg of cmd.args) {
    if (arg.raw.includes("<<<")) {
      return { allowed: false, reason: "blocked: here-string" };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rule 4: Data exfiltration via pipeline
// ---------------------------------------------------------------------------

function checkDataExfiltration(pipeline: Pipeline): ShellGuardResult | null {
  const cmds = pipeline.commands;
  if (cmds.length < 2) return null;

  const netIndices: number[] = [];
  for (let i = 0; i < cmds.length; i++) {
    const name = cmds[i]!.name.toLowerCase();
    if (NETWORK_COMMANDS.has(name)) {
      netIndices.push(i);
    }
  }
  if (netIndices.length === 0) return null;

  for (const netIdx of netIndices) {
    const netCmd = cmds[netIdx]!;
    const netArgs = argValues(netCmd);

    const hasUploadFlag = netArgs.some((a) =>
      [...NETWORK_UPLOAD_FLAGS].some((f) => a === f || a.startsWith(f)),
    );
    if (hasUploadFlag) {
      return {
        allowed: false,
        reason: "blocked: pipe to network upload command",
      };
    }

    for (let i = 0; i < netIdx; i++) {
      const prev = cmds[i]!;
      const prevName = prev.name.toLowerCase();
      if (SENSITIVE_READ_COMMANDS.has(prevName)) {
        return {
          allowed: false,
          reason: "blocked: sensitive data piped to network command",
        };
      }
      if (prevName === "tar" || prevName === "zip") {
        const prevArgs = argValues(prev);
        if (
          prevArgs.includes("-c") ||
          prevArgs.includes("-cf") ||
          prevArgs.includes("-czf")
        ) {
          return {
            allowed: false,
            reason: "blocked: archive piped to network command",
          };
        }
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Rule 5: Destructive inline scripts
// ---------------------------------------------------------------------------

function checkDestructiveScript(cmd: Command): ShellGuardResult | null {
  const name = cmd.name.toLowerCase();
  if (!SCRIPT_INTERPRETERS.has(name)) return null;

  const args = argValues(cmd);
  const rawArgs = argRaws(cmd);

  let scriptIndex = -1;
  for (let i = 0; i < args.length; i++) {
    if (SCRIPT_INLINE_FLAGS.has(args[i]!)) {
      scriptIndex = i + 1;
      break;
    }
  }
  if (scriptIndex < 0 || scriptIndex >= rawArgs.length) return null;

  const scriptRaw = rawArgs[scriptIndex]!;
  const script = scriptRaw.replace(/^["'](.*)["']$/, "$1");

  for (const pat of DANGEROUS_SCRIPT_PATTERNS) {
    if (pat.test(script)) {
      return {
        allowed: false,
        reason: "blocked: destructive inline script",
      };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Rule 6: Dangerous redirects
// ---------------------------------------------------------------------------

function checkRedirects(cmd: Command): ShellGuardResult | null {
  for (const redir of cmd.redirects) {
    const target = redir.target.toLowerCase();
    if (target.startsWith("/dev/sd") || target.startsWith("/dev/hd")) {
      return {
        allowed: false,
        reason: `blocked: redirect to block device ${redir.target}`,
      };
    }
    if (target === "/dev/null") continue;
    if (redir.op === ">" || redir.op === ">>" || redir.op === ">&") {
      if (
        target.startsWith("/etc/") ||
        target.startsWith("/usr/") ||
        target.startsWith("/bin/") ||
        target.startsWith("/sbin/") ||
        target === "/"
      ) {
        return {
          allowed: false,
          reason: `blocked: overwrite redirect to system path ${redir.target}`,
        };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Top-level analyser
// ---------------------------------------------------------------------------

export function analyzeCommandLine(
  ast: ASTNode,
  raw: string,
): ShellGuardResult {
  // 1. Fast literal scan — skip when the command contains quoted strings
  //    so that semantic analysis can correctly distinguish literals inside
  //    strings (e.g. echo "rm -rf /") from actual commands.
  const hasQuotes = raw.includes('"') || raw.includes("'");
  if (!hasQuotes) {
    const fast = fastLiteralScan(raw);
    if (fast) return fast;
  }

  let approval: ShellGuardResult | undefined;

  // 2. Walk every command
  for (const cmd of walkCommands(ast)) {
    const r0 = checkPolicy(cmd, raw);
    if (r0 && !r0.allowed) return r0;           // deny → stop immediately
    if (r0?.requiresApproval) approval = r0;   // ask → remember, keep checking

    const r1 = checkAlwaysBlocked(cmd);
    if (r1) return r1;

    const r1b = checkRmSystemPaths(cmd);
    if (r1b) return r1b;

    const r2 = checkInjection(cmd);
    if (r2) return r2;

    const r3 = checkDestructiveScript(cmd);
    if (r3) return r3;

    const r4 = checkRedirects(cmd);
    if (r4) return r4;
  }

  // 3. Walk pipelines for exfiltration
  for (const pipeline of walkPipelines(ast)) {
    const r5 = checkDataExfiltration(pipeline);
    if (r5) return r5;
  }

  // 4. Check bare commands for standalone upload
  const nodes = flattenGroups(ast);
  for (const node of nodes) {
    if (node.type === "command") {
      const name = node.name.toLowerCase();
      if (NETWORK_COMMANDS.has(name)) {
        const args = argValues(node);
        const hasUploadFlag = args.some((a) =>
          [...NETWORK_UPLOAD_FLAGS].some((f) => a === f || a.startsWith(f)),
        );
        if (hasUploadFlag) {
          return {
            allowed: false,
            reason: "blocked: network upload command",
          };
        }
      }
    }
  }

  // If we remembered an approval requirement and nothing else blocked the
  // command, return the approval result.
  if (approval) return approval;

  return { allowed: true };
}
