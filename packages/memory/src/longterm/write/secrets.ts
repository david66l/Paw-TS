/**
 * Secret Interceptor（spec v2 §5.5）—— 纯函数，可单测
 *
 * 蒸馏前与入库前双道调用：
 * - 命中已知密钥模式（sk-/ghp_/-----BEGIN/云厂商 key…）→ reject：整条拒写
 * - 仅命中高熵字符串（entropy>4.5 且长度≥20，可能是 base64/hash/token 化 ID）→ redact：
 *   该字符串打码为 [REDACTED] 后照常入库（避免误报吞掉正常记忆）
 */

export type SecretScanResult =
  | { action: "pass" }
  | { action: "reject"; pattern: string; match: string }
  | { action: "redact"; text: string; count: number };

interface KnownPattern {
  name: string;
  re: RegExp;
}

/** 已知密钥模式：命中即整条拒写 */
const KNOWN_PATTERNS: KnownPattern[] = [
  // OpenAI / Anthropic 风格 API key
  { name: "api-key:sk", re: /\bsk-[A-Za-z0-9_-]{20,}/ },
  // GitHub tokens
  { name: "github:pat", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/ },
  { name: "github:fine-grained", re: /\bgithub_pat_[A-Za-z0-9_]{20,}/ },
  // PEM 私钥块
  { name: "pem:private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  // AWS Access Key ID
  { name: "aws:access-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  // Google API key
  { name: "google:api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  // Slack tokens
  { name: "slack:token", re: /\bxox[baprs]-[0-9A-Za-z-]{10,}/ },
  // GitLab PAT
  { name: "gitlab:pat", re: /\bglpat-[A-Za-z0-9_-]{20,}/ },
  // JWT（三段式 base64url）
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/ },
];

/** 高熵候选 token：base64/hex/url-safe 字符，长度 ≥20 */
const ENTROPY_TOKEN_RE = /[A-Za-z0-9+/=_-]{20,}/g;
const ENTROPY_THRESHOLD = 4.5;

export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function isHighEntropyToken(token: string): boolean {
  return token.length >= 20 && shannonEntropy(token) > ENTROPY_THRESHOLD;
}

/**
 * 扫描文本中的密钥。优先级：已知模式（reject）> 高熵（redact）> pass。
 */
export function scanForSecrets(text: string): SecretScanResult {
  for (const { name, re } of KNOWN_PATTERNS) {
    const m = re.exec(text);
    if (m) return { action: "reject", pattern: name, match: m[0].slice(0, 12) + "…" };
  }

  let count = 0;
  const redacted = text.replace(ENTROPY_TOKEN_RE, (token) => {
    if (isHighEntropyToken(token)) {
      count += 1;
      return "[REDACTED]";
    }
    return token;
  });

  return count > 0 ? { action: "redact", text: redacted, count } : { action: "pass" };
}
