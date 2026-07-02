/**
 * 语义策略引擎 — 基于可配置规则分析 Shell AST。
 * ===============================================
 *
 * 相比旧的纯正则守卫的优势：
 *   • 精确阻断：  rm build/ → 放行  ;   rm -rf / → 阻断
 *   • 上下文感知：echo "rm -rf /" → 放行（字符串字面量）
 *   • 管道语义：  cat | grep → 放行 ;   cat /etc/passwd | curl → 阻断
 *   • 参数级别：  find -name "*.js" → 放行 ;   find -delete → 阻断
 *   • 可配置：    规则在 PolicyConfig 中定义，不硬编码
 *
 * 规则体系（6 层）：
 * 1. 策略配置评估：使用 shell-policy-config.ts 的规则引擎
 * 2. 始终阻断的命令：sudo、mkfs、shred 等
 * 3. 系统路径上的 rm 操作
 * 4. 命令注入/混淆
 * 5. 管道数据泄露（敏感命令 + 网络命令的组合）
 * 6. 危险重定向（覆盖系统文件/块设备）
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
  /** 需要审批但不阻断 */
  readonly requiresApproval?: boolean;
  readonly reason?: string;
  /** 匹配的规则名（用于审计） */
  readonly matchedRule?: string;
}

/** 危险脚本模式：检测内联脚本中的破坏性操作 */
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

/** 无论什么参数都始终阻断的命令（纵深防御） */
const ALWAYS_BLOCKED_COMMANDS = new Set([
  "sudo", "su", "mkfs", "mkfs.ext4", "mkfs.ext3",
  "mkfs.ntfs", "shred",
]);

/** 读取敏感信息的命令 — 与网络工具配对 → 数据泄露 */
const SENSITIVE_READ_COMMANDS = new Set([
  "cat", "head", "tail", "tar", "zip",
  "ps", "ss", "netstat", "env", "printenv",
]);

/** 网络通信命令 */
const NETWORK_COMMANDS = new Set(["curl", "wget", "nc", "ncat", "netcat"]);

/** 网络上传标志（表示数据将被发送到远程） */
const NETWORK_UPLOAD_FLAGS = new Set([
  "--data", "--data-binary", "--data-raw", "--data-urlencode",
  "--upload-file", "-x", "-post", "--post", "--post-data", "--post-file",
]);

/** 接受内联代码的脚本解释器 */
const SCRIPT_INTERPRETERS = new Set([
  "python", "python3", "node", "bun", "ruby", "perl", "php",
]);

/** 内联代码标志（如 python -c, node -e） */
const SCRIPT_INLINE_FLAGS = new Set(["-c", "-e"]);

// ── 辅助函数 ──

function argValues(cmd: Command): string[] {
  return cmd.args.map((a) => a.value.toLowerCase());
}
function argRaws(cmd: Command): string[] {
  return cmd.args.map((a) => a.raw);
}

// ── 快速字面量扫描（AST 分析前拦截明显攻击）──

const DANGEROUS_LITERALS = [
  "rm -rf /", "rm -rf /*", "> /dev/sda",
  "mkfs.", "dd if=", ":(){ :|:& };:",
];
const INJECTION_MARKERS = ["$(", "`", "<<<"];

function fastLiteralScan(raw: string): ShellGuardResult | null {
  const low = raw.toLowerCase();
  for (const lit of DANGEROUS_LITERALS) {
    if (low.includes(lit)) return { allowed: false, reason: `blocked literal: ${lit}` };
  }
  for (const m of INJECTION_MARKERS) {
    if (raw.includes(m)) return { allowed: false, reason: `disallowed pattern (injection): ${m}` };
  }
  return null;
}

// ═══ 规则 1：策略配置评估 ═══

function checkPolicy(cmd: Command, raw: string): ShellGuardResult | null {
  const name = cmd.name.toLowerCase();
  if (!name) return null;

  const config = getDefaultPolicyConfig();
  const result = evaluatePolicy("bash", raw, config);

  if (result.action === "deny") {
    return { allowed: false, reason: result.reason, matchedRule: result.matchedRule };
  }
  // "ask" 表示命令被允许但需要 UI 审批流程
  if (result.action === "ask") {
    return { allowed: true, requiresApproval: true, reason: result.reason, matchedRule: result.matchedRule };
  }
  return null;
}

// ═══ 规则 2：始终阻断的命令 ═══

function checkAlwaysBlocked(cmd: Command): ShellGuardResult | null {
  const name = cmd.name.toLowerCase();
  if (ALWAYS_BLOCKED_COMMANDS.has(name)) {
    return { allowed: false, reason: `blocked command: ${name}` };
  }
  return null;
}

// ═══ 规则 2b：系统路径上的 rm ═══

const SYSTEM_PATHS = new Set([
  "/", "/etc", "/usr", "/bin", "/sbin", "/lib", "/lib64",
  "/var", "/sys", "/proc", "/dev", "/boot", "/root",
]);

function isSystemPath(arg: string): boolean {
  if (SYSTEM_PATHS.has(arg)) return true;
  const normalized = arg.replace(/\*+$/, "").replace(/\/*$/, "");
  if (SYSTEM_PATHS.has(normalized)) return true;
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
      return { allowed: false, reason: `blocked: removing system path "${arg.value}"` };
    }
  }
  return null;
}

// ═══ 规则 3：注入/混淆 ═══

function checkInjection(cmd: Command): ShellGuardResult | null {
  for (const arg of cmd.args) {
    if (arg.hasSubstitution) return { allowed: false, reason: "blocked: command substitution in arguments" };
  }
  for (const arg of cmd.args) {
    if (arg.raw.includes("<<<")) return { allowed: false, reason: "blocked: here-string" };
  }
  return null;
}

// ═══ 规则 4：管道数据泄露 ═══

function checkDataExfiltration(pipeline: Pipeline): ShellGuardResult | null {
  const cmds = pipeline.commands;
  if (cmds.length < 2) return null;

  const netIndices: number[] = [];
  for (let i = 0; i < cmds.length; i++) {
    const name = cmds[i]!.name.toLowerCase();
    if (NETWORK_COMMANDS.has(name)) netIndices.push(i);
  }
  if (netIndices.length === 0) return null;

  for (const netIdx of netIndices) {
    const netCmd = cmds[netIdx]!;
    const netArgs = argValues(netCmd);

    // 管道 + 上传标志 → 泄露
    const hasUploadFlag = netArgs.some((a) =>
      [...NETWORK_UPLOAD_FLAGS].some((f) => a === f || a.startsWith(f)),
    );
    if (hasUploadFlag) return { allowed: false, reason: "blocked: pipe to network upload command" };

    // 敏感读取命令 + 管道到网络命令 → 泄露
    for (let i = 0; i < netIdx; i++) {
      const prev = cmds[i]!;
      const prevName = prev.name.toLowerCase();
      if (SENSITIVE_READ_COMMANDS.has(prevName)) {
        return { allowed: false, reason: "blocked: sensitive data piped to network command" };
      }
      if (prevName === "tar" || prevName === "zip") {
        const prevArgs = argValues(prev);
        if (prevArgs.includes("-c") || prevArgs.includes("-cf") || prevArgs.includes("-czf")) {
          return { allowed: false, reason: "blocked: archive piped to network command" };
        }
      }
    }
  }
  return null;
}

// ═══ 规则 5：破坏性内联脚本 ═══

function checkDestructiveScript(cmd: Command): ShellGuardResult | null {
  const name = cmd.name.toLowerCase();
  if (!SCRIPT_INTERPRETERS.has(name)) return null;

  const args = argValues(cmd);
  const rawArgs = argRaws(cmd);
  let scriptIndex = -1;
  for (let i = 0; i < args.length; i++) {
    if (SCRIPT_INLINE_FLAGS.has(args[i]!)) { scriptIndex = i + 1; break; }
  }
  if (scriptIndex < 0 || scriptIndex >= rawArgs.length) return null;

  const scriptRaw = rawArgs[scriptIndex]!;
  const script = scriptRaw.replace(/^["'](.*)["']$/, "$1");
  for (const pat of DANGEROUS_SCRIPT_PATTERNS) {
    if (pat.test(script)) return { allowed: false, reason: "blocked: destructive inline script" };
  }
  return null;
}

// ═══ 规则 6：危险重定向 ═══

function checkRedirects(cmd: Command): ShellGuardResult | null {
  for (const redir of cmd.redirects) {
    const target = redir.target.toLowerCase();
    if (target.startsWith("/dev/sd") || target.startsWith("/dev/hd")) {
      return { allowed: false, reason: `blocked: redirect to block device ${redir.target}` };
    }
    if (target === "/dev/null") continue;
    if (redir.op === ">" || redir.op === ">>" || redir.op === ">&") {
      if (target.startsWith("/etc/") || target.startsWith("/usr/") ||
          target.startsWith("/bin/") || target.startsWith("/sbin/") || target === "/") {
        return { allowed: false, reason: `blocked: overwrite redirect to system path ${redir.target}` };
      }
    }
  }
  return null;
}

// ═════════════════════════════════════════════════════════════
// 顶层分析器
// ═════════════════════════════════════════════════════════════

/**
 * 分析命令行 AST 并返回安全判定。
 *
 * 分析流程：
 * 1. 快速字面量扫描（仅不含引号时 — 避免误杀字符串中的命令文本）
 * 2. 遍历每个命令节点，依次执行规则 1-6
 *    - deny → 立即返回阻断
 *    - ask → 记住但不阻断（等所有规则检查完）
 * 3. 遍历管道节点，检查数据泄露
 * 4. 检查独立的上传命令
 * 5. 无阻断 + 有 ask → 返回审批要求
 */
export function analyzeCommandLine(
  ast: ASTNode,
  raw: string,
): ShellGuardResult {
  // 1. 快速字面量扫描
  const hasQuotes = raw.includes('"') || raw.includes("'");
  if (!hasQuotes) {
    const fast = fastLiteralScan(raw);
    if (fast) return fast;
  }

  let approval: ShellGuardResult | undefined;

  // 2. 遍历每个命令
  for (const cmd of walkCommands(ast)) {
    const r0 = checkPolicy(cmd, raw);
    if (r0 && !r0.allowed) return r0;          // deny → 立即阻断
    if (r0?.requiresApproval) approval = r0;    // ask → 记住，继续检查

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

  // 3. 管道泄露检查
  for (const pipeline of walkPipelines(ast)) {
    const r5 = checkDataExfiltration(pipeline);
    if (r5) return r5;
  }

  // 4. 独立上传命令检查
  const nodes = flattenGroups(ast);
  for (const node of nodes) {
    if (node.type === "command") {
      const name = node.name.toLowerCase();
      if (NETWORK_COMMANDS.has(name)) {
        const args = argValues(node);
        const hasUploadFlag = args.some((a) =>
          [...NETWORK_UPLOAD_FLAGS].some((f) => a === f || a.startsWith(f)),
        );
        if (hasUploadFlag) return { allowed: false, reason: "blocked: network upload command" };
      }
    }
  }

  // 如果有 ask 等待且没被阻断 → 返回审批要求
  if (approval) return approval;

  return { allowed: true };
}
