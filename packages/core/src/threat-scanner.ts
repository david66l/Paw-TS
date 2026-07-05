/**
 * 威胁扫描器：检测 prompt 注入、外泄、C2 攻击模式。
 *
 * 对标 hermes tools/threat_patterns.py，完整移植 40+ 条规则 + 不可见 Unicode 检测。
 *
 * 三级 scope 体系（与 hermes 一致）：
 * - "all"：经典注入 + 外泄（最少误报，适用所有文本）
 * - "context"：上面 + promptware / C2 / 角色劫持（适用上下文文件、工具输出）
 * - "strict"：上面 + 持久化 / SSH / 密钥（适用记忆写入、skill 安装等用户可控路径）
 *
 * 实现细节（与 hermes 对齐）：
 * - NFKC 归一化：折叠全角/兼容性变体（如 ｃａｔ → cat），防同形异义绕过
 * - 有界填充：模式间用 (?:\\w+\\s+){0,8} 替代 .*，防止回溯爆炸
 * - 不可见 Unicode：17 个已知攻击码点（zero-width space, RTL override 等）
 * - 扫描上限：65,536 字符，防止超大输入导致正则回溯
 *
 * 移植要点：
 * - Python re.IGNORECASE → JS RegExp('pattern', 'i')
 * - Python frozenset → JS Set<string>
 * - Python unicodedata.normalize('NFKC') → JS String.prototype.normalize('NFKC')
 */

// ── 常量 ─────────────────────────────────────────────────

/** 扫描字符上限（与 hermes 一致：65,536） */
const MAX_SCAN_CHARS = 65_536;

/** 有界填充词：替代 .* 防止正则回溯爆炸 */
const F = String.raw`(?:\w+\s+){0,8}`;

// ── 不可见 Unicode 字符集（17 个码点） ─────────────────────

const INVISIBLE_CHARS = new Set([
  "​", // zero-width space
  "‌", // zero-width non-joiner
  "‍", // zero-width joiner
  "⁠", // word joiner
  "⁢", // invisible times
  "⁣", // invisible separator
  "⁤", // invisible plus
  "﻿", // zero-width no-break space (BOM)
  "‪", // left-to-right embedding
  "‫", // right-to-left embedding
  "‬", // pop directional formatting
  "‭", // left-to-right override
  "‮", // right-to-left override
  "⁦", // left-to-right isolate
  "⁧", // right-to-left isolate
  "⁨", // first strong isolate
  "⁩", // pop directional isolate
]);

// ── 威胁模式 ──────────────────────────────────────────────

interface ThreatPattern {
  readonly regex: RegExp;
  readonly id: string;
}

/** scope → compiled patterns */
const _PATTERNS: Record<string, ThreatPattern[]> = {};

function definePatterns(): void {
  if (Object.keys(_PATTERNS).length > 0) return;

  const all: ThreatPattern[] = [];
  const context: ThreatPattern[] = [];
  const strict: ThreatPattern[] = [];

  /**
   * 注册一个模式。scope 语义：
   * - "all" → 加入 all + context + strict
   * - "context" → 加入 context + strict
   * - "strict" → 只加入 strict
   */
  function p(pattern: string, id: string, scope: "all" | "context" | "strict"): void {
    const entry: ThreatPattern = { regex: new RegExp(pattern, "i"), id };
    if (scope === "all") {
      all.push(entry);
      context.push(entry);
      strict.push(entry);
    } else if (scope === "context") {
      context.push(entry);
      strict.push(entry);
    } else {
      strict.push(entry);
    }
  }

  // ═══ Classic prompt injection (all) ═══
  p(String.raw`ignore\s+${F}(previous|all|above|prior)\s+${F}instructions`, "prompt_injection", "all");
  p(String.raw`system\s+prompt\s+override`, "sys_prompt_override", "all");
  p(String.raw`disregard\s+${F}(your|all|any)\s+${F}(instructions|rules|guidelines)`, "disregard_rules", "all");
  p(String.raw`act\s+as\s+(if|though)\s+${F}you\s+${F}(have\s+no|don't\s+have)\s+${F}(restrictions|limits|rules)`, "bypass_restrictions", "all");
  p(String.raw`<!--[^>]{0,512}(?:ignore|override|system|secret|hidden)[^>]{0,512}-->`, "html_comment_injection", "all");
  p(String.raw`<\s*div\s+style\s*=\s*["'][^>]{0,2048}display\s*:\s*none`, "hidden_div", "all");
  p(String.raw`translate\s+[^\n]{0,512}\s+into\s+[^\n]{0,512}\s+and\s+(execute|run|eval)`, "translate_execute", "all");
  p(String.raw`do\s+not\s+${F}tell\s+${F}the\s+user`, "deception_hide", "all");

  // ═══ Role-play / identity hijack (context) ═══
  p(String.raw`you\s+are\s+${F}now\s+(?:a|an|the)\s+`, "role_hijack", "context");
  p(String.raw`pretend\s+${F}(you\s+are|to\s+be)\s+`, "role_pretend", "context");
  p(String.raw`output\s+${F}(system|initial)\s+prompt`, "leak_system_prompt", "context");
  p(String.raw`(respond|answer|reply)\s+without\s+${F}(restrictions|limitations|filters|safety)`, "remove_filters", "context");
  p(String.raw`you\s+have\s+been\s+${F}(updated|upgraded|patched)\s+to`, "fake_update", "context");
  p(String.raw`\bname\s+yourself\s+\w+`, "identity_override", "context");

  // ═══ C2 / Brainworm-style promptware (context) ═══
  p(String.raw`register\s+(as\s+)?a?\s*node`, "c2_node_registration", "context");
  p(String.raw`(heartbeat|beacon|check[\s\-]?in)\s+(to|with)\s+`, "c2_heartbeat", "context");
  p(String.raw`pull\s+(down\s+)?(?:new\s+)?task(?:ing|s)?\b`, "c2_task_pull", "context");
  p(String.raw`connect\s+to\s+the\s+network\b`, "c2_network_connect", "context");
  p(String.raw`you\s+must\s+(?:\w+\s+){0,3}(register|connect|report|beacon)\b`, "forced_action", "context");
  p(String.raw`only\s+use\s+one[\s\-]?liners?\b`, "anti_forensic_oneliner", "context");
  p(String.raw`never\s+${F}(?:create|write)\s+${F}(?:script|file)\s+${F}disk`, "anti_forensic_disk", "context");
  p(String.raw`unset\s+\w*(?:CLAUDE|CODEX|HERMES|AGENT|OPENAI|ANTHROPIC|PAW)\w*`, "env_var_unset_agent", "context");

  // ═══ Known C2 / red-team framework names (context) ═══
  p(String.raw`\b(?:cobalt\s*strike|sliver|havoc|mythic|metasploit|brainworm)\b`, "known_c2_framework", "context");
  p(String.raw`\bc2\s+(?:server|channel|infrastructure|beacon)\b`, "c2_explicit", "context");
  p(String.raw`\bcommand\s+and\s+control\b`, "c2_explicit_long", "context");

  // ═══ Exfiltration via curl/wget/cat (all) ═══
  p(String.raw`curl\s+[^\n]{0,2048}\$\{?\w*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)`, "exfil_curl", "all");
  p(String.raw`wget\s+[^\n]{0,2048}\$\{?\w*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)`, "exfil_wget", "all");
  p(String.raw`cat\s+[^\n]{0,2048}(?:\.env|credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)`, "read_secrets", "all");
  p(String.raw`(?:send|post|upload|transmit)\s+[^\n]{0,2048}\s+(?:to|at)\s+https?://`, "send_to_url", "strict");
  p(String.raw`(?:include|output|print|share)\s+${F}(?:conversation|chat\s+history|previous\s+messages|full\s+context|entire\s+context)`, "context_exfil", "strict");

  // ═══ Persistence / SSH backdoor (strict) ═══
  p(String.raw`authorized_keys`, "ssh_backdoor", "strict");
  p(String.raw`\$HOME/\.ssh|\~/\.ssh`, "ssh_access", "strict");
  p(String.raw`\$HOME/\.hermes/\.env|\~/\.hermes/\.env`, "hermes_env", "strict");
  p(String.raw`(?:update|modify|edit|write|change|append|add\s+to)\s+[^\n]{0,2048}(?:AGENTS\.md|CLAUDE\.md|\.cursorrules|\.clinerules)`, "agent_config_mod", "strict");
  p(String.raw`(?:update|modify|edit|write|change|append|add\s+to)\s+[^\n]{0,2048}\.hermes/(?:config\.yaml|SOUL\.md)`, "hermes_config_mod", "strict");

  // ═══ Hardcoded secrets (strict) ═══
  p(String.raw`(?:api[_-]?key|token|secret|password)\s*[=:]\s*["'][A-Za-z0-9+/=_-]{20,}`, "hardcoded_secret", "strict");

  _PATTERNS["all"] = all;
  _PATTERNS["context"] = context;
  _PATTERNS["strict"] = strict;
}

// 初始化时编译
definePatterns();

// ── 公共 API ──────────────────────────────────────────────

/**
 * 扫描内容中的威胁模式。
 *
 * @param content - 要扫描的文本
 * @param scope - 扫描范围："all" | "context" | "strict"（默认 "context"）
 * @returns 匹配到的模式 ID 列表
 */
export function scanForThreats(
  content: string,
  scope: "all" | "context" | "strict" = "context",
): string[] {
  if (!content) return [];

  const findings: string[] = [];
  const text = content.slice(0, MAX_SCAN_CHARS);

  // 不可见 Unicode 检测（在 NFKC 归一化之前执行 —— 归一化可能剥离部分码点）
  const charSet = new Set(text);
  for (const ch of INVISIBLE_CHARS) {
    if (charSet.has(ch)) {
      findings.push(`invisible_unicode_U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`);
    }
  }

  // NFKC 归一化：折叠全角/兼容性变体（ｃａｔ → cat）
  const normalized = text.normalize("NFKC");

  // 威胁模式扫描
  const patterns = _PATTERNS[scope];
  if (!patterns) {
    throw new Error(`scanForThreats: unknown scope ${scope}`);
  }
  for (const { regex, id } of patterns) {
    if (regex.test(normalized)) {
      findings.push(id);
    }
  }

  return findings;
}

/**
 * 返回第一个威胁的可读描述，无威胁时返回 null。
 *
 * 用于写入路径的阻断判断（类似 hermes first_threat_message）。
 */
export function firstThreatMessage(
  content: string,
  scope: "all" | "context" | "strict" = "strict",
): string | null {
  const findings = scanForThreats(content, scope);
  if (findings.length === 0) return null;
  const pid = findings[0]!;
  if (pid.startsWith("invisible_unicode_")) {
    const codepoint = pid.replace("invisible_unicode_", "");
    return `Blocked: content contains invisible unicode character ${codepoint} (possible injection).`;
  }
  return (
    `Blocked: content matches threat pattern '${pid}'. ` +
    `Content is injected into the system prompt and must not contain ` +
    `injection or exfiltration payloads.`
  );
}
