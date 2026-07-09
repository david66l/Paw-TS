/**
 * Policy Engine (8.15 simplified)
 *
 * 统一策略解析入口。替换各模块中的硬编码阈值。
 * MVP: global 默认 + project/repository 级覆盖。Task Session 创建时绑定快照。
 */

import { getSql, parseJson } from "../../connection.js";
import { generateId } from "./idGen.js";

// ══════════════════════════════════════════════
// Policy domain types
// ══════════════════════════════════════════════

export interface WritePolicy {
  allowedCandidateTypes: string[];
  minConfidence: number;
  requireEvidence: boolean;
  maxCandidatesPerTask: number;
  autoGenerationEnabled: boolean;
}

export interface RetrievalPolicy {
  topK: number;
  minScore: number;
  allowedMemoryTypes: string[];
  tokenBudget: number;
  retrievalMode: string;
}

export interface GovernancePolicy {
  autoApproveLowRiskThreshold: number;
  autoApproveMediumRiskThreshold: number;
  autoApproveConditions: string[];
  autoRejectConditions: string[];
  conflictMode: string;
  duplicateThreshold: number;
  scopeConstraints: Record<string, string[]>;
}

export interface ContextPolicy {
  tokenBudget: {
    totalTokens: number;
    reservedForSystem: number;
    reservedForGeneration: number;
    availableForContext: number;
    categoryBudgets: Record<string, { minTokens: number; targetTokens: number; maxTokens: number }>;
  };
  evictionOrder: string[];
}

export interface ErrorPolicy {
  maxRetries: number;
  timeoutMs: number;
  codeIndexDegradation: string;
  memoryWriterFailure: string;
  policyFallbackOrder: string[];
}

export interface EffectivePolicy {
  write: WritePolicy;
  retrieval: RetrievalPolicy;
  governance: GovernancePolicy;
  context: ContextPolicy;
  error: ErrorPolicy;
}

export interface PolicySnapshot {
  id: string;
  taskSessionId: string;
  effectivePolicy: EffectivePolicy;
  sourceVersions: Record<string, string>;
  checksum: string;
  createdAt: string;
}

// ══════════════════════════════════════════════
// Safe defaults (always available)
// ══════════════════════════════════════════════

const DEFAULTS: EffectivePolicy = {
  write: {
    allowedCandidateTypes: ["task_summary", "decision", "failure", "project_knowledge", "user_preference", "rule", "skill"],
    minConfidence: 0.5,
    requireEvidence: true,
    maxCandidatesPerTask: 20,
    autoGenerationEnabled: true,
  },
  retrieval: {
    topK: 10,
    minScore: 0.4,
    allowedMemoryTypes: ["task_summary", "decision", "failure", "project_knowledge", "user_preference", "rule", "skill"],
    tokenBudget: 4000,
    retrievalMode: "memory_only",
  },
  governance: {
    autoApproveLowRiskThreshold: 0.6,
    autoApproveMediumRiskThreshold: 0.7,
    autoApproveConditions: ["low+sufficient_confidence", "medium+high_confidence"],
    autoRejectConditions: ["no_evidence", "schema_invalid"],
    conflictMode: "reject",
    duplicateThreshold: 0.9,
    scopeConstraints: {},
  },
  context: {
    tokenBudget: {
      totalTokens: 8000,
      reservedForSystem: 200,
      reservedForGeneration: 2000,
      availableForContext: 5800,
      categoryBudgets: {
        hot: { minTokens: 500, targetTokens: 2000, maxTokens: 3000 },
        warm: { minTokens: 200, targetTokens: 1500, maxTokens: 2500 },
        cold_pointer: { minTokens: 0, targetTokens: 500, maxTokens: 1000 },
      },
    },
    evictionOrder: ["pinned", "importance", "recent"],
  },
  error: {
    maxRetries: 3,
    timeoutMs: 10000,
    codeIndexDegradation: "memory_only",
    memoryWriterFailure: "continue",
    policyFallbackOrder: ["session_snapshot", "last_known_good", "safe_default", "fail_closed"],
  },
};

// ══════════════════════════════════════════════
// Engine
// ══════════════════════════════════════════════

type PolicyScope = { repositoryId?: string; userId?: string; taskType?: string };

export class PolicyEngine {
  private cache = new Map<string, { policy: EffectivePolicy; ts: number }>();
  private cacheTtlMs = 60_000;

  /** 解析 Effective Policy */
  async resolve(scope: PolicyScope = {}): Promise<EffectivePolicy> {
    const cacheKey = this.cacheKey(scope);
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < this.cacheTtlMs) return cached.policy;

    const sql = getSql();
    try {
      const rows = await sql`
        SELECT domain, config FROM policy_configs
        WHERE status = 'active'
          AND (
            (scope_type = 'global')
            ${scope.repositoryId ? sql`OR (scope_type = 'repository' AND scope_value = ${scope.repositoryId})` : sql``}
            ${scope.userId ? sql`OR (scope_type = 'user' AND scope_value = ${scope.userId})` : sql``}
          )
        ORDER BY CASE scope_type WHEN 'global' THEN 0 WHEN 'repository' THEN 1 WHEN 'user' THEN 2 END
      `;

      const merged = this.merge(rows as unknown as { domain: string; config: unknown }[]);
      this.cache.set(cacheKey, { policy: merged, ts: Date.now() });
      return merged;
    } catch {
      return DEFAULTS;
    }
  }

  /** 为 Task Session 创建不可变策略快照 */
  async createSnapshot(taskSessionId: string, scope?: PolicyScope): Promise<PolicySnapshot> {
    const policy = await this.resolve(scope);
    const sourceVersions = await this.getVersions();
    const raw = JSON.stringify(policy);

    const sql = getSql();
    const id = generateId("snap");
    const now = new Date().toISOString();
    await sql`
      INSERT INTO policy_snapshots (id, task_session_id, effective_policy, source_versions, checksum, status, created_at)
      VALUES (${id}, ${taskSessionId}, ${sql.json(policy as any)}, ${sql.json(sourceVersions as any)}, ${simpleHash(raw)}, 'active', ${now})
      ON CONFLICT (task_session_id) DO NOTHING
    `;
    return { id, taskSessionId, effectivePolicy: policy, sourceVersions, checksum: simpleHash(raw), createdAt: now };
  }

  /** 根据 snapshotId 获取固定策略 */
  async getSnapshot(snapshotId: string): Promise<EffectivePolicy | null> {
    const sql = getSql();
    const rows = await sql`SELECT effective_policy FROM policy_snapshots WHERE id = ${snapshotId}`;
    if (rows.length === 0) return null;
    const raw = rows[0]!.effective_policy;
    const parsed = parseJson(raw) as Record<string, unknown>;
    return parsed as unknown as EffectivePolicy;
  }

  /** 获取默认策略（最保守，永不失败） */
  getDefaults(): EffectivePolicy {
    return structuredClone(DEFAULTS);
  }

  // ── private ──

  private cacheKey(scope: PolicyScope): string {
    return `${scope.repositoryId ?? "*"}:${scope.userId ?? "*"}:${scope.taskType ?? "*"}`;
  }

  private merge(rows: { domain: string; config: unknown }[]): EffectivePolicy {
    const result = structuredClone(DEFAULTS);
    for (const row of rows) {
      const config = (parseJson(row.config) ?? {}) as Record<string, unknown>;
      if (row.domain === "write") Object.assign(result.write, config);
      else if (row.domain === "retrieval") Object.assign(result.retrieval, config);
      else if (row.domain === "governance") Object.assign(result.governance, config);
      else if (row.domain === "context") Object.assign(result.context, config);
      else if (row.domain === "error") Object.assign(result.error, config);
    }
    return result;
  }

  private async getVersions(): Promise<Record<string, string>> {
    const sql = getSql();
    const rows = await sql`SELECT domain, name, version FROM policy_configs WHERE status = 'active'`;
    const versions: Record<string, string> = {};
    for (const r of rows as unknown as { domain: string; name: string; version: number }[]) {
      versions[`${r.domain}/${r.name}`] = `v${r.version}`;
    }
    return versions;
  }
}

function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return h.toString(16);
}
