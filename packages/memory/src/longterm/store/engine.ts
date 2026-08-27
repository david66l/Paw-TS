/**
 * 条目类型定义（spec v2 §4.2）+ 存储引擎接口（spec v2 §9.1）
 *
 * file/db 双后端的统一契约。MVP 仅提供 db 后端（postgres-engine.ts），
 * file 后端推迟（03 §3.5 决议）。
 */

// ══════════════════════════════════════════════════════════
// 条目类型（spec §4.2）
// ══════════════════════════════════════════════════════════

export type MemoryKind = "semantic" | "episodic" | "profile" | "vault_ref";

export type MemorySource =
  | "user_statement"
  | "agent_verified"
  | "agent_inferred"
  | "repo_docs"
  | "trial_graduated";

/** 所有库条目的公共字段 */
export interface MemoryBase {
  /** 库内唯一；内容哈希派生（见 id.ts），同内容重复写入天然幂等 */
  id: string;
  kind: MemoryKind;
  /** git common dir 的规范化路径 hash */
  repo: string;
  /** ISO 8601 创建时间 */
  created: string;
  /** 事实生效时间（写入时 = created） */
  tValid: string;
  /** 软失效时间；非 null = 已过期，永不注入但可查 */
  tInvalid: string | null;
  source: MemorySource;
  /** [0,1]，蒸馏器/裁决器输出 */
  confidence: number;
  /** 证据指针："runs/<runId>/trajectory#step-N"，可回溯 */
  evidence: string[];
  /** 被检索命中次数（效用账本） */
  freq: number;
  /** 命中后所在任务成功的次数 */
  utility: number;
}

/** Semantic 事实（L2） */
export interface SemanticFact extends MemoryBase {
  kind: "semantic";
  /** 单句事实 */
  fact: string;
  /** 3–6 个，供 BM25/过滤 */
  keywords: string[];
  /** 实际参与向量化的文本 = fact + keywords 拼接 */
  embeddingKey: string;
  /** UPDATE 版本链（保留 old 值） */
  history?: { fact: string; tInvalid: string }[];
}

/** Episodic 经验（L1，v2） */
export interface EpisodicExperience extends MemoryBase {
  kind: "episodic";
  /** 检索主键（embedding 此字段）：LLM 生成的使用场景条件句 */
  whenToUse: string;
  /** 思维层抽象（禁实体名） */
  perspective: string;
  /** 1–3 条操作建议，泛化表述 */
  modification: string[];
  /** ExpeRepair 四元组（可选，高价值） */
  failureFixPair?: {
    failed: string;
    /** 关键错误输出（截断 ≤400 字符） */
    feedback: string;
    fixed: string;
  };
  /** 泛化错误标签，如 "ModuleResolutionError" */
  issueType: string;
  taskId: string;
  branch?: string;
}

/** Profile 画像（L4，v2） */
export interface ProfileInsight extends MemoryBase {
  kind: "profile";
  /** 行为描述式（非形容词式） */
  insight: string;
  /** 证据条数，≥3 才允许存在 */
  supportCount: number;
}

/** Vault 引用（L5）：只存去哪找，永不存值 */
export interface VaultRef extends MemoryBase {
  kind: "vault_ref";
  refDescription: string;
  sensitivity: "low" | "medium" | "high";
}

/** 正式库条目（四种 kind 的判别联合） */
export type MemoryEntry = SemanticFact | EpisodicExperience | ProfileInsight | VaultRef;

/**
 * 试用教训（spec §4.2）：独立存储（memory_trial_lessons 表），
 * 不进正式检索池，故不属于 MemoryEntry / MemoryStoreEngine 契约。
 */
export interface TrialLesson {
  id: string;
  /** Reflexion 式第一人称教训 */
  lesson: string;
  originTaskId: string;
  created: string;
  /** 默认 3：被试用 N 次仍未验证成功则丢弃 */
  attemptsLeft: number;
}

// ══════════════════════════════════════════════════════════
// 存储引擎接口（spec §9.1）
// ══════════════════════════════════════════════════════════

/** query 的元数据过滤条件 */
export interface MemoryFilter {
  kind?: MemoryKind;
  repo?: string;
  source?: MemorySource;
  /** true = 含已软失效条目（memory list --all）；默认 false 只返回活跃条目 */
  includeInvalidated?: boolean;
  /**
   * false = 排除蒸馏降级条目（payload.degraded）。默认 true：
   * query/list 是给人看的（§5.7 "仅 memory list 可见"）；
   * 自动注入的过滤在 searchText/searchVector 检索路径，不在 query。
   */
  includeDegraded?: boolean;
  limit?: number;
  offset?: number;
}

export interface ScoredId {
  id: string;
  score: number;
}

/**
 * Model identity is part of the derived-index contract. Two providers that
 * happen to emit the same number of dimensions must never share vectors.
 */
export interface MemoryEmbeddingService {
  readonly dimensions: number;
  readonly model: string;
  readonly version: string;
  embed(text: string): Promise<number[]>;
  /** Optional bulk aperture. Implementations must preserve input order. */
  embedMany?(texts: readonly string[]): Promise<readonly (readonly number[])[]>;
}

export interface LedgerEntry {
  freq: number;
  utility: number;
}

/**
 * utility 计数上限（红队修复：utility farming 防御）。
 * 单条记忆的成功归因计数到此封顶——防止同 run 反复成功把 utility/freq 比率
 * 刷过删除阈值（§7.2 的 utility/freq≤0.3 判据会被无限 utility 免疫）。
 * freq 不封顶：freq 是注入次数，刷高只会更快越过 deleteMinFreq 加速删除评审，无增益。
 */
export const LEDGER_UTILITY_MAX = 50;

export interface ReindexReport {
  /** 扫描到的活跃条目数 */
  scanned: number;
  /** 成功重建索引的条目数 */
  indexed: number;
  /** 重建失败的条目数 */
  failed: number;
  /**
   * 重建后冒烟回归（spec §4.3）：抽样活跃条目，用其检索键文本做向量查询，
   * 验证条目能被召回。total=0 表示空库跳过。
   */
  smoke: {
    total: number;
    passed: number;
    /** 未被召回的条目 id */
    failedIds: string[];
  };
}

export interface MemoryStoreEngine {
  /** Present on runtime engines; all operations are physically sealed to it. */
  readonly scope?: import("./scope-key.js").MemoryScopeKey;
  /** 新增/覆盖；entry.id 为空时按内容+scope 哈希派生（同 scope 幂等） */
  put(entry: MemoryEntry): Promise<void>;
  get(id: string): Promise<MemoryEntry | null>;
  /**
   * Optional bulk hydration aperture for deep discovery. Implementations must
   * return entries in input order, preserve duplicate ids, and omit misses.
   * Callers must remain compatible with engines that only implement get().
   */
  getMany?(ids: readonly string[]): Promise<MemoryEntry[]>;
  /** 软失效：写 t_invalid */
  invalidate(id: string, tInvalid: string): Promise<void>;
  /** 物理删除（仅 gc） */
  delete(id: string): Promise<void>;
  /** 元数据过滤；默认排除已软失效条目 */
  query(filter: MemoryFilter): Promise<MemoryEntry[]>;
  /**
   * BM25/全文检索。repo 可选：提供时只检索该仓库条目（scope->>'repositoryId'）。
   * 缺省=跨仓库（Governor 相似召回保留跨 repo 去重语义，spec §5.6 已拍板）。
   */
  searchText(query: string, k: number, repo?: string): Promise<ScoredId[]>;
  /**
   * embedding 向量检索。repo 可选：提供时只检索该仓库条目——
   * 注入路径必须 repo 密封（A 仓库任务不得注入 B 仓库记忆），
   * 否则共享库中同内容异仓库条目会竞争 top-k。
   */
  searchVector(query: string, k: number, repo?: string): Promise<ScoredId[]>;
  /** 读效用账本；条目不存在返回 null */
  ledger(id: string): Promise<LedgerEntry | null>;
  /** 账本计数 +1（utility 封顶 LEDGER_UTILITY_MAX；freq 不封顶） */
  bumpLedger(id: string, field: "freq" | "utility"): Promise<void>;
  /** 重建派生索引（embedding 等） */
  reindex(): Promise<ReindexReport>;
}
