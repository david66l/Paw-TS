/**
 * Shell 策略配置类型定义与加载器。
 *
 * ## 功能概述
 * 本模块定义了 Shell 命令安全策略的完整数据结构，包括：
 *   - 核心类型（PolicyAction, PolicyRule, ToolPolicy, PolicyConfig）
 *   - 内置的生产安全默认规则集
 *   - 通配符匹配引擎
 *   - 策略评估算法
 *   - 单例配置实例管理
 *
 * ## 三级操作级别
 *
 * 系统支持三种策略动作（按严格程度递增）：
 *
 *   `allow` — 无需确认直接执行。适用于安全、稳定的只读命令。
 *   `ask`   — 需要用户审批。适用于可能有副作用的命令（如网络请求、文件写入）。
 *   `deny`  — 完全阻止执行。适用于破坏性操作（如 `rm -rf /`、`sudo`）。
 *
 * ## 规则匹配策略：最后匹配优先（Last-Match-Wins）
 *
 * 规则按数组顺序进行评估，但**最后一条匹配的规则生效**。
 * 这允许将宽泛的默认规则放在前面，精细的覆盖规则放在后面：
 *
 *   ```
 *   rules: [
 *     { pattern: "rm*",     action: "ask"  },  // 宽泛默认：删除操作需确认
 *     { pattern: "rm -rf /", action: "deny" },  // 精细覆盖：根目录删除完全禁止
 *   ]
 *   ```
 *
 * 这种设计避免了排序逻辑的复杂性——只需追加更具体的规则即可覆盖。
 *
 * ## 内置规则集的分层设计
 *
 * 内置规则按风险级别分为四层（从宽松到严格）：
 *
 *   1. **安全命令（safeRules）**: `ls`, `cat`, `grep` 等 → `allow`
 *   2. **谨慎命令（cautionRules）**: `rm`, `cp`, `mv` 等 → `ask`（需确认）
 *      - 包含针对根目录/系统路径的具体 deny 规则覆盖
 *   3. **危险命令（dangerousRules）**: `sudo`, `dd`, `mkfs` 等 → `deny`
 *   4. **网络命令（networkRules）**: `curl`, `wget`, `ssh` 等 → `ask`
 *      - 包含带数据上传标志的 deny 覆盖（如 `curl --data`）
 *
 * 除了 bash 工具外，还定义了 `read`（读文件）和 `edit`（编辑文件）工具的
 * 策略，保护敏感文件（`.env`, `*.pem`, 私钥等）。
 *
 * ## 设计决策
 *
 * 1. **单例配置**：
 *    使用模块级变量 `_config` 持有全局策略配置。`getDefaultPolicyConfig()`
 *    在首次调用时惰性初始化，后续调用返回同一实例。`setPolicyConfig()` 允许
 *    运行时覆盖（如从配置文件加载自定义规则），`resetPolicyConfig()` 恢复默认。
 *
 * 2. **通配符匹配**：
 *    支持简单的 glob 语法：`*` 匹配任意字符序列，`?` 匹配单个字符。
 *    模式匹配时忽略大小写（`i` 标志），防止大小写绕过。
 *
 * 3. **模式字符串转正则**：
 *    内部将 glob 模式转为 `RegExp` 进行匹配。特殊正则字符（如 `.^${}` 等）
 *    被正确转义，只有 `*` 和 `?` 具有通配符语义。
 */

// ---------------------------------------------------------------------------
// 核心类型
// ---------------------------------------------------------------------------

/** 策略动作：allow（放行）/ ask（询问）/ deny（拒绝） */
export type PolicyAction = "allow" | "ask" | "deny";

/** 单条策略规则 */
export interface PolicyRule {
  /** 匹配模式（glob 语法），作用于命令文本（含参数） */
  readonly pattern: string;
  /** 命中此规则时的动作 */
  readonly action: PolicyAction;
  /** 命中原因（人类可读，用于 UI 提示和审计日志） */
  readonly reason?: string;
}

/** 单个工具的完整策略 */
export interface ToolPolicy {
  /** 默认动作（无规则命中时使用） */
  readonly defaultAction: PolicyAction;
  /** 规则列表，最后匹配优先 */
  readonly rules: PolicyRule[];
}

/** 顶层策略配置 */
export interface PolicyConfig {
  /** 策略版本号 */
  readonly version: string;
  /** 全局默认动作（未定义的工具使用此动作） */
  readonly defaultAction: PolicyAction;
  /** 各工具的策略映射，key 为工具 ID（如 "bash", "read", "edit"） */
  readonly tools: Record<string, ToolPolicy>;
}

// ---------------------------------------------------------------------------
// 内置默认规则（生产安全的保守基线）
// ---------------------------------------------------------------------------

/** 安全命令列表 — 只读且无副作用，可直接放行 */
const BUILTIN_SAFE_COMMANDS = [
  "ls", "cat", "head", "tail", "grep", "rg", "find", "echo", "printf",
  "pwd", "env", "printenv", "which", "whereis", "date", "id", "whoami",
  "wc", "stat", "file", "strings", "jq", "awk", "cut", "sort", "uniq",
  "tr", "sed", "less", "more", "true", "false",
];

/** 谨慎命令列表 — 有写操作但通常是正常使用，需要用户确认 */
const BUILTIN_CAUTION_COMMANDS = [
  "rm", "cp", "mv", "mkdir", "rmdir", "touch", "chmod", "chown", "ln",
];

/** 危险命令列表 — 系统级破坏性操作，完全禁止 */
const BUILTIN_DANGEROUS_COMMANDS = [
  "sudo", "su", "mkfs", "mkfs.ext4", "mkfs.ext3", "mkfs.ntfs",
  "shred", "dd", "fdisk", "parted",
];

/** 网络命令列表 — 可能泄露数据或下载恶意内容，需要确认 */
const BUILTIN_NETWORK_COMMANDS = [
  "curl", "wget", "nc", "ncat", "netcat", "ssh", "scp", "sftp",
];

/**
 * 构建完整的默认策略配置。
 *
 * 分层设计：
 *   1. safeRules → allow（只读命令直接放行）
 *   2. cautionRules → ask + 具体的 deny 覆盖
 *      - `rm` 等基本放行为 ask，但针对根目录/系统路径的特殊模式设为 deny
 *      - git force push、kubectl delete、docker rm 等设为 deny
 *   3. dangerousRules → deny（系统级危险命令完全禁止）
 *   4. networkRules → ask + 上传数据的 deny 覆盖
 *
 * 附加工具策略：
 *   - `read`: 默认 allow，但敏感文件（.env、私钥等）设为 ask/deny
 *   - `edit`: 默认 ask，敏感文件设为 deny
 *
 * @returns 完整的默认策略配置对象
 */
function builtinRules(): PolicyConfig {
  /** 安全命令规则 — 全部 allow */
  const safeRules: PolicyRule[] = BUILTIN_SAFE_COMMANDS.map((cmd) => ({
    pattern: `${cmd}*`,
    action: "allow" as const,
    reason: "safe read-only command",
  }));

  /** 谨慎命令规则 — 默认 ask + 具体的 deny 覆盖 */
  const cautionRules: PolicyRule[] = [
    // 宽泛默认：文件操作需确认
    ...BUILTIN_CAUTION_COMMANDS.map((cmd) => ({
      pattern: `${cmd}*`,
      action: "ask" as const,
      reason: "potentially mutating command",
    })),
    // ---- 根目录删除：最高危，直接 deny ----
    { pattern: "rm -rf /", action: "deny" as const, reason: "destructive: root deletion" },
    { pattern: "rm -r /", action: "deny" as const, reason: "destructive: root deletion" },
    { pattern: "rm -rf /*", action: "deny" as const, reason: "destructive: root glob" },
    { pattern: "rm -r /*", action: "deny" as const, reason: "destructive: root glob" },
    // ---- 系统目录删除：禁止触碰 /etc, /usr, /bin, /sbin, /lib, /var, /sys, /proc, /dev ----
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
    // ---- 家目录删除：高危，至少 ask ----
    { pattern: "rm -rf ~", action: "ask" as const, reason: "destructive: home directory" },
    { pattern: "rm -rf ~/.*", action: "ask" as const, reason: "destructive: hidden files in home" },
    // ---- 高危 git 操作 ----
    { pattern: "git push --force*", action: "deny" as const, reason: "destructive git operation" },
    { pattern: "git push -f*", action: "deny" as const, reason: "destructive git operation" },
    { pattern: "git reset --hard*", action: "deny" as const, reason: "destructive git operation" },
    { pattern: "git clean -f*", action: "deny" as const, reason: "destructive git operation" },
    // ---- 容器/集群危险操作 ----
    { pattern: "docker rm*", action: "deny" as const, reason: "destructive docker operation" },
    { pattern: "docker rmi*", action: "deny" as const, reason: "destructive docker operation" },
    { pattern: "docker system prune*", action: "deny" as const, reason: "destructive docker operation" },
    { pattern: "kubectl delete*", action: "deny" as const, reason: "destructive k8s operation" },
    // ---- 包管理器的卸载操作 ----
    { pattern: "pip uninstall*", action: "deny" as const, reason: "package removal" },
    { pattern: "npm uninstall*", action: "deny" as const, reason: "package removal" },
    { pattern: "npm rm*", action: "deny" as const, reason: "package removal" },
    { pattern: "cargo uninstall*", action: "deny" as const, reason: "package removal" },
    // ---- 带删除的 find ----
    { pattern: "find* -delete*", action: "deny" as const, reason: "destructive find" },
    { pattern: "find* -exec rm*", action: "deny" as const, reason: "destructive find" },
  ];

  /** 危险命令规则 — 全部 deny */
  const dangerousRules: PolicyRule[] = BUILTIN_DANGEROUS_COMMANDS.map((cmd) => ({
    pattern: `${cmd}*`,
    action: "deny" as const,
    reason: "dangerous command",
  }));

  /** 网络命令规则 — 默认 ask + 上传数据的 deny 覆盖 */
  const networkRules: PolicyRule[] = [
    ...BUILTIN_NETWORK_COMMANDS.map((cmd) => ({
      pattern: `${cmd}*`,
      action: "ask" as const,
      reason: "network command",
    })),
    // 带数据上传标志的网络命令直接禁止
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
          // 额外的特权提升/系统修改模式
          { pattern: "*sudo*", action: "deny" as const, reason: "privilege escalation" },
          { pattern: "*su*", action: "deny" as const, reason: "privilege escalation" },
          { pattern: "*chmod*", action: "ask" as const, reason: "permission change" },
          { pattern: "*chown*", action: "ask" as const, reason: "ownership change" },
          // 块设备覆写重定向
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
// 通配符匹配（简单 glob: * 匹配任意字符序列, ? 匹配单个字符）
// ---------------------------------------------------------------------------

/**
 * 将 glob 模式转换为等价的正则表达式。
 *
 * 转换规则：
 *   - `*` → `.*`（匹配任意字符序列）
 *   - `?` → `.`（匹配单个字符）
 *   - 正则特殊字符 → 转义（`.^${}()[]\\|` 等）
 *
 * 生成的正则使用 `i` 标志（忽略大小写），防止大小写变化绕过模式匹配。
 *
 * @param pattern - glob 模式字符串
 * @returns 等价的正则表达式（带 i 标志）
 */
function globToRegex(pattern: string): RegExp {
  let re = "^";
  for (const ch of pattern) {
    if (ch === "*") re += ".*";
    else if (ch === "?") re += ".";
    // 转义正则特殊字符
    else if (/[.+^${}()|[\]\\]/.test(ch)) re += "\\" + ch;
    else re += ch;
  }
  re += "$";
  return new RegExp(re, "i");  // 忽略大小写
}

/**
 * 测试文本是否匹配给定的 glob 模式。
 *
 * @param pattern - glob 模式字符串
 * @param text - 待匹配的文本
 * @returns 是否匹配
 */
export function matchPattern(pattern: string, text: string): boolean {
  return globToRegex(pattern).test(text);
}

// ---------------------------------------------------------------------------
// 策略评估
// ---------------------------------------------------------------------------

/** 策略评估结果 */
export interface PolicyResult {
  /** 最终裁决动作 */
  readonly action: PolicyAction;
  /** 裁决原因（人类可读） */
  readonly reason: string;
  /** 匹配到的规则模式（如果有），用于审计和调试 */
  readonly matchedRule?: string;
}

/**
 * 对给定的命令文本评估策略，返回最终裁决。
 *
 * 评估算法：
 *   1. 查找工具 ID 对应的 ToolPolicy
 *      - 无对应策略 → 使用全局 `config.defaultAction`
 *   2. 遍历该工具的所有规则，找到**最后一条匹配的规则**
 *      - 最后匹配优先（Last-Match-Wins）：允许宽泛默认 + 精细覆盖
 *   3. 无规则命中 → 使用该工具的 `defaultAction`
 *
 * @param toolId - 工具标识符（如 "bash", "read", "edit"）
 * @param commandText - 命令文本（对于 bash）或文件路径（对于 read/edit）
 * @param config - 当前生效的策略配置
 * @returns 策略评估结果
 */
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

  // 找到最后一条匹配的规则（Last-Match-Wins 策略）
  let lastMatch: PolicyRule | undefined;
  for (const rule of toolPolicy.rules) {
    if (matchPattern(rule.pattern, commandText)) {
      lastMatch = rule;  // 覆盖之前的匹配，保留最后一条
    }
  }

  if (lastMatch) {
    return {
      action: lastMatch.action,
      reason: lastMatch.reason || `matched rule: ${lastMatch.pattern}`,
      matchedRule: lastMatch.pattern,
    };
  }

  // 无规则命中 → 使用该工具的默认动作
  return {
    action: toolPolicy.defaultAction,
    reason: `default action for tool "${toolId}"`,
  };
}

// ---------------------------------------------------------------------------
// 单例配置实例管理
// ---------------------------------------------------------------------------

/** 全局策略配置实例（惰性初始化） */
let _config: PolicyConfig | undefined;

/**
 * 获取默认策略配置。
 *
 * 首次调用时惰性构建内置默认规则，后续调用返回同一实例。
 * 使用 `setPolicyConfig()` 覆盖，`resetPolicyConfig()` 恢复默认。
 *
 * @returns 当前生效的策略配置
 */
export function getDefaultPolicyConfig(): PolicyConfig {
  if (!_config) {
    _config = builtinRules();
  }
  return _config;
}

/**
 * 设置自定义策略配置（运行时覆盖）。
 *
 * 可用于从配置文件加载用户自定义规则，或在不同环境（开发/生产）间切换策略。
 *
 * @param config - 新的策略配置
 */
export function setPolicyConfig(config: PolicyConfig): void {
  _config = config;
}

/**
 * 重置策略配置为内置默认值。
 *
 * 放弃所有运行时自定义规则，恢复为生产安全的保守基线。
 * 通常在测试清理或"恢复默认设置"场景中使用。
 */
export function resetPolicyConfig(): void {
  _config = undefined;
}
