/**
 * Policy configuration types and loader.
 *
 * Supports three action levels:
 *   allow  — execute without confirmation
 *   ask    — require user approval
 *   deny   — block execution
 *
 * Rules are matched in order; the LAST matching rule wins (allowing
 * fine-grained overrides after broad defaults).
 */

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

export type PolicyAction = "allow" | "ask" | "deny";

export interface PolicyRule {
  readonly pattern: string;
  readonly action: PolicyAction;
  readonly reason?: string;
}

export interface ToolPolicy {
  readonly defaultAction: PolicyAction;
  readonly rules: PolicyRule[];
}

export interface PolicyConfig {
  readonly version: string;
  readonly defaultAction: PolicyAction;
  readonly tools: Record<string, ToolPolicy>;
}

// ---------------------------------------------------------------------------
// Built-in defaults (production-safe conservative baseline)
// ---------------------------------------------------------------------------

const BUILTIN_SAFE_COMMANDS = [
  "ls", "cat", "head", "tail", "grep", "rg", "find", "echo", "printf",
  "pwd", "env", "printenv", "which", "whereis", "date", "id", "whoami",
  "wc", "stat", "file", "strings", "jq", "awk", "cut", "sort", "uniq",
  "tr", "sed", "less", "more", "true", "false",
];

const BUILTIN_CAUTION_COMMANDS = [
  "rm", "cp", "mv", "mkdir", "rmdir", "touch", "chmod", "chown", "ln",
];

const BUILTIN_DANGEROUS_COMMANDS = [
  "sudo", "su", "mkfs", "mkfs.ext4", "mkfs.ext3", "mkfs.ntfs",
  "shred", "dd", "fdisk", "parted",
];

const BUILTIN_NETWORK_COMMANDS = [
  "curl", "wget", "nc", "ncat", "netcat", "ssh", "scp", "sftp",
];

function builtinRules(): PolicyConfig {
  const safeRules: PolicyRule[] = BUILTIN_SAFE_COMMANDS.map((cmd) => ({
    pattern: `${cmd}*`,
    action: "allow" as const,
    reason: "safe read-only command",
  }));

  const cautionRules: PolicyRule[] = [
    ...BUILTIN_CAUTION_COMMANDS.map((cmd) => ({
      pattern: `${cmd}*`,
      action: "ask" as const,
      reason: "potentially mutating command",
    })),
    { pattern: "rm -rf /", action: "deny" as const, reason: "destructive: root deletion" },
    { pattern: "rm -r /", action: "deny" as const, reason: "destructive: root deletion" },
    { pattern: "rm -rf /*", action: "deny" as const, reason: "destructive: root glob" },
    { pattern: "rm -r /*", action: "deny" as const, reason: "destructive: root glob" },
    { pattern: "rm -rf /etc*", action: "deny" as const, reason: "destructive: system path" },
    { pattern: "rm -r /etc*", action: "deny" as const, reason: "destructive: system path" },
    { pattern: "rm /etc*", action: "deny" as const, reason: "destructive: system path" },
    { pattern: "rm -rf /usr*", action: "deny" as const, reason: "destructive: system path" },
    { pattern: "rm -r /usr*", action: "deny" as const, reason: "destructive: system path" },
    { pattern: "rm /usr*", action: "deny" as const, reason: "destructive: system path" },
    { pattern: "rm -rf /bin*", action: "deny" as const, reason: "destructive: system path" },
    { pattern: "rm -r /bin*", action: "deny" as const, reason: "destructive: system path" },
    { pattern: "rm /bin*", action: "deny" as const, reason: "destructive: system path" },
    { pattern: "rm -rf /sbin*", action: "deny" as const, reason: "destructive: system path" },
    { pattern: "rm -r /sbin*", action: "deny" as const, reason: "destructive: system path" },
    { pattern: "rm /sbin*", action: "deny" as const, reason: "destructive: system path" },
    { pattern: "rm -rf /lib*", action: "deny" as const, reason: "destructive: system path" },
    { pattern: "rm -r /lib*", action: "deny" as const, reason: "destructive: system path" },
    { pattern: "rm /lib*", action: "deny" as const, reason: "destructive: system path" },
    { pattern: "rm -rf /var*", action: "deny" as const, reason: "destructive: system path" },
    { pattern: "rm -r /var*", action: "deny" as const, reason: "destructive: system path" },
    { pattern: "rm /var*", action: "deny" as const, reason: "destructive: system path" },
    { pattern: "rm -rf /sys*", action: "deny" as const, reason: "destructive: system path" },
    { pattern: "rm -r /sys*", action: "deny" as const, reason: "destructive: system path" },
    { pattern: "rm /sys*", action: "deny" as const, reason: "destructive: system path" },
    { pattern: "rm -rf /proc*", action: "deny" as const, reason: "destructive: system path" },
    { pattern: "rm -r /proc*", action: "deny" as const, reason: "destructive: system path" },
    { pattern: "rm /proc*", action: "deny" as const, reason: "destructive: system path" },
    { pattern: "rm -rf /dev*", action: "deny" as const, reason: "destructive: system path" },
    { pattern: "rm -r /dev*", action: "deny" as const, reason: "destructive: system path" },
    { pattern: "rm /dev*", action: "deny" as const, reason: "destructive: system path" },
    { pattern: "rm -rf ~", action: "ask" as const, reason: "destructive: home directory" },
    { pattern: "rm -rf ~/.*", action: "ask" as const, reason: "destructive: hidden files in home" },
    { pattern: "git push --force*", action: "deny" as const, reason: "destructive git operation" },
    { pattern: "git push -f*", action: "deny" as const, reason: "destructive git operation" },
    { pattern: "git reset --hard*", action: "deny" as const, reason: "destructive git operation" },
    { pattern: "git clean -f*", action: "deny" as const, reason: "destructive git operation" },
    { pattern: "docker rm*", action: "deny" as const, reason: "destructive docker operation" },
    { pattern: "docker rmi*", action: "deny" as const, reason: "destructive docker operation" },
    { pattern: "docker system prune*", action: "deny" as const, reason: "destructive docker operation" },
    { pattern: "kubectl delete*", action: "deny" as const, reason: "destructive k8s operation" },
    { pattern: "pip uninstall*", action: "deny" as const, reason: "package removal" },
    { pattern: "npm uninstall*", action: "deny" as const, reason: "package removal" },
    { pattern: "npm rm*", action: "deny" as const, reason: "package removal" },
    { pattern: "cargo uninstall*", action: "deny" as const, reason: "package removal" },
    { pattern: "find* -delete*", action: "deny" as const, reason: "destructive find" },
    { pattern: "find* -exec rm*", action: "deny" as const, reason: "destructive find" },
  ];

  const dangerousRules: PolicyRule[] = BUILTIN_DANGEROUS_COMMANDS.map((cmd) => ({
    pattern: `${cmd}*`,
    action: "deny" as const,
    reason: "dangerous command",
  }));

  const networkRules: PolicyRule[] = [
    ...BUILTIN_NETWORK_COMMANDS.map((cmd) => ({
      pattern: `${cmd}*`,
      action: "ask" as const,
      reason: "network command",
    })),
    { pattern: "curl*--data*", action: "deny" as const, reason: "data upload" },
    { pattern: "curl*--data-binary*", action: "deny" as const, reason: "data upload" },
    { pattern: "curl*--data-raw*", action: "deny" as const, reason: "data upload" },
    { pattern: "wget*--post*", action: "deny" as const, reason: "data upload" },
  ];

  return {
    version: "1.0",
    defaultAction: "ask",
    tools: {
      bash: {
        defaultAction: "ask",
        rules: [
          ...safeRules,
          ...cautionRules,
          ...dangerousRules,
          ...networkRules,
          { pattern: "*sudo*", action: "deny" as const, reason: "privilege escalation" },
          { pattern: "*su*", action: "deny" as const, reason: "privilege escalation" },
          { pattern: "*chmod*", action: "ask" as const, reason: "permission change" },
          { pattern: "*chown*", action: "ask" as const, reason: "ownership change" },
          { pattern: "> /dev/sd*", action: "deny" as const, reason: "block device overwrite" },
          { pattern: "> /dev/hd*", action: "deny" as const, reason: "block device overwrite" },
        ],
      },
      read: {
        defaultAction: "allow",
        rules: [
          { pattern: "*.env", action: "ask" as const, reason: "sensitive file" },
          { pattern: "*.env.*", action: "ask" as const, reason: "sensitive file" },
          { pattern: "*id_rsa*", action: "deny" as const, reason: "private key" },
          { pattern: "*id_ed25519*", action: "deny" as const, reason: "private key" },
          { pattern: "*.pem", action: "ask" as const, reason: "certificate/key file" },
          { pattern: "*.key", action: "ask" as const, reason: "key file" },
          { pattern: "*secret*", action: "ask" as const, reason: "potential secret" },
          { pattern: "*password*", action: "ask" as const, reason: "potential secret" },
          { pattern: "*token*", action: "ask" as const, reason: "potential secret" },
          { pattern: "*credential*", action: "ask" as const, reason: "potential secret" },
        ],
      },
      edit: {
        defaultAction: "ask",
        rules: [
          { pattern: "*.env", action: "deny" as const, reason: "sensitive file" },
          { pattern: "*.env.*", action: "deny" as const, reason: "sensitive file" },
          { pattern: "*id_rsa*", action: "deny" as const, reason: "private key" },
          { pattern: "*id_ed25519*", action: "deny" as const, reason: "private key" },
          { pattern: "*.pem", action: "deny" as const, reason: "certificate/key file" },
          { pattern: "*.key", action: "deny" as const, reason: "key file" },
        ],
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Wildcard matching (simple glob: * matches any sequence, ? matches one char)
// ---------------------------------------------------------------------------

function globToRegex(pattern: string): RegExp {
  let re = "^";
  for (const ch of pattern) {
    if (ch === "*") re += ".*";
    else if (ch === "?") re += ".";
    else if (/[.+^${}()|[\]\\]/.test(ch)) re += "\\" + ch;
    else re += ch;
  }
  re += "$";
  return new RegExp(re, "i");
}

export function matchPattern(pattern: string, text: string): boolean {
  return globToRegex(pattern).test(text);
}

// ---------------------------------------------------------------------------
// Policy evaluation
// ---------------------------------------------------------------------------

export interface PolicyResult {
  readonly action: PolicyAction;
  readonly reason: string;
  readonly matchedRule?: string;
}

export function evaluatePolicy(
  toolId: string,
  commandText: string,
  config: PolicyConfig,
): PolicyResult {
  const toolPolicy = config.tools[toolId];
  if (!toolPolicy) {
    return {
      action: config.defaultAction,
      reason: `no policy defined for tool "${toolId}"`,
    };
  }

  // Find the LAST matching rule (overrides earlier broad rules)
  let lastMatch: PolicyRule | undefined;
  for (const rule of toolPolicy.rules) {
    if (matchPattern(rule.pattern, commandText)) {
      lastMatch = rule;
    }
  }

  if (lastMatch) {
    return {
      action: lastMatch.action,
      reason: lastMatch.reason || `matched rule: ${lastMatch.pattern}`,
      matchedRule: lastMatch.pattern,
    };
  }

  return {
    action: toolPolicy.defaultAction,
    reason: `default action for tool "${toolId}"`,
  };
}

// ---------------------------------------------------------------------------
// Singleton config instance
// ---------------------------------------------------------------------------

let _config: PolicyConfig | undefined;

export function getDefaultPolicyConfig(): PolicyConfig {
  if (!_config) {
    _config = builtinRules();
  }
  return _config;
}

export function setPolicyConfig(config: PolicyConfig): void {
  _config = config;
}

export function resetPolicyConfig(): void {
  _config = undefined;
}
