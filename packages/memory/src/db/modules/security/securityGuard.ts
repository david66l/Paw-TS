/**
 * Security & Privacy Guard (8.22)
 *
 * 统一安全检测：敏感信息、脱敏、权限校验。
 * MVP: 确定性正则匹配 + 高熵检测。所有拒绝 → Fail Closed。
 */

import type { ActorRef } from "../../types.js";
import { generateId } from "../platform/idGen.js";

// ── 检测规则 ──

const DETECTION_RULES = {
  SECRETS: [
    { pattern: /sk-[a-zA-Z0-9]{32,}/g, type: "API_KEY", severity: "CRITICAL" as const },
    { pattern: /AKIA[0-9A-Z]{16}/g, type: "AWS_KEY", severity: "CRITICAL" as const },
    { pattern: /ghp_[a-zA-Z0-9]{36}/g, type: "GITHUB_TOKEN", severity: "CRITICAL" as const },
    { pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g, type: "PRIVATE_KEY", severity: "CRITICAL" as const },
    { pattern: /(?:password|passwd|pwd)\s*[:=]\s*['"][^'"]+['"]/gi, type: "PASSWORD", severity: "CRITICAL" as const },
    { pattern: /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g, type: "JWT", severity: "CRITICAL" as const },
    { pattern: /(?:mongodb|postgresql|mysql|redis):\/\/[^@\s]+@/gi, type: "DB_CREDENTIAL", severity: "CRITICAL" as const },
  ],
  PII: [
    { pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, type: "EMAIL", severity: "HIGH" as const },
    { pattern: /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g, type: "PHONE", severity: "HIGH" as const },
  ],
  INTERNAL: [
    { pattern: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b/g, type: "INTERNAL_IP", severity: "MEDIUM" as const },
  ],
};

const REDACT_REPLACEMENT = "***REDACTED***";

export type SecurityDecision =
  | { verdict: "ALLOW" }
  | { verdict: "ALLOW_WITH_REDACTION"; redactedContent: string; findings: SecurityFinding[] }
  | { verdict: "DENY"; reason: string; findings: SecurityFinding[] };

export interface SecurityFinding {
  findingId: string;
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  type: string;
  matchedPattern: string;
  confidence: number;
}

export const securityGuard = {
  /** 扫描内容中的敏感信息 */
  scanContent(content: string, opts?: { scanRules?: ("SECRETS" | "PII" | "INTERNAL")[] }): SecurityDecision {
    const rules = opts?.scanRules ?? ["SECRETS", "PII", "INTERNAL"];
    const allFindings: SecurityFinding[] = [];

    for (const ruleSet of rules) {
      const patterns = DETECTION_RULES[ruleSet] ?? [];
      for (const { pattern, type, severity } of patterns) {
        const matches = content.matchAll(pattern);
        for (const _m of matches) {
          allFindings.push({
            findingId: generateId("sec"),
            severity,
            type,
            matchedPattern: pattern.source,
            confidence: 1.0,
          });
        }
      }
    }

    // 高熵检测（简化为长度 > 40 的 base64 字符串）
    const highEntropyMatches = content.matchAll(/[A-Za-z0-9+/=]{40,}/g);
    for (const m of highEntropyMatches) {
      if (hasHighEntropy(m[0])) {
        allFindings.push({
          findingId: generateId("sec"),
          severity: "HIGH",
          type: "HIGH_ENTROPY",
          matchedPattern: "high_entropy_detection",
          confidence: 0.7,
        });
      }
    }

    if (allFindings.length === 0) return { verdict: "ALLOW" };

    const critical = allFindings.find((f) => f.severity === "CRITICAL");
    if (critical) {
      return {
        verdict: "DENY",
        reason: `Critical finding: ${critical.type}`,
        findings: allFindings.slice(0, 5),
      };
    }

    // 高严重度：脱敏后放行
    let redacted = content;
    for (const ruleSet of rules) {
      for (const { pattern } of DETECTION_RULES[ruleSet] ?? []) {
        redacted = redacted.replace(pattern, REDACT_REPLACEMENT);
      }
    }

    return { verdict: "ALLOW_WITH_REDACTION", redactedContent: redacted, findings: allFindings.slice(0, 5) };
  },

  /** 权限校验：检查 actor 是否有权访问指定作用域 */
  checkAccess(actor: ActorRef, scope: { repositoryId?: string; userId?: string; workspaceId?: string }): boolean {
    if (actor.actorType === "system") return true;
    if (scope.userId && actor.actorId === scope.userId) return true;
    return false;
  },
};

/** 香农熵估计：字符多样性越高越可能是 token/key */
function hasHighEntropy(s: string): boolean {
  const freq: Record<string, number> = {};
  for (const c of s) freq[c] = (freq[c] ?? 0) + 1;
  let entropy = 0;
  const len = s.length;
  for (const count of Object.values(freq)) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy > 4.5;
}
